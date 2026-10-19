import { useEffect, useRef, useState } from 'react'
import { useWriteContract, useWaitForTransactionReceipt, useAccount, useSwitchChain, useReadContract } from 'wagmi'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { ExternalLink, Info } from 'lucide-react'
import { METER_ABI, ACTIVE_CHAIN, ACTIVE_CFG, explorerTx } from '../usdcmeter-config'
import { TxButton } from './TxButton'
import { formatEther } from 'viem'

interface Props {
  provider: `0x${string}` | undefined
  onAction?: () => void
}

function parseOnchainError(err: unknown): string {
  const msg = (err as Error)?.message?.toLowerCase() ?? ''
  if (msg.includes('user rejected') || msg.includes('denied')) return 'Cancelled.'
  if (msg.includes('noavailablebalance')) return 'No available balance to withdraw.'
  if (msg.includes('withdrawalreadypending')) return 'A withdrawal is already pending.'
  if (msg.includes('nochannelornopending')) return 'No pending withdrawal to cancel.'
  if (msg.includes('nopendingwithdraw')) return 'No pending withdrawal to complete.'
  if (msg.includes('tooearlytowithdraw')) return 'Notice period has not elapsed yet.'
  return 'Transaction failed. Try again.'
}

/** Fire toast + invalidate queries exactly once per confirmed hash. */
function useConfirmedEffect(
  hash: `0x${string}` | undefined,
  isSuccess: boolean,
  label: string,
  queryClient: ReturnType<typeof useQueryClient>,
  onAction?: () => void,
) {
  const handledRef = useRef(new Set<string>())
  useEffect(() => {
    if (!isSuccess || !hash) return
    if (handledRef.current.has(hash)) return
    handledRef.current.add(hash)
    toast.success(label, {
      id: hash,
      description: (
        <a href={explorerTx(hash)} target="_blank" rel="noreferrer" className="flex items-center gap-1 underline">
          View on explorer <ExternalLink className="size-3" />
        </a>
      ),
    })
    // Fix 2: invalidate all reads so channel card updates immediately after confirmation
    void queryClient.invalidateQueries()
    onAction?.()
  }, [isSuccess, hash, label, queryClient, onAction])
}

export function WithdrawControls({ provider, onAction }: Props) {
  const { address, chainId } = useAccount()
  const { switchChain } = useSwitchChain()
  const queryClient = useQueryClient()
  const cfg = ACTIVE_CFG
  const wrongChain = chainId !== ACTIVE_CHAIN.id

  const enabled = !!address && !!provider && !!cfg && !wrongChain

  const { data: channelData } = useReadContract({
    address: cfg?.address,
    abi: METER_ABI,
    functionName: 'getChannel',
    args: address && provider ? [address, provider] : undefined,
    chainId: ACTIVE_CHAIN.id,
    query: { enabled, refetchInterval: 5000 },
  })

  const { data: noticePeriod } = useReadContract({
    address: cfg?.address,
    abi: METER_ABI,
    functionName: 'noticePeriod',
    chainId: ACTIVE_CHAIN.id,
    query: { enabled: !!cfg },
  })

  const withdrawReadyAt: number = channelData ? Number(channelData[3]) : 0
  const available: bigint = channelData ? (channelData[4]) : 0n
  // Tick once a second while a withdrawal is pending, so "Complete withdrawal" enables the moment the notice ends
  // (without a timer the button only updated on the next unrelated re-render).
  const [nowSec, setNowSec] = useState(() => Math.trunc(Date.now() / 1000))
  const hasPending = withdrawReadyAt > 0
  const isReady = hasPending && withdrawReadyAt <= nowSec
  useEffect(() => {
    if (!hasPending || isReady) return
    const id = setInterval(() => setNowSec(Math.trunc(Date.now() / 1000)), 1000)
    return () => clearInterval(id)
  }, [hasPending, isReady])

  // Request withdraw
  const { writeContract: reqWrite, data: reqHash, isPending: reqPending } = useWriteContract()
  const { isLoading: reqConfirming, isSuccess: reqSuccess } = useWaitForTransactionReceipt({ hash: reqHash })

  // Cancel withdraw
  const { writeContract: cancelWrite, data: cancelHash, isPending: cancelPending } = useWriteContract()
  const { isLoading: cancelConfirming, isSuccess: cancelSuccess } = useWaitForTransactionReceipt({ hash: cancelHash })

  // Complete withdraw
  const { writeContract: completeWrite, data: completeHash, isPending: completePending } = useWriteContract()
  const { isLoading: completeConfirming, isSuccess: completeSuccess } = useWaitForTransactionReceipt({ hash: completeHash })

  // Fix 1 + 2: one effect per tx, never side-effects in render
  useConfirmedEffect(reqHash, reqSuccess, 'Withdrawal requested!', queryClient, onAction)
  useConfirmedEffect(cancelHash, cancelSuccess, 'Withdrawal cancelled.', queryClient, onAction)
  useConfirmedEffect(completeHash, completeSuccess, 'Withdrawal complete!', queryClient, onAction)

  const callContract = (
    fn: 'requestWithdraw' | 'cancelWithdraw' | 'completeWithdraw',
    write: typeof reqWrite,
  ) => {
    if (wrongChain) { switchChain({ chainId: ACTIVE_CHAIN.id }); return }
    if (!cfg || !provider) return
    write(
      {
        address: cfg.address,
        abi: METER_ABI,
        functionName: fn,
        args: [provider],
        chainId: ACTIVE_CHAIN.id,
      },
      {
        onSuccess: (h) => toast.loading('Waiting for confirmation…', { id: h }),
        onError: (e) => toast.error(parseOnchainError(e)),
      },
    )
  }

  const glass = {
    background: 'var(--surface)',
    backdropFilter: 'blur(20px)',
    WebkitBackdropFilter: 'blur(20px)',
    border: '1px solid var(--border)',
  }

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
      <h3 className="mb-1 text-sm font-semibold" style={{ color: 'var(--ink)' }}>Withdraw controls</h3>
      <p className="mb-4 flex items-start gap-1.5 text-xs" style={{ color: 'var(--subtle)' }}>
        <Info className="mt-0.5 size-3 shrink-0" />
        The provider can still redeem outstanding vouchers during the notice period.
        {noticePeriod !== undefined && (
          <span className="font-medium"> Notice period: {Number(noticePeriod)}s.</span>
        )}
      </p>

      <div className="mb-3 rounded-xl p-3" style={{ background: 'var(--surface-muted)' }}>
        <span className="text-xs" style={{ color: 'var(--subtle)' }}>Available to withdraw</span>
        <div className="display tabular-nums text-2xl font-bold" style={{ color: 'var(--ink)' }}>
          {parseFloat(formatEther(available)).toLocaleString('en-US', { maximumFractionDigits: 6 })}
          <span className="ml-1 text-sm font-normal" style={{ color: 'var(--subtle)' }}>USDC</span>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        {!hasPending && (
          <TxButton
            onClick={() => callContract('requestWithdraw', reqWrite)}
            disabled={!enabled || available === 0n}
            isPending={reqPending}
            isConfirming={reqConfirming}
            variant="ghost"
          >
            {wrongChain ? `Switch to ${ACTIVE_CHAIN.name}` : 'Start withdrawal'}
          </TxButton>
        )}

        {hasPending && (
          <>
            <TxButton
              onClick={() => callContract('completeWithdraw', completeWrite)}
              disabled={!isReady}
              isPending={completePending}
              isConfirming={completeConfirming}
            >
              {isReady ? 'Complete withdrawal' : 'Waiting for notice period…'}
            </TxButton>
            <TxButton
              onClick={() => callContract('cancelWithdraw', cancelWrite)}
              isPending={cancelPending}
              isConfirming={cancelConfirming}
              variant="danger"
            >
              Cancel withdrawal
            </TxButton>
          </>
        )}
      </div>
    </div>
  )
}
