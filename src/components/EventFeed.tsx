import { useEffect, useState, useCallback } from 'react'
import { usePublicClient, useAccount } from 'wagmi'
import { formatEther } from 'viem'
import { ArrowDownToLine, Receipt, Clock, XCircle, ArrowUpToLine, RefreshCw } from 'lucide-react'
import { ACTIVE_CHAIN, ACTIVE_CFG, METER_ABI, explorerTx, explorerAddr } from '../usdcmeter-config'

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

const CHUNK = 9000n
const MAX_EVENTS = 50

interface Props {
  client?: `0x${string}`
  provider?: `0x${string}`
  /** Bump to force an immediate refresh (e.g. after redeem). */
  refreshKey?: number
}

// Narrow the ABI to the event entries only
type MeterAbi = typeof METER_ABI
type AbiEvent = Extract<MeterAbi[number], { type: 'event' }>

function getEventAbi(name: EventKind): AbiEvent {
  const found = METER_ABI.find((e): e is AbiEvent => e.type === 'event' && e.name === name)
  if (!found) throw new Error(`Event ${name} not in ABI`)
  return found
}

const EVENT_KINDS: EventKind[] = [
  'Deposited',
  'Redeemed',
  'WithdrawRequested',
  'WithdrawCancelled',
  'Withdrawn',
]

export function EventFeed({ client, provider, refreshKey }: Props) {
  const { chainId } = useAccount()
  const publicClient = usePublicClient({ chainId: ACTIVE_CHAIN.id })
  const cfg = ACTIVE_CFG

  const [events, setEvents] = useState<FeedEvent[]>([])
  const [loading, setLoading] = useState(false)
  const [status, setStatus] = useState('')

  const fetchEvents = useCallback(async () => {
    if (!publicClient || !cfg || chainId !== ACTIVE_CHAIN.id) return
    setLoading(true)
    setEvents([])

    try {
      const head = await publicClient.getBlockNumber({ cacheTime: 0 }) // fresh head: the default 4 s cache missed a just-confirmed event
      const deployBlock = cfg.deployBlock

      const collected: FeedEvent[] = []
      let to = head
      let from = to >= CHUNK ? to - CHUNK + 1n : deployBlock
      if (from < deployBlock) from = deployBlock

      outer: while (to >= deployBlock && collected.length < MAX_EVENTS) {
        setStatus(`Scanning blocks ${from.toString()}–${to.toString()}…`)

        for (const kind of EVENT_KINDS) {
          try {
            const eventAbi = getEventAbi(kind)
            // Build args filter — only pass indexed topics
            const argsFilter: Record<string, (`0x${string}` | null)[] | null> = {}
            if (client) argsFilter.client = [client]
            if (provider) argsFilter.provider = [provider]

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const raw: unknown[] = await (publicClient.getLogs as (...a: unknown[]) => Promise<unknown[]>)({
              address: cfg.address,
              event: eventAbi,
              args: argsFilter,
              fromBlock: from,
              toBlock: to,
            })

            for (const logRaw of raw) {
              const log = logRaw as Record<string, unknown>
              const args = (log.args ?? {}) as Record<string, unknown>
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

              collected.push({
                id: `${(log.transactionHash as string | undefined) ?? ''}-${String(Number(log.logIndex ?? 0))}`,
                kind,
                blockNumber: (log.blockNumber as bigint | undefined) ?? 0n,
                txHash: (log.transactionHash as string | undefined) ?? '',
                client: (args.client as string | undefined) ?? '',
                provider: (args.provider as string | undefined) ?? '',
                amount,
                extra,
              })
            }
          } catch {
            // Event may not be present in range — continue
          }
        }

        if (collected.length >= MAX_EVENTS) break outer

        if (from <= deployBlock) break
        to = from - 1n
        from = to >= CHUNK ? to - CHUNK + 1n : deployBlock
        if (from < deployBlock) from = deployBlock
      }

      collected.sort((a, b) => (a.blockNumber > b.blockNumber ? -1 : 1))
      setEvents(collected.slice(0, MAX_EVENTS))
      setStatus(`Showing ${Math.min(collected.length, MAX_EVENTS)} event${collected.length !== 1 ? 's' : ''}`)
    } catch (e) {
      setStatus('Failed to load events')
      console.error(e)
    } finally {
      setLoading(false)
    }
  }, [publicClient, cfg, chainId, client, provider])

  /* oxlint-disable react/set-state-in-effect */
  useEffect(() => {
    void fetchEvents()
  }, [fetchEvents])

  // Fix 4: re-fetch when parent bumps refreshKey (e.g. after a successful redeem)
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
