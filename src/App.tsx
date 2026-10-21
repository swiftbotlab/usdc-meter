import { useState } from 'react'
import { Search } from 'lucide-react'
import { Header } from './components/Header'
import { HowItWorks } from './components/HowItWorks'
import { ClientView } from './components/ClientView'
import { ProviderView } from './components/ProviderView'
import { ChannelCard } from './components/ChannelCard'
import { EventFeed } from './components/EventFeed'
import { Footer } from './components/Footer'

type Role = 'client' | 'provider'

function readParam(name: string): string {
  try {
    return new URLSearchParams(window.location.search).get(name)?.trim() ?? ''
  } catch {
    return ''
  }
}
function asAddr(v: string): `0x${string}` | undefined {
  const s = v.trim()
  return /^0x[0-9a-fA-F]{40}$/.test(s) ? (s as `0x${string}`) : undefined
}

// Walletless channel lookup: read channel state + activity for any client→provider
// pair from the URL (?provider=…&client=…) or typed in, with no wallet connected.
function ChannelLookup() {
  const [clientInput, setClientInput] = useState(() => readParam('client'))
  const [providerInput, setProviderInput] = useState(() => readParam('provider'))
  const client = asAddr(clientInput)
  const provider = asAddr(providerInput)

  const input = {
    background: 'var(--surface-muted)',
    color: 'var(--ink)',
    border: '1px solid var(--border)',
  }

  return (
    <div className="mb-6 flex flex-col gap-4">
      <div
        className="rounded-2xl p-5"
        style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
      >
        <div className="mb-3 flex items-center gap-2">
          <Search className="size-4" style={{ color: 'var(--accent)' }} />
          <h3 className="text-sm font-semibold" style={{ color: 'var(--ink)' }}>
            Look up a channel
          </h3>
          <span className="text-[11px]" style={{ color: 'var(--subtle)' }}>no wallet needed</span>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          <input
            value={clientInput}
            onChange={(e) => setClientInput(e.target.value.trim())}
            placeholder="0x… client address"
            className="mono w-full rounded-xl px-3 py-2.5 text-sm outline-none"
            style={input}
          />
          <input
            value={providerInput}
            onChange={(e) => setProviderInput(e.target.value.trim())}
            placeholder="0x… provider address"
            className="mono w-full rounded-xl px-3 py-2.5 text-sm outline-none"
            style={input}
          />
        </div>
        <p className="mt-2 text-[11px]" style={{ color: 'var(--subtle)' }}>
          Reads channel balances and on-chain activity straight from Arc — shareable, no connection required.
        </p>
      </div>

      {client && provider ? (
        <>
          <ChannelCard client={client} provider={provider} readOnly perspective="client" />
          <EventFeed client={client} provider={provider} />
        </>
      ) : (
        <div
          className="rounded-2xl p-5 text-sm"
          style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--subtle)' }}
        >
          Enter a valid client and provider address above to view the channel.
        </div>
      )}
    </div>
  )
}

export default function App() {
  const [role, setRole] = useState<Role>('client')

  // A shared lookup link (?provider=… or ?client=…) opens the walletless lookup directly.
  const hasLookupParams = !!readParam('provider') || !!readParam('client')
  const [showLookup, setShowLookup] = useState<boolean>(hasLookupParams)

  return (
    <div className="flex min-h-dvh flex-col" style={{ background: 'var(--bg-gradient)' }}>
      <Header />

      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8">
        {/* Tagline */}
        <div className="mb-8 text-center">
          <h1 className="display mb-2 text-3xl font-bold tracking-tight" style={{ color: 'var(--ink)', letterSpacing: '-0.03em' }}>
            USDC Meter
          </h1>
          <p className="mx-auto max-w-md text-sm" style={{ color: 'var(--subtle)' }}>
            Prepaid metered billing in USDC on Arc. One deposit, a signed voucher per API call, settle whenever you like.
          </p>
        </div>

        {/* How it works */}
        <div className="mb-6">
          <HowItWorks />
        </div>

        {/* Walletless channel lookup */}
        {showLookup ? (
          <ChannelLookup />
        ) : (
          <div className="mb-6 text-center">
            <button
              onClick={() => setShowLookup(true)}
              className="inline-flex items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-semibold transition-colors"
              style={{ background: 'var(--surface-muted)', color: 'var(--muted)', border: '1px solid var(--border)' }}
            >
              <Search className="size-3" />
              Look up a channel (no wallet)
            </button>
          </div>
        )}

        {/* Role switch */}
        <div
          className="mb-6 flex rounded-2xl p-1"
          style={{ background: 'var(--surface-muted)' }}
        >
          {(['client', 'provider'] as Role[]).map((r) => (
            <button
              key={r}
              onClick={() => setRole(r)}
              className="flex-1 rounded-xl py-2.5 text-sm font-semibold capitalize transition-all"
              style={
                role === r
                  ? { background: 'var(--accent)', color: '#0d1b2f' }
                  : { color: 'var(--subtle)' }
              }
            >
              {r}
            </button>
          ))}
        </div>

        {/* View */}
        {role === 'client' ? <ClientView /> : <ProviderView />}
      </main>

      <Footer />
    </div>
  )
}
