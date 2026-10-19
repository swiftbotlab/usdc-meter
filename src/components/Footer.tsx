import { useReadContract } from 'wagmi'
import { ExternalLink } from 'lucide-react'
import { METER_ABI, ACTIVE_CHAIN, ACTIVE_CFG, explorerAddr } from '../usdcmeter-config'

export function Footer() {
  const cfg = ACTIVE_CFG

  const { data: noticePeriod } = useReadContract({
    address: cfg?.address,
    abi: METER_ABI,
    functionName: 'noticePeriod',
    chainId: ACTIVE_CHAIN.id,
    query: { enabled: !!cfg },
  })

  return (
    <footer
      className="mt-auto border-t py-6"
      style={{ borderColor: 'var(--border)' }}
    >
      <div className="mx-auto max-w-5xl px-4">
        <div className="flex flex-wrap items-center justify-between gap-3 text-xs" style={{ color: 'var(--subtle)' }}>
          <div className="flex flex-wrap items-center gap-4">
            {cfg && (
              <a
                href={explorerAddr(cfg.address)}
                target="_blank"
                rel="noreferrer"
                className="mono flex items-center gap-1 hover:underline"
              >
                {cfg.address.slice(0, 10)}…{cfg.address.slice(-6)}
                <ExternalLink className="size-2.5" />
              </a>
            )}
            {noticePeriod !== undefined && (
              <span>Notice period: {Number(noticePeriod)}s</span>
            )}
            <span>{ACTIVE_CHAIN.name}</span>
          </div>
          <span style={{ color: 'var(--muted)' }}>Swift Bot Labs</span>
        </div>
      </div>
    </footer>
  )
}
