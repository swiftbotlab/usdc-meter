import { ArrowDownToLine, FileSignature, Receipt, Clock } from 'lucide-react'

const STEPS = [
  {
    icon: ArrowDownToLine,
    step: '1',
    title: 'Deposit',
    body: 'Client deposits native USDC into a channel for a provider. Stays locked until withdrawn.',
  },
  {
    icon: FileSignature,
    step: '2',
    title: 'Sign per call',
    body: 'Each API call, the client signs a cumulative EIP-712 voucher off-chain. No gas per call.',
  },
  {
    icon: Receipt,
    step: '3',
    title: 'Provider redeems',
    body: 'Provider submits the latest voucher on-chain to collect the delta. Partial pay if balance is short.',
  },
  {
    icon: Clock,
    step: '4',
    title: 'Notice period',
    body: 'Client requests a withdrawal. Provider has the notice window to redeem outstanding vouchers.',
  },
]

export function HowItWorks() {
  return (
    <section
      className="w-full rounded-2xl border p-5"
      style={{ background: 'var(--surface-muted)', borderColor: 'var(--border)' }}
    >
      <p className="mb-4 text-xs font-semibold uppercase tracking-widest" style={{ color: 'var(--subtle)' }}>
        How it works · for services or agents paying each other per call
      </p>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {STEPS.map(({ icon: Icon, step, title, body }) => (
          <div key={step} className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <span
                className="flex size-6 shrink-0 items-center justify-center rounded-lg text-xs font-bold"
                style={{ background: 'rgba(172,198,233,0.15)', color: 'var(--accent)' }}
              >
                {step}
              </span>
              <Icon className="size-3.5" style={{ color: 'var(--muted)' }} />
            </div>
            <div className="text-sm font-semibold" style={{ color: 'var(--ink)' }}>{title}</div>
            <div className="text-xs leading-relaxed" style={{ color: 'var(--subtle)' }}>{body}</div>
          </div>
        ))}
      </div>
    </section>
  )
}
