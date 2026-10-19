// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {UsdcMeter} from "../UsdcMeter.sol";
import {ReentrantDepositor, LoggingProvider} from "../test-helpers/PayoutHooks.sol";

/// Regression tests from the external security review of v1 (2026-10-19).
/// test_V2_* : findings fixed in v2 (they FAIL on v1). test_PoC_* : inherent, documented properties that still hold
/// (notice-period boundary, non-canonical signature forms rejected on-chain, stale voucher carry-over).
/// test_Safe_* : properties that hold (replay protection, provider payout bounded by signed max and funds).
contract UsdcMeterReviewTest is Test {
    UsdcMeter internal meter;
    uint64 internal constant NOTICE = 120;
    uint256 internal constant SECP_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;

    address internal alice; // client
    uint256 internal alicePk;
    address internal bob; // provider
    address internal carol; // other provider / client

    function setUp() public {
        meter = new UsdcMeter(NOTICE);
        (alice, alicePk) = makeAddrAndKey("alice");
        bob = makeAddr("bob");
        carol = makeAddr("carol");
        vm.deal(alice, 1000 ether);
        vm.deal(carol, 1000 ether);
    }

    function _sign(uint256 pk, address client, address provider, uint256 cumulative) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, meter.voucherDigest(client, provider, cumulative));
        return abi.encodePacked(r, s, v);
    }

    function _deposit(address client, address provider, uint256 amount) internal {
        vm.prank(client);
        meter.deposit{value: amount}(provider);
    }

    /// The provider-side acceptance rule used by the app (DemoApiPanel / ProviderView) and
    /// examples/python/meter_client.py verify(): signer ok && cum > redeemed && cum - redeemed <= available.
    /// It never looks at withdrawReadyAt.
    function _appProviderCheck(address client, address provider, uint256 cum) internal view returns (bool) {
        (,, uint128 red,, uint256 avail) = meter.getChannel(client, provider);
        return cum > red && cum - red <= avail;
    }

    // ------------------------------------------------------------------
    // F1: a withdrawal armed with dust never expires and sweeps later deposits with ZERO notice
    // ------------------------------------------------------------------
    /// v2 regression for F1: an armed (even matured) withdrawal blocks new deposits, so a later deposit can never
    /// leave without a full notice period.
    function test_V2_ArmedWithdrawal_CannotSweepLaterDeposit() public {
        _deposit(alice, bob, 1);
        vm.prank(alice);
        meter.requestWithdraw(bob);
        vm.warp(block.timestamp + 30 days);

        vm.prank(alice);
        vm.expectRevert(UsdcMeter.WithdrawAlreadyPending.selector);
        meter.deposit{value: 10 ether}(bob);

        // the only way to add funds: cancel, deposit, and a NEW request restarts the full notice
        vm.prank(alice);
        meter.cancelWithdraw(bob);
        _deposit(alice, bob, 10 ether);
        uint256 cum = 4 ether;
        bytes memory sig = _sign(alicePk, alice, bob, cum);
        vm.prank(alice);
        meter.requestWithdraw(bob);
        vm.prank(alice);
        vm.expectRevert(UsdcMeter.TooEarlyToWithdraw.selector);
        meter.completeWithdraw(bob);

        meter.redeem(alice, bob, cum, sig); // provider redeems during the notice
        assertEq(bob.balance, 4 ether, "provider paid for the calls it served");

        vm.warp(block.timestamp + NOTICE);
        uint256 before = alice.balance;
        vm.prank(alice);
        meter.completeWithdraw(bob);
        assertEq(alice.balance - before, 6 ether + 1, "client gets exactly the rest");
        assertEq(address(meter).balance, 0);
    }

    /// Even without dust-arming, the provider's window is [requestWithdraw, readyAt); at readyAt the client
    /// can complete first in the same block. Vouchers signed during the notice that are not redeemed in time are lost.
    function test_PoC_NoticeBoundary_ClientCompletesFirstAtReadyAt() public {
        _deposit(alice, bob, 1 ether);
        vm.prank(alice);
        meter.requestWithdraw(bob);
        (,,, uint64 readyAt,) = meter.getChannel(alice, bob);

        bytes memory sig = _sign(alicePk, alice, bob, 0.5 ether); // signed during the notice, provider serves
        vm.warp(readyAt); // exactly readyAt
        vm.prank(alice);
        meter.completeWithdraw(bob);
        vm.expectRevert(UsdcMeter.NoPayout.selector);
        meter.redeem(alice, bob, 0.5 ether, sig);
    }

    // ------------------------------------------------------------------
    // F3: on-chain verifier rejects high-s / v in {0,1} / 64-byte compact forms of a VALID signature by the client
    // (off-chain verifiers in the app and python example accept them - see review/offchain/)
    // ------------------------------------------------------------------
    function test_PoC_NonCanonicalButValidSignatureForms_RejectedOnChain() public {
        _deposit(alice, bob, 1 ether);
        uint256 cum = 0.1 ether;
        bytes32 digest = meter.voucherDigest(alice, bob, cum);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(alicePk, digest);

        // high-s twin: same key, same digest, recovers to alice with raw ecrecover
        bytes32 sHigh = bytes32(SECP_N - uint256(s));
        uint8 vHigh = v == 27 ? 28 : 27;
        assertEq(ecrecover(digest, vHigh, r, sHigh), alice, "high-s twin is a valid alice signature");
        vm.expectRevert(abi.encodeWithSelector(UsdcMeter.InvalidSigner.selector, address(0)));
        meter.redeem(alice, bob, cum, abi.encodePacked(r, sHigh, vHigh));

        // yParity encoding (v = 0/1), as some wallets / libraries return
        vm.expectRevert(abi.encodeWithSelector(UsdcMeter.InvalidSigner.selector, address(0)));
        meter.redeem(alice, bob, cum, abi.encodePacked(r, s, uint8(v - 27)));

        // EIP-2098 compact (64 bytes)
        bytes32 vs = bytes32(uint256(s) | (uint256(v - 27) << 255));
        vm.expectRevert(abi.encodeWithSelector(UsdcMeter.InvalidSigner.selector, address(0)));
        meter.redeem(alice, bob, cum, abi.encodePacked(r, vs));

        // the provider CAN recover by normalising to (r, low-s, 27/28) - if its tooling knows to
        meter.redeem(alice, bob, cum, abi.encodePacked(r, s, v));
        assertEq(bob.balance, cum);
    }

    // ------------------------------------------------------------------
    // F4 (design note): vouchers never expire and there is no channel epoch; a stale voucher whose cumulative
    // exceeds `redeemed` is paid out of any later deposit, by anyone, with no new service.
    // ------------------------------------------------------------------
    function test_PoC_StaleVoucherDrainsLaterDeposit() public {
        _deposit(alice, bob, 1 ether);
        bytes memory sig = _sign(alicePk, alice, bob, 2 ether); // over-signed (meter_client.py `sign` has no balance check)
        meter.redeem(alice, bob, 2 ether, sig); // pays only 1 (partial)
        (,, uint128 red,, uint256 avail) = meter.getChannel(alice, bob);
        assertEq(red, 1 ether);
        assertEq(avail, 0);

        vm.warp(block.timestamp + 180 days);
        _deposit(alice, bob, 1 ether); // client starts a "new session" months later

        vm.prank(makeAddr("anyone")); // permissionless
        meter.redeem(alice, bob, 2 ether, sig);
        (,,,, avail) = meter.getChannel(alice, bob);
        assertEq(avail, 0, "new deposit fully consumed by the old voucher");
        assertEq(bob.balance, 2 ether);
    }

    // ------------------------------------------------------------------
    // F5 (info): cross-function re-entry into deposit() during the redeem payout; Redeemed is logged AFTER the
    // external call, so indexers see the nested Deposited first. Accounting stays correct.
    // ------------------------------------------------------------------
    /// v2 regression: deposit() is nonReentrant, so a nested deposit during the payout makes the provider's own
    /// redeem fail (TransferFailed) with all state rolled back.
    function test_V2_ReentrantDepositDuringRedeem_Reverts() public {
        ReentrantDepositor prov = new ReentrantDepositor(address(meter), carol);
        _deposit(alice, address(prov), 1 ether);
        bytes memory sig = _sign(alicePk, alice, address(prov), 0.4 ether);

        vm.expectRevert(UsdcMeter.TransferFailed.selector);
        meter.redeem(alice, address(prov), 0.4 ether, sig);

        (,, uint128 red,, uint256 avail) = meter.getChannel(alice, address(prov));
        (uint128 dep,,,,) = meter.getChannel(address(prov), carol);
        assertEq(red, 0);
        assertEq(avail, 1 ether);
        assertEq(dep, 0);
        assertEq(address(meter).balance, 1 ether);
    }

    /// v2 regression: Redeemed is emitted before the native transfer (checks-effects-interactions).
    function test_V2_RedeemedLoggedBeforePayout() public {
        LoggingProvider prov = new LoggingProvider();
        _deposit(alice, address(prov), 1 ether);
        bytes memory sig = _sign(alicePk, alice, address(prov), 0.4 ether);
        vm.recordLogs();
        meter.redeem(alice, address(prov), 0.4 ether, sig);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 2);
        assertEq(logs[0].topics[0], UsdcMeter.Redeemed.selector, "Redeemed first");
        assertEq(logs[1].topics[0], LoggingProvider.Received.selector, "payout hook second");
    }

    // ------------------------------------------------------------------
    // Properties that hold
    // ------------------------------------------------------------------

    /// Studio deploys with CREATE2, so mainnet may reuse the testnet address. chainId in the domain still binds.
    function test_Safe_SameAddressOtherChain_ReplayRejected() public {
        _deposit(alice, bob, 1 ether);
        bytes memory sig = _sign(alicePk, alice, bob, 0.3 ether); // signed on chain 31337
        bytes32 dsBefore = meter.domainSeparator();
        vm.chainId(5042); // same contract address, different chain
        assertTrue(meter.domainSeparator() != dsBefore, "domain separator follows block.chainid");
        vm.expectPartialRevert(UsdcMeter.InvalidSigner.selector);
        meter.redeem(alice, bob, 0.3 ether, sig);
    }

    function test_Safe_OtherDeployment_ReplayRejected() public {
        UsdcMeter meter2 = new UsdcMeter(NOTICE);
        vm.prank(alice);
        meter2.deposit{value: 1 ether}(bob);
        bytes memory sig = _sign(alicePk, alice, bob, 0.3 ether); // for `meter`
        vm.expectPartialRevert(UsdcMeter.InvalidSigner.selector);
        meter2.redeem(alice, bob, 0.3 ether, sig);
    }

    function test_Safe_CrossChannelReplayRejected() public {
        _deposit(alice, bob, 1 ether);
        _deposit(alice, carol, 1 ether);
        vm.deal(bob, 1 ether);
        bytes memory sig = _sign(alicePk, alice, bob, 0.3 ether);
        // same client, other provider
        vm.expectPartialRevert(UsdcMeter.InvalidSigner.selector);
        meter.redeem(alice, carol, 0.3 ether, sig);
        // swapped roles
        vm.expectPartialRevert(UsdcMeter.InvalidSigner.selector);
        meter.redeem(bob, alice, 0.3 ether, sig);
    }

    function test_Safe_ZeroClientAndGarbageSignatures() public {
        bytes memory zeros = new bytes(65);
        vm.expectRevert(abi.encodeWithSelector(UsdcMeter.InvalidSigner.selector, address(0)));
        meter.redeem(address(0), bob, 1, zeros);
        vm.expectRevert(abi.encodeWithSelector(UsdcMeter.InvalidSigner.selector, address(0)));
        meter.redeem(address(0), bob, 1, "");
        vm.expectRevert(UsdcMeter.ZeroProvider.selector);
        meter.redeem(alice, address(0), 1, zeros);
    }

    /// Random op sequences, including the client signing LOWER cumulatives later (device switch) and partial
    /// redemptions: provider income never exceeds the max cumulative ever signed nor deposits - withdrawals,
    /// and the contract balance always equals deposited - withdrawn - paid.
    function testFuzz_Safe_ProviderBoundedBySignedMaxAndFunds(uint256 seed) public {
        uint256 maxSigned;
        uint256 deposited;
        uint256 withdrawnTotal;
        uint256[] memory cums = new uint256[](40);
        bytes[] memory sigs = new bytes[](40);
        uint256 nSigs;

        for (uint256 i = 0; i < 40; i++) {
            uint256 rnd = uint256(keccak256(abi.encode(seed, i)));
            uint256 op = rnd % 6;
            if (op == 0) {
                uint256 amt = 1 + (rnd >> 8) % 5 ether;
                (,,, uint64 ready,) = meter.getChannel(alice, bob);
                if (ready != 0) {
                    vm.prank(alice);
                    vm.expectRevert(UsdcMeter.WithdrawAlreadyPending.selector); // v2: no deposits while pending
                    meter.deposit{value: amt}(bob);
                } else {
                    _deposit(alice, bob, amt);
                    deposited += amt;
                }
            } else if (op == 1) {
                uint256 c = (rnd >> 8) % (maxSigned + 3 ether); // may be below previous vouchers
                cums[nSigs] = c;
                sigs[nSigs] = _sign(alicePk, alice, bob, c);
                nSigs++;
                if (c > maxSigned) maxSigned = c;
            } else if (op == 2 && nSigs > 0) {
                uint256 k = (rnd >> 8) % nSigs;
                try meter.redeem(alice, bob, cums[k], sigs[k]) {} catch {}
            } else if (op == 3) {
                vm.prank(alice);
                try meter.requestWithdraw(bob) {} catch {}
            } else if (op == 4) {
                vm.warp(block.timestamp + (rnd >> 8) % 200);
            } else {
                uint256 b = alice.balance;
                vm.prank(alice);
                try meter.completeWithdraw(bob) {
                    withdrawnTotal += alice.balance - b;
                } catch {}
            }
            assertLe(bob.balance, maxSigned, "provider got more than any signed cumulative");
            assertLe(bob.balance + withdrawnTotal, deposited, "more out than in");
            assertEq(address(meter).balance, deposited - withdrawnTotal - bob.balance, "balance mismatch");
        }
    }
}
