# Security

## Scope
`contracts/UsdcMeter.sol` holds client deposits in native USDC on Arc. The app (`src/`) and the Python example never
hold keys: the app signs through the user's wallet, the example reads keys from environment variables.

## Design choices that matter
- Vouchers are EIP-712 typed data bound to `chainId` and the contract address; cumulative amounts make replays pay nothing.
- EOA signatures only (OpenZeppelin `ECDSA.tryRecover`: 65 bytes, v 27/28, low s). No ERC-1271, so a contract wallet
  cannot invalidate vouchers. Smart-contract-account clients can't produce redeemable vouchers (the app warns).
- v2: `deposit()` reverts while a withdrawal is pending or matured, so the amount that can leave at completion was under
  notice for the full period. A client that wants to add funds must cancel; a new request restarts the notice.
- `deposit`, `redeem` and `completeWithdraw` are `nonReentrant`; state and events are written before the native
  transfer; a failed transfer reverts (and only blocks the recipient's own payout).
- Amounts are `uint128` with explicit overflow checks; `noticePeriod` is immutable (60 s to 30 days).
- No owner, no admin functions, no upgradeability, no fees.

## Provider rules (enforced by `src/voucher-check.ts` and `examples/python/meter_client.py verify`)
- Serve a call only if: the voucher pays you, the signature is canonical and recovers to the client, the channel's
  `withdrawReadyAt == 0`, `cumulative >= max(last accepted, redeemed) + price`, and `cumulative - redeemed <= available`.
- When `withdrawReadyAt != 0` (pending or matured): stop serving and redeem the newest voucher immediately. A matured
  request stays executable until the client completes or cancels it.

## Known limits (documented, by design)
- Vouchers are lifetime-cumulative per `(client, provider)`: an unredeemed voucher stays redeemable against later
  deposits, also after a full withdrawal. Clients should never sign beyond their balance (the app and the Python
  `sign` command refuse to).
- At `withdrawReadyAt` the client may complete in the same block as a provider's redeem; providers must redeem during
  the notice, not at its last second.
- USDC sent to the contract other than through `deposit()` (e.g. via the ERC-20 interface) credits no channel and is
  stuck; there is intentionally no sweep (no owner).
- The Studio preview hooks (`src/tracing.ts`, `src/console-capture.ts`) are loaded only when the page is framed by
  https://studio.arc.io; the public build never runs them, and refuses to render inside any other frame. Netlify also
  sends `X-Frame-Options: DENY` and `frame-ancestors 'none'`.
- Not audited by a third party. Reviewed by Arc Studio's audit pipeline (two auditors, Slither), an external review of
  v1 (findings fixed or documented in v2, see CHANGES.md), and 89 Foundry tests including fuzz and invariant suites.

## Reporting
Open a GitHub issue without exploit details and ask for a private contact, or use GitHub's private vulnerability
reporting on this repository.
