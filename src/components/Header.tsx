import { ConnectKitButton } from 'connectkit'
import { useAccount } from 'wagmi'
import { Zap } from 'lucide-react'
import { ACTIVE_CHAIN, ACTIVE_NETWORK, networkHref, type ArcNetwork } from '../usdcmeter-config'

export function Header() {
  const { chainId } = useAccount()
  const onCorrectChain = chainId === ACTIVE_CHAIN.id

  return (
    <header
      className="sticky top-0 z-30 w-full border-b"
      style={{
        background: 'rgba(13,27,47,0.88)',
        backdropFilter: 'blur(20px) saturate(180%)',
        WebkitBackdropFilter: 'blur(20px) saturate(180%)',
        borderColor: 'var(--border)',
      }}
    >
      <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-4 py-3">
        {/* Brand */}
        <div className="flex items-center gap-2.5">
          <div
            className="flex size-8 items-center justify-center rounded-xl"
            style={{ background: 'var(--accent)', color: '#0d1b2f' }}
          >
            <Zap className="size-4" />
          </div>
          <div>
            <div className="display text-sm font-bold leading-none" style={{ color: 'var(--ink)' }}>
              USDC Meter
            </div>
            <div className="mt-0.5 text-[10px]" style={{ color: 'var(--subtle)' }}>
              by Swift Bot Labs
            </div>
          </div>
        </div>

        {/* Right side */}
        <div className="flex items-center gap-2.5">
          {chainId !== undefined && !onCorrectChain && (
            <span
              className="hidden rounded-full px-2.5 py-1 text-xs font-semibold sm:inline-block"
              style={{ background: 'rgba(232,109,122,0.18)', color: 'var(--danger)' }}
            >
              Wrong network
            </span>
          )}
          {onCorrectChain && (
            <span
              className="hidden rounded-full px-2.5 py-1 text-xs font-semibold sm:inline-block"
              style={{ background: 'rgba(141,216,159,0.14)', color: 'var(--success)' }}
            >
              {ACTIVE_CHAIN.name}
            </span>
          )}
          {/* Network switch: same app, ?network=testnet|mainnet */}
          <nav className="flex rounded-full p-0.5 text-[11px] font-semibold" style={{ background: 'var(--surface-muted)' }} aria-label="Network">
            {(['testnet', 'mainnet'] as ArcNetwork[]).map((n) => (
              <a
                key={n}
                href={networkHref(n)}
                aria-current={n === ACTIVE_NETWORK ? 'page' : undefined}
                className="rounded-full px-2.5 py-1 capitalize"
                style={n === ACTIVE_NETWORK ? { background: 'var(--accent)', color: '#0d1b2f' } : { color: 'var(--subtle)' }}
              >
                {n}
              </a>
            ))}
          </nav>
          <ConnectKitButton />
        </div>
      </div>
    </header>
  )
}
