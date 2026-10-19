# Changes

## v2 (2026-10-19): external review fixes

An external review of v1 (contract PoCs in Foundry plus an end-to-end test of the live app) reported one high, five
medium and several low findings. Arc Studio's daily usage limit was exhausted (`budget_exceeded`), so the fixes were made
by hand in the Studio workspace. The v2 prompt for Studio's Smart Contract mode is ready to re-run when the limit resets.

### Contract (`contracts/UsdcMeter.sol`)
- **High, fixed:** a matured withdrawal request never expired and `completeWithdraw` paid whatever was available at
  completion, so a client could arm a request with dust, wait, deposit, use the service and leave in the same block.
  `deposit()` now reverts `WithdrawAlreadyPending` while a request exists (pending or matured).
- **Low, fixed:** `Redeemed` / `Withdrawn` are emitted before the native transfer (checks-effects-interactions), and
  `deposit()` is `nonReentrant` (a nested deposit from a payout hook now fails that payout).
- **Documented (no logic change):** provider rules, lifetime-cumulative vouchers, EOA-only signatures, stray transfers.
- Storage layout, EIP-712 domain, voucher type, function signatures, errors and events are unchanged.
- Tests: Studio's suite updated (the "deposit does not cancel a pending withdrawal" test became
  `test_Deposit_RevertsWhileWithdrawPending`; new `test_ArmedWithdrawal_CannotSweepLaterDeposit`,
  `test_Reentrancy_DepositDuringRedeem_Reverts`, `test_Events_EmittedBeforePayout`), plus the independent suite and the
  review regressions: 89 tests pass on v2; 13 of them fail on v1 (positive control).
- Deployed to Arc Testnet at `0x4c72e9de7e19b8b752f652ffcef7c99abf0a6d84` (block 67934662), source verified (full match).

### App
- **Medium, fixed:** the provider's withdrawal banner is now driven by `getChannel().withdrawReadyAt` (polled every
  5 s) instead of a one-off 500-block log scan; it shows a red warning for both pending and matured requests and clears
  when the request is cancelled or completed. The channel card shows "Client can withdraw now" to the provider.
- **Medium, fixed:** the provider view rejects a voucher whose client is not the selected channel's client, and
  redeems with the voucher's own client/provider. Auto-loaded vouchers go through the same validation (corrupt local
  storage can no longer blank the page).
- **Medium, fixed:** Demo API: synchronous in-flight guard (a double click signs once), button disabled while signing,
  unique log keys, the simulated provider requires `cumulative >= max(last accepted, redeemed) + price`, refuses calls
  while a withdrawal is pending (nothing is signed), and checks against fresh channel state.
- **Medium, fixed:** Studio's tracing / console-capture hooks are loaded only inside the Studio preview (framed by
  https://studio.arc.io, origin-checked); the public build refuses to render inside any other frame; Netlify sends
  `X-Frame-Options: DENY` + `frame-ancestors 'none'`.
- **Low, fixed:** signatures must be canonical (65 bytes, v 27/28, low s) before a voucher is accepted (shared
  `src/voucher-check.ts`). Deposits are disabled while a withdrawal is pending, and a warning shows for smart-contract
  wallets. Price per call is remembered across tab switches.
- Network: `DEFAULT_NETWORK` one-line switch in `src/usdcmeter-config.ts`, `?network=testnet|mainnet` override and a
  header toggle; mainnet entry ready for the deployed address.

### Python example (`examples/python/meter_client.py`)
- **Medium, fixed:** `verify voucher.json PRICE` checks the voucher pays the caller's own provider address, keeps the
  highest accepted cumulative per channel (no replays), requires `+ price`, refuses while `withdrawReadyAt != 0`, and
  rejects non-canonical signatures. `sign` refuses to sign beyond the prepaid balance or while a withdrawal is pending.

### Considered and not changed
- Channel epoch / voucher expiry: would change the voucher type; lifetime-cumulative accounting is documented instead.
- Recording the requested amount / expiring matured requests: unnecessary once deposits are blocked while a request
  exists (the amount under notice can only shrink, through redeems).
- Sweep for stray transfers: would need an owner or a global counter; documented instead.

## v1 follow-ups made by hand after the Arc Studio session

Studio's daily usage limit interrupted the last v1 fix round after it had updated `DepositForm.tsx` and
`WithdrawControls.tsx`. These follow-ups were made by hand:

- `src/components/ProviderView.tsx`: the redeem-confirmed toast and refresh ran during render, which looped and
  blanked the page after the first redeem. They now run in an effect, once per transaction hash.
- `src/components/ClientView.tsx`: confirmed deposits and withdrawals refresh the channel card and the activity feed.
- `src/components/EventFeed.tsx`: event scans read a fresh block number (`cacheTime: 0`).
- `src/components/WithdrawControls.tsx`: a one-second clock while a withdrawal is pending, so "Complete withdrawal"
  enables as soon as the notice period ends.

## v1 testnet walkthroughs (Studio deployment `0xeca961579bcf4978d083a0c3a72788a2def6e61a`)

Scripted: deposit 1.00 [`0x2039f98f…`](https://explorer.testnet.arc.io/tx/0x2039f98fb2498e0b9f3ead905b8031e442a3cf666bcb7b265f3fa758e5938452),
redeem latest 0.15 [`0x07629b1a…`](https://explorer.testnet.arc.io/tx/0x07629b1a60c3323b4bb67428f7433cac9d4cfeb63702de0e360f5b0fc8bcf25a),
request withdraw [`0xe3941259…`](https://explorer.testnet.arc.io/tx/0xe394125937410be7ec2d0018d468fc0d1c42bf03dc16cd1b859947b9e2cc353a),
redeem 0.05 during notice [`0x69f13464…`](https://explorer.testnet.arc.io/tx/0x69f13464443f098f749f214ca012eb0ef4785e8d61b877164384fa5db53be936),
complete 0.80 [`0x8363439e…`](https://explorer.testnet.arc.io/tx/0x8363439e10f08c5407a38696e585a44608376de1fefaf6db8e8e7b88095c33ba).

In the app: deposit 0.60 [`0x163c5dd0…`](https://explorer.testnet.arc.io/tx/0x163c5dd009d4d4ad87fde686dfa90befaab4dbf5135a1ace3345512c528a3dd5),
redeem 0.15 [`0x9ed22c76…`](https://explorer.testnet.arc.io/tx/0x9ed22c761c3e74c07570b5815b62cba67de8600e5c9c1f25d88545f04ffc6866),
request [`0x5e03af53…`](https://explorer.testnet.arc.io/tx/0x5e03af53450bc766eb06db8eabb302c98845b1f93b3dfc1f5685c43c055dd236),
redeem 0.01 [`0x588dbc83…`](https://explorer.testnet.arc.io/tx/0x588dbc83d190415bd46025e8f459c11be5df051499c2c28b5ade6ff463d84251),
complete 0.84 [`0x7ae734d7…`](https://explorer.testnet.arc.io/tx/0x7ae734d71c951f420b37e4ae373835e795541e471335aa54805a46d3e1e47a2f).
