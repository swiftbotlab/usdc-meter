# UsdcMeter

> Built with Arc Studio - money-powered apps in minutes

This is the **project memory** - what Arc Studio remembers about building this app. It helps future agents (or humans) understand and extend the project.

---

## What This App Does

Prepaid metered billing payment channels on Arc Testnet. Clients deposit native USDC (msg.value) into per-(client,provider) channels, sign EIP-712 cumulative vouchers off-chain, and providers (or relayers) redeem vouchers on-chain. Partial redemption, notice-period withdrawal, full reentrancy protection.

## Deployed Contracts

| Contract | Network | Address |
|---|---|---|
| UsdcMeter | Arc Testnet | 0xeca961579bcf4978d083a0c3a72788a2def6e61a |

Explorer: https://explorer.testnet.arc.io/address/0xeca961579bcf4978d083a0c3a72788a2def6e61a

Constructor args: `noticePeriod = 120` (seconds)

## Tech Stack

- Frontend: React 18, Vite, TypeScript, Tailwind CSS
- Web3: wagmi v2, viem v2, ConnectKit
- Contracts: Solidity 0.8.28 + Foundry. Sources in `contracts/`, unit tests in `contracts/test/*.t.sol`. Build with `bun run contracts:build` (`forge build`), test with `bun run contracts:test` (`forge test`).
- Wallet: injected (MetaMask, etc.)
- Chain: Arc Testnet (Chain ID: 5042002, imported from `viem/chains`) by default; `VITE_ARC_NETWORK=mainnet` selects Arc (5042) from `src/usdcmeter-config.ts`
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
