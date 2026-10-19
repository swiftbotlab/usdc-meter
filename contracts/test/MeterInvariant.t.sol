// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {UsdcMeter} from "../UsdcMeter.sol";
import {VoucherSigner} from "./Helpers.sol";

/// Stateful handler. Every action predicts its own outcome from the pre-state and asserts the contract
/// matches (success amounts and revert selectors), so fail_on_revert catches any divergence.
contract MeterHandler is VoucherSigner {
    UsdcMeter public meter;
    uint256 public constant N = 3;
    uint256[N] internal clientPk;
    address[N] public clients;
    address[N] public providers;
    address public relayer = address(0x5E1A);
    uint256 internal constant FORGER_PK = 0xBAD;

    struct Ghost {
        uint256 deposits; // sum of msg.value deposited
        uint256 redeemPaid; // sum of native received by the provider from redeem
        uint256 withdrawPaid; // sum of native received by the client from completeWithdraw
        uint256 maxSigned; // highest cumulative amount the client ever signed
        uint256 lastSigned; // client's running meter (monotonic)
    }

    mapping(uint256 => Ghost) public ghost;
    mapping(uint256 => uint256[]) internal vAmt;
    mapping(uint256 => bytes[]) internal vSig;

    // coverage counters
    uint256 public nDeposit;
    uint256 public nDepositBlocked;
    uint256 public nCall;
    uint256 public nRedeemOk;
    uint256 public nRedeemReplay;
    uint256 public nRedeemNoPayout;
    uint256 public nRedeemPartial;
    uint256 public nForgeRejected;
    uint256 public nReqOk;
    uint256 public nReqRejected;
    uint256 public nCancelOk;
    uint256 public nCompleteOk;
    uint256 public nCompleteEarly;
    uint256 public nCompleteNone;

    constructor(UsdcMeter m) {
        meter = m;
        for (uint256 i; i < N; ++i) {
            clientPk[i] = 0x1000 + i;
            clients[i] = vm.addr(clientPk[i]);
            providers[i] = address(uint160(0xF00D0 + i)); // providers only receive; start at 0 balance
        }
    }

    function _k(uint256 c, uint256 p) internal pure returns (uint256) {
        return c * N + p;
    }

    function _state(uint256 c, uint256 p)
        public
        view
        returns (uint256 dep, uint256 wd, uint256 red, uint256 ready, uint256 avail)
    {
        (uint128 a, uint128 b, uint128 r, uint64 d, uint256 e) = meter.getChannel(clients[c], providers[p]);
        return (a, b, r, d, e);
    }

    function deposit(uint256 c, uint256 p, uint256 amt) external {
        c = bound(c, 0, N - 1);
        p = bound(p, 0, N - 1);
        amt = bound(amt, 1, 1e24);
        vm.deal(clients[c], clients[c].balance + amt);
        (,,, uint256 readyBefore, uint256 availBefore) = _state(c, p);
        if (readyBefore != 0) {
            // v2: deposits are refused while a withdrawal is pending or matured
            vm.prank(clients[c]);
            vm.expectRevert(UsdcMeter.WithdrawAlreadyPending.selector);
            meter.deposit{value: amt}(providers[p]);
            ++nDepositBlocked;
            return;
        }
        vm.prank(clients[c]);
        meter.deposit{value: amt}(providers[p]);
        ghost[_k(c, p)].deposits += amt;
        (,,, uint256 readyAfter, uint256 availAfter) = _state(c, p);
        assertEq(availAfter, availBefore + amt);
        assertEq(readyAfter, readyBefore, "deposit must not touch a pending withdrawal");
        ++nDeposit;
    }

    /// One metered API call: the client signs the next cumulative voucher off-chain.
    function callApi(uint256 c, uint256 p, uint256 price) external {
        c = bound(c, 0, N - 1);
        p = bound(p, 0, N - 1);
        price = bound(price, 1, 1e22);
        Ghost storage g = ghost[_k(c, p)];
        uint256 next = g.lastSigned + price;
        vAmt[_k(c, p)].push(next);
        vSig[_k(c, p)].push(_sign(clientPk[c], address(meter), clients[c], providers[p], next));
        g.lastSigned = next;
        if (next > g.maxSigned) g.maxSigned = next;
        ++nCall;
    }

    /// Redeem ANY voucher the client signed (latest or a stale one), from the provider or a relayer.
    struct Pre {
        uint256 k;
        uint256 i;
        uint256 amt;
        uint256 dMinusW;
        uint256 red;
        uint256 avail;
        uint256 pb;
        uint256 rb;
        address prov;
        address cl;
    }

    function redeem(uint256 c, uint256 p, uint256 which, bool viaRelayer) external {
        c = bound(c, 0, N - 1);
        p = bound(p, 0, N - 1);
        Pre memory x;
        x.k = _k(c, p);
        uint256 n = vAmt[x.k].length;
        if (n == 0) return;
        // bias towards the latest voucher half of the time
        x.i = which % 2 == 0 ? n - 1 : bound(which, 0, n - 1);
        x.amt = vAmt[x.k][x.i];
        {
            (uint256 d, uint256 w, uint256 red,, uint256 avail) = _state(c, p);
            x.dMinusW = d - w;
            x.red = red;
            x.avail = avail;
        }
        x.prov = providers[p];
        x.cl = clients[c];
        x.pb = x.prov.balance;
        x.rb = relayer.balance;
        bytes memory sig = vSig[x.k][x.i];
        vm.prank(viaRelayer ? relayer : x.prov);
        try meter.redeem(x.cl, x.prov, x.amt, sig) {
            _afterRedeemOk(x, c, p);
        } catch (bytes memory err) {
            bytes4 sel = bytes4(err);
            if (x.amt <= x.red) {
                assertEq(sel, UsdcMeter.NothingToRedeem.selector);
                ++nRedeemReplay;
            } else {
                assertEq(x.avail, 0, "unexpected revert with funds available");
                assertEq(sel, UsdcMeter.NoPayout.selector);
                ++nRedeemNoPayout;
            }
        }
    }

    function _afterRedeemOk(Pre memory x, uint256 c, uint256 p) internal {
        assertGt(x.amt, x.red, "paid on a non-increasing voucher");
        uint256 paid = x.prov.balance - x.pb;
        assertEq(paid, _min(x.amt - x.red, x.avail), "paid != min(owed, available)");
        assertEq(relayer.balance, x.rb, "relayer must never receive funds");
        (,, uint256 red2,,) = _state(c, p);
        assertEq(red2, _min(x.amt, x.dMinusW), "redeemed != min(voucher, deposited - withdrawn)");
        ghost[x.k].redeemPaid += paid;
        if (paid < x.amt - x.red) ++nRedeemPartial;
        ++nRedeemOk;
    }

    /// Anyone else (provider, relayer) signs a voucher claiming to be the client: must never pay.
    function forgeRedeem(uint256 c, uint256 p, uint256 amt, uint256 who) external {
        c = bound(c, 0, N - 1);
        p = bound(p, 0, N - 1);
        amt = bound(amt, 1, 1e25);
        uint256 pk = who % 3 == 0 ? FORGER_PK : (who % 3 == 1 ? clientPk[(c + 1) % N] : 0xF00D0 + p);
        bytes memory sig = _sign(pk, address(meter), clients[c], providers[p], amt);
        uint256 pb = providers[p].balance;
        try meter.redeem(clients[c], providers[p], amt, sig) {
            fail("forged voucher was accepted");
        } catch (bytes memory err) {
            assertEq(bytes4(err), UsdcMeter.InvalidSigner.selector);
        }
        assertEq(providers[p].balance, pb);
        ++nForgeRejected;
    }

    function requestWithdraw(uint256 c, uint256 p) external {
        c = bound(c, 0, N - 1);
        p = bound(p, 0, N - 1);
        (,,, uint256 ready, uint256 avail) = _state(c, p);
        vm.prank(clients[c]);
        try meter.requestWithdraw(providers[p]) {
            assertGt(avail, 0);
            assertEq(ready, 0);
            (,,, uint256 ready2,) = _state(c, p);
            assertEq(ready2, block.timestamp + meter.noticePeriod());
            ++nReqOk;
        } catch (bytes memory err) {
            bytes4 sel = bytes4(err);
            if (avail == 0) assertEq(sel, UsdcMeter.NoAvailableBalance.selector);
            else assertEq(sel, UsdcMeter.WithdrawAlreadyPending.selector);
            ++nReqRejected;
        }
    }

    function cancelWithdraw(uint256 c, uint256 p) external {
        c = bound(c, 0, N - 1);
        p = bound(p, 0, N - 1);
        (,,, uint256 ready,) = _state(c, p);
        vm.prank(clients[c]);
        try meter.cancelWithdraw(providers[p]) {
            assertGt(ready, 0);
            ++nCancelOk;
        } catch (bytes memory err) {
            assertEq(ready, 0);
            assertEq(bytes4(err), UsdcMeter.NoChannelOrNoPending.selector);
        }
    }

    function completeWithdraw(uint256 c, uint256 p) external {
        c = bound(c, 0, N - 1);
        p = bound(p, 0, N - 1);
        (,,, uint256 ready, uint256 avail) = _state(c, p);
        address cl = clients[c];
        uint256 cb = cl.balance;
        vm.prank(cl);
        try meter.completeWithdraw(providers[p]) {
            assertGt(ready, 0);
            assertGe(block.timestamp, ready);
            assertEq(cl.balance - cb, avail, "withdraw paid != available");
            (,,, uint256 ready2, uint256 avail2) = _state(c, p);
            assertEq(ready2, 0);
            assertEq(avail2, 0);
            ghost[_k(c, p)].withdrawPaid += avail;
            ++nCompleteOk;
        } catch (bytes memory err) {
            bytes4 sel = bytes4(err);
            if (ready == 0) {
                assertEq(sel, UsdcMeter.NoPendingWithdraw.selector);
                ++nCompleteNone;
            } else {
                assertLt(block.timestamp, ready);
                assertEq(sel, UsdcMeter.TooEarlyToWithdraw.selector);
                ++nCompleteEarly;
            }
        }
    }

    function warp(uint256 secs) external {
        secs = bound(secs, 1, 200);
        vm.warp(block.timestamp + secs);
    }

    // ---------- used by afterInvariant ----------
    function drainAll() external {
        for (uint256 c; c < N; ++c) {
            for (uint256 p; p < N; ++p) {
                uint256 k = _k(c, p);
                uint256 n = vAmt[k].length;
                if (n == 0) continue;
                (,, uint256 red,, uint256 avail) = _state(c, p);
                uint256 amt = vAmt[k][n - 1];
                if (amt > red && avail > 0) {
                    uint256 pb = providers[p].balance;
                    vm.prank(providers[p]);
                    meter.redeem(clients[c], providers[p], amt, vSig[k][n - 1]);
                    ghost[k].redeemPaid += providers[p].balance - pb;
                }
            }
        }
        for (uint256 c; c < N; ++c) {
            for (uint256 p; p < N; ++p) {
                (,,, uint256 ready, uint256 avail) = _state(c, p);
                if (avail > 0 && ready == 0) {
                    vm.prank(clients[c]);
                    meter.requestWithdraw(providers[p]);
                }
            }
        }
        vm.warp(block.timestamp + meter.noticePeriod());
        for (uint256 c; c < N; ++c) {
            for (uint256 p; p < N; ++p) {
                (,,, uint256 ready, uint256 avail) = _state(c, p);
                if (ready == 0) continue;
                uint256 cb = clients[c].balance;
                vm.prank(clients[c]);
                meter.completeWithdraw(providers[p]);
                assertEq(clients[c].balance - cb, avail);
                ghost[_k(c, p)].withdrawPaid += avail;
            }
        }
    }
}

contract MeterInvariantTest is VoucherSigner {
    UsdcMeter internal meter;
    MeterHandler internal h;

    function setUp() public {
        vm.warp(1_760_000_000);
        meter = new UsdcMeter(120);
        h = new MeterHandler(meter);
        targetContract(address(h));
        bytes4[] memory sels = new bytes4[](8);
        sels[0] = MeterHandler.deposit.selector;
        sels[1] = MeterHandler.callApi.selector;
        sels[2] = MeterHandler.redeem.selector;
        sels[3] = MeterHandler.forgeRedeem.selector;
        sels[4] = MeterHandler.requestWithdraw.selector;
        sels[5] = MeterHandler.cancelWithdraw.selector;
        sels[6] = MeterHandler.completeWithdraw.selector;
        sels[7] = MeterHandler.warp.selector;
        targetSelector(FuzzSelector({addr: address(h), selectors: sels}));
    }

    function _g(uint256 c, uint256 p)
        internal
        view
        returns (uint256 deposits, uint256 redeemPaid, uint256 withdrawPaid, uint256 maxSigned)
    {
        (deposits, redeemPaid, withdrawPaid, maxSigned,) = h.ghost(c * 3 + p);
    }

    /// deposits == redemptions + withdrawals + still-available, per channel, and on-chain counters
    /// equal the native amounts that actually moved.
    function invariant_conservationPerChannel() public view {
        for (uint256 c; c < 3; ++c) {
            for (uint256 p; p < 3; ++p) {
                (uint256 dep, uint256 wd, uint256 red,, uint256 avail) = h._state(c, p);
                (uint256 gd, uint256 gr, uint256 gw,) = _g(c, p);
                assertEq(dep, gd, "deposited counter != native deposited");
                assertEq(red, gr, "redeemed counter != native paid to provider");
                assertEq(wd, gw, "withdrawn counter != native paid to client");
                assertEq(gd, gr + gw + avail, "deposits != redemptions + withdrawals + available");
            }
        }
    }

    /// The provider never receives more than the highest voucher the client signed.
    function invariant_providerTotalLeMaxSigned() public view {
        for (uint256 c; c < 3; ++c) {
            for (uint256 p; p < 3; ++p) {
                (,, uint256 red,,) = h._state(c, p);
                (,,, uint256 maxSigned) = _g(c, p);
                assertLe(red, maxSigned, "provider total > max signed");
            }
        }
    }

    /// Contract holds exactly the sum of available balances; each provider's wallet holds exactly what
    /// it redeemed across all clients.
    function invariant_solvencyAndProviderBalances() public view {
        uint256 sum;
        for (uint256 p; p < 3; ++p) {
            uint256 provSum;
            for (uint256 c; c < 3; ++c) {
                (,,,, uint256 avail) = h._state(c, p);
                sum += avail;
                (, uint256 gr,,) = _g(c, p);
                provSum += gr;
            }
            assertEq(h.providers(p).balance, provSum, "provider wallet != sum redeemed");
        }
        assertEq(address(meter).balance, sum, "contract balance != sum(available)");
        assertEq(h.relayer().balance, 0);
    }

    function invariant_readyAtBounded() public view {
        for (uint256 c; c < 3; ++c) {
            for (uint256 p; p < 3; ++p) {
                (,,, uint256 ready,) = h._state(c, p);
                assertTrue(ready == 0 || ready <= block.timestamp + 120);
            }
        }
    }

    /// After each run: provider redeems its latest voucher, every client exits. Then
    /// redemptions + withdrawals == deposits EXACTLY and the contract is empty.
    function afterInvariant() public {
        h.drainAll();
        uint256 totalDep;
        uint256 totalOut;
        for (uint256 c; c < 3; ++c) {
            for (uint256 p; p < 3; ++p) {
                (uint256 dep, uint256 wd, uint256 red, uint256 ready, uint256 avail) = h._state(c, p);
                (uint256 gd, uint256 gr, uint256 gw, uint256 maxSigned) = _g(c, p);
                assertEq(avail, 0);
                assertEq(ready, 0);
                assertEq(gr + gw, gd, "after close: redemptions + withdrawals != deposits");
                assertEq(red + wd, dep);
                assertLe(red, maxSigned);
                totalDep += gd;
                totalOut += gr + gw;
            }
        }
        assertEq(totalDep, totalOut);
        assertEq(address(meter).balance, 0, "contract not empty after all channels closed");
    }

    function test_coverageSmoke() public pure {}
}

/// Prints how often each path was hit (run with -vv), so a "pass" is not a pass over dead paths.
contract MeterCoverageReport is VoucherSigner {
    function test_handlerPathsAreReachable() public {
        vm.warp(1_760_000_000);
        UsdcMeter meter = new UsdcMeter(120);
        MeterHandler h = new MeterHandler(meter);
        uint256 seed = 42;
        for (uint256 i; i < 3000; ++i) {
            seed = uint256(keccak256(abi.encode(seed)));
            uint256 a = seed % 3;
            uint256 b = (seed >> 8) % 3;
            uint256 x = seed >> 16;
            uint256 op = (seed >> 128) % 8;
            if (op == 0) h.deposit(a, b, x % 5e22 + 1);
            else if (op == 1) h.callApi(a, b, x % 1e22 + 1);
            else if (op == 2) h.redeem(a, b, x, (x & 1) == 1);
            else if (op == 3) h.forgeRedeem(a, b, x, x >> 3);
            else if (op == 4) h.requestWithdraw(a, b);
            else if (op == 5) h.cancelWithdraw(a, b);
            else if (op == 6) h.completeWithdraw(a, b);
            else h.warp(x % 200 + 1);
        }
        emit log_named_uint("deposit", h.nDeposit());
        emit log_named_uint("deposit blocked (pending withdraw)", h.nDepositBlocked());
        emit log_named_uint("callApi(vouchers)", h.nCall());
        emit log_named_uint("redeem ok", h.nRedeemOk());
        emit log_named_uint("redeem partial", h.nRedeemPartial());
        emit log_named_uint("redeem replay->NothingToRedeem", h.nRedeemReplay());
        emit log_named_uint("redeem NoPayout", h.nRedeemNoPayout());
        emit log_named_uint("forged rejected", h.nForgeRejected());
        emit log_named_uint("requestWithdraw ok", h.nReqOk());
        emit log_named_uint("requestWithdraw rejected", h.nReqRejected());
        emit log_named_uint("cancel ok", h.nCancelOk());
        emit log_named_uint("complete ok", h.nCompleteOk());
        emit log_named_uint("complete early", h.nCompleteEarly());
        emit log_named_uint("complete none", h.nCompleteNone());
        assertGt(h.nRedeemOk(), 0);
        assertGt(h.nRedeemPartial(), 0);
        assertGt(h.nRedeemReplay(), 0);
        assertGt(h.nRedeemNoPayout(), 0);
        assertGt(h.nCompleteOk(), 0);
        assertGt(h.nCompleteEarly(), 0);
        assertGt(h.nCancelOk(), 0);
    }
}
