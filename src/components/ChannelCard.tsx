import { useReadContract, useAccount, useSwitchChain } from 'wagmi'
import { Clock, ExternalLink } from 'lucide-react'
import { METER_ABI, ACTIVE_CHAIN, ACTIVE_CFG, explorerAddr } from '../usdcmeter-config'
import { formatEther } from 'viem'
import { useEffect, useState } from 'react'

interface Props {
  client: `0x${string}` | undefined
  provider: `0x${string}` | undefined
  /** External refetch trigger — bump to force an immediate refresh. */
  refreshKey?: number
}

function useCountdown(targetTs: number | undefined): string {
  const [display, setDisplay] = useState('')

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- initializing countdown state from external deps is correct
    if (!targetTs) { setDisplay(''); return }
    const tick = () => {
      // oxlint-disable-next-line react/purity -- live countdown reads wall time
      const diff = targetTs * 1000 - Date.now()
      if (diff <= 0) { setDisplay('Ready'); return }
      const h = Math.floor(diff / 3_600_000)
      const m = Math.floor((diff % 3_600_000) / 60_000)
      const s = Math.floor((diff % 60_000) / 1000)
      setDisplay(h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`)
    }
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [targetTs])

  return display
}

function fmt(raw: bigint) {
  return parseFloat(formatEther(raw)).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  })
}

export function ChannelCard({ client, provider, refreshKey }: Props) {
  const { chainId } = useAccount()
  const { switchChain } = useSwitchChain()
  const cfg = ACTIVE_CFG

  const enabled =
    !!client && !!provider && !!cfg && chainId === ACTIVE_CHAIN.id

  const { data, isLoading, refetch } = useReadContract({
    address: cfg?.address,
    abi: METER_ABI,
    functionName: 'getChannel',
    args: client && provider ? [client, provider] : undefined,
    chainId: ACTIVE_CHAIN.id,
    query: { enabled, refetchInterval: 5000 },
  })

  // Fire an extra refetch when parent signals a refresh
  useEffect(() => {
    if (refreshKey !== undefined && refreshKey > 0) {
      void refetch()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey])

  const withdrawReadyAt: number | undefined =
    data ? Number(data[3]) : undefined
  const countdown = useCountdown(
    withdrawReadyAt && withdrawReadyAt > 0 ? withdrawReadyAt : undefined
  )

  // oxlint-disable-next-line react/purity -- live badge needs wall time
  const nowSec = Math.trunc(Date.now() / 1000)
  const isPending = !!withdrawReadyAt && withdrawReadyAt > 0 && withdrawReadyAt > nowSec
  const isReady = !!withdrawReadyAt && withdrawReadyAt > 0 && withdrawReadyAt <= nowSec

  const statusBadge = isReady
    ? { label: 'Ready to withdraw', bg: 'rgba(141,216,159,0.18)', color: 'var(--success)' }
    : isPending
    ? { label: `Withdrawal pending · ${countdown}`, bg: 'rgba(255,200,80,0.15)', color: '#c9a020' }
    : { label: 'Open', bg: 'rgba(172,198,233,0.15)', color: 'var(--accent)' }

  const deposited: bigint = data ? (data[0]) : 0n
  const withdrawn: bigint = data ? (data[1]) : 0n
  const redeemed: bigint = data ? (data[2]) : 0n
  const available: bigint = data ? (data[4]) : 0n

  const glass = {
    background: 'var(--surface)',
    backdropFilter: 'blur(20px)',
    WebkitBackdropFilter: 'blur(20px)',
    border: '1px solid var(--border)',
  }

  // No contract on this network yet
  if (!cfg) {
    return (
      <div className="rounded-2xl p-5" style={{ ...glass, borderColor: 'rgba(232,109,122,0.4)' }}>
        <p className="text-sm" style={{ color: 'var(--danger)' }}>
          Contract not deployed on {ACTIVE_CHAIN.name} yet.
        </p>
      </div>
    )
  }

  if (!client || !provider) {
    return (
      <div className="rounded-2xl p-5" style={{ ...glass, opacity: 0.5 }}>
        <p className="text-sm" style={{ color: 'var(--subtle)' }}>Enter a provider address to see channel state.</p>
      </div>
    )
  }

  if (chainId !== ACTIVE_CHAIN.id) {
    return (
      <div className="rounded-2xl p-5" style={glass}>
        <p className="mb-3 text-sm" style={{ color: 'var(--subtle)' }}>
          Switch to {ACTIVE_CHAIN.name} to read channel state.
        </p>
        <button
          onClick={() => switchChain({ chainId: ACTIVE_CHAIN.id })}
          className="rounded-xl px-4 py-2 text-sm font-semibold"
          style={{ background: 'var(--accent)', color: '#0d1b2f' }}
        >
          Switch to {ACTIVE_CHAIN.name}
        </button>
      </div>
    )
  }

  return (
    <div className="rounded-2xl p-5" style={glass}>
      {/* Header row */}
      <div className="mb-4 flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold uppercase tracking-widest" style={{ color: 'var(--subtle)' }}>
              Channel
            </span>
            <a
              href={explorerAddr(cfg.address)}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-0.5 text-xs"
              style={{ color: 'var(--subtle)' }}
            >
              <ExternalLink className="size-2.5" />
            </a>
          </div>
          <div className="mt-0.5 flex items-center gap-1 font-mono text-[11px]" style={{ color: 'var(--muted)' }}>
            <a href={explorerAddr(client)} target="_blank" rel="noreferrer" className="hover:underline">
              {client.slice(0, 6)}…{client.slice(-4)}
            </a>
            <span>→</span>
            <a href={explorerAddr(provider)} target="_blank" rel="noreferrer" className="hover:underline">
              {provider.slice(0, 6)}…{provider.slice(-4)}
            </a>
          </div>
        </div>
        <span
          className="rounded-full px-2.5 py-1 text-xs font-semibold"
          style={{ background: statusBadge.bg, color: statusBadge.color }}
        >
          {isPending && <Clock className="mr-1 inline size-3" />}
          {statusBadge.label}
        </span>
      </div>

      {/* Stats grid */}
      {isLoading ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="animate-pulse rounded-xl p-3" style={{ background: 'var(--surface-muted)' }}>
              <div className="mb-1.5 h-2 w-16 rounded" style={{ background: 'var(--border)' }} />
              <div className="h-5 w-20 rounded" style={{ background: 'var(--border)' }} />
            </div>
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            { label: 'Available', value: fmt(available), accent: true },
            { label: 'Deposited', value: fmt(deposited) },
            { label: 'Redeemed', value: fmt(redeemed) },
            { label: 'Withdrawn', value: fmt(withdrawn) },
          ].map(({ label, value, accent }) => (
            <div
              key={label}
              className="rounded-xl p-3"
              style={{ background: 'var(--surface-muted)' }}
            >
              <div className="mb-1 text-xs" style={{ color: 'var(--subtle)' }}>{label}</div>
              <div
                className="display tabular-nums text-lg font-bold"
                style={{ color: accent ? 'var(--accent)' : 'var(--ink)' }}
              >
                {value}
              </div>
              <div className="text-[10px]" style={{ color: 'var(--muted)' }}>USDC</div>
            </div>
          ))}
        </div>
      )}

      <button
        onClick={() => void refetch()}
        className="mt-3 text-xs"
        style={{ color: 'var(--subtle)' }}
      >
        Refresh
      </button>
    </div>
  )
}
