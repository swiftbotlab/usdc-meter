import { Loader2 } from 'lucide-react'
import type { ReactNode } from 'react'

interface Props {
  onClick: () => void
  disabled?: boolean
  isPending?: boolean
  isConfirming?: boolean
  children: ReactNode
  className?: string
  variant?: 'primary' | 'ghost' | 'danger'
}

export function TxButton({
  onClick,
  disabled,
  isPending,
  isConfirming,
  children,
  className = '',
  variant = 'primary',
}: Props) {
  const busy = isPending || isConfirming
  const isDisabled = disabled || busy

  const styles: Record<string, React.CSSProperties> = {
    primary: { background: 'var(--accent)', color: '#0d1b2f' },
    ghost: {
      background: 'var(--surface-muted)',
      color: 'var(--ink)',
      border: '1px solid var(--border)',
    },
    danger: { background: 'rgba(232,109,122,0.18)', color: 'var(--danger)' },
  }

  return (
    <button
      onClick={onClick}
      disabled={isDisabled}
      className={`flex w-full items-center justify-center gap-2 rounded-2xl py-3 text-sm font-semibold transition-all hover:scale-[1.01] active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-40 ${className}`}
      style={styles[variant]}
    >
      {busy && <Loader2 className="size-4 animate-spin" />}
      {isPending
        ? 'Confirm in wallet…'
        : isConfirming
        ? 'Confirming…'
        : children}
    </button>
  )
}
