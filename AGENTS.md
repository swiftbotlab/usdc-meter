# UsdcMeter

> Built with Arc Studio - money-powered apps in minutes

This is the **project memory** - what Arc Studio remembers about building this app. It helps future agents (or humans) understand and extend the project.

---

## What This App Does

Prepaid metered billing payment channels on Arc Testnet. Clients deposit native USDC (msg.value) into per-(client,provider) channels, sign EIP-712 cumulative vouchers off-chain, and providers (or relayers) redeem vouchers on-chain. Partial redemption, notice-period withdrawal, full reentrancy protection.

## Deployed Contracts

| Contract | Network | Address |
|---|---|---|
| UsdcMeter v2 | Arc Testnet | 0x4c72e9de7e19b8b752f652ffcef7c99abf0a6d84 (deploy block 67934662) |
| UsdcMeter v1 (superseded) | Arc Testnet | 0xeca961579bcf4978d083a0c3a72788a2def6e61a |
| UsdcMeter v2 | Arc Mainnet | 0x61afe97430a8551cd1940f314dfed86269d12cf3 (deploy block 26700672) |

Explorer: https://explorer.arc.io/address/0x61afe97430a8551cd1940f314dfed86269d12cf3 (mainnet), https://explorer.testnet.arc.io/address/0x4c72e9de7e19b8b752f652ffcef7c99abf0a6d84 (testnet)

Constructor args: `noticePeriod = 120` (seconds). v2 = deposits revert `WithdrawAlreadyPending` while a withdrawal is
pending or matured; events before payouts; `deposit` is `nonReentrant` (see CHANGES.md).

## Tech Stack

- Frontend: React 18, Vite, TypeScript, Tailwind CSS
- Web3: wagmi v2, viem v2, ConnectKit
- Contracts: Solidity 0.8.28 + Foundry. Sources in `contracts/`, unit tests in `contracts/test/*.t.sol`. Build with `bun run contracts:build` (`forge build`), test with `bun run contracts:test` (`forge test`).
- Wallet: injected (MetaMask, etc.)
- Chain: Arc mainnet (Chain ID 5042, `arcMainnet` defined in `src/usdcmeter-config.ts`) by default; Arc Testnet (5042002, from `viem/chains`) via `?network=testnet`. Network = `?network=` URL param, else `VITE_ARC_NETWORK`, else `DEFAULT_NETWORK`
- Provider-side voucher checks: `src/voucher-check.ts` (keep in sync with the contract)
- Studio preview hooks (`src/tracing.ts`, `src/console-capture.ts`) are loaded from `main.tsx` only when framed by https://studio.arc.io
- Token: native USDC (msg.value, 18 decimals). The 6-decimal ERC-20 interface at 0x3600000000000000000000000000000000000000 is not used.
- Toasts: Sonner

## Key Files

- `src/App.tsx` - Main application logic
- `src/components/` - UI components
- `src/config.ts` - wagmi config (chains, connectors, transports)
- `src/usdcmeter-config.ts` - contract address + deploy block per network, EIP-712 domain/types, explorer links

## To Run

```bash
bun install
bun run dev
```
