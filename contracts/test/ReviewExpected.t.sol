// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {UsdcMeter} from "../UsdcMeter.sol";

/// Each test asserts the property a provider/client would EXPECT from the README ("the client can start a withdrawal
/// of the unused balance, which completes after a notice period, so the provider can redeem outstanding vouchers
/// first"). On v1 F1 FAILED (the finding); v2 makes it pass. F4 is a documented design property (no channel epoch).
contract UsdcMeterExpectedBehaviourTest is Test {
    UsdcMeter internal meter;
    address internal alice;
    uint256 internal alicePk;
    address internal bob;

    function setUp() public {
        meter = new UsdcMeter(120);
        (alice, alicePk) = makeAddrAndKey("alice");
        bob = makeAddr("bob");
        vm.deal(alice, 100 ether);
    }

    function _sign(uint256 cum) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(alicePk, meter.voucherDigest(alice, bob, cum));
        return abi.encodePacked(r, s, v);
    }

    /// F1: funds deposited AFTER a withdrawal matured must still get a notice period before they can leave.
    function test_Expected_F1_LaterDepositGetsNoticePeriod() public {
        vm.prank(alice);
        meter.deposit{value: 1}(bob);
        vm.prank(alice);
        meter.requestWithdraw(bob);
        vm.warp(block.timestamp + 30 days);

        // v2: the deposit is refused while the request exists (pending or matured)
        vm.prank(alice);
        vm.expectRevert(UsdcMeter.WithdrawAlreadyPending.selector);
        meter.deposit{value: 10 ether}(bob);

        // a client that wants to add funds must cancel; the new deposit then gets a full notice period
        vm.prank(alice);
        meter.cancelWithdraw(bob);
        vm.prank(alice);
        meter.deposit{value: 10 ether}(bob);
        bytes memory sig = _sign(4 ether);
        vm.prank(alice);
        meter.requestWithdraw(bob);

        uint256 before = alice.balance;
        vm.prank(alice);
        try meter.completeWithdraw(bob) {} catch {}
        assertLe(alice.balance - before, 1, "EXPECTED: only the 1 wei that was under notice can leave now");

        meter.redeem(alice, bob, 4 ether, sig);
        assertEq(bob.balance, 4 ether, "EXPECTED: provider is paid for the calls it served");
    }

    /// F4 (design): a deposit made after the channel was fully settled should not be consumed by an old voucher
    /// without new service. Fails by design today (no channel epoch / voucher expiry).
    function test_Documented_F4_StaleVoucherCarriesOver() public {
        vm.prank(alice);
        meter.deposit{value: 1 ether}(bob);
        bytes memory sig = _sign(2 ether);
        meter.redeem(alice, bob, 2 ether, sig); // pays 1 (partial)

        vm.warp(block.timestamp + 180 days);
        vm.prank(alice);
        meter.deposit{value: 1 ether}(bob);

        // DOCUMENTED (README / SECURITY.md): vouchers are lifetime-cumulative, so the unpaid part of an old voucher
        // (the client did sign for it) is paid from the new deposit. Clients must not sign beyond their balance.
        meter.redeem(alice, bob, 2 ether, sig);
        (,,,, uint256 avail) = meter.getChannel(alice, bob);
        assertEq(avail, 0, "old voucher's unpaid remainder is settled from the later deposit");
    }
}
