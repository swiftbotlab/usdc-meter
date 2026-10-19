// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @dev Malicious provider that attempts re-entrancy on receive().
/// The attack vector is set before the first call; the contract tries to
/// re-enter on the first ETH transfer it receives.
interface IUsdcMeterReentrant {
    function redeem(address client, address provider, uint256 cumulativeAmount, bytes calldata signature) external;
    function completeWithdraw(address provider) external;
}

contract MaliciousProvider {
    IUsdcMeterReentrant public meter;
    address public client;
    uint256 public cumulativeAmount;
    bytes public signature;
    bool public attackViaRedeem; // true = attack via redeem, false = via completeWithdraw
    bool public attacked;

    constructor(address meter_) {
        meter = IUsdcMeterReentrant(meter_);
    }

    function setRedeemAttack(address client_, uint256 cumulativeAmount_, bytes calldata sig_) external {
        client = client_;
        cumulativeAmount = cumulativeAmount_;
        signature = sig_;
        attackViaRedeem = true;
        attacked = false;
    }

    function setWithdrawAttack() external {
        attackViaRedeem = false;
        attacked = false;
    }

    receive() external payable {
        if (!attacked) {
            attacked = true;
            if (attackViaRedeem) {
                // try to re-enter redeem
                meter.redeem(client, address(this), cumulativeAmount, signature);
            } else {
                // try to re-enter completeWithdraw
                meter.completeWithdraw(address(this));
            }
        }
    }
}
