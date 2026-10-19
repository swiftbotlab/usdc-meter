import { useState, useEffect, useCallback, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useWriteContract, useWaitForTransactionReceipt, useAccount, useSwitchChain, useReadContract, usePublicClient } from 'wagmi'
import { recoverTypedDataAddress, parseAbiItem, formatEther } from 'viem'
import { toast } from 'sonner'
import { ExternalLink, ClipboardPaste, AlertTriangle, Check } from 'lucide-react'
import {
  METER_ABI,
  ACTIVE_CHAIN,
  ACTIVE_CFG,
  explorerTx,
  explorerAddr,
  voucherDomain,
  VOUCHER_TYPES,
  voucherStorageKey,
  clientStorageKey,
  type StoredVoucher,
} from '../usdcmeter-config'
import { ChannelCard } from './ChannelCard'
import { TxButton } from './TxButton'
import { EventFeed } from './EventFeed'

// Fix 2: corrected error key matching (one 'e' in 'redeem') + full error map
function parseOnchainError(err: unknown): string {
  const msg = (err as Error)?.message?.toLowerCase() ?? ''
  if (msg.includes('user rejected') || msg.includes('denied')) return 'Cancelled.'
  if (msg.includes('invalidsigner')) return 'Invalid signature — signer does not match client.'
  if (msg.includes('nothingtoredeem')) return 'Nothing to redeem — cumulative must exceed already-redeemed amount.'
  if (msg.includes('nopayout')) return 'No payout available — balance may be zero after redemption.'
  if (msg.includes('transferfailed')) return 'Native transfer to provider failed.'
  if (msg.includes('tooearlytowithdraw')) return 'Notice period has not elapsed yet.'
  if (msg.includes('withdrawalreadypending')) return 'A withdrawal is already pending.'
  if (msg.includes('nopendingwithdraw')) return 'No pending withdrawal to complete.'
  if (msg.includes('noavailablebalance')) return 'No available balance to withdraw.'
  return 'Transaction failed. Try again.'
}

export function ProviderView() {
  const { address, chainId } = useAccount()
  const { switchChain } = useSwitchChain()
  const cfg = ACTIVE_CFG
  const publicClient = usePublicClient({ chainId: ACTIVE_CHAIN.id })

  const [clientInput, setClientInput] = useState<string>(
    () => localStorage.getItem(clientStorageKey(ACTIVE_CHAIN.id)) ?? '',
  )
  const [voucherJson, setVoucherJson] = useState('')
  const [parsedVoucher, setParsedVoucher] = useState<StoredVoucher | null>(null)
  const [voucherError, setVoucherError] = useState('')
  const [isVerified, setIsVerified] = useState<boolean | null>(null)
  const [withdrawAlert, setWithdrawAlert] = useState<string | null>(null)
  // Fix 4: bump this to trigger ChannelCard + EventFeed immediate refresh
  const [refreshKey, setRefreshKey] = useState(0)
  const queryClient = useQueryClient()
  // true while the textarea holds a voucher auto-loaded from localStorage (auto-validated); false once edited by hand
  const autoLoadedRef = useRef(false)
  const handledRedeemsRef = useRef(new Set<string>())

  const wrongChain = chainId !== ACTIVE_CHAIN.id

  const client = clientInput.startsWith('0x') && clientInput.length === 42
    ? (clientInput as `0x${string}`)
    : undefined

  useEffect(() => {
    if (clientInput.length > 0) {
      localStorage.setItem(clientStorageKey(ACTIVE_CHAIN.id), clientInput)
    }
  }, [clientInput])

  // Auto-load voucher from localStorage when client or provider changes
  /* oxlint-disable react/set-state-in-effect */
  useEffect(() => {
    if (!client || !address || !cfg) { setParsedVoucher(null); return }
    const key = voucherStorageKey(ACTIVE_CHAIN.id, cfg.address, client, address)
    const raw = localStorage.getItem(key)
    if (raw) {
      try {
        const v = JSON.parse(raw) as StoredVoucher
        setParsedVoucher(v)
        setVoucherJson(JSON.stringify(v, null, 2))
        autoLoadedRef.current = true
      } catch {
        setParsedVoucher(null)
      }
    }
  }, [client, address, cfg])
  /* oxlint-enable react/set-state-in-effect */

  // Channel read
  const { data: channelData } = useReadContract({
    address: cfg?.address,
    abi: METER_ABI,
    functionName: 'getChannel',
    args: client && address ? [client, address] : undefined,
    chainId: ACTIVE_CHAIN.id,
    query: { enabled: !!client && !!address && !!cfg && !wrongChain, refetchInterval: 5000 },
  })

  const available: bigint = channelData ? (channelData[4]) : 0n
  const redeemed: bigint = channelData ? BigInt(String(channelData[2])) : 0n

  // Parse and validate pasted voucher
  const handleParseVoucher = useCallback(async () => {
    setVoucherError('')
    setIsVerified(null)
    if (!cfg || !address) return
    let v: StoredVoucher
    try { v = JSON.parse(voucherJson) as StoredVoucher } catch {
      setVoucherError('Invalid JSON')
      return
    }
    if (!v.client || !v.provider || !v.cumulativeAmount || !v.signature) {
      setVoucherError('Missing required fields')
      return
    }
    if (v.provider.toLowerCase() !== address.toLowerCase()) {
      setVoucherError(`Voucher is for provider ${v.provider} — that is not your address.`)
      return
    }
    // Verify signature
    try {
      const recovered = await recoverTypedDataAddress({
        domain: voucherDomain(ACTIVE_CHAIN.id, cfg.address),
        types: VOUCHER_TYPES,
        primaryType: 'Voucher',
        message: {
          client: v.client as `0x${string}`,
          provider: v.provider as `0x${string}`,
          cumulativeAmount: BigInt(v.cumulativeAmount),
        },
        signature: v.signature as `0x${string}`,
      })
      if (recovered.toLowerCase() !== v.client.toLowerCase()) {
        setVoucherError('Signature does not match client')
        setIsVerified(false)
        return
      }
    } catch {
      setVoucherError('Signature verification failed')
      setIsVerified(false)
      return
    }
    const cumulative = BigInt(v.cumulativeAmount)
    if (cumulative <= redeemed) {
      setVoucherError(`Cumulative ${formatEther(cumulative)} ≤ already redeemed ${formatEther(redeemed)}. Nothing to pay.`)
      setIsVerified(false)
      return
    }
    setParsedVoucher(v)
    setIsVerified(true)
  }, [voucherJson, cfg, address, redeemed])

  // Compute redeemable
  const redeemable: bigint = parsedVoucher
    ? (() => {
        const c = BigInt(parsedVoucher.cumulativeAmount)
        const owed: bigint = c > redeemed ? c - redeemed : 0n
        return owed < available ? owed : available
      })()
    : 0n

  // Watch WithdrawRequested events for this channel
  /* oxlint-disable react/set-state-in-effect */
  useEffect(() => {
    if (!publicClient || !cfg || !client || !address) return
    let cancelled = false
    const run = async () => {
      try {
        const head = await publicClient.getBlockNumber({ cacheTime: 0 }) // fresh head: the default 4 s cache missed a just-confirmed event
        const from = head > 500n ? head - 500n : cfg.deployBlock
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const logs: unknown[] = await (publicClient.getLogs as (...a: unknown[]) => Promise<unknown[]>)({
          address: cfg.address,
          event: parseAbiItem('event WithdrawRequested(address indexed client, address indexed provider, uint64 readyAt)'),
          args: { client: [client], provider: [address] },
          fromBlock: from,
          toBlock: head,
        })
        if (!cancelled && logs.length > 0) {
          const last = logs[logs.length - 1] as Record<string, unknown>
          const args = (last.args ?? {}) as Record<string, unknown>
          const readyAt = Number(args.readyAt as bigint | undefined ?? 0n)
          // oxlint-disable-next-line react/purity -- comparing to current wall time is intentional
          const now = Math.floor(Date.now() / 1000)
          if (readyAt > now) {
            setWithdrawAlert(`Client started a withdrawal — redeem before ${new Date(readyAt * 1000).toLocaleString()}`)
          }
        }
      } catch { /* ignore */ }
    }
    void run()
    return () => { cancelled = true }
  }, [publicClient, cfg, client, address])
  /* oxlint-enable react/set-state-in-effect */

  // Redeem
  const { writeContract, data: redeemHash, isPending: redeemPending } = useWriteContract()
  const { isLoading: redeemConfirming, isSuccess: redeemSuccess } = useWaitForTransactionReceipt({ hash: redeemHash })

  const handleRedeem = () => {
    if (wrongChain) { switchChain({ chainId: ACTIVE_CHAIN.id }); return }
    if (!cfg || !parsedVoucher || !client) return
    writeContract(
      {
        address: cfg.address,
        abi: METER_ABI,
        functionName: 'redeem',
        args: [
          client,
          parsedVoucher.provider as `0x${string}`,
          BigInt(parsedVoucher.cumulativeAmount),
          parsedVoucher.signature as `0x${string}`,
        ],
        chainId: ACTIVE_CHAIN.id,
      },
      {
        onSuccess: (h) => toast.loading('Redeeming…', { id: h }),
        onError: (e) => toast.error(parseOnchainError(e)),
      },
    )
  }

  // On a confirmed redeem: toast + refresh, exactly once per hash. Never in render (setState in render looped and
  // blanked the page after the first redeem).
  /* oxlint-disable react/set-state-in-effect */
  useEffect(() => {
    if (!redeemSuccess || !redeemHash) return
    if (handledRedeemsRef.current.has(redeemHash)) return
    handledRedeemsRef.current.add(redeemHash)
    toast.success('Redeemed!', {
      id: redeemHash,
      description: (
        <a href={explorerTx(redeemHash)} target="_blank" rel="noreferrer" className="flex items-center gap-1 underline">
          View on explorer <ExternalLink className="size-3" />
        </a>
      ),
    })
    void queryClient.invalidateQueries()
    setRefreshKey((k) => k + 1)
  }, [redeemSuccess, redeemHash, queryClient])

  // Auto-validate a voucher loaded from localStorage, and re-validate when the channel's redeemed/available change.
  useEffect(() => {
    if (!autoLoadedRef.current || !voucherJson || !client || !address || !channelData) return
    void handleParseVoucher()
  }, [handleParseVoucher, voucherJson, client, address, channelData, available])
  /* oxlint-enable react/set-state-in-effect */

  const glass = {
    background: 'var(--surface)',
    backdropFilter: 'blur(20px)',
    WebkitBackdropFilter: 'blur(20px)',
    border: '1px solid var(--border)',
  }

  if (!cfg) {
    return (
      <div className="flex flex-col gap-5">
        <div className="rounded-2xl p-5" style={{ ...glass, borderColor: 'rgba(232,109,122,0.4)' }}>
          <p className="text-sm" style={{ color: 'var(--danger)' }}>
            Contract not deployed on {ACTIVE_CHAIN.name} yet.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-5">
      {/* Withdraw alert */}
      {withdrawAlert && (
        <div
          className="flex items-start gap-2 rounded-2xl p-4 text-sm"
          style={{ background: 'rgba(255,200,80,0.12)', border: '1px solid rgba(201,160,32,0.3)', color: '#c9a020' }}
        >
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <div>{withdrawAlert}</div>
        </div>
      )}

      {/* Client address */}
      <div className="rounded-2xl p-5" style={glass}>
        <h3 className="mb-3 text-sm font-semibold" style={{ color: 'var(--ink)' }}>Client address</h3>
        <input
          value={clientInput}
          onChange={(e) => setClientInput(e.target.value.trim())}
          placeholder="0x… client address"
          className="mono w-full rounded-xl px-3 py-2.5 text-sm outline-none transition-colors"
          style={{
            background: 'var(--surface-muted)',
            color: 'var(--ink)',
            border: '1px solid var(--border)',
          }}
        />
        {client && (
          <div className="mt-1.5 flex items-center gap-1 text-xs" style={{ color: 'var(--subtle)' }}>
            <Check className="size-3" style={{ color: 'var(--success)' }} />
            Valid address ·
            <a href={explorerAddr(client)} target="_blank" rel="noreferrer" className="hover:underline">
              view on explorer <ExternalLink className="inline size-2.5" />
            </a>
          </div>
        )}
      </div>

      {/* Channel card — fix 4: pass refreshKey */}
      <ChannelCard client={client} provider={address} refreshKey={refreshKey} />

      {/* Voucher panel */}
      <div className="rounded-2xl p-5" style={glass}>
        <h3 className="mb-1 text-sm font-semibold" style={{ color: 'var(--ink)' }}>Voucher</h3>
        <p className="mb-3 text-xs" style={{ color: 'var(--subtle)' }}>
          Auto-loaded from localStorage if the client used this browser. Or paste a voucher JSON below.
        </p>

        <textarea
          value={voucherJson}
          onChange={(e) => { autoLoadedRef.current = false; setVoucherJson(e.target.value); setIsVerified(null) }}
          placeholder={'{\n  "client": "0x…",\n  "provider": "0x…",\n  "cumulativeAmount": "1000000000000000000",\n  "signature": "0x…"\n}'}
          rows={5}
          className="mono w-full resize-none rounded-xl px-3 py-2.5 text-xs outline-none"
          style={{
            background: 'var(--surface-muted)',
            color: 'var(--ink)',
            border: '1px solid var(--border)',
          }}
        />

        {voucherError && (
          <p className="mt-1 text-xs" style={{ color: 'var(--danger)' }}>{voucherError}</p>
        )}

        <div className="mt-2 flex gap-2">
          <button
            onClick={() => void handleParseVoucher()}
            className="flex items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-semibold transition-colors"
            style={{ background: 'var(--surface-muted)', color: 'var(--muted)', border: '1px solid var(--border)' }}
          >
            <ClipboardPaste className="size-3" />
            Validate
          </button>
          {isVerified === true && parsedVoucher && (
            <div className="flex items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-semibold" style={{ background: 'rgba(141,216,159,0.15)', color: 'var(--success)' }}>
              <Check className="size-3" />
              Valid · Redeemable now:{' '}
              {parseFloat(formatEther(redeemable)).toLocaleString('en-US', { maximumFractionDigits: 6 })} USDC
            </div>
          )}
        </div>

        {parsedVoucher && isVerified && (
          <div className="mt-4">
            <p className="mb-2 text-[10px]" style={{ color: 'var(--subtle)' }}>
              Anyone may submit this redemption. Funds always go to the provider.
            </p>
            <TxButton
              onClick={handleRedeem}
              disabled={!client || redeemable === 0n || wrongChain}
              isPending={redeemPending}
              isConfirming={redeemConfirming}
            >
              {wrongChain ? `Switch to ${ACTIVE_CHAIN.name}` : `Redeem ${parseFloat(formatEther(redeemable)).toLocaleString('en-US', { maximumFractionDigits: 6 })} USDC`}
            </TxButton>
          </div>
        )}
      </div>

      {/* Event feed — fix 4: pass refreshKey so it refetches after redeem */}
      <EventFeed client={client} provider={address} refreshKey={refreshKey} />
    </div>
  )
}
