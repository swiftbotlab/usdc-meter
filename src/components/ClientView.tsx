import { useState, useEffect, useCallback } from 'react'
import { useAccount } from 'wagmi'
import { Check, ExternalLink } from 'lucide-react'
import {
  ACTIVE_CHAIN,
  ACTIVE_CFG,
  providerStorageKey,
  explorerAddr,
  type StoredVoucher,
} from '../usdcmeter-config'
import { ChannelCard } from './ChannelCard'
import { DepositForm } from './DepositForm'
import { WithdrawControls } from './WithdrawControls'
import { DemoApiPanel } from './DemoApiPanel'
import { EventFeed } from './EventFeed'

export function ClientView() {
  const { address } = useAccount()
  const cfg = ACTIVE_CFG
  // bumped after every confirmed deposit / withdrawal tx so the channel card and activity feed refresh at once
  const [refreshKey, setRefreshKey] = useState(0)
  const bump = useCallback(() => setRefreshKey((k) => k + 1), [])
  const [providerInput, setProviderInput] = useState<string>(
    () => localStorage.getItem(providerStorageKey(ACTIVE_CHAIN.id)) ?? '',
  )

  const provider =
    providerInput.startsWith('0x') && providerInput.length === 42
      ? (providerInput as `0x${string}`)
      : undefined

  useEffect(() => {
    if (providerInput.length > 0) {
      localStorage.setItem(providerStorageKey(ACTIVE_CHAIN.id), providerInput)
    }
  }, [providerInput])

  const glass = {
    background: 'var(--surface)',
    backdropFilter: 'blur(20px)',
    WebkitBackdropFilter: 'blur(20px)',
    border: '1px solid var(--border)',
  }

  if (!address) {
    return (
      <div className="rounded-2xl p-8 text-center" style={glass}>
        <p className="text-sm" style={{ color: 'var(--subtle)' }}>Connect your wallet to use the Client view.</p>
      </div>
    )
  }

  const handleVoucherSigned = (_v: StoredVoucher) => {
    // Channel card will auto-refetch; nothing else needed here
  }

  return (
    <div className="flex flex-col gap-5">
      {/* Provider address */}
      <div className="rounded-2xl p-5" style={glass}>
        <h3 className="mb-3 text-sm font-semibold" style={{ color: 'var(--ink)' }}>Provider address</h3>
        <input
          value={providerInput}
          onChange={(e) => setProviderInput(e.target.value.trim())}
          placeholder="0x… provider address"
          className="mono w-full rounded-xl px-3 py-2.5 text-sm outline-none transition-colors"
          style={{
            background: 'var(--surface-muted)',
            color: 'var(--ink)',
            border: '1px solid var(--border)',
          }}
        />
        {provider && (
          <div className="mt-1.5 flex items-center gap-1 text-xs" style={{ color: 'var(--subtle)' }}>
            <Check className="size-3" style={{ color: 'var(--success)' }} />
            Valid ·
            <a href={explorerAddr(provider)} target="_blank" rel="noreferrer" className="hover:underline">
              view on explorer <ExternalLink className="inline size-2.5" />
            </a>
          </div>
        )}
        {provider && provider.toLowerCase() === address?.toLowerCase() && (
          <p className="mt-1 text-xs" style={{ color: 'var(--danger)' }}>
            You cannot open a channel with yourself.
          </p>
        )}
        {cfg && (
          <p className="mt-2 text-[10px]" style={{ color: 'var(--subtle)' }}>
            Contract:{' '}
            <a href={explorerAddr(cfg.address)} target="_blank" rel="noreferrer" className="mono hover:underline">
              {cfg.address.slice(0, 10)}…{cfg.address.slice(-6)}
            </a>
          </p>
        )}
      </div>

      {/* Channel state */}
      <ChannelCard client={address} provider={provider} refreshKey={refreshKey} />

      {/* Deposit */}
      <DepositForm provider={provider} onDeposited={bump} />

      {/* Demo API */}
      {address && provider && (
        <DemoApiPanel provider={provider} onVoucherSigned={handleVoucherSigned} />
      )}

      {/* Withdraw controls */}
      {provider && (
        <WithdrawControls provider={provider} onAction={bump} />
      )}

      {/* Event feed */}
      <EventFeed client={address} provider={provider} refreshKey={refreshKey} />
    </div>
  )
}
