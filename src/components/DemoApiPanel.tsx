import { useState, useCallback, useRef, useEffect } from 'react'
import { useSignTypedData, useAccount, useReadContract } from 'wagmi'
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
import { checkVoucher, parseVoucher } from '../voucher-check'

const FAKE_RESPONSES = [
  { quote: '"Simplicity is the ultimate sophistication." — Leonardo da Vinci' },
  { quote: '"First, solve the problem. Then, write the code." — John Johnson' },
  { quote: '"Programs must be written for people to read." — Abelson & Sussman' },
  { quote: '"Any fool can write code that a computer can understand." — Martin Fowler' },
  { quote: '"Code is like humor. When you have to explain it, it\'s bad." — Cory House' },
]

interface CallLogEntry {
  id: number
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

function lsGet(key: string): string | null {
  try { return localStorage.getItem(key) } catch { return null }
}
function lsSet(key: string, value: string) {
  try { localStorage.setItem(key, value) } catch { /* storage blocked */ }
}

/** The simulated provider's own memory: the highest cumulative it has accepted (and served) for this channel. */
function acceptedKey(meter: string, client: string, provider: string) {
  return `usdcmeter:provider-accepted:${ACTIVE_CHAIN.id}:${meter}:${client.toLowerCase()}:${provider.toLowerCase()}`
}
const PRICE_KEY = `usdcmeter:price:${ACTIVE_CHAIN.id}`

export function DemoApiPanel({ provider, onVoucherSigned }: Props) {
  const { address, chainId } = useAccount()
  // persisted, so switching the Client/Provider tab (which remounts this panel) keeps the price
  const [pricePerCall, setPricePerCall] = useState(() => lsGet(PRICE_KEY) ?? '0.01')
  const [log, setLog] = useState<CallLogEntry[]>([])
  const [collapsed, setCollapsed] = useState(false)
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)
  const inFlight = useRef(false) // synchronous guard: a double click in the same tick signs only once
  const logId = useRef(0)

  useEffect(() => { if (pricePerCall) lsSet(PRICE_KEY, pricePerCall) }, [pricePerCall])

  const cfg = ACTIVE_CFG
  const { signTypedDataAsync } = useSignTypedData()

  // Read channel to know available balance, on-chain redeemed and withdrawal state
  const { data: channelData, refetch } = useReadContract({
    address: cfg?.address,
    abi: METER_ABI,
    functionName: 'getChannel',
    args: address && provider ? [address, provider] : undefined,
    chainId: ACTIVE_CHAIN.id,
    query: { enabled: !!address && !!provider && !!cfg && chainId === ACTIVE_CHAIN.id, refetchInterval: 4000 },
  })

  const available: bigint = channelData ? (channelData[4]) : 0n
  const onChainRedeemed: bigint = channelData ? BigInt(String(channelData[2])) : 0n
  const withdrawReadyAt: number = channelData ? Number(channelData[3]) : 0

  // Latest voucher this client signed (localStorage, untrusted: parsed defensively)
  const getStoredVoucher = useCallback((): StoredVoucher | null => {
    if (!address || !provider || !cfg) return null
    const { v } = parseVoucher(lsGet(voucherStorageKey(ACTIVE_CHAIN.id, cfg.address, address, provider)))
    return v ?? null
  }, [address, provider, cfg])

  const storeVoucher = useCallback(
    (v: StoredVoucher) => {
      if (!address || !provider || !cfg) return
      lsSet(voucherStorageKey(ACTIVE_CHAIN.id, cfg.address, address, provider), JSON.stringify(v))
    },
    [address, provider, cfg],
  )

  const getAccepted = useCallback((): bigint => {
    if (!address || !provider || !cfg) return 0n
    const raw = lsGet(acceptedKey(cfg.address, address, provider))
    return raw && /^\d{1,78}$/.test(raw) ? BigInt(raw) : 0n
  }, [address, provider, cfg])

  const addLog = (e: Omit<CallLogEntry, 'id'>) => {
    logId.current += 1
    const entry = { ...e, id: logId.current }
    setLog((prev) => [entry, ...prev.slice(0, 19)])
  }

  const handleCall = async () => {
    if (!address || !provider || !cfg) return
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    try {
      let price: bigint
      try { price = parseEther(pricePerCall) } catch { return }
      if (price === 0n) return

      // fresh channel state right before deciding (not the 4 s poll)
      const fresh = (await refetch()).data ?? channelData
      if (!fresh) return
      const redeemedNow = BigInt(String(fresh[2]))
      const availNow: bigint = fresh[4]
      const readyNow = Number(fresh[3])

      const stored = getStoredVoucher()
      const storedCumulative = stored ? BigInt(stored.cumulativeAmount) : 0n
      const accepted = getAccepted()
      const callCount = (stored?.callCount ?? 0) + 1

      // The provider refuses service while a withdrawal is pending or matured: don't sign anything.
      if (readyNow !== 0) {
        addLog({ index: callCount, cumulative: formatEther(storedCumulative), signature: '', verified: false,
          reason: 'Refused: a withdrawal is pending. The provider stops serving until you cancel it.' })
        return
      }

      // Next cumulative = max(what I signed, what was redeemed, what the provider says it accepted) + price.
      // (A real API returns its last accepted cumulative with each response; here it is simulated.)
      let base = storedCumulative > redeemedNow ? storedCumulative : redeemedNow
      if (accepted > base) base = accepted
      const newCumulative = base + price

      // Never sign beyond the prepaid balance
      const wouldSpend = newCumulative - redeemedNow
      if (wouldSpend > availNow) {
        addLog({ index: callCount, cumulative: formatEther(newCumulative), signature: '', verified: false,
          reason: `Insufficient available balance (need ${formatEther(wouldSpend)}, have ${formatEther(availNow)} USDC)` })
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

      // Simulated provider: same checks a real provider runs before serving (see src/voucher-check.ts)
      const res = await checkVoucher({
        v: newVoucher,
        chainId: ACTIVE_CHAIN.id,
        meter: cfg.address,
        expectedClient: address,
        self: provider,
        channel: { redeemed: redeemedNow, available: availNow, withdrawReadyAt: readyNow },
        minCumulative: (accepted > redeemedNow ? accepted : redeemedNow) + price,
        forServing: true,
      })
      if (res.ok) lsSet(acceptedKey(cfg.address, address, provider), newCumulative.toString())

      addLog({
        index: callCount,
        cumulative: formatEther(newCumulative),
        signature: sig,
        verified: res.ok,
        reason: res.ok ? undefined : res.error,
        response: res.ok ? FAKE_RESPONSES[callCount % FAKE_RESPONSES.length].quote : undefined,
      })
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  const latestVoucher = getStoredVoucher()

  // base for the display is max(stored, on-chain redeemed)
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

  const canCall = !!address && !!provider && !!pricePerCall && chainId === ACTIVE_CHAIN.id && !!cfg && !busy

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
        Each click signs a cumulative EIP-712 voucher (no gas per call). The simulated provider checks it the way a real
        one should: signer, canonical signature, cumulative ≥ last accepted + price, within the prepaid balance, and no
        withdrawal pending.
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

      {withdrawReadyAt !== 0 && (
        <div className="mb-3 flex items-center gap-2 rounded-xl px-3 py-2 text-xs" style={{ background: 'rgba(255,200,80,0.12)', color: '#c9a020' }}>
          <AlertCircle className="size-3.5 shrink-0" />
          Withdrawal pending: the provider stops serving calls (and redeems) until you cancel it.
        </div>
      )}

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
        {busy ? 'Signing…' : 'Call the API'}
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
                  key={entry.id}
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
