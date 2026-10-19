import { useState, useEffect, useRef } from 'react'
import { useWriteContract, useWaitForTransactionReceipt, useAccount, useSwitchChain } from 'wagmi'
import { useQueryClient } from '@tanstack/react-query'
import { parseEther } from 'viem'
import { toast } from 'sonner'
import { ExternalLink } from 'lucide-react'
import { METER_ABI, ACTIVE_CHAIN, ACTIVE_CFG, explorerTx } from '../usdcmeter-config'
import { TxButton } from './TxButton'

interface Props {
  provider: `0x${string}` | undefined
  onDeposited?: () => void
}

function parseOnchainError(err: unknown): string {
  const msg = (err as Error)?.message?.toLowerCase() ?? ''
  if (msg.includes('user rejected') || msg.includes('denied')) return 'Cancelled.'
  if (msg.includes('insufficient')) return 'Insufficient balance.'
  if (msg.includes('zeroprovider')) return 'Invalid provider address.'
  if (msg.includes('zerovalue')) return 'Amount must be greater than 0.'
  if (msg.includes('selfchannel')) return 'Cannot open a channel with yourself.'
  if (msg.includes('amounttoolarge')) return 'Amount too large for this channel.'
  if (msg.includes('reverted')) return 'Transaction reverted.'
  return 'Something went wrong. Try again.'
}

export function DepositForm({ provider, onDeposited }: Props) {
  const [amount, setAmount] = useState('')
  const { address, chainId } = useAccount()
  const { switchChain } = useSwitchChain()
  const queryClient = useQueryClient()
  const cfg = ACTIVE_CFG

  const { writeContract, data: hash, isPending, reset } = useWriteContract()
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash })

  const handledRef = useRef(new Set<string>())

  // Fix 1 + 2: side-effects and cache invalidation in effect, never in render
  useEffect(() => {
    if (!isSuccess || !hash) return
    if (handledRef.current.has(hash)) return
    handledRef.current.add(hash)

    toast.success('Deposit confirmed!', {
      id: hash,
      description: (
        <a href={explorerTx(hash)} target="_blank" rel="noreferrer" className="flex items-center gap-1 underline">
          View on explorer <ExternalLink className="size-3" />
        </a>
      ),
    })
    // Invalidate all wagmi read queries so channel card, withdraw controls,
    // and demo panel all pick up the new balance immediately.
    void queryClient.invalidateQueries()
    onDeposited?.()
  }, [isSuccess, hash, queryClient, onDeposited])

  const wrongChain = chainId !== ACTIVE_CHAIN.id

  const handleDeposit = () => {
    if (wrongChain) { switchChain({ chainId: ACTIVE_CHAIN.id }); return }
    if (!provider || !cfg || !amount) return
    let parsed: bigint
    try { parsed = parseEther(amount) } catch { toast.error('Invalid amount'); return }
    if (parsed === 0n) { toast.error('Amount must be > 0'); return }

    writeContract(
      {
        address: cfg.address,
        abi: METER_ABI,
        functionName: 'deposit',
        args: [provider],
        value: parsed,
        chainId: ACTIVE_CHAIN.id,
      },
      {
        onSuccess: (h) => toast.loading('Depositing…', { id: h }),
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

  const canDeposit = !!address && !!provider && !!amount && !wrongChain

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
      <h3 className="mb-4 text-sm font-semibold" style={{ color: 'var(--ink)' }}>Deposit USDC</h3>

      {/* Amount input */}
      <div className="mb-3 rounded-2xl p-4" style={{ background: 'var(--surface-muted)' }}>
        <input
          inputMode="decimal"
          value={amount}
          onChange={(e) => {
            const v = e.target.value.replace(/[^0-9.]/g, '')
            if (v === '' || /^\d*\.?\d*$/.test(v)) setAmount(v)
          }}
          placeholder="0.00"
          className="display w-full bg-transparent text-4xl font-bold tabular-nums outline-none placeholder:opacity-30"
          style={{ color: 'var(--ink)' }}
        />
        <div className="mt-1.5 flex items-center justify-between">
          <span className="text-xs" style={{ color: 'var(--subtle)' }}>USDC (native, 18 dec)</span>
          <div className="flex gap-1.5">
            {['0.1', '1', '10'].map((v) => (
              <button
                key={v}
                onClick={() => setAmount(v)}
                className="rounded-lg px-2 py-0.5 text-xs font-semibold transition-colors"
                style={{ background: 'var(--border)', color: 'var(--muted)' }}
              >
                {v}
              </button>
            ))}
          </div>
        </div>
      </div>

      <TxButton
        onClick={handleDeposit}
        disabled={!canDeposit}
        isPending={isPending}
        isConfirming={isConfirming}
      >
        {!address
          ? 'Connect wallet'
          : wrongChain
          ? `Switch to ${ACTIVE_CHAIN.name}`
          : !provider
          ? 'Enter a provider address'
          : `Deposit ${amount || '0'} USDC`}
      </TxButton>

      {isSuccess && (
        <button onClick={reset} className="mt-2 w-full text-center text-xs" style={{ color: 'var(--subtle)' }}>
          Deposit another
        </button>
      )}
    </div>
  )
}
