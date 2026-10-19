# Security

## Scope
`contracts/UsdcMeter.sol` holds client deposits in native USDC on Arc. The app (`src/`) and the Python example
never hold keys: the app signs through the user's wallet, the example reads keys from environment variables.

## Design choices that matter
- Vouchers are EIP-712 typed data bound to `chainId` and the contract address; cumulative amounts make replays pay nothing.
- EOA signatures only (`ECDSA.tryRecover`, high-s rejected). No ERC-1271, so a contract wallet cannot invalidate vouchers.
- `redeem` and `completeWithdraw` are `nonReentrant`, update state before the native transfer, and revert on a failed transfer.
- Amounts are stored as `uint128` with explicit overflow checks; `noticePeriod` is immutable (60 s to 30 days).
- No owner, no admin functions, no upgradeability, no fees.

## Known limits
- A provider must redeem outstanding vouchers before a requested withdrawal completes. The app shows a banner when a
  withdrawal is pending; a production provider should watch `WithdrawRequested` events.
- A deposit made while a withdrawal is pending is included in that withdrawal when it completes.
- Not audited by a third party. Reviewed by Arc Studio's audit pipeline (two auditors, Slither) and tested with Foundry
  (unit, fuzz, reentrancy, 128,000-call invariant run).

## Reporting
Open a GitHub issue without exploit details and ask for a private contact, or use GitHub's private vulnerability reporting
on this repository.
