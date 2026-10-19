/**
 * UsdcMeter contract config — one entry per chain.
 *
 * Network selection (first match wins):
 *   1. ?network=testnet|mainnet in the page URL (lets one hosted build show both)
 *   2. VITE_ARC_NETWORK=testnet|mainnet at build time
 *   3. DEFAULT_NETWORK below  <- the one-line switch
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
// ACTIVE chain
// ---------------------------------------------------------------------------
export type ArcNetwork = 'testnet' | 'mainnet'

/** ONE-LINE SWITCH: the network this build serves when the URL / build env do not choose one. */
export const DEFAULT_NETWORK: ArcNetwork = 'mainnet'

function _pick(v: unknown): ArcNetwork | undefined {
  const s = String(v ?? '').trim().toLowerCase()
  return s === 'testnet' || s === 'mainnet' ? s : undefined
}
const _fromUrl = (() => {
  try { return _pick(new URLSearchParams(window.location.search).get('network')) } catch { return undefined }
})()
export const ACTIVE_NETWORK: ArcNetwork = _fromUrl ?? _pick(import.meta.env.VITE_ARC_NETWORK) ?? DEFAULT_NETWORK
export const ACTIVE_CHAIN: SupportedArcChain = ACTIVE_NETWORK === 'mainnet' ? arcMainnet : arcTestnet

/** Same page on the other network (keeps the path, swaps ?network=). */
export function networkHref(n: ArcNetwork): string {
  try {
    const u = new URL(window.location.href)
    u.searchParams.set('network', n)
    return u.pathname + u.search + u.hash
  } catch { return `?network=${n}` }
}

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
  // UsdcMeter v2 on Arc Testnet (noticePeriod 120 s). v1 was 0xeca961579bcf4978d083a0c3a72788a2def6e61a.
  [arcTestnet.id]: {
    address: '0x4c72e9de7e19b8b752f652ffcef7c99abf0a6d84',
    deployBlock: 67934662n,
  },
  // UsdcMeter v2 on Arc mainnet — fill in after mainnet/deploy.py (one line):
  [arcMainnet.id]: { address: '0x61afe97430a8551cd1940f314dfed86269d12cf3', deployBlock: 26700672n },
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
