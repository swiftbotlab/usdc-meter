/**
 * Rate-limit-safe sequential event-log scanner for Arc's public RPC.
 *
 * rpc.mainnet.arc.io caps eth_getLogs at a ~10k-block range and answers parallel
 * bursts with -32005 "rate limit exceeded". Arc also mints ~177k blocks/day, so a
 * scan from the deployment block grows by ~20 chunks/day. This module:
 *   - scans SEQUENTIALLY in 9k-block chunks (never Promise.all bursts);
 *   - retries each chunk with exponential backoff on rate-limit errors;
 *   - never silently drops a failed chunk — it returns complete=false plus the last
 *     fully-scanned block, so the caller can show "still loading" + Retry and resume;
 *   - pairs with a localStorage cache (readScanCache / writeScanCache) so reloads only
 *     scan the new tail instead of rescanning from genesis.
 */
import type { PublicClient } from 'viem'

export const LOG_CHUNK = 9_000n
// Steady pace between chunks. The public RPC tolerates ~120ms spacing on a fresh quota
// but throttles under sustained scanning, so the pace adapts upward after any throttle.
const INTER_CHUNK_DELAY_MS = 120
const MAX_INTER_CHUNK_DELAY_MS = 1500
const MAX_RETRIES = 8
const BASE_BACKOFF_MS = 500
const MAX_BACKOFF_MS = 8000

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** True for the public RPC's -32005 "rate limit exceeded" and similar throttling errors. */
export function isRateLimitError(e: unknown): boolean {
  const msg = String((e as { message?: unknown })?.message ?? e).toLowerCase()
  return (
    msg.includes('rate limit') ||
    msg.includes('32005') ||
    msg.includes('too many') ||
    msg.includes('429')
  )
}

// viem's getLogs has heavily-overloaded generics; call it with a plain object.
type GetLogsArgs = Record<string, unknown>
export interface RawLog {
  address: string
  topics: string[]
  data: string
  blockNumber: bigint | null
  transactionHash: string | null
  logIndex: number | null
}

export interface ScanResult {
  logs: RawLog[]
  /** false if a chunk failed after all retries — the data is partial. */
  complete: boolean
  /** last block fully scanned (inclusive); resume a Retry from lastScanned + 1. */
  lastScanned: bigint
}

/**
 * Scan [fromBlock..toBlock] sequentially in 9k-block chunks. `filter` carries
 * address / topics / event / args for client.getLogs.
 *
 * Each chunk retries with exponential backoff on rate-limit errors, and whenever a
 * throttle is seen the steady inter-chunk pace is raised (adaptive) so the RPC's quota
 * can refill. On a chunk that still fails after all retries, stop and return what we have
 * with complete=false and the last fully-scanned block (so a Retry resumes the tail).
 */
export async function scanLogsSequential(
  client: PublicClient,
  fromBlock: bigint,
  toBlock: bigint,
  filter: GetLogsArgs,
  onProgress?: (from: bigint, to: bigint) => void,
): Promise<ScanResult> {
  const logs: RawLog[] = []
  if (toBlock < fromBlock) return { logs, complete: true, lastScanned: toBlock }
  const getLogs = client.getLogs as (a: GetLogsArgs) => Promise<unknown>
  let from = fromBlock
  let lastScanned = fromBlock - 1n
  let interDelay = INTER_CHUNK_DELAY_MS

  while (from <= toBlock) {
    const to = from + LOG_CHUNK - 1n < toBlock ? from + LOG_CHUNK - 1n : toBlock
    onProgress?.(from, to)

    let chunk: RawLog[] | null = null
    let backoff = BASE_BACKOFF_MS
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        chunk = (await getLogs({ ...filter, fromBlock: from, toBlock: to })) as RawLog[]
        break
      } catch (e) {
        if (!isRateLimitError(e) || attempt === MAX_RETRIES - 1) {
          return { logs, complete: false, lastScanned }
        }
        // Throttled: back off this chunk and slow the steady pace for the rest of the scan.
        interDelay = Math.min(interDelay * 2, MAX_INTER_CHUNK_DELAY_MS)
        await sleep(backoff + Math.floor(Math.random() * 250))
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS)
      }
    }
    if (chunk === null) return { logs, complete: false, lastScanned }

    logs.push(...chunk)
    lastScanned = to
    from = to + 1n
    if (from <= toBlock) await sleep(interDelay)
  }
  return { logs, complete: true, lastScanned }
}

// --- localStorage cache (bigint-safe, fail-safe) ----------------------------------
const CACHE_PREFIX = 'arc-logcache-v1:'

function reviveBigint(_k: string, v: unknown): unknown {
  if (v && typeof v === 'object' && !Array.isArray(v) && '$bi' in (v as Record<string, unknown>)) {
    return BigInt((v as { $bi: string }).$bi)
  }
  return v
}
function replaceBigint(_k: string, v: unknown): unknown {
  return typeof v === 'bigint' ? { $bi: v.toString() } : v
}

/** Read cached, already-decoded items plus the last block they cover. null on miss/any error. */
export function readScanCache<T>(key: string): { lastScanned: bigint; items: T[] } | null {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + key)
    if (!raw) return null
    const parsed = JSON.parse(raw, reviveBigint) as { lastScanned?: unknown; items?: unknown }
    const items = Array.isArray(parsed.items) ? (parsed.items as T[]) : []
    const ls = parsed.lastScanned
    const lastScanned = typeof ls === 'bigint' ? ls : typeof ls === 'string' ? BigInt(ls) : null
    if (lastScanned === null) return null
    return { lastScanned, items }
  } catch {
    return null
  }
}

/** Persist decoded items + the covered block. Best-effort: storage errors are swallowed. */
export function writeScanCache<T>(key: string, lastScanned: bigint, items: T[]): void {
  try {
    localStorage.setItem(CACHE_PREFIX + key, JSON.stringify({ lastScanned, items }, replaceBigint))
  } catch {
    /* storage full/blocked — cache is best-effort; scanning still works */
  }
}
