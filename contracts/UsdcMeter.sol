// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title UsdcMeter (v2)
/// @notice Prepaid, one-way metered billing payment channels using native value deposits and EIP-712 vouchers.
/// @dev One channel exists per `(client, provider)` pair, keyed by `keccak256(abi.encode(client, provider))`.
///      Provider rules: stop serving and redeem the latest voucher as soon as `withdrawReadyAt != 0` (pending OR
///      matured; a matured request stays executable until it is completed or cancelled). Deposits are refused while a
///      withdrawal is pending, so the amount that can leave is never larger than what was under notice.
///      Vouchers are lifetime-cumulative per `(client, provider)`: an unredeemed voucher stays redeemable against later
///      deposits. Only EOA ECDSA signatures are accepted (65 bytes, v 27/28, low s; no ERC-1271).
///      USDC sent other than through `deposit()` credits no channel and cannot be recovered.
contract UsdcMeter is EIP712, ReentrancyGuard {
    /// @notice Channel accounting state for a `(client, provider)` pair.
    /// @param deposited Total amount ever deposited by the client.
    /// @param withdrawn Total amount ever withdrawn by the client.
    /// @param redeemed Total cumulative amount redeemed to the provider.
    /// @param withdrawReadyAt Timestamp when a pending withdrawal becomes executable, or `0` when no withdrawal is pending.
    struct Channel {
        uint128 deposited;
        uint128 withdrawn;
        uint128 redeemed;
        uint64 withdrawReadyAt;
    }

    /// @notice Reverts when an expected non-zero value input is zero.
    error ZeroValue();

    /// @notice Reverts when a provider address is zero.
    error ZeroProvider();

    /// @notice Reverts when the client attempts to open a channel to itself.
    error SelfChannel();

    /// @notice Reverts when an amount cannot fit in the contract's bounded storage type.
    error AmountTooLarge();

    /// @notice Reverts when constructor notice period is outside the allowed bounds.
    error InvalidNoticePeriod();

    /// @notice Reverts when a voucher does not increase cumulative redeemed amount.
    error NothingToRedeem();

    /// @notice Reverts when redemption computes a zero payable amount.
    error NoPayout();

    /// @notice Reverts when a native-value transfer fails.
    error TransferFailed();

    /// @notice Reverts when a withdrawal request already exists for the channel.
    error WithdrawAlreadyPending();

    /// @notice Reverts when cancel is requested but no channel withdrawal is pending.
    error NoChannelOrNoPending();

    /// @notice Reverts when complete withdrawal is requested but no withdrawal is pending.
    error NoPendingWithdraw();

    /// @notice Reverts when withdrawal completion is attempted before the notice period matures.
    error TooEarlyToWithdraw();

    /// @notice Reverts when a withdrawal request is made while no funds are currently available.
    error NoAvailableBalance();

    /// @notice Reverts when voucher signature is invalid or not signed by the claimed client.
    /// @param recovered The address recovered from the signature (or address(0) on failure).
    error InvalidSigner(address recovered);

    /// @notice Emitted when a client deposits native value into a provider channel.
    /// @param client Channel client.
    /// @param provider Channel provider.
    /// @param amount Deposit amount.
    /// @param available Channel available balance after deposit.
    event Deposited(address indexed client, address indexed provider, uint256 amount, uint256 available);

    /// @notice Emitted when a voucher is redeemed and value is paid to the provider.
    /// @param client Channel client.
    /// @param provider Channel provider.
    /// @param cumulativeAmount Signed cumulative amount from voucher.
    /// @param paid Amount paid in this redemption.
    /// @param redeemed New cumulative redeemed total after payment.
    event Redeemed(
        address indexed client,
        address indexed provider,
        uint256 cumulativeAmount,
        uint256 paid,
        uint256 redeemed
    );

    /// @notice Emitted when a client starts the withdrawal notice countdown.
    /// @param client Channel client.
    /// @param provider Channel provider.
    /// @param readyAt Timestamp when withdrawal can be completed.
    event WithdrawRequested(address indexed client, address indexed provider, uint64 readyAt);

    /// @notice Emitted when a client cancels a pending withdrawal request.
    /// @param client Channel client.
    /// @param provider Channel provider.
    event WithdrawCancelled(address indexed client, address indexed provider);

    /// @notice Emitted when a client completes withdrawal after notice period.
    /// @param client Channel client.
    /// @param provider Channel provider.
    /// @param amount Amount withdrawn (may be zero if funds were redeemed during notice period).
    event Withdrawn(address indexed client, address indexed provider, uint256 amount);

    /// @notice EIP-712 type hash for vouchers.
    bytes32 public constant VOUCHER_TYPEHASH =
        keccak256("Voucher(address client,address provider,uint256 cumulativeAmount)");

    /// @notice Required waiting period before requested withdrawals can be completed.
    uint64 public immutable noticePeriod;

    /// @notice Channel storage keyed by `keccak256(abi.encode(client, provider))`.
    mapping(bytes32 => Channel) private _channels;

    /// @notice Initializes the contract and sets the immutable withdrawal notice period.
    /// @param noticePeriod_ Required delay between withdrawal request and completion.
    constructor(uint64 noticePeriod_) EIP712("USDC Meter", "1") {
        if (noticePeriod_ < 60 || noticePeriod_ > 30 days) {
            revert InvalidNoticePeriod();
        }

        noticePeriod = noticePeriod_;
    }

    /// @notice Deposits native value into the caller's channel for `provider`.
    /// @dev Reverts with `WithdrawAlreadyPending` while a withdrawal request exists (pending or matured): cancel it
    ///      first; a new request then restarts the full notice period.
    /// @param provider Service provider receiving future redemptions.
    function deposit(address provider) external payable nonReentrant {
        if (msg.value == 0) {
            revert ZeroValue();
        }
        if (provider == address(0)) {
            revert ZeroProvider();
        }
        if (provider == msg.sender) {
            revert SelfChannel();
        }

        bytes32 key = _channelKey(msg.sender, provider);
        Channel storage ch = _channels[key];
        if (ch.withdrawReadyAt != 0) {
            revert WithdrawAlreadyPending();
        }

        uint256 nextDeposited = uint256(ch.deposited) + msg.value;
        if (nextDeposited > type(uint128).max) {
            revert AmountTooLarge();
        }

        ch.deposited = uint128(nextDeposited);

        uint256 available = uint256(ch.deposited) - uint256(ch.withdrawn) - uint256(ch.redeemed);
        emit Deposited(msg.sender, provider, msg.value, available);
    }

    /// @notice Redeems a signed cumulative voucher and pays owed native value to `provider`.
    /// @dev Callable by anyone; payment always routes to `provider`.
    /// @param client Channel client and expected voucher signer.
    /// @param provider Channel provider receiving payment.
    /// @param cumulativeAmount Signed cumulative amount authorized by the client.
    /// @param signature EIP-712 signature over the voucher payload.
    function redeem(address client, address provider, uint256 cumulativeAmount, bytes calldata signature)
        external
        nonReentrant
    {
        if (provider == address(0)) revert ZeroProvider();
        _verifyVoucher(client, provider, cumulativeAmount, signature);

        bytes32 key = _channelKey(client, provider);
        Channel storage ch = _channels[key];

        (uint256 paid, uint256 newRedeemed) = _computePayment(ch, cumulativeAmount);

        ch.redeemed = uint128(newRedeemed);
        emit Redeemed(client, provider, cumulativeAmount, paid, newRedeemed);

        (bool ok,) = provider.call{value: paid}("");
        if (!ok) {
            revert TransferFailed();
        }
    }

    /// @notice Starts the notice period to withdraw currently available channel balance.
    /// @dev While the request exists the provider can still redeem; deposits are refused until it is cancelled or
    ///      completed.
    /// @param provider Channel provider.
    function requestWithdraw(address provider) external {
        bytes32 key = _channelKey(msg.sender, provider);
        Channel storage ch = _channels[key];

        uint256 available = uint256(ch.deposited) - uint256(ch.withdrawn) - uint256(ch.redeemed);
        if (available == 0) {
            revert NoAvailableBalance();
        }
        if (ch.withdrawReadyAt != 0) {
            revert WithdrawAlreadyPending();
        }

        ch.withdrawReadyAt = uint64(block.timestamp + noticePeriod);

        emit WithdrawRequested(msg.sender, provider, ch.withdrawReadyAt);
    }

    /// @notice Cancels a pending withdrawal request for caller's channel with `provider`.
    /// @param provider Channel provider.
    function cancelWithdraw(address provider) external {
        bytes32 key = _channelKey(msg.sender, provider);
        Channel storage ch = _channels[key];

        if (ch.withdrawReadyAt == 0) {
            revert NoChannelOrNoPending();
        }

        ch.withdrawReadyAt = 0;

        emit WithdrawCancelled(msg.sender, provider);
    }

    /// @notice Completes a previously requested withdrawal after notice period expires.
    /// @param provider Channel provider.
    function completeWithdraw(address provider) external nonReentrant {
        bytes32 key = _channelKey(msg.sender, provider);
        Channel storage ch = _channels[key];

        uint64 readyAt = ch.withdrawReadyAt;
        if (readyAt == 0) {
            revert NoPendingWithdraw();
        }
        if (block.timestamp < readyAt) {
            revert TooEarlyToWithdraw();
        }

        uint256 available = uint256(ch.deposited) - uint256(ch.withdrawn) - uint256(ch.redeemed);

        uint256 nextWithdrawn = uint256(ch.withdrawn) + available;
        if (nextWithdrawn > type(uint128).max) {
            revert AmountTooLarge();
        }
        ch.withdrawn = uint128(nextWithdrawn);
        ch.withdrawReadyAt = 0;
        emit Withdrawn(msg.sender, provider, available);

        if (available > 0) {
            (bool ok,) = msg.sender.call{value: available}("");
            if (!ok) {
                revert TransferFailed();
            }
        }
    }

    /// @notice Returns the full channel state and currently available balance.
    /// @param client Channel client.
    /// @param provider Channel provider.
    /// @return deposited Total deposited amount.
    /// @return withdrawn Total withdrawn amount.
    /// @return redeemed Total redeemed amount.
    /// @return withdrawReadyAt Pending withdrawal maturity timestamp, or `0` if none.
    /// @return available Current available balance (`deposited - withdrawn - redeemed`).
    function getChannel(address client, address provider)
        external
        view
        returns (uint128 deposited, uint128 withdrawn, uint128 redeemed, uint64 withdrawReadyAt, uint256 available)
    {
        Channel storage ch = _channels[_channelKey(client, provider)];

        deposited = ch.deposited;
        withdrawn = ch.withdrawn;
        redeemed = ch.redeemed;
        withdrawReadyAt = ch.withdrawReadyAt;
        available = uint256(deposited) - uint256(withdrawn) - uint256(redeemed);
    }

    /// @notice Returns the EIP-712 digest for a voucher payload.
    /// @param client Voucher client signer.
    /// @param provider Voucher provider recipient.
    /// @param cumulativeAmount Voucher cumulative amount.
    /// @return Digest to be signed or verified with ECDSA.
    function voucherDigest(address client, address provider, uint256 cumulativeAmount) external view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(VOUCHER_TYPEHASH, client, provider, cumulativeAmount));
        return _hashTypedDataV4(structHash);
    }

    /// @notice Returns the EIP-712 domain separator used by this contract.
    /// @return Domain separator.
    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    /// @notice Verifies an EIP-712 voucher signature.
    /// @dev Reverts with `InvalidSigner` if the signature is invalid or not from `client`.
    /// @param client Expected signer.
    /// @param provider Voucher provider field.
    /// @param cumulativeAmount Voucher amount field.
    /// @param signature EIP-712 signature bytes.
    function _verifyVoucher(
        address client,
        address provider,
        uint256 cumulativeAmount,
        bytes calldata signature
    ) private view {
        bytes32 structHash = keccak256(abi.encode(VOUCHER_TYPEHASH, client, provider, cumulativeAmount));
        bytes32 digest = _hashTypedDataV4(structHash);
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, signature);
        if (err != ECDSA.RecoverError.NoError || recovered != client) {
            revert InvalidSigner(recovered);
        }
    }

    /// @notice Computes the amount to pay and the new cumulative redeemed value.
    /// @dev Reverts with `NothingToRedeem`, `NoPayout`, or `AmountTooLarge` as appropriate.
    /// @param ch The channel storage slot.
    /// @param cumulativeAmount Voucher cumulative amount.
    /// @return paid Amount to pay in this redemption.
    /// @return newRedeemed New cumulative redeemed total after this payment.
    function _computePayment(Channel storage ch, uint256 cumulativeAmount)
        private
        view
        returns (uint256 paid, uint256 newRedeemed)
    {
        uint256 redeemedSoFar = uint256(ch.redeemed);
        if (cumulativeAmount <= redeemedSoFar) {
            revert NothingToRedeem();
        }
        uint256 owed = cumulativeAmount - redeemedSoFar;
        uint256 available = uint256(ch.deposited) - uint256(ch.withdrawn) - redeemedSoFar;
        paid = owed < available ? owed : available;
        if (paid == 0) {
            revert NoPayout();
        }
        newRedeemed = redeemedSoFar + paid;
        if (newRedeemed > type(uint128).max) {
            revert AmountTooLarge();
        }
    }

    /// @notice Computes the storage key for a `(client, provider)` channel pair.
    /// @param client Channel client.
    /// @param provider Channel provider.
    /// @return key Mapping key for `_channels`.
    function _channelKey(address client, address provider) private pure returns (bytes32 key) {
        key = keccak256(abi.encode(client, provider));
    }
}
