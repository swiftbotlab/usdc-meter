/**
 * UsdcMeter contract config — one entry per chain.
 *
 * VITE_ARC_NETWORK=testnet (default) | mainnet
 * Arc mainnet chain and contract address are stubbed until deployment.
 */
import { arcTestnet, mainnet } from 'viem/chains'
import { defineChain } from 'viem'

export { METER_ABI } from './usdcmeter-abi'

// ---------------------------------------------------------------------------
// Chain definitions
// ---------------------------------------------------------------------------

/** Arc mainnet, defined inline until viem/chains ships it. */
export const arcMainnet = defineChain({
  id: 5042,
  name: 'Arc',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.mainnet.arc.io'] } },
  blockExplorers: { default: { name: 'Arc Explorer', url: 'https://explorer.arc.io' } },
})

export type SupportedArcChain = typeof arcTestnet | typeof arcMainnet

// ---------------------------------------------------------------------------
// ACTIVE chain — chosen at build time by VITE_ARC_NETWORK
// ---------------------------------------------------------------------------
const _network = String(import.meta.env.VITE_ARC_NETWORK ?? 'testnet').trim().toLowerCase()
export const ACTIVE_CHAIN: SupportedArcChain =
  _network === 'mainnet' ? arcMainnet : arcTestnet

/** All chains needed in the wagmi config (active Arc chain + mainnet for ENS). */
export const WAGMI_CHAINS = [ACTIVE_CHAIN, mainnet] as const

// ---------------------------------------------------------------------------
// Contract config per chain
// ---------------------------------------------------------------------------

export interface MeterChainConfig {
  address: `0x${string}`
  /** Earliest block to start getLogs scans — the deployment block. */
  deployBlock: bigint
}

export const METER_CHAINS: Partial<Record<number, MeterChainConfig>> = {
  [arcTestnet.id]: {
    address: '0xeca961579bcf4978d083a0c3a72788a2def6e61a',
    deployBlock: 67920821n,
  },
  // Arc mainnet — add address + deployBlock once deployed:
  // [arcMainnet.id]: { address: '0x...', deployBlock: 0n },
}

/** Config for the currently active chain (may be undefined on mainnet before deployment). */
export const ACTIVE_CFG: MeterChainConfig | undefined = METER_CHAINS[ACTIVE_CHAIN.id]

// ---------------------------------------------------------------------------
// Explorer helpers — derived from the active chain
// ---------------------------------------------------------------------------

function _explorerBase(): string {
  return ACTIVE_CHAIN.blockExplorers?.default.url ?? 'https://testnet.arcscan.app'
}

export function explorerTx(hash: string): string {
  return `${_explorerBase()}/tx/${hash}`
}
export function explorerAddr(addr: string): string {
  return `${_explorerBase()}/address/${addr}`
}

// ---------------------------------------------------------------------------
// EIP-712 helpers
// ---------------------------------------------------------------------------

/** EIP-712 domain for voucher signing — must match the contract. */
export function voucherDomain(chainId: number, contractAddress: `0x${string}`) {
  return {
    name: 'USDC Meter',
    version: '1',
    chainId,
    verifyingContract: contractAddress,
  } as const
}

export const VOUCHER_TYPES = {
  Voucher: [
    { name: 'client', type: 'address' },
    { name: 'provider', type: 'address' },
    { name: 'cumulativeAmount', type: 'uint256' },
  ],
} as const

// ---------------------------------------------------------------------------
// localStorage key helpers
// ---------------------------------------------------------------------------

/** localStorage key for persisted vouchers */
export function voucherStorageKey(
  chainId: number,
  contractAddress: string,
  client: string,
  provider: string,
): string {
  return `usdcmeter:voucher:${chainId}:${contractAddress}:${client.toLowerCase()}:${provider.toLowerCase()}`
}

/** localStorage key for remembered provider address */
export function providerStorageKey(chainId: number): string {
  return `usdcmeter:provider:${chainId}`
}

/** localStorage key for remembered client address (provider view) */
export function clientStorageKey(chainId: number): string {
  return `usdcmeter:client:${chainId}`
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StoredVoucher {
  client: string
  provider: string
  cumulativeAmount: string // bigint as decimal string
  signature: string
  callCount: number
  pricePerCall: string // bigint as decimal string
}
