# USDC Meter

**by Swift Bot Labs**

Prepaid metered billing in USDC on Arc. One deposit, a signed voucher per API call, settle whenever you like.

Paying per API call on-chain normally means one transaction per call: fees and latency on every request. Invoices and subscriptions avoid that but bring credit risk and manual billing. USDC Meter sits in between. A client deposits USDC once into a channel for a provider. Every call carries an off-chain EIP-712 voucher that states the **cumulative** amount the client owes so far. The provider redeems the latest voucher whenever it likes and the contract pays only the difference over what was already redeemed. It is a minimal one-way payment channel, built for services or agents paying each other per call.

- Live app: https://usdc-meter.netlify.app (Arc Testnet)
- Contract: [`contracts/UsdcMeter.sol`](contracts/UsdcMeter.sol) (about 300 lines, OpenZeppelin EIP712 + ECDSA + ReentrancyGuard)
- Built in [Arc Studio](https://studio.arc.io): Smart Contract mode for the contract (writer, two auditors, Slither, Foundry tests, deploy), Build mode for the app

---

## How it works

```
Client                         UsdcMeter                        Provider
  |-- deposit(provider) {value} -->|                                 |
  |                                |  channel(client, provider)      |
  |== API call #1 + voucher(0.05) ==================================>|  verify off-chain, serve
  |== API call #2 + voucher(0.10) ==================================>|  verify off-chain, serve
  |== API call #3 + voucher(0.15) ==================================>|  verify off-chain, serve
  |                                |<--- redeem(voucher 0.15) -------|  pays 0.15
  |-- requestWithdraw(provider) -->|  notice period starts           |
  |== API call #4 + voucher(0.20) ==================================>|
  |                                |<--- redeem(voucher 0.20) -------|  pays 0.05 (the delta)
  |-- completeWithdraw(provider) ->|  (after notice) client gets the rest
```

Calls cost nothing on-chain. A billing cycle is one deposit, one or more redemptions at the provider's pace, and optionally one withdrawal, however many calls happen in between.

### Vouchers

A voucher is EIP-712 typed data signed by the client's key:

```
Voucher(address client, address provider, uint256 cumulativeAmount)
domain = { name: "USDC Meter", version: "1", chainId, verifyingContract }
```

- **Cumulative, not per-call.** Each voucher states the total owed so far. The provider only needs to keep the latest one; losing older vouchers costs nothing, and replaying an old voucher pays nothing (`cumulativeAmount <= redeemed` reverts with `NothingToRedeem`).
- **Bound to one chain and one contract** through the EIP-712 domain, so a voucher can't be replayed on another deployment or network.
- **EOA signatures only** (`ECDSA.tryRecover`, malleable signatures rejected). ERC-1271 contract signatures are deliberately not accepted: a contract wallet could change its signature logic and invalidate vouchers the provider already holds.
- **Partial redemption.** If a voucher asks for more than the channel holds, the provider receives what is available and the rest stays claimable with the same voucher after the client tops up.
- **Permissionless submission.** Anyone may submit `redeem` (for example a relayer that pays the gas); the funds always go to the provider named in the voucher.

### Channel state

One channel per `(client, provider)` pair:

| Field | Meaning |
|---|---|
| `deposited` | total the client ever deposited |
| `withdrawn` | total the client ever withdrew |
| `redeemed` | total paid to the provider (equals the highest voucher redeemed, capped by funds) |
| `withdrawReadyAt` | 0, or the time a requested withdrawal can complete |
| `available` | `deposited - withdrawn - redeemed` |

| Status in the app | Condition |
|---|---|
| Open | `withdrawReadyAt == 0` |
| Withdrawal pending | `now < withdrawReadyAt`: the provider should redeem any outstanding voucher now |
| Ready to withdraw | `withdrawReadyAt <= now`: the client can complete the withdrawal |

### Functions

| Function | Caller | Effect |
|---|---|---|
| `deposit(provider)` payable | client | adds `msg.value` to the channel; does not cancel a pending withdrawal |
| `redeem(client, provider, cumulativeAmount, signature)` | anyone | pays `min(cumulativeAmount - redeemed, available)` to the provider |
| `requestWithdraw(provider)` | client | starts the notice period (`noticePeriod`, immutable, 60 s to 30 days) |
| `cancelWithdraw(provider)` | client | clears a pending request |
| `completeWithdraw(provider)` | client | after the notice period, sends everything still available to the client |
| `getChannel`, `voucherDigest`, `domainSeparator`, `VOUCHER_TYPEHASH`, `noticePeriod` | view | helpers for apps and services |

Events: `Deposited`, `Redeemed`, `WithdrawRequested`, `WithdrawCancelled`, `Withdrawn`.

### Who carries what risk

- **Client:** the provider can never take more than the client signed for, and never more than the channel holds.
- **Provider:** if the provider checks each voucher before serving a call (signer, amount increased by exactly the price, `cumulative - redeemed <= available`), its exposure is at most one call. The client can only take funds back after the notice period, and the provider can redeem during that window, so a provider must watch for `WithdrawRequested` (the app shows a banner) and redeem before `withdrawReadyAt`.
- **Payout failures:** payouts use a native `call`. A recipient that rejects native USDC only blocks its own payout, never the other party's.

---

## Arc specifics

- **Native USDC, 18 decimals.** USDC is Arc's gas token. Deposits are `msg.value`, and every amount in the contract, the vouchers and the app has 18 decimals (`parseEther` / `formatEther`). The 6-decimal ERC-20 interface at `0x3600000000000000000000000000000000000000` is not used.
- **Fee floor.** Arc rejects transactions with `maxFeePerGas` below 20 gwei.
- **Log range.** `eth_getLogs` accepts fewer than 10,000 blocks per call; the app's activity feed pages backwards in 9,000-block chunks from the deployment block.
- **Finality.** Sub-second blocks, so receipts arrive within a second or two and a provider can redeem right after a withdrawal request.

---

## Deployments

| Network | Address | Deploy tx | Notice period |
|---|---|---|---|
| Arc Testnet (5042002) | [`0xeca961579bcf4978d083a0c3a72788a2def6e61a`](https://testnet.arcscan.app/address/0xeca961579bcf4978d083a0c3a72788a2def6e61a) | [`0x29280e33…`](https://testnet.arcscan.app/tx/0x29280e33cf020862a83e8f633c75fd6f4832c390ebe1c2d4250b30ec122ba444) | 120 s |
| Arc Mainnet (5042) | coming soon | | |

The testnet source is verified on the explorer (Blockscout): solc 0.8.28, optimizer 200 runs, EVM `paris`, constructor argument `noticePeriod = 120`.

## Testnet walkthrough (real transactions)

One full cycle with throwaway keys, client `0xfFf9…8ec8`, provider `0x20a9…d2A3`:

| Step | Amount | Tx |
|---|---|---|
| Client deposits | 1.00 | [`0x2039f98f…`](https://testnet.arcscan.app/tx/0x2039f98fb2498e0b9f3ead905b8031e442a3cf666bcb7b265f3fa758e5938452) |
| Client signs vouchers 0.05, 0.10, 0.15 off-chain | | no transactions |
| Provider redeems only the latest (0.15) | 0.15 paid | [`0x07629b1a…`](https://testnet.arcscan.app/tx/0x07629b1a60c3323b4bb67428f7433cac9d4cfeb63702de0e360f5b0fc8bcf25a) |
| Replaying voucher 0.05 | reverts `NothingToRedeem` | |
| Client signs 0.20, then requests a withdrawal | | [`0xe3941259…`](https://testnet.arcscan.app/tx/0xe394125937410be7ec2d0018d468fc0d1c42bf03dc16cd1b859947b9e2cc353a) |
| Completing before the notice ends | reverts `TooEarlyToWithdraw` | |
| Provider redeems 0.20 during the notice | 0.05 paid (delta) | [`0x69f13464…`](https://testnet.arcscan.app/tx/0x69f13464443f098f749f214ca012eb0ef4785e8d61b877164384fa5db53be936) |
| Client completes the withdrawal | 0.80 back | [`0x8363439e…`](https://testnet.arcscan.app/tx/0x8363439e10f08c5407a38696e585a44608376de1fefaf6db8e8e7b88095c33ba) |

Final channel: deposited 1.00, redeemed 0.20, withdrawn 0.80, contract balance 0.

The same cycle through the live app (client and provider views, vouchers signed in the wallet):

| Step | Tx |
|---|---|
| Client deposits 0.60 | [`0x163c5dd0…`](https://testnet.arcscan.app/tx/0x163c5dd009d4d4ad87fde686dfa90befaab4dbf5135a1ace3345512c528a3dd5) |
| Three calls in the demo API: vouchers 0.45, 0.50, 0.55 | off-chain |
| Provider redeems the latest voucher: 0.15 paid | [`0x9ed22c76…`](https://testnet.arcscan.app/tx/0x9ed22c761c3e74c07570b5815b62cba67de8600e5c9c1f25d88545f04ffc6866) |
| Client starts a withdrawal | [`0x5e03af53…`](https://testnet.arcscan.app/tx/0x5e03af53450bc766eb06db8eabb302c98845b1f93b3dfc1f5685c43c055dd236) |
| One more call (voucher 0.56); the provider view shows "redeem before …" and redeems 0.01 | [`0x588dbc83…`](https://testnet.arcscan.app/tx/0x588dbc83d190415bd46025e8f459c11be5df051499c2c28b5ade6ff463d84251) |
| Notice over: client completes the withdrawal, 0.84 back | [`0x7ae734d7…`](https://testnet.arcscan.app/tx/0x7ae734d71c951f420b37e4ae373835e795541e471335aa54805a46d3e1e47a2f) |

---

## Repository layout

| Path | What |
|---|---|
| `contracts/UsdcMeter.sol` | the contract |
| `contracts/test/UsdcMeter.t.sol` | Foundry unit, fuzz and invariant tests (37 tests incl. a 128,000-call invariant run) |
| `contracts/test-helpers/MaliciousProvider.sol` | reentrancy attacker used by the tests |
| `src/` | React + Vite + wagmi/viem app (client view, provider view, demo paid API, activity feed) |
| `src/usdcmeter-config.ts` | contract address per network, EIP-712 domain and types, `VITE_ARC_NETWORK` switch |
| `examples/python/meter_client.py` | headless client/provider for scripts, backends and agents (deposit, sign, verify, redeem, withdraw) |

## Run it

```bash
bun install
bun run dev                       # app on Arc Testnet
VITE_ARC_NETWORK=mainnet bun run build   # mainnet build once the mainnet address is filled in
forge test                        # contract tests (needs node_modules/@openzeppelin/contracts from bun install)
```

Headless usage (Python 3.10+, `pip install eth-account eth-abi eth-utils`):

```bash
export METER_ADDRESS=0xeca961579bcf4978d083a0c3a72788a2def6e61a CLIENT_PK=... PROVIDER_PK=...
python examples/python/meter_client.py deposit 0xPROVIDER 1
python examples/python/meter_client.py sign 0xPROVIDER 0.05 > voucher.json     # attach to each request
python examples/python/meter_client.py verify voucher.json                     # provider, before serving
python examples/python/meter_client.py redeem voucher.json
```

## How it was built

The contract, its tests and the app were generated and iterated in Arc Studio: Smart Contract mode wrote the contract,
ran two auditors and Slither, fixed what they found, wrote the Foundry suite and deployed to Arc Testnet; Build mode
wrote the app and deployed it to Netlify. Studio's daily usage limit stopped the last fix round halfway, so four small
follow-up fixes were made by hand (listed in [CHANGES.md](CHANGES.md)).

## Security

The contract went through Arc Studio's Smart Contract pipeline (solidity-auditor and functional-auditor, two rounds; Slither; Foundry unit, fuzz, reentrancy and invariant tests). That is not a paid third-party audit. See [SECURITY.md](SECURITY.md).

## License

MIT
