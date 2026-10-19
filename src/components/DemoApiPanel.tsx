import { useState, useCallback } from 'react'
import { useSignTypedData, useAccount, useReadContract } from 'wagmi'
import { recoverTypedDataAddress } from 'viem'
import { parseEther, formatEther } from 'viem'
import { Copy, Check, ChevronDown, ChevronUp, AlertCircle } from 'lucide-react'
import {
  METER_ABI,
  ACTIVE_CHAIN,
  ACTIVE_CFG,
  voucherDomain,
  VOUCHER_TYPES,
  voucherStorageKey,
  type StoredVoucher,
} from '../usdcmeter-config'

const FAKE_RESPONSES = [
  { quote: '"Simplicity is the ultimate sophistication." — Leonardo da Vinci' },
  { quote: '"First, solve the problem. Then, write the code." — John Johnson' },
  { quote: '"Programs must be written for people to read." — Abelson & Sussman' },
  { quote: '"Any fool can write code that a computer can understand." — Martin Fowler' },
  { quote: '"Code is like humor. When you have to explain it, it\'s bad." — Cory House' },
]

interface CallLogEntry {
  index: number
  cumulative: string
  signature: string
  verified: boolean
  reason?: string
  response?: string
}

interface Props {
  provider: `0x${string}` | undefined
  onVoucherSigned?: (v: StoredVoucher) => void
}

export function DemoApiPanel({ provider, onVoucherSigned }: Props) {
  const { address, chainId } = useAccount()
  const [pricePerCall, setPricePerCall] = useState('0.01')
  const [log, setLog] = useState<CallLogEntry[]>([])
  const [collapsed, setCollapsed] = useState(false)
  const [copied, setCopied] = useState(false)

  const cfg = ACTIVE_CFG
  const { signTypedDataAsync } = useSignTypedData()

  // Read channel to know available balance and on-chain redeemed
  const { data: channelData } = useReadContract({
    address: cfg?.address,
    abi: METER_ABI,
    functionName: 'getChannel',
    args: address && provider ? [address, provider] : undefined,
    chainId: ACTIVE_CHAIN.id,
    query: { enabled: !!address && !!provider && !!cfg && chainId === ACTIVE_CHAIN.id, refetchInterval: 4000 },
  })

  const available: bigint = channelData ? (channelData[4]) : 0n
  // Fix 1: on-chain redeemed — the authoritative floor for the next cumulative
  const onChainRedeemed: bigint = channelData ? BigInt(String(channelData[2])) : 0n

  // Recover last cumulative from localStorage
  const getStoredVoucher = useCallback((): StoredVoucher | null => {
    if (!address || !provider || !cfg) return null
    const key = voucherStorageKey(ACTIVE_CHAIN.id, cfg.address, address, provider)
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as StoredVoucher) : null
  }, [address, provider, cfg])

  const storeVoucher = useCallback(
    (v: StoredVoucher) => {
      if (!address || !provider || !cfg) return
      const key = voucherStorageKey(ACTIVE_CHAIN.id, cfg.address, address, provider)
      localStorage.setItem(key, JSON.stringify(v))
    },
    [address, provider, cfg],
  )

  const handleCall = async () => {
    if (!address || !provider || !cfg) return

    let price: bigint
    try { price = parseEther(pricePerCall) } catch { return }
    if (price === 0n) return

    const stored = getStoredVoucher()
    const storedCumulative = stored ? BigInt(stored.cumulativeAmount) : 0n

    // Fix 1: base = max(stored cumulative, on-chain redeemed)
    const base = storedCumulative > onChainRedeemed ? storedCumulative : onChainRedeemed
    const newCumulative = base + price

    // Check balance before signing: the new spend on top of what's already redeemed
    const wouldSpend = newCumulative - onChainRedeemed
    if (wouldSpend > available) {
      setLog((prev) => [
        {
          index: (stored?.callCount ?? 0) + 1,
          cumulative: formatEther(newCumulative),
          signature: '',
          verified: false,
          reason: `Insufficient available balance (need ${formatEther(wouldSpend)}, have ${formatEther(available)} USDC)`,
        },
        ...prev,
      ])
      return
    }

    let sig: `0x${string}`
    try {
      sig = await signTypedDataAsync({
        domain: voucherDomain(ACTIVE_CHAIN.id, cfg.address),
        types: VOUCHER_TYPES,
        primaryType: 'Voucher',
        message: { client: address, provider, cumulativeAmount: newCumulative },
      })
    } catch {
      return // user rejected
    }

    // Fix 1: Simulated provider verification — also checks newCumulative > redeemed and spend <= available
    let verified = false
    let reason: string | undefined
    try {
      const recovered = await recoverTypedDataAddress({
        domain: voucherDomain(ACTIVE_CHAIN.id, cfg.address),
        types: VOUCHER_TYPES,
        primaryType: 'Voucher',
        message: { client: address, provider, cumulativeAmount: newCumulative },
        signature: sig,
      })
      if (recovered.toLowerCase() !== address.toLowerCase()) {
        reason = 'Signer mismatch'
      } else if (newCumulative <= onChainRedeemed) {
        // Fix 1: must exceed on-chain redeemed, not just stored cumulative
        reason = `Cumulative (${formatEther(newCumulative)}) must exceed on-chain redeemed (${formatEther(onChainRedeemed)})`
      } else if (newCumulative - onChainRedeemed > available) {
        // Fix 1: (newCumulative - redeemed) must not exceed available
        reason = 'Exceeds available balance'
      } else {
        verified = true
      }
    } catch {
      reason = 'Signature verification failed'
    }

    const callCount = (stored?.callCount ?? 0) + 1
    const newVoucher: StoredVoucher = {
      client: address,
      provider,
      cumulativeAmount: newCumulative.toString(),
      signature: sig,
      callCount,
      pricePerCall: price.toString(),
    }
    storeVoucher(newVoucher)
    onVoucherSigned?.(newVoucher)

    const fakeResponse = verified
      ? FAKE_RESPONSES[callCount % FAKE_RESPONSES.length].quote
      : undefined

    setLog((prev) => [
      {
        index: callCount,
        cumulative: formatEther(newCumulative),
        signature: sig,
        verified,
        reason,
        response: fakeResponse,
      },
      ...prev.slice(0, 19),
    ])
  }

  const latestVoucher = getStoredVoucher()

  // Fix 1: base for the display is max(stored, on-chain redeemed)
  const storedCumulative = latestVoucher ? BigInt(latestVoucher.cumulativeAmount) : 0n
  const displayBase = storedCumulative > onChainRedeemed ? storedCumulative : onChainRedeemed

  const copyVoucher = () => {
    if (!latestVoucher) return
    void navigator.clipboard.writeText(JSON.stringify(latestVoucher, null, 2))
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const glass = {
    background: 'var(--surface)',
    backdropFilter: 'blur(20px)',
    WebkitBackdropFilter: 'blur(20px)',
    border: '1px solid var(--border)',
  }

  const canCall = !!address && !!provider && !!pricePerCall && chainId === ACTIVE_CHAIN.id && !!cfg

  if (!cfg) {
    return (
      <div className="rounded-2xl p-5" style={{ ...glass, borderColor: 'rgba(232,109,122,0.4)' }}>
        <p className="text-sm" style={{ color: 'var(--danger)' }}>
          Contract not deployed on {ACTIVE_CHAIN.name} yet.
        </p>
      </div>
    )
  }

  return (
    <div className="rounded-2xl p-5" style={glass}>
      <div className="mb-1 flex items-center justify-between">
        <h3 className="text-sm font-semibold" style={{ color: 'var(--ink)' }}>Demo API</h3>
        <span
          className="rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider"
          style={{ background: 'rgba(172,198,233,0.15)', color: 'var(--accent)' }}
        >
          Simulated in browser
        </span>
      </div>
      <p className="mb-4 text-xs" style={{ color: 'var(--subtle)' }}>
        Each click signs a cumulative EIP-712 voucher. The simulated provider verifies it in-browser.
        No gas per call.
      </p>

      {/* Price input */}
      <div className="mb-3 flex items-center gap-2">
        <label className="text-xs font-medium shrink-0" style={{ color: 'var(--muted)' }}>Price/call</label>
        <div className="flex flex-1 items-center gap-1 rounded-xl px-3 py-2" style={{ background: 'var(--surface-muted)' }}>
          <input
            inputMode="decimal"
            value={pricePerCall}
            onChange={(e) => {
              const v = e.target.value.replace(/[^0-9.]/g, '')
              if (v === '' || /^\d*\.?\d*$/.test(v)) setPricePerCall(v)
            }}
            className="mono w-full bg-transparent text-sm tabular-nums outline-none"
            style={{ color: 'var(--ink)' }}
          />
          <span className="text-xs" style={{ color: 'var(--subtle)' }}>USDC</span>
        </div>
      </div>

      {/* Fix 1: always show the effective base (max of stored vs on-chain redeemed) */}
      <div className="mb-3 flex items-center gap-2 rounded-xl px-3 py-2 text-xs" style={{ background: 'var(--surface-muted)' }}>
        <span style={{ color: 'var(--subtle)' }}>Cumulative so far:</span>
        <span className="mono tabular-nums font-semibold" style={{ color: 'var(--ink)' }}>
          {parseFloat(formatEther(displayBase)).toLocaleString('en-US', { maximumFractionDigits: 6 })} USDC
        </span>
        {onChainRedeemed > storedCumulative && (
          <span className="ml-1 text-[10px]" style={{ color: '#c9a020' }}>
            (raised to match on-chain redeemed)
          </span>
        )}
        {latestVoucher && (
          <span className="ml-auto" style={{ color: 'var(--subtle)' }}>({latestVoucher.callCount} calls)</span>
        )}
      </div>

      {available === 0n && (
        <div className="mb-3 flex items-center gap-2 rounded-xl px-3 py-2 text-xs" style={{ background: 'rgba(232,109,122,0.12)', color: 'var(--danger)' }}>
          <AlertCircle className="size-3.5 shrink-0" />
          No available balance. Deposit USDC first.
        </div>
      )}

      <button
        onClick={() => void handleCall()}
        disabled={!canCall}
        className="mb-4 flex w-full items-center justify-center gap-2 rounded-2xl py-3 text-sm font-semibold transition-all hover:scale-[1.01] active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-40"
        style={{ background: 'var(--accent)', color: '#0d1b2f' }}
      >
        Call the API
      </button>

      {/* Latest voucher */}
      {latestVoucher && (
        <div className="mb-3 rounded-xl p-3" style={{ background: 'var(--surface-muted)' }}>
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-semibold" style={{ color: 'var(--muted)' }}>Latest voucher</span>
            <button
              onClick={copyVoucher}
              className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs transition-colors"
              style={{ background: 'var(--border)', color: 'var(--muted)' }}
            >
              {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
              {copied ? 'Copied' : 'Copy JSON'}
            </button>
          </div>
          <div className="mono overflow-x-auto whitespace-nowrap text-[10px]" style={{ color: 'var(--subtle)' }}>
            <span>cumulative: </span>
            <span style={{ color: 'var(--ink)' }}>
              {parseFloat(formatEther(BigInt(latestVoucher.cumulativeAmount))).toLocaleString('en-US', { maximumFractionDigits: 8 })} USDC
            </span>
            <span className="ml-3">sig: </span>
            <span style={{ color: 'var(--ink)' }}>
              {latestVoucher.signature.slice(0, 10)}…{latestVoucher.signature.slice(-6)}
            </span>
          </div>
        </div>
      )}

      {/* Call log */}
      {log.length > 0 && (
        <div>
          <button
            onClick={() => setCollapsed((c) => !c)}
            className="mb-2 flex items-center gap-1 text-xs font-semibold"
            style={{ color: 'var(--muted)' }}
          >
            Call log ({log.length})
            {collapsed ? <ChevronDown className="size-3" /> : <ChevronUp className="size-3" />}
          </button>
          {!collapsed && (
            <div className="max-h-56 overflow-y-auto rounded-xl" style={{ background: 'var(--surface-muted)' }}>
              {log.map((entry) => (
                <div
                  key={entry.index}
                  className="border-b px-3 py-2.5 last:border-b-0"
                  style={{ borderColor: 'var(--border)' }}
                >
                  <div className="flex items-center gap-2">
                    <span className="mono text-[10px] tabular-nums" style={{ color: 'var(--subtle)' }}>
                      #{entry.index}
                    </span>
                    <span
                      className="rounded px-1.5 py-0.5 text-[10px] font-semibold"
                      style={{
                        background: entry.verified ? 'rgba(141,216,159,0.18)' : 'rgba(232,109,122,0.18)',
                        color: entry.verified ? 'var(--success)' : 'var(--danger)',
                      }}
                    >
                      {entry.verified ? 'Verified' : 'Rejected'}
                    </span>
                    <span className="mono tabular-nums text-[10px]" style={{ color: 'var(--ink)' }}>
                      {parseFloat(entry.cumulative).toLocaleString('en-US', { maximumFractionDigits: 6 })} USDC cumulative
                    </span>
                  </div>
                  {entry.reason && (
                    <div className="mt-0.5 text-[10px]" style={{ color: 'var(--danger)' }}>{entry.reason}</div>
                  )}
                  {entry.response && (
                    <div className="mt-1 text-[10px] italic" style={{ color: 'var(--subtle)' }}>{entry.response}</div>
                  )}
                  {entry.signature && (
                    <div className="mono mt-0.5 text-[10px]" style={{ color: 'var(--muted)' }}>
                      {entry.signature.slice(0, 12)}…{entry.signature.slice(-6)}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
