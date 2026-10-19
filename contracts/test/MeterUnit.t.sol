// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {UsdcMeter} from "../UsdcMeter.sol";
import {VoucherSigner, Rejector, HookProvider} from "./Helpers.sol";

contract MeterUnitTest is VoucherSigner {
    UsdcMeter internal meter;
    uint64 internal constant NOTICE = 120;

    uint256 internal constant CLIENT_PK = 0xA11CE;
    uint256 internal constant PROVIDER_PK = 0xB0B;
    uint256 internal constant OTHER_PK = 0xC0FFEE;
    address internal client;
    address internal provider;
    address internal other;
    address internal relayer = address(0x7E1A7E1A);

    event Deposited(address indexed client, address indexed provider, uint256 amount, uint256 available);
    event Redeemed(
        address indexed client, address indexed provider, uint256 cumulativeAmount, uint256 paid, uint256 redeemed
    );
    event WithdrawRequested(address indexed client, address indexed provider, uint64 readyAt);
    event WithdrawCancelled(address indexed client, address indexed provider);
    event Withdrawn(address indexed client, address indexed provider, uint256 amount);

    function setUp() public {
        vm.warp(1_760_000_000);
        meter = new UsdcMeter(NOTICE);
        client = vm.addr(CLIENT_PK);
        provider = vm.addr(PROVIDER_PK);
        other = vm.addr(OTHER_PK);
        vm.deal(client, 100 ether);
        vm.deal(other, 100 ether);
    }

    // ---------- helpers ----------
    function _ch(address c, address p)
        internal
        view
        returns (uint256 dep, uint256 wd, uint256 red, uint256 ready, uint256 avail)
    {
        (uint128 a, uint128 b, uint128 c_, uint64 d, uint256 e) = meter.getChannel(c, p);
        return (a, b, c_, d, e);
    }

    function _deposit(address c, address p, uint256 amt) internal {
        vm.prank(c);
        meter.deposit{value: amt}(p);
    }

    function _redeem(uint256 cpk, address p, uint256 amt) internal {
        address c = vm.addr(cpk);
        bytes memory sig = _sign(cpk, address(meter), c, p, amt);
        vm.prank(p);
        meter.redeem(c, p, amt, sig);
    }

    // ---------- constructor / EIP-712 ----------
    function test_constructor_bounds() public {
        uint64[4] memory bad = [uint64(0), 59, 30 days + 1, type(uint64).max];
        for (uint256 i; i < bad.length; ++i) {
            vm.expectRevert(UsdcMeter.InvalidNoticePeriod.selector);
            new UsdcMeter(bad[i]);
        }
        assertEq(new UsdcMeter(60).noticePeriod(), 60);
        assertEq(new UsdcMeter(30 days).noticePeriod(), 30 days);
    }

    function test_eip712_matchesIndependentImplementation() public view {
        assertEq(meter.domainSeparator(), _domain(address(meter), block.chainid));
        assertEq(meter.VOUCHER_TYPEHASH(), V_TYPEHASH);
        assertEq(meter.voucherDigest(client, provider, 1234), _digest(address(meter), block.chainid, client, provider, 1234));
        (, string memory name, string memory version, uint256 chainId, address vc,,) = meter.eip712Domain();
        assertEq(name, "USDC Meter");
        assertEq(version, "1");
        assertEq(chainId, block.chainid);
        assertEq(vc, address(meter));
    }

    function test_eip712_chainForkInvalidatesOldVouchers() public {
        _deposit(client, provider, 1 ether);
        bytes memory sig = _sign(CLIENT_PK, address(meter), client, provider, 0.1 ether);
        vm.chainId(5042); // e.g. the same bytecode address on another chain / a fork
        assertEq(meter.domainSeparator(), _domain(address(meter), 5042));
        vm.prank(provider);
        vm.expectPartialRevert(UsdcMeter.InvalidSigner.selector);
        meter.redeem(client, provider, 0.1 ether, sig);
    }

    function test_voucherFromOtherDeploymentRejected() public {
        UsdcMeter meter2 = new UsdcMeter(NOTICE);
        _deposit(client, provider, 1 ether);
        bytes memory sigFor2 = _sign(CLIENT_PK, address(meter2), client, provider, 0.1 ether);
        vm.prank(provider);
        vm.expectPartialRevert(UsdcMeter.InvalidSigner.selector);
        meter.redeem(client, provider, 0.1 ether, sigFor2);
    }

    // ---------- deposit ----------
    function test_deposit_guards() public {
        vm.startPrank(client);
        vm.expectRevert(UsdcMeter.ZeroValue.selector);
        meter.deposit{value: 0}(provider);
        vm.expectRevert(UsdcMeter.ZeroProvider.selector);
        meter.deposit{value: 1}(address(0));
        vm.expectRevert(UsdcMeter.SelfChannel.selector);
        meter.deposit{value: 1}(client);
        vm.stopPrank();
    }

    function test_deposit_eventsAndAccumulation() public {
        vm.expectEmit(true, true, false, true, address(meter));
        emit Deposited(client, provider, 1 ether, 1 ether);
        _deposit(client, provider, 1 ether);
        _redeem(CLIENT_PK, provider, 0.3 ether);
        vm.expectEmit(true, true, false, true, address(meter));
        emit Deposited(client, provider, 0.5 ether, 1.2 ether); // available after redemptions
        _deposit(client, provider, 0.5 ether);
        (uint256 dep,, uint256 red,, uint256 avail) = _ch(client, provider);
        assertEq(dep, 1.5 ether);
        assertEq(red, 0.3 ether);
        assertEq(avail, 1.2 ether);
        assertEq(address(meter).balance, 1.2 ether);
    }

    function test_deposit_uint128Cap() public {
        vm.deal(client, uint256(type(uint128).max) + 10);
        _deposit(client, provider, type(uint128).max);
        vm.prank(client);
        vm.expectRevert(UsdcMeter.AmountTooLarge.selector);
        meter.deposit{value: 1}(provider);
        // a full-cap channel can still be fully redeemed + withdrawn without overflow
        _redeem(CLIENT_PK, provider, type(uint256).max); // voucher above cap: pays everything
        (uint256 dep,, uint256 red,, uint256 avail) = _ch(client, provider);
        assertEq(red, dep);
        assertEq(avail, 0);
        assertEq(provider.balance, type(uint128).max);
    }

    function test_plainTransferRejected_andForcedBalanceIsStuck() public {
        (bool ok,) = address(meter).call{value: 1 ether}("");
        assertFalse(ok, "contract has no receive/fallback");
        // On Arc the 6-dec ERC-20 USDC interface moves the SAME native balance without calling the
        // contract (like selfdestruct). Simulate: balance rises but no channel is credited.
        _deposit(client, provider, 1 ether);
        vm.deal(address(meter), address(meter).balance + 5 ether);
        _redeem(CLIENT_PK, provider, 0.4 ether);
        vm.prank(client);
        meter.requestWithdraw(provider);
        vm.warp(block.timestamp + NOTICE);
        vm.prank(client);
        meter.completeWithdraw(provider);
        assertEq(provider.balance, 0.4 ether);
        assertEq(address(meter).balance, 5 ether, "force-fed funds remain, unclaimable by anyone");
    }

    // ---------- redeem ----------
    function test_redeem_latestOnly_replayAndEqualRevert() public {
        _deposit(client, provider, 1 ether);
        bytes memory s1 = _sign(CLIENT_PK, address(meter), client, provider, 0.05 ether);
        bytes memory s3 = _sign(CLIENT_PK, address(meter), client, provider, 0.15 ether);
        vm.expectEmit(true, true, false, true, address(meter));
        emit Redeemed(client, provider, 0.15 ether, 0.15 ether, 0.15 ether);
        vm.prank(provider);
        meter.redeem(client, provider, 0.15 ether, s3);
        assertEq(provider.balance, 0.15 ether);

        vm.prank(provider);
        vm.expectRevert(UsdcMeter.NothingToRedeem.selector);
        meter.redeem(client, provider, 0.05 ether, s1);
        vm.prank(provider);
        vm.expectRevert(UsdcMeter.NothingToRedeem.selector);
        meter.redeem(client, provider, 0.15 ether, s3);

        bytes memory s4 = _sign(CLIENT_PK, address(meter), client, provider, 0.2 ether);
        vm.prank(provider);
        meter.redeem(client, provider, 0.2 ether, s4);
        assertEq(provider.balance, 0.2 ether, "only the delta is paid");
    }

    function test_redeem_zeroVoucher() public {
        _deposit(client, provider, 1 ether);
        bytes memory s0 = _sign(CLIENT_PK, address(meter), client, provider, 0);
        vm.prank(provider);
        vm.expectRevert(UsdcMeter.NothingToRedeem.selector);
        meter.redeem(client, provider, 0, s0);
    }

    function test_redeem_partialThenTopUp() public {
        _deposit(client, provider, 0.3 ether);
        bytes memory s = _sign(CLIENT_PK, address(meter), client, provider, 1 ether);
        vm.prank(provider);
        meter.redeem(client, provider, 1 ether, s);
        assertEq(provider.balance, 0.3 ether);
        vm.prank(provider);
        vm.expectRevert(UsdcMeter.NoPayout.selector);
        meter.redeem(client, provider, 1 ether, s);
        _deposit(client, provider, 0.5 ether);
        vm.prank(provider);
        meter.redeem(client, provider, 1 ether, s);
        assertEq(provider.balance, 0.8 ether);
        _deposit(client, provider, 0.5 ether);
        vm.prank(provider);
        meter.redeem(client, provider, 1 ether, s);
        assertEq(provider.balance, 1 ether, "never more than signed");
        vm.prank(provider);
        vm.expectRevert(UsdcMeter.NothingToRedeem.selector);
        meter.redeem(client, provider, 1 ether, s);
        (,,,, uint256 avail) = _ch(client, provider);
        assertEq(avail, 0.3 ether);
    }

    function test_redeem_emptyChannel_NoPayout() public {
        bytes memory s = _sign(CLIENT_PK, address(meter), client, provider, 1 ether);
        vm.prank(provider);
        vm.expectRevert(UsdcMeter.NoPayout.selector);
        meter.redeem(client, provider, 1 ether, s);
    }

    function test_redeem_badSignatures() public {
        _deposit(client, provider, 1 ether);
        uint256 amt = 0.1 ether;
        bytes memory good = _sign(CLIENT_PK, address(meter), client, provider, amt);

        // signed by someone else -> InvalidSigner(recovered = that someone)
        bytes memory byOther = _sign(OTHER_PK, address(meter), client, provider, amt);
        vm.expectRevert(abi.encodeWithSelector(UsdcMeter.InvalidSigner.selector, other));
        meter.redeem(client, provider, amt, byOther);
        // signed by the provider itself
        bytes memory byProv = _sign(PROVIDER_PK, address(meter), client, provider, amt);
        vm.expectRevert(abi.encodeWithSelector(UsdcMeter.InvalidSigner.selector, provider));
        meter.redeem(client, provider, amt, byProv);
        // amount tampered
        vm.expectPartialRevert(UsdcMeter.InvalidSigner.selector);
        meter.redeem(client, provider, amt + 1, good);
        // voucher for another provider used on this channel
        bytes memory forOther = _sign(CLIENT_PK, address(meter), client, other, amt);
        vm.expectPartialRevert(UsdcMeter.InvalidSigner.selector);
        meter.redeem(client, provider, amt, forOther);
        // client/provider swapped
        vm.expectPartialRevert(UsdcMeter.InvalidSigner.selector);
        meter.redeem(provider, client, amt, good);

        // malformed: empty, 64-byte (EIP-2098 compact), 66-byte, v=29, r=0, high-s malleated
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := mload(add(good, 32))
            s := mload(add(good, 64))
            v := byte(0, mload(add(good, 96)))
        }
        bytes32 vs = bytes32(uint256(s) | (uint256(v - 27) << 255));
        bytes[6] memory bad = [
            bytes(""),
            abi.encodePacked(r, vs),
            abi.encodePacked(good, uint8(0)),
            abi.encodePacked(r, s, uint8(29)),
            abi.encodePacked(bytes32(0), s, v),
            abi.encodePacked(r, bytes32(SECP256K1_N - uint256(s)), v == 27 ? uint8(28) : uint8(27))
        ];
        for (uint256 i; i < bad.length; ++i) {
            vm.prank(provider);
            vm.expectRevert(abi.encodeWithSelector(UsdcMeter.InvalidSigner.selector, address(0)));
            meter.redeem(client, provider, amt, bad[i]);
        }
        assertEq(provider.balance, 0);
        (,, uint256 red,,) = _ch(client, provider);
        assertEq(red, 0);
        // the good one still works afterwards
        vm.prank(provider);
        meter.redeem(client, provider, amt, good);
        assertEq(provider.balance, amt);
    }

    function test_redeem_zeroClientCannotBeSpoofed() public {
        // ecrecover returns 0 for garbage; tryRecover must not let client=0 "match"
        vm.expectPartialRevert(UsdcMeter.InvalidSigner.selector);
        meter.redeem(address(0), provider, 1, abi.encodePacked(bytes32(uint256(1)), bytes32(uint256(1)), uint8(27)));
    }

    function test_redeem_permissionless_paysProviderOnly() public {
        _deposit(client, provider, 1 ether);
        bytes memory s = _sign(CLIENT_PK, address(meter), client, provider, 0.25 ether);
        uint256 relBefore = relayer.balance;
        vm.prank(relayer);
        meter.redeem(client, provider, 0.25 ether, s);
        assertEq(provider.balance, 0.25 ether);
        assertEq(relayer.balance, relBefore);
    }

    function test_redeem_zeroProvider() public {
        vm.expectRevert(UsdcMeter.ZeroProvider.selector);
        meter.redeem(client, address(0), 1, "");
    }

    function test_redeem_providerRejects_stateRolledBack() public {
        Rejector prov = new Rejector(meter);
        _deposit(client, address(prov), 1 ether);
        bytes memory s = _sign(CLIENT_PK, address(meter), client, address(prov), 0.4 ether);
        vm.expectRevert(UsdcMeter.TransferFailed.selector);
        meter.redeem(client, address(prov), 0.4 ether, s);
        (,, uint256 red,, uint256 avail) = _ch(client, address(prov));
        assertEq(red, 0);
        assertEq(avail, 1 ether);
        // client is not blocked by a hostile provider
        vm.prank(client);
        meter.requestWithdraw(address(prov));
        vm.warp(block.timestamp + NOTICE);
        uint256 b = client.balance;
        vm.prank(client);
        meter.completeWithdraw(address(prov));
        assertEq(client.balance - b, 1 ether);
    }

    function test_redeem_reentrancyAndHooks() public {
        HookProvider prov = new HookProvider(meter);
        _deposit(client, address(prov), 1 ether);
        bytes memory s1 = _sign(CLIENT_PK, address(meter), client, address(prov), 0.1 ether);
        bytes memory s2 = _sign(CLIENT_PK, address(meter), client, address(prov), 0.5 ether);

        // mode 1: re-enter redeem from receive -> nonReentrant -> outer TransferFailed, nothing moves
        prov.arm(1, client, 0.5 ether, s2, address(0));
        vm.expectRevert(UsdcMeter.TransferFailed.selector);
        meter.redeem(client, address(prov), 0.1 ether, s1);

        // mode 2: provider tries completeWithdraw of its own client channel during payout
        address p2 = address(0xBEEF);
        vm.deal(address(prov), 1 ether);
        prov.depositAsClient{value: 1 ether}(p2);
        prov.requestWithdrawAsClient(p2);
        vm.warp(block.timestamp + NOTICE);
        prov.arm(2, address(0), 0, "", p2);
        vm.expectRevert(UsdcMeter.TransferFailed.selector);
        meter.redeem(client, address(prov), 0.1 ether, s1);

        // mode 4: gas burner only hurts itself
        prov.arm(4, address(0), 0, "", address(0));
        vm.expectRevert(UsdcMeter.TransferFailed.selector);
        meter.redeem{gas: 5_000_000}(client, address(prov), 0.1 ether, s1);

        // mode 3: forward payout as a deposit -> v2 deposit() is nonReentrant -> outer TransferFailed, nothing moves
        prov.arm(3, address(0), 0, "", p2);
        vm.expectRevert(UsdcMeter.TransferFailed.selector);
        meter.redeem(client, address(prov), 0.1 ether, s1);
        (,, uint256 red,, uint256 avail) = _ch(client, address(prov));
        assertEq(red, 0);
        assertEq(avail, 1 ether);
        (uint256 dep2,,,, uint256 avail2) = _ch(address(prov), p2);
        assertEq(dep2, 1 ether);
        assertEq(avail2, 1 ether);
        assertEq(address(meter).balance, avail + avail2);

        // plain payout (mode 0) still works
        prov.arm(0, address(0), 0, "", address(0));
        meter.redeem(client, address(prov), 0.1 ether, s1);
        (,, red,,) = _ch(client, address(prov));
        assertEq(red, 0.1 ether);
    }

    // ---------- withdraw ----------
    function test_requestWithdraw_guards() public {
        vm.prank(client);
        vm.expectRevert(UsdcMeter.NoAvailableBalance.selector);
        meter.requestWithdraw(provider);

        _deposit(client, provider, 1 ether);
        vm.expectEmit(true, true, false, true, address(meter));
        emit WithdrawRequested(client, provider, uint64(block.timestamp + NOTICE));
        vm.prank(client);
        meter.requestWithdraw(provider);
        (,,, uint256 ready,) = _ch(client, provider);
        assertEq(ready, block.timestamp + NOTICE);

        vm.prank(client);
        vm.expectRevert(UsdcMeter.WithdrawAlreadyPending.selector);
        meter.requestWithdraw(provider);

        // a third party cannot start/cancel/complete someone else's withdrawal (msg.sender is the client)
        vm.prank(other);
        vm.expectRevert(UsdcMeter.NoChannelOrNoPending.selector);
        meter.cancelWithdraw(provider);
        vm.warp(block.timestamp + NOTICE);
        vm.prank(provider);
        vm.expectRevert(UsdcMeter.NoPendingWithdraw.selector);
        meter.completeWithdraw(client);
    }

    function test_requestWithdraw_afterFullRedeem_NoAvailableBalance() public {
        _deposit(client, provider, 0.2 ether);
        _redeem(CLIENT_PK, provider, 0.2 ether);
        vm.prank(client);
        vm.expectRevert(UsdcMeter.NoAvailableBalance.selector);
        meter.requestWithdraw(provider);
    }

    function test_cancel_and_rerequest_resetsTimer() public {
        vm.prank(client);
        vm.expectRevert(UsdcMeter.NoChannelOrNoPending.selector);
        meter.cancelWithdraw(provider);

        _deposit(client, provider, 1 ether);
        vm.prank(client);
        meter.requestWithdraw(provider);
        vm.warp(block.timestamp + 100);
        vm.expectEmit(true, true, false, false, address(meter));
        emit WithdrawCancelled(client, provider);
        vm.prank(client);
        meter.cancelWithdraw(provider);
        (,,, uint256 ready,) = _ch(client, provider);
        assertEq(ready, 0);
        vm.prank(client);
        vm.expectRevert(UsdcMeter.NoPendingWithdraw.selector);
        meter.completeWithdraw(provider);

        vm.prank(client);
        meter.requestWithdraw(provider);
        (,,, ready,) = _ch(client, provider);
        assertEq(ready, block.timestamp + NOTICE, "fresh full notice after re-request");
    }

    function test_completeWithdraw_timingAndAccounting() public {
        _deposit(client, provider, 1 ether);
        _redeem(CLIENT_PK, provider, 0.15 ether);
        vm.prank(client);
        meter.requestWithdraw(provider);
        uint256 readyAt = block.timestamp + NOTICE;

        vm.warp(readyAt - 1);
        vm.prank(client);
        vm.expectRevert(UsdcMeter.TooEarlyToWithdraw.selector);
        meter.completeWithdraw(provider);

        // provider redeems during the notice
        _redeem(CLIENT_PK, provider, 0.2 ether);

        vm.warp(readyAt); // exactly at readyAt is allowed
        uint256 b = client.balance;
        vm.expectEmit(true, true, false, true, address(meter));
        emit Withdrawn(client, provider, 0.8 ether);
        vm.prank(client);
        meter.completeWithdraw(provider);
        assertEq(client.balance - b, 0.8 ether);
        (uint256 dep, uint256 wd, uint256 red, uint256 ready, uint256 avail) = _ch(client, provider);
        assertEq(dep, 1 ether);
        assertEq(wd, 0.8 ether);
        assertEq(red, 0.2 ether);
        assertEq(ready, 0);
        assertEq(avail, 0);
        assertEq(red + wd, dep, "redemptions + withdrawals == deposits after close");
        assertEq(address(meter).balance, 0);

        vm.prank(client);
        vm.expectRevert(UsdcMeter.NoPendingWithdraw.selector);
        meter.completeWithdraw(provider);
    }

    function test_completeWithdraw_zeroAfterProviderDrains() public {
        _deposit(client, provider, 0.5 ether);
        vm.prank(client);
        meter.requestWithdraw(provider);
        _redeem(CLIENT_PK, provider, 0.7 ether); // voucher exceeds funds: provider takes all 0.5
        vm.warp(block.timestamp + NOTICE);
        uint256 b = client.balance;
        vm.expectEmit(true, true, false, true, address(meter));
        emit Withdrawn(client, provider, 0);
        vm.prank(client);
        meter.completeWithdraw(provider);
        assertEq(client.balance, b);
        assertEq(provider.balance, 0.5 ether);
    }

    /// v2: deposits are refused while a withdrawal is pending; the pending request is untouched.
    function test_depositDuringNotice_reverts() public {
        _deposit(client, provider, 1 ether);
        vm.prank(client);
        meter.requestWithdraw(provider);
        (,,, uint256 readyBefore,) = _ch(client, provider);
        vm.deal(client, client.balance + 2 ether);
        vm.prank(client);
        vm.expectRevert(UsdcMeter.WithdrawAlreadyPending.selector);
        meter.deposit{value: 2 ether}(provider);
        (,,, uint256 ready,) = _ch(client, provider);
        assertEq(ready, readyBefore, "pending withdrawal unchanged");
        vm.warp(block.timestamp + NOTICE);
        uint256 b = client.balance;
        vm.prank(client);
        meter.completeWithdraw(provider);
        assertEq(client.balance - b, 1 ether, "only what was under notice leaves");
    }

    function test_completeWithdraw_clientRejects_stateRolledBack() public {
        Rejector cl = new Rejector(meter);
        cl.setReject(false);
        cl.deposit{value: 1 ether}(provider);
        cl.requestWithdraw(provider);
        vm.warp(block.timestamp + NOTICE);
        cl.setReject(true);
        vm.expectRevert(UsdcMeter.TransferFailed.selector);
        cl.completeWithdraw(provider);
        (, uint256 wd,, uint256 ready, uint256 avail) = _ch(address(cl), provider);
        assertEq(wd, 0);
        assertGt(ready, 0);
        assertEq(avail, 1 ether);
        cl.setReject(false);
        cl.completeWithdraw(provider);
        assertEq(address(cl).balance, 1 ether);
    }

    // ---------- isolation / lifecycle ----------
    function test_channelIsolation() public {
        address p2 = address(0xBEEF2);
        _deposit(client, provider, 1 ether);
        _deposit(client, p2, 1 ether);
        _deposit(other, provider, 1 ether);
        vm.deal(provider, 1 ether);
        _deposit(provider, client, 1 ether); // reverse direction is a separate channel

        _redeem(CLIENT_PK, provider, 0.3 ether);
        (,, uint256 r1,,) = _ch(client, provider);
        (,, uint256 r2,,) = _ch(client, p2);
        (,, uint256 r3,,) = _ch(other, provider);
        (,, uint256 r4,,) = _ch(provider, client);
        assertEq(r1, 0.3 ether);
        assertEq(r2 + r3 + r4, 0);

        // the (client, provider) voucher can't be used on (other, provider) or (client, p2)
        bytes memory s = _sign(CLIENT_PK, address(meter), client, provider, 0.5 ether);
        vm.expectPartialRevert(UsdcMeter.InvalidSigner.selector);
        meter.redeem(other, provider, 0.5 ether, s);
        vm.expectPartialRevert(UsdcMeter.InvalidSigner.selector);
        meter.redeem(client, p2, 0.5 ether, s);

        vm.prank(client);
        meter.requestWithdraw(provider);
        (,,, uint256 rdy2,) = _ch(client, p2);
        assertEq(rdy2, 0, "withdrawal is per channel");
    }

    function test_channelReuseAfterClose() public {
        _deposit(client, provider, 1 ether);
        _redeem(CLIENT_PK, provider, 0.4 ether);
        vm.prank(client);
        meter.requestWithdraw(provider);
        vm.warp(block.timestamp + NOTICE);
        vm.prank(client);
        meter.completeWithdraw(provider);
        // reopen
        _deposit(client, provider, 1 ether);
        bytes memory old = _sign(CLIENT_PK, address(meter), client, provider, 0.4 ether);
        vm.prank(provider);
        vm.expectRevert(UsdcMeter.NothingToRedeem.selector);
        meter.redeem(client, provider, 0.4 ether, old);
        _redeem(CLIENT_PK, provider, 0.5 ether);
        assertEq(provider.balance, 0.5 ether);
        (uint256 dep, uint256 wd, uint256 red,, uint256 avail) = _ch(client, provider);
        assertEq(dep, 2 ether);
        assertEq(wd, 0.6 ether);
        assertEq(red, 0.5 ether);
        assertEq(avail, 0.9 ether);
    }

    // ---------- documented behaviours worth knowing (pass = behaviour confirmed) ----------

    /// An unredeemed voucher survives a full withdrawal and becomes payable again after the next deposit.
    function test_behaviour_staleVoucherSurvivesClose() public {
        _deposit(client, provider, 1 ether);
        bytes memory s = _sign(CLIENT_PK, address(meter), client, provider, 0.3 ether); // provider never redeems
        vm.prank(client);
        meter.requestWithdraw(provider);
        vm.warp(block.timestamp + NOTICE);
        vm.prank(client);
        meter.completeWithdraw(provider); // client takes back all 1.0
        vm.warp(block.timestamp + 30 days);
        _deposit(client, provider, 1 ether); // new session a month later
        vm.prank(provider);
        meter.redeem(client, provider, 0.3 ether, s);
        assertEq(provider.balance, 0.3 ether, "old voucher paid from the NEW deposit");
    }

    /// A matured-but-not-completed withdrawal request lets the client exit instantly at any later time,
    /// so a provider that keeps serving (checking only signer/amount/available) can lose all unredeemed calls.
    /// v2: a matured request can no longer be topped up, so fresh funds always get a full notice period.
    /// (A matured request still lets the client leave with the balance that WAS under notice: providers must stop
    /// serving as soon as withdrawReadyAt != 0 - enforced in the app and meter_client.verify.)
    function test_behaviour_maturedRequestBlocksTopUp() public {
        _deposit(client, provider, 1 ether);
        vm.prank(client);
        meter.requestWithdraw(provider);
        vm.warp(block.timestamp + 10 days);
        vm.deal(client, client.balance + 5 ether);
        vm.prank(client);
        vm.expectRevert(UsdcMeter.WithdrawAlreadyPending.selector);
        meter.deposit{value: 5 ether}(provider);
        (,,, uint256 ready, uint256 avail) = _ch(client, provider);
        assertGt(ready, 0);
        assertEq(avail, 1 ether, "exposure stays at the amount under notice");
    }

    // ---------- fuzz ----------
    function testFuzz_redeemFormula(uint96 dep, uint96 v1, uint96 v2, uint96 dep2) public {
        dep = uint96(bound(dep, 1, 1e27));
        vm.deal(client, uint256(dep) + uint256(dep2));
        _deposit(client, provider, dep);
        uint256[2] memory vs = [uint256(v1), uint256(v2)];
        for (uint256 i; i < 2; ++i) {
            if (i == 1 && dep2 > 0) {
                _deposit(client, provider, dep2);
            }
            (uint256 d, uint256 w, uint256 red,, uint256 avail) = _ch(client, provider);
            bytes memory s = _sign(CLIENT_PK, address(meter), client, provider, vs[i]);
            uint256 pb = provider.balance;
            vm.prank(provider);
            if (vs[i] <= red) {
                vm.expectRevert(UsdcMeter.NothingToRedeem.selector);
                meter.redeem(client, provider, vs[i], s);
            } else if (avail == 0) {
                vm.expectRevert(UsdcMeter.NoPayout.selector);
                meter.redeem(client, provider, vs[i], s);
            } else {
                meter.redeem(client, provider, vs[i], s);
                assertEq(provider.balance - pb, _min(vs[i] - red, avail));
                (,, uint256 red2,,) = _ch(client, provider);
                assertEq(red2, _min(vs[i], d - w));
            }
        }
        (uint256 dd, uint256 ww, uint256 rr,, uint256 aa) = _ch(client, provider);
        assertEq(dd, rr + ww + aa);
        assertLe(rr, _min(dd, v1 > v2 ? v1 : v2));
    }

    function testFuzz_forgedVoucherNeverPays(uint256 pk, uint96 amt) public {
        pk = bound(pk, 1, SECP256K1_N - 1);
        vm.assume(pk != CLIENT_PK);
        amt = uint96(bound(amt, 1, 1 ether));
        _deposit(client, provider, 1 ether);
        bytes memory s = _sign(pk, address(meter), client, provider, amt);
        vm.expectRevert(abi.encodeWithSelector(UsdcMeter.InvalidSigner.selector, vm.addr(pk)));
        meter.redeem(client, provider, amt, s);
    }

    function testFuzz_randomSignatureBytesNeverPay(bytes32 r, bytes32 s, uint8 v, uint96 amt) public {
        _deposit(client, provider, 1 ether);
        vm.expectPartialRevert(UsdcMeter.InvalidSigner.selector);
        meter.redeem(client, provider, amt, abi.encodePacked(r, s, v));
    }

    function testFuzz_withdrawTiming(uint32 waitSecs, uint96 dep) public {
        dep = uint96(bound(dep, 1, 50 ether));
        _deposit(client, provider, dep);
        vm.prank(client);
        meter.requestWithdraw(provider);
        uint256 readyAt = block.timestamp + NOTICE;
        vm.warp(block.timestamp + waitSecs);
        vm.prank(client);
        if (block.timestamp < readyAt) {
            vm.expectRevert(UsdcMeter.TooEarlyToWithdraw.selector);
            meter.completeWithdraw(provider);
        } else {
            uint256 b = client.balance;
            meter.completeWithdraw(provider);
            assertEq(client.balance - b, dep);
        }
    }
}
