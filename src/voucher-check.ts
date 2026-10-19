/**
 * Provider-side voucher checks, kept identical to what the contract accepts (UsdcMeter v2):
 *  - EIP-712 Voucher(client, provider, cumulativeAmount) on this chain + contract
 *  - signature in the ONLY form OpenZeppelin ECDSA.tryRecover accepts: 65 bytes, v 27/28, low s
 *  - signer == voucher client == the channel's client; voucher provider == the provider checking it
 *  - cumulative > redeemed on-chain (and, for serving a call, >= last accepted + price)
 *  - no withdrawal pending or matured (withdrawReadyAt != 0 means: stop serving, redeem now)
 */
import { recoverTypedDataAddress } from 'viem'
import { voucherDomain, VOUCHER_TYPES, type StoredVoucher } from './usdcmeter-config'

const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n

export type Hex = `0x${string}`

/** True when the signature is in the canonical form the contract accepts. */
export function isCanonicalSignature(sig: string): boolean {
  if (!/^0x[0-9a-fA-F]{130}$/.test(sig)) return false // exactly 65 bytes
  const s = BigInt('0x' + sig.slice(66, 130))
  const v = parseInt(sig.slice(130, 132), 16)
  return (v === 27 || v === 28) && s > 0n && s <= SECP256K1_N / 2n
}

export function isAddress(a: unknown): a is Hex {
  return typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a)
}

export function sameAddr(a?: string, b?: string): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase()
}

/** Parse untrusted voucher JSON (pasted or from localStorage). Never throws. */
export function parseVoucher(raw: string | null | undefined): { v?: StoredVoucher; cumulative?: bigint; error?: string } {
  if (!raw) return { error: 'Empty voucher' }
  let v: StoredVoucher
  try {
    v = JSON.parse(raw) as StoredVoucher
  } catch {
    return { error: 'Invalid JSON' }
  }
  if (!v || typeof v !== 'object') return { error: 'Invalid voucher' }
  if (!isAddress(v.client) || !isAddress(v.provider)) return { error: 'client / provider must be 0x addresses' }
  if (typeof v.cumulativeAmount !== 'string' || !/^\d{1,78}$/.test(v.cumulativeAmount)) {
    return { error: 'cumulativeAmount must be a decimal integer string (wei)' }
  }
  if (typeof v.signature !== 'string') return { error: 'Missing signature' }
  return { v, cumulative: BigInt(v.cumulativeAmount) }
}

export type WithdrawState = 'none' | 'pending' | 'matured'

export function withdrawState(withdrawReadyAt: number | bigint | undefined, nowSec: number): WithdrawState {
  const t = Number(withdrawReadyAt ?? 0)
  if (!t) return 'none'
  return t > nowSec ? 'pending' : 'matured'
}

export interface ChannelSnapshot {
  redeemed: bigint
  available: bigint
  withdrawReadyAt: number
}

export interface CheckResult {
  ok: boolean
  error?: string
  /** What redeem() would pay right now. */
  redeemable: bigint
}

/**
 * Full check of a voucher against the selected channel. `expectedClient` is the channel's client, `self` the provider
 * doing the check. `minCumulative` (optional) = last accepted cumulative + price when deciding whether to serve a call.
 */
export async function checkVoucher(args: {
  v: StoredVoucher
  chainId: number
  meter: Hex
  expectedClient: string | undefined
  self: string | undefined
  channel: ChannelSnapshot
  minCumulative?: bigint
  forServing?: boolean
}): Promise<CheckResult> {
  const { v, chainId, meter, expectedClient, self, channel } = args
  const fail = (error: string): CheckResult => ({ ok: false, error, redeemable: 0n })
  if (!sameAddr(v.provider, self)) return fail(`Voucher pays provider ${v.provider}, not this provider.`)
  if (!sameAddr(v.client, expectedClient)) {
    return fail(`Voucher was signed for client ${v.client}, but the selected channel's client is ${expectedClient ?? '(none)'}.`)
  }
  if (!isCanonicalSignature(v.signature)) {
    return fail('Signature is not in canonical form (65 bytes, v 27/28, low s): the contract would reject it.')
  }
  const cumulative = BigInt(v.cumulativeAmount)
  try {
    const recovered = await recoverTypedDataAddress({
      domain: voucherDomain(chainId, meter),
      types: VOUCHER_TYPES,
      primaryType: 'Voucher',
      message: { client: v.client as Hex, provider: v.provider as Hex, cumulativeAmount: cumulative },
      signature: v.signature as Hex,
    })
    if (!sameAddr(recovered, v.client)) return fail('Signature does not match the client.')
  } catch {
    return fail('Signature verification failed.')
  }
  if (cumulative <= channel.redeemed) return fail('Cumulative is not above what was already redeemed: nothing to pay.')
  const owed = cumulative - channel.redeemed
  const redeemable = owed < channel.available ? owed : channel.available
  if (args.forServing) {
    if (channel.withdrawReadyAt !== 0) return fail('Client started a withdrawal: stop serving and redeem now.')
    if (args.minCumulative !== undefined && cumulative < args.minCumulative) {
      return fail('Cumulative does not cover this call (below last accepted voucher + price).')
    }
    if (owed > channel.available) return fail('Voucher exceeds the prepaid balance.')
  }
  if (redeemable === 0n) return fail('No funds available in the channel to pay this voucher.')
  return { ok: true, redeemable }
}
