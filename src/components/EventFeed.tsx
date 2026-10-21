import { useEffect, useState, useCallback } from 'react'
import { usePublicClient } from 'wagmi'
import { formatEther, pad, decodeEventLog, type PublicClient } from 'viem'
import { ArrowDownToLine, Receipt, Clock, XCircle, ArrowUpToLine, RefreshCw } from 'lucide-react'
import { ACTIVE_CHAIN, ACTIVE_CFG, METER_ABI, explorerTx, explorerAddr } from '../usdcmeter-config'
import { scanLogsSequential, readScanCache, writeScanCache } from '../logscan'

type EventKind = 'Deposited' | 'Redeemed' | 'WithdrawRequested' | 'WithdrawCancelled' | 'Withdrawn'

interface FeedEvent {
  id: string
  kind: EventKind
  blockNumber: bigint
  txHash: string
  client: string
  provider: string
  amount?: bigint
  extra?: string
}

const ICONS: Record<EventKind, typeof ArrowDownToLine> = {
  Deposited: ArrowDownToLine,
  Redeemed: Receipt,
  WithdrawRequested: Clock,
  WithdrawCancelled: XCircle,
  Withdrawn: ArrowUpToLine,
}

const EVENT_COLORS: Record<EventKind, string> = {
  Deposited: 'var(--success)',
  Redeemed: 'var(--accent)',
  WithdrawRequested: '#c9a020',
  WithdrawCancelled: 'var(--danger)',
  Withdrawn: 'var(--muted)',
}

const MAX_EVENTS = 50
const CACHE_CAP = 200 // bound stored history per channel

const EVENT_KINDS: EventKind[] = [
  'Deposited',
  'Redeemed',
  'WithdrawRequested',
  'WithdrawCancelled',
  'Withdrawn',
]

interface Props {
  client?: `0x${string}`
  provider?: `0x${string}`
  /** Bump to force an immediate refresh (e.g. after redeem). */
  refreshKey?: number
}

function sortDesc(events: FeedEvent[]): FeedEvent[] {
  return [...events].sort((a, b) => (a.blockNumber > b.blockNumber ? -1 : a.blockNumber < b.blockNumber ? 1 : 0))
}

export function EventFeed({ client, provider, refreshKey }: Props) {
  // publicClient for the active Arc chain — available without a connected wallet,
  // so the feed works for a walletless channel lookup too.
  const publicClient = usePublicClient({ chainId: ACTIVE_CHAIN.id })
  const cfg = ACTIVE_CFG

  const [events, setEvents] = useState<FeedEvent[]>([])
  const [loading, setLoading] = useState(false)
  const [status, setStatus] = useState('')
  const [partial, setPartial] = useState(false)

  const fetchEvents = useCallback(async () => {
    if (!publicClient || !cfg) return
    // Need at least one indexed party to filter on — never scan every channel.
    if (!client && !provider) { setEvents([]); setStatus(''); setPartial(false); return }

    setLoading(true)
    setPartial(false)

    const cacheKey = `meter:${ACTIVE_CHAIN.id}:${cfg.address.toLowerCase()}:${(client ?? '*').toLowerCase()}:${(provider ?? '*').toLowerCase()}`
    const cached = readScanCache<FeedEvent>(cacheKey)
    const haveCache = !!cached && cached.lastScanned >= cfg.deployBlock - 1n
    const existing: FeedEvent[] = haveCache ? cached!.items : []
    const fromBlock = haveCache ? cached!.lastScanned + 1n : cfg.deployBlock

    try {
      // fresh head: the default cache missed just-confirmed events
      const head = await publicClient.getBlockNumber({ cacheTime: 0 })

      if (fromBlock > head) {
        const sorted = sortDesc(existing)
        setEvents(sorted.slice(0, MAX_EVENTS))
        setStatus(`Showing ${Math.min(sorted.length, MAX_EVENTS)} event${sorted.length !== 1 ? 's' : ''}`)
        setLoading(false)
        return
      }

      // topic1 = client, topic2 = provider (both indexed on every Meter event).
      // ONE getLogs per 9k chunk for ALL event kinds of this channel.
      const topics: (`0x${string}` | null)[] = [
        null,
        client ? pad(client, { size: 32 }) : null,
        provider ? pad(provider, { size: 32 }) : null,
      ]

      const { logs, complete, lastScanned } = await scanLogsSequential(
        publicClient as unknown as PublicClient,
        fromBlock,
        head,
        { address: cfg.address, topics },
        (f, t) => setStatus(`Scanning blocks ${f.toString()}–${t.toString()}…`),
      )

      const fresh: FeedEvent[] = []
      for (const log of logs) {
        let dec: { eventName: string; args: Record<string, unknown> } | null = null
        try {
          dec = decodeEventLog({
            abi: METER_ABI,
            data: log.data as `0x${string}`,
            topics: log.topics as unknown as [`0x${string}`, ...`0x${string}`[]],
          }) as unknown as { eventName: string; args: Record<string, unknown> }
        } catch { continue }
        const kind = dec?.eventName as EventKind
        if (!dec || !EVENT_KINDS.includes(kind)) continue
        const args = dec.args ?? {}

        let amount: bigint | undefined
        let extra: string | undefined
        if (kind === 'Deposited' && args.amount) {
          amount = args.amount as bigint
        } else if (kind === 'Redeemed' && args.paid) {
          amount = args.paid as bigint
          extra = `cumulative: ${parseFloat(formatEther(args.cumulativeAmount as bigint)).toLocaleString('en-US', { maximumFractionDigits: 6 })} USDC`
        } else if (kind === 'Withdrawn' && args.amount) {
          amount = args.amount as bigint
        } else if (kind === 'WithdrawRequested' && args.readyAt) {
          extra = `Ready at ${new Date(Number(args.readyAt) * 1000).toLocaleString()}`
        }

        fresh.push({
          id: `${(log.transactionHash as string | null) ?? ''}-${String(log.logIndex ?? 0)}`,
          kind,
          blockNumber: (log.blockNumber as bigint | null) ?? 0n,
          txHash: (log.transactionHash as string | null) ?? '',
          client: (args.client as string | undefined) ?? '',
          provider: (args.provider as string | undefined) ?? '',
          amount,
          extra,
        })
      }

      // Merge with cache, dedupe by log id, newest first.
      const byId = new Map<string, FeedEvent>()
      for (const e of existing) byId.set(e.id, e)
      for (const e of fresh) byId.set(e.id, e)
      const merged = sortDesc([...byId.values()])

      setEvents(merged.slice(0, MAX_EVENTS))
      setPartial(!complete)
      writeScanCache(cacheKey, complete ? head : lastScanned, merged.slice(0, CACHE_CAP))
      setStatus(
        complete
          ? `Showing ${Math.min(merged.length, MAX_EVENTS)} event${merged.length !== 1 ? 's' : ''}`
          : 'Some activity is still loading',
      )
    } catch (e) {
      setStatus('Could not load activity')
      setPartial(true)
      // keep any cached events visible
      if (existing.length) setEvents(sortDesc(existing).slice(0, MAX_EVENTS))
      console.error(e)
    } finally {
      setLoading(false)
    }
  }, [publicClient, cfg, client, provider])

  /* oxlint-disable react/set-state-in-effect */
  useEffect(() => {
    void fetchEvents()
  }, [fetchEvents])

  // Re-fetch when parent bumps refreshKey (e.g. after a successful redeem)
  useEffect(() => {
    if (refreshKey !== undefined && refreshKey > 0) {
      void fetchEvents()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey])
  /* oxlint-enable react/set-state-in-effect */

  const glass = {
    background: 'var(--surface)',
    backdropFilter: 'blur(20px)',
    WebkitBackdropFilter: 'blur(20px)',
    border: '1px solid var(--border)',
  }

  return (
    <div className="rounded-2xl p-5" style={glass}>
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-sm font-semibold" style={{ color: 'var(--ink)' }}>Activity</h3>
        <button
          onClick={() => void fetchEvents()}
          disabled={loading}
          className="flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs transition-colors disabled:opacity-40"
          style={{ background: 'var(--surface-muted)', color: 'var(--muted)' }}
        >
          <RefreshCw className={`size-3 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {status && (
        <p className="mb-2 text-[10px]" style={{ color: 'var(--subtle)' }}>{status}</p>
      )}

      {partial && !loading && (
        <button
          onClick={() => void fetchEvents()}
          className="mb-2 text-[10px] underline"
          style={{ color: '#c9a020' }}
        >
          Some activity is still loading — Retry
        </button>
      )}

      {loading && events.length === 0 && (
        <div className="flex flex-col gap-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="animate-pulse rounded-xl p-3" style={{ background: 'var(--surface-muted)' }}>
              <div className="h-3 w-32 rounded" style={{ background: 'var(--border)' }} />
            </div>
          ))}
        </div>
      )}

      {!loading && events.length === 0 && (
        <p className="text-xs" style={{ color: 'var(--subtle)' }}>No events found for this channel yet.</p>
      )}

      <div className="flex flex-col gap-1.5">
        {events.map((ev) => {
          const Icon = ICONS[ev.kind]
          const color = EVENT_COLORS[ev.kind]
          return (
            <div
              key={ev.id}
              className="flex items-start gap-3 rounded-xl px-3 py-2.5"
              style={{ background: 'var(--surface-muted)' }}
            >
              <div
                className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-lg"
                style={{ background: `${color}22` }}
              >
                <Icon className="size-3" style={{ color }} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                  <span className="text-xs font-semibold" style={{ color: 'var(--ink)' }}>{ev.kind}</span>
                  {ev.amount !== undefined && (
                    <span className="mono tabular-nums text-xs" style={{ color }}>
                      {parseFloat(formatEther(ev.amount)).toLocaleString('en-US', { maximumFractionDigits: 6 })} USDC
                    </span>
                  )}
                  {ev.extra && (
                    <span className="text-[10px]" style={{ color: 'var(--subtle)' }}>{ev.extra}</span>
                  )}
                </div>
                <div className="mt-0.5 flex flex-wrap gap-x-2 text-[10px]" style={{ color: 'var(--subtle)' }}>
                  {ev.client && (
                    <a href={explorerAddr(ev.client)} target="_blank" rel="noreferrer" className="mono hover:underline">
                      {ev.client.slice(0, 6)}…{ev.client.slice(-4)}
                    </a>
                  )}
                  {ev.client && ev.provider && <span>→</span>}
                  {ev.provider && (
                    <a href={explorerAddr(ev.provider)} target="_blank" rel="noreferrer" className="mono hover:underline">
                      {ev.provider.slice(0, 6)}…{ev.provider.slice(-4)}
                    </a>
                  )}
                  {ev.txHash && (
                    <a href={explorerTx(ev.txHash)} target="_blank" rel="noreferrer" className="mono hover:underline">
                      tx {ev.txHash.slice(0, 8)}…
                    </a>
                  )}
                </div>
              </div>
              <span className="mono shrink-0 text-[10px]" style={{ color: 'var(--subtle)' }}>
                #{ev.blockNumber.toString()}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
