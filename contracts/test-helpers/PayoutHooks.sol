// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IUsdcMeterDeposit {
    function deposit(address provider) external payable;
}

/// @dev Provider contract that forwards a redeem payout as a nested deposit() (blocked by nonReentrant in v2).
contract ReentrantDepositor {
    IUsdcMeterDeposit internal immutable meter;
    address internal immutable other;

    constructor(address meter_, address other_) {
        meter = IUsdcMeterDeposit(meter_);
        other = other_;
    }

    receive() external payable {
        meter.deposit{value: msg.value}(other);
    }
}

/// @dev Provider contract that logs every payout it receives (used to check event order).
contract LoggingProvider {
    event Received(uint256 amount);

    receive() external payable {
        emit Received(msg.value);
    }
}
