# USDC Meter

**by Swift Bot Labs**

Prepaid metered billing in USDC on Arc. One deposit, a signed voucher per API call, settle whenever you like.

Paying per API call on-chain normally means one transaction per call: fees and latency on every request. Invoices and subscriptions avoid that but bring credit risk and manual billing. USDC Meter sits in between. A client deposits USDC once into a channel for a provider. Every call carries an off-chain EIP-712 voucher that states the **cumulative** amount the client owes so far. The provider redeems the latest voucher whenever it likes and the contract pays only the difference over what was already redeemed. It is a minimal one-way payment channel, built for services or agents paying each other per call.

- Live app: https://swiftbotlab.github.io/usdc-meter/ (GitHub Pages, built from this repo) and https://usdc-meter.netlify.app (Netlify).
  Both serve Arc Testnet by default; `?network=mainnet` switches to Arc mainnet (also available as a toggle in the header).
- Contract: [`contracts/UsdcMeter.sol`](contracts/UsdcMeter.sol) (v2, about 320 lines, OpenZeppelin EIP712 + ECDSA + ReentrancyGuard)
- Built in [Arc Studio](https://studio.arc.io): Smart Contract mode for the contract (writer, two auditors, Slither, Foundry tests, deploy), Build mode for the app

---

## How it works

```
Client                         UsdcMeter                        Provider
  |-- deposit(provider) {value} -->|                                 |
  |                                |  channel(client, provider)      |
  |== API call #1 + voucher(0.02) ==================================>|  check, serve
  |== API call #2 + voucher(0.04) ==================================>|  check, serve
  |   ...                                                            |
  |                                |<--- redeem(latest voucher) -----|  pays the delta
  |-- requestWithdraw(provider) -->|  notice period starts           |  sees withdrawReadyAt != 0:
  |                                |<--- redeem(newest voucher) -----|  stops serving, redeems now
  |-- completeWithdraw(provider) ->|  (after notice) client gets the rest
```

Calls cost nothing on-chain. A billing cycle is one deposit, one or more redemptions at the provider's pace, and optionally one withdrawal, however many calls happen in between.

### Vouchers

A voucher is EIP-712 typed data signed by the client's key:

```
Voucher(address client, address provider, uint256 cumulativeAmount)
domain = { name: "USDC Meter", version: "1", chainId, verifyingContract }
```

- **Cumulative, not per-call.** Each voucher states the total owed so far. The provider only needs to keep the latest one; replaying an old voucher pays nothing (`cumulativeAmount <= redeemed` reverts with `NothingToRedeem`).
- **Bound to one chain and one contract** through the EIP-712 domain, so a voucher can't be replayed on another deployment or network.
- **EOA signatures only.** OpenZeppelin `ECDSA.tryRecover`: exactly 65 bytes, `v` 27/28, low `s`. ERC-1271 contract signatures are deliberately not accepted (a contract wallet could change its logic and invalidate vouchers the provider already holds), so **the client must be an EOA** (EIP-7702 delegated EOAs work; the app warns if the connected wallet is a smart-contract account).
- **Partial redemption.** If a voucher asks for more than the channel holds, the provider receives what is available and the rest stays claimable with the same voucher after a top-up.
- **Lifetime-cumulative.** Amounts never reset for a `(client, provider)` pair, so an unredeemed voucher stays redeemable against later deposits, even after a full withdrawal. The client did sign for it; never sign beyond your balance (the app and `meter_client.py sign` refuse to).
- **Permissionless submission.** Anyone may submit `redeem` (for example a relayer that pays the gas); the funds always go to the provider named in the voucher.

### Channel state

| Field | Meaning |
|---|---|
| `deposited` | total the client ever deposited |
| `withdrawn` | total the client ever withdrew |
| `redeemed` | total paid to the provider |
| `withdrawReadyAt` | 0, or the time a requested withdrawal can complete |
| `available` | `deposited - withdrawn - redeemed` |

| Status | Condition | Client view | Provider view |
|---|---|---|---|
| Open | `withdrawReadyAt == 0` | deposit, call, withdraw | serve calls |
| Withdrawal pending | `now < withdrawReadyAt` | calls refused, deposits blocked | red banner: stop serving, redeem now |
| Matured | `withdrawReadyAt <= now` | complete (or cancel) | red banner: client can leave at any moment |

### Functions

| Function | Caller | Effect |
|---|---|---|
| `deposit(provider)` payable | client | adds `msg.value` to the channel; **reverts `WithdrawAlreadyPending` while a withdrawal is pending or matured** |
| `redeem(client, provider, cumulativeAmount, signature)` | anyone | pays `min(cumulativeAmount - redeemed, available)` to the provider |
| `requestWithdraw(provider)` | client | starts the notice period (`noticePeriod`, immutable, 60 s to 30 days) |
| `cancelWithdraw(provider)` | client | clears a pending request (deposits are possible again; a new request restarts the notice) |
| `completeWithdraw(provider)` | client | after the notice period, sends everything still available to the client |
| `getChannel`, `voucherDigest`, `domainSeparator`, `VOUCHER_TYPEHASH`, `noticePeriod` | view | helpers for apps and services |

Events: `Deposited`, `Redeemed`, `WithdrawRequested`, `WithdrawCancelled`, `Withdrawn` (emitted before the payout transfer).

### Provider checklist (before serving each call)

`src/voucher-check.ts` (app) and `examples/python/meter_client.py verify` (backends) implement exactly this:

1. `voucher.provider` is **my** address, and the signature recovers to `voucher.client` in canonical form (65 bytes, `v` 27/28, low `s`).
2. `getChannel(client, me).withdrawReadyAt == 0`. Anything else means the client started a withdrawal: **stop serving and redeem the newest voucher now** (a matured request lets the client take the rest at any moment).
3. `cumulative >= max(highest cumulative I already accepted, redeemed) + price`: no replays, no free calls. Keep that number per channel on the provider side.
4. `cumulative - redeemed <= available`: the call is prepaid.

### Who carries what risk

- **Client:** the provider can never take more than the client signed for, and never more than the channel holds.
- **Provider:** with the checklist above, exposure is at most the calls served since the provider last looked at the channel. The contract guarantees that what can leave at withdrawal time was under notice for the full period (deposits are blocked while a request exists), so a provider that checks `withdrawReadyAt` well within the notice period (for example every quarter of it, or on every call) and redeems as soon as it sees a request is paid for everything it served. At `withdrawReadyAt` itself the client can complete first, so don't wait for the last block.
- **Payout failures:** payouts use a native `call`. A recipient that rejects native USDC only blocks its own payout, never the other party's.
- **Stray transfers:** USDC sent to the contract other than through `deposit()` (for example through the ERC-20 interface) credits no channel and cannot be recovered.

---

## Arc specifics

- **Native USDC, 18 decimals.** USDC is Arc's gas token. Deposits are `msg.value`, and every amount in the contract, the vouchers and the app has 18 decimals (`parseEther` / `formatEther`). The 6-decimal ERC-20 interface at `0x3600000000000000000000000000000000000000` is not used.
- **Fee floor.** Arc rejects transactions with `maxFeePerGas` below 20 gwei.
- **Log range.** `eth_getLogs` accepts fewer than 10,000 blocks per call; the activity feed pages backwards in 9,000-block chunks from the deployment block.
- **Finality.** Sub-second blocks, so receipts arrive within a second or two and a provider can redeem right after a withdrawal request.

---

## Deployments

| Network | Version | Address | Deploy tx | Notice |
|---|---|---|---|---|
| Arc Testnet (5042002) | v2 | [`0x4c72e9de7e19b8b752f652ffcef7c99abf0a6d84`](https://explorer.testnet.arc.io/address/0x4c72e9de7e19b8b752f652ffcef7c99abf0a6d84) | [`0x926f51dc…`](https://explorer.testnet.arc.io/tx/0x926f51dc0790f172e8bd3d49727fb06fd2776ba5432734e51d5ae5f8f2c4c9ab) | 120 s |
| Arc Mainnet (5042) | v2 | coming soon | | |
| Arc Testnet (5042002) | v1 (superseded) | [`0xeca961579bcf4978d083a0c3a72788a2def6e61a`](https://explorer.testnet.arc.io/address/0xeca961579bcf4978d083a0c3a72788a2def6e61a) | [`0x29280e33…`](https://explorer.testnet.arc.io/tx/0x29280e33cf020862a83e8f633c75fd6f4832c390ebe1c2d4250b30ec122ba444) | 120 s |

v2 testnet source is verified on Blockscout with a **full match** (solc 0.8.28, optimizer 200 runs, EVM `paris`, OpenZeppelin 5.1.0, constructor `noticePeriod = 120`). `forge build` with this repo's `foundry.toml` reproduces Studio's deployed v1 bytecode byte for byte, and the v2 testnet bytecode likewise.

## Testnet walkthrough, v2 (real transactions)

Scripted end-to-end run (fresh client `0x3368…bC85`, fresh provider `0x0C90…8d58`, price 0.02 per call):

| Step | Amount | Tx |
|---|---|---|
| Client deposits | 0.30 | [`0x15b68664…`](https://explorer.testnet.arc.io/tx/0x15b68664b002ad621f48ab1dfcaf392430ffc32cf5620c9c01265bde0e1c4926) |
| 5 API calls: vouchers 0.02 … 0.10 signed off-chain, each checked by the provider | | no transactions |
| Provider redeems only the latest voucher | 0.10 paid | [`0xd73329cf…`](https://explorer.testnet.arc.io/tx/0xd73329cf537a14c4c0a94cfefc9533165161e92547c50d87a83ee3c4757a13e8) |
| Call #6 (voucher 0.12), then the client starts a withdrawal | | [`0x2ce47a00…`](https://explorer.testnet.arc.io/tx/0x2ce47a00e64819bd58dba77f360bb8708b37cb9a20e82837ecb4fa7062fbc4e0) |
| Provider sees `withdrawReadyAt != 0`, stops serving, redeems the newest voucher | 0.02 paid | [`0x20955130…`](https://explorer.testnet.arc.io/tx/0x20955130e2122782fb750c8c36166b7c1eb5627c5520db482272a25cf233674f) |
| After the 120 s notice the client completes the withdrawal | 0.18 back | [`0x2537bac3…`](https://explorer.testnet.arc.io/tx/0x2537bac324154ab0903268aa1244d9ef87ae68af9aa1d8f64b592995928d59b5) |

The same cycle through the app (client and provider views, vouchers signed in the wallet):

| Step | Tx |
|---|---|
| Client deposits 0.30 | [`0x79bc1e3a…`](https://explorer.testnet.arc.io/tx/0x79bc1e3a7540645fcb5e9bcc00b82dfcaa527e7f17bb71405cd031c1fcc35dd6) |
| Two calls at 0.05 (a double click signs once); provider view auto-validates and redeems 0.10 | [`0x2eb45693…`](https://explorer.testnet.arc.io/tx/0x2eb4569399eacea53430646a157dc65ddc3c32ca7a8dc86822d69057eac42d81) |
| One more call (0.15), then the client starts a withdrawal: further calls are refused, Deposit is disabled | [`0xa30a4b28…`](https://explorer.testnet.arc.io/tx/0xa30a4b2843581af4da76a7f3a7510fd5a6ca69ff30e8ed4af6f6726ec39bc53a) |
| Provider view shows the red banner and redeems 0.05 during the notice | [`0x02ab50fe…`](https://explorer.testnet.arc.io/tx/0x02ab50fe07702de144eed86f6e195006619dbfd16822d9140e6bbddde2dd57ef) |
| Client completes the withdrawal, 0.15 back; the provider banner clears | [`0xcceee514…`](https://explorer.testnet.arc.io/tx/0xcceee514350873e414706c9867884d2830f77867e2e10b960c9c3a82433c9833) |

In the provider view a voucher signed by another key, or the high-s twin of a valid signature, is rejected before Redeem is offered.
The v1 walkthroughs (Studio deployment) are kept in [CHANGES.md](CHANGES.md).

---

## Repository layout

| Path | What |
|---|---|
| `contracts/UsdcMeter.sol` | the contract (v2) |
| `contracts/test/UsdcMeter.t.sol` | Arc Studio's Foundry suite (unit, fuzz, reentrancy, invariants), updated for v2 |
| `contracts/test/MeterUnit.t.sol`, `MeterInvariant.t.sol`, `Helpers.sol` | independent unit/fuzz/invariant suite |
| `contracts/test/ReviewRegression.t.sol`, `ReviewExpected.t.sol` | regressions from the external review of v1 (they fail on v1, pass on v2) |
| `contracts/test-helpers/` | attacker / hook contracts used by the tests |
| `src/` | React + Vite + wagmi/viem app (client view, provider view, demo paid API, activity feed) |
| `src/usdcmeter-config.ts` | contract address per network, `DEFAULT_NETWORK` one-line switch, EIP-712 domain and types |
| `src/voucher-check.ts` | the provider-side checks shared by the provider view and the demo API |
| `examples/python/meter_client.py` | headless client/provider for scripts, backends and agents |
| `.github/workflows/pages.yml` | builds the app and publishes it to GitHub Pages on every push to `main` |

## Run it

```bash
bun install
bun run dev                                  # app (Arc Testnet by default; add ?network=mainnet)
forge test                                   # 89 contract tests (needs node_modules/@openzeppelin/contracts from bun install)
```

Mainnet: after deploying, set one line in `src/usdcmeter-config.ts`:
`[arcMainnet.id]: { address: '0x…', deployBlock: <block>n }` and (optionally) `DEFAULT_NETWORK = 'mainnet'`.

Headless usage (Python 3.10+, `pip install eth-account eth-abi eth-utils`):

```bash
export METER_ADDRESS=0x4c72e9de7e19b8b752f652ffcef7c99abf0a6d84 CLIENT_PK=... PROVIDER_PK=...
python examples/python/meter_client.py deposit 0xPROVIDER 1
python examples/python/meter_client.py sign 0xPROVIDER 0.05 > voucher.json      # attach to each request
python examples/python/meter_client.py verify voucher.json 0.05                 # provider, before serving one 0.05 call
python examples/python/meter_client.py redeem voucher.json
```

## How it was built

The contract, its tests and the app were generated and iterated in Arc Studio: Smart Contract mode wrote the contract,
ran two auditors and Slither, fixed what they found, wrote the Foundry suite and deployed v1 to Arc Testnet; Build mode
wrote the app and deployed it to Netlify. An external review of v1 then found that a matured withdrawal request could
sweep later deposits without notice. Studio's daily usage limit was exhausted at that point, so the v2 fix (about ten
lines: deposits blocked while a withdrawal is pending, events before payouts, `nonReentrant` on `deposit`) and the app
hardening were made by hand in the same workspace, tested with Studio's suite plus the new regressions, and deployed with
the same compiler settings. Every hand change is listed in [CHANGES.md](CHANGES.md).

## Security

Reviewed by Arc Studio's Smart Contract pipeline (solidity-auditor and functional-auditor, Slither, Foundry) and by an
external review of v1 whose findings are fixed or documented in v2. That is not a paid third-party audit. See
[SECURITY.md](SECURITY.md).

## License

MIT
