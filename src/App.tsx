import { useState } from 'react'
import { Header } from './components/Header'
import { HowItWorks } from './components/HowItWorks'
import { ClientView } from './components/ClientView'
import { ProviderView } from './components/ProviderView'
import { Footer } from './components/Footer'

type Role = 'client' | 'provider'

export default function App() {
  const [role, setRole] = useState<Role>('client')

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
