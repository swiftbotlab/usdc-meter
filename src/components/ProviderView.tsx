import { useState, useEffect, useCallback, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useWriteContract, useWaitForTransactionReceipt, useAccount, useSwitchChain, useReadContract } from 'wagmi'
import { formatEther } from 'viem'
import { toast } from 'sonner'
import { ExternalLink, ClipboardPaste, AlertTriangle, Check } from 'lucide-react'
import {
  METER_ABI,
  ACTIVE_CHAIN,
  ACTIVE_CFG,
  explorerTx,
  explorerAddr,
  voucherStorageKey,
  clientStorageKey,
  type StoredVoucher,
} from '../usdcmeter-config'
import { checkVoucher, parseVoucher, withdrawState, sameAddr } from '../voucher-check'
import { useNowSec } from '../use-now'
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
  if (msg.includes('reentrancyguard')) return 'Re-entrant call rejected.'
  if (msg.includes('nopendingwithdraw')) return 'No pending withdrawal to complete.'
  if (msg.includes('noavailablebalance')) return 'No available balance to withdraw.'
  return 'Transaction failed. Try again.'
}

export function ProviderView() {
  const { address, chainId } = useAccount()
  const { switchChain } = useSwitchChain()
  const cfg = ACTIVE_CFG

  const [clientInput, setClientInput] = useState<string>(
    () => localStorage.getItem(clientStorageKey(ACTIVE_CHAIN.id)) ?? '',
  )
  const [voucherJson, setVoucherJson] = useState('')
  const [parsedVoucher, setParsedVoucher] = useState<StoredVoucher | null>(null)
  const [voucherError, setVoucherError] = useState('')
  const [isVerified, setIsVerified] = useState<boolean | null>(null)
  const [redeemable, setRedeemable] = useState<bigint>(0n)
  const nowSec = useNowSec()
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

  // Auto-load the latest voucher from localStorage when client or provider changes. It is only put in the textarea;
  // it becomes `parsedVoucher` after the same validation as a pasted one (untrusted data, may be corrupt).
  /* oxlint-disable react/set-state-in-effect */
  useEffect(() => {
    setParsedVoucher(null)
    setIsVerified(null)
    if (!client || !address || !cfg) return
    let raw: string | null = null
    try { raw = localStorage.getItem(voucherStorageKey(ACTIVE_CHAIN.id, cfg.address, client, address)) } catch { /* storage blocked */ }
    if (raw) {
      setVoucherJson(raw)
      autoLoadedRef.current = true
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
  const withdrawReadyAt: number = channelData ? Number(channelData[3]) : 0
  // Withdrawal state comes from the channel itself (polled every 5 s), not from a log scan: it can't be missed,
  // it covers the matured state, and it clears as soon as the client cancels or completes.
  const wState = withdrawState(withdrawReadyAt, nowSec)

  // Parse and validate the voucher (pasted, or auto-loaded) against the SELECTED channel
  const handleParseVoucher = useCallback(async () => {
    // results are set together at the end (no flicker on the 5 s re-validation)
    const reject = (msg: string) => { setParsedVoucher(null); setRedeemable(0n); setVoucherError(msg); setIsVerified(false) }
    if (!cfg || !address) return
    const { v, error } = parseVoucher(voucherJson)
    if (!v) { reject(error ?? 'Invalid voucher'); return }
    if (!client) {
      // no client selected yet: take it from the voucher, the effect below re-validates once the channel loads
      autoLoadedRef.current = true
      setClientInput(v.client)
      return
    }
    if (!channelData) { setVoucherError('Loading channel…'); setIsVerified(null); return }
    const res = await checkVoucher({
      v,
      chainId: ACTIVE_CHAIN.id,
      meter: cfg.address,
      expectedClient: client,
      self: address,
      channel: { redeemed, available, withdrawReadyAt },
    })
    if (!res.ok) { reject(res.error ?? 'Invalid voucher'); return }
    setVoucherError('')
    setParsedVoucher(v)
    setRedeemable(res.redeemable)
    setIsVerified(true)
  }, [voucherJson, cfg, address, client, channelData, redeemed, available, withdrawReadyAt])

  // Redeem
  const { writeContract, data: redeemHash, isPending: redeemPending } = useWriteContract()
  const { isLoading: redeemConfirming, isSuccess: redeemSuccess } = useWaitForTransactionReceipt({ hash: redeemHash })

  const handleRedeem = () => {
    if (wrongChain) { switchChain({ chainId: ACTIVE_CHAIN.id }); return }
    if (!cfg || !parsedVoucher || !client || !isVerified) return
    if (!sameAddr(parsedVoucher.client, client) || !sameAddr(parsedVoucher.provider, address)) return
    writeContract(
      {
        address: cfg.address,
        abi: METER_ABI,
        functionName: 'redeem',
        args: [
          parsedVoucher.client as `0x${string}`,
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
    if (!(autoLoadedRef.current || isVerified) || !voucherJson || !client || !address || !channelData) return
    void handleParseVoucher()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- isVerified only gates; re-run on channel/voucher changes
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
      {/* Withdrawal alert, driven by getChannel().withdrawReadyAt */}
      {client && wState !== 'none' && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-2xl p-4 text-sm"
          style={{ background: 'rgba(232,109,122,0.14)', border: '1px solid rgba(232,109,122,0.45)', color: 'var(--danger)' }}
        >
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <div>
            <div className="font-semibold">
              {wState === 'pending'
                ? `Client started a withdrawal: stop serving and redeem now (it can complete at ${new Date(withdrawReadyAt * 1000).toLocaleTimeString()}).`
                : 'Withdrawal notice has ended: the client can take the remaining balance at any moment. Redeem now.'}
            </div>
            <div className="mt-0.5 text-xs" style={{ opacity: 0.85 }}>
              New deposits are blocked until the client cancels or completes the withdrawal.
            </div>
          </div>
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
      <ChannelCard client={client} provider={address} refreshKey={refreshKey} perspective="provider" />

      {/* Voucher panel */}
      <div className="rounded-2xl p-5" style={glass}>
        <h3 className="mb-1 text-sm font-semibold" style={{ color: 'var(--ink)' }}>Voucher</h3>
        <p className="mb-3 text-xs" style={{ color: 'var(--subtle)' }}>
          Auto-loaded from localStorage if the client used this browser. Or paste a voucher JSON below.
        </p>

        <textarea
          value={voucherJson}
          onChange={(e) => { autoLoadedRef.current = false; setVoucherJson(e.target.value); setIsVerified(null); setParsedVoucher(null) }}
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
