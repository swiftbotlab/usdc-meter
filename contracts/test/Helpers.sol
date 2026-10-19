// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {UsdcMeter} from "../UsdcMeter.sol";

/// Independent EIP-712 implementation (does NOT call meter.voucherDigest), so signatures in these
/// tests check the contract against the spec rather than against itself.
abstract contract VoucherSigner is Test {
    bytes32 internal constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 internal constant V_TYPEHASH = keccak256("Voucher(address client,address provider,uint256 cumulativeAmount)");
    uint256 internal constant SECP256K1_N =
        0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;

    function _domain(address meter, uint256 chainId) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(DOMAIN_TYPEHASH, keccak256(bytes("USDC Meter")), keccak256(bytes("1")), chainId, meter)
        );
    }

    function _digest(address meter, uint256 chainId, address client, address provider, uint256 amt)
        internal
        pure
        returns (bytes32)
    {
        bytes32 sh = keccak256(abi.encode(V_TYPEHASH, client, provider, amt));
        return keccak256(abi.encodePacked("\x19\x01", _domain(meter, chainId), sh));
    }

    function _signFor(uint256 pk, address meter, uint256 chainId, address client, address provider, uint256 amt)
        internal
        pure
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, _digest(meter, chainId, client, provider, amt));
        return abi.encodePacked(r, s, v);
    }

    function _sign(uint256 pk, address meter, address client, address provider, uint256 amt)
        internal
        view
        returns (bytes memory)
    {
        return _signFor(pk, meter, block.chainid, client, provider, amt);
    }

    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }
}

/// A client or provider that can refuse native USDC.
contract Rejector {
    UsdcMeter internal immutable m;
    bool public reject = true;

    constructor(UsdcMeter m_) {
        m = m_;
    }

    function setReject(bool r) external {
        reject = r;
    }

    function deposit(address provider) external payable {
        m.deposit{value: msg.value}(provider);
    }

    function requestWithdraw(address provider) external {
        m.requestWithdraw(provider);
    }

    function completeWithdraw(address provider) external {
        m.completeWithdraw(provider);
    }

    receive() external payable {
        if (reject) revert("rejecting");
    }
}

/// A provider contract that does something on payout.
/// mode 1: re-enter redeem with a stored voucher; mode 2: completeWithdraw on its OWN client channel;
/// mode 3: forward the payout as a deposit into its own client channel (deposit is not nonReentrant);
/// mode 4: burn all gas.
contract HookProvider {
    UsdcMeter internal immutable m;
    uint8 public mode;
    address public vClient;
    uint256 public vAmount;
    bytes public vSig;
    address public otherProvider;

    constructor(UsdcMeter m_) {
        m = m_;
    }

    function arm(uint8 mode_, address c, uint256 a, bytes calldata s, address other) external {
        mode = mode_;
        vClient = c;
        vAmount = a;
        vSig = s;
        otherProvider = other;
    }

    function depositAsClient(address provider) external payable {
        m.deposit{value: msg.value}(provider);
    }

    function requestWithdrawAsClient(address provider) external {
        m.requestWithdraw(provider);
    }

    receive() external payable {
        if (mode == 1) {
            m.redeem(vClient, address(this), vAmount, vSig);
        } else if (mode == 2) {
            m.completeWithdraw(otherProvider);
        } else if (mode == 3) {
            m.deposit{value: msg.value}(otherProvider);
        } else if (mode == 4) {
            while (true) {}
        }
    }
}
