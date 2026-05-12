// Shared identity + doxx UI used by both leaderboards (referral + holders).
//
// Each leaderboard joins against `holder_summary` to surface `is_doxxed`
// and `display_name`, then renders rows through `WalletIdentity` and exposes
// `DoxxToggle` on the connected wallet's own row. The components below are
// the canonical implementations — duplication caused drift in tooltips +
// behavior so we moved them here.

import { useState } from 'react'
import { useWallet } from '@solana/wallet-adapter-react'
import { anonymousPseudonym, shortPk } from '../lib/format'

/** Minimum shape any row passed to these components must satisfy. */
export interface DoxxIdentity {
  /** The wallet pubkey, base58. */
  wallet: string
  /** Whether the wallet has opted in via /api/doxx. */
  isDoxxed: boolean
  /** Optional display name set during opt-in. */
  displayName: string | null
}

/**
 * Anonymous-by-default identity cell. Wallets without `is_doxxed = true`
 * render as a stable pseudonym derived from the pubkey — the real address
 * is intentionally NOT in the DOM, so a screenshot can't leak it. Doxxed
 * wallets render the real shortPk (or display_name) + copy + solscan link.
 *
 * Opt-in is global: once a wallet opts in via DoxxToggle, all rows for
 * that wallet (referral / holders / wherever) render with the real
 * identity. Other users can't dox you — only the wallet owner can flip
 * the flag (signature-gated on /api/doxx).
 */
export function WalletIdentity({
  row,
  isMe,
  copy,
  copiedKey,
  className = '',
}: {
  row: DoxxIdentity
  isMe: boolean
  copy: (text: string) => void
  copiedKey: string | null
  className?: string
}) {
  if (!row.isDoxxed) {
    return (
      <span
        className={`text-[var(--color-dim)] font-mono ${className}`}
        title={
          isMe
            ? 'your own row — currently anonymous (the address is not in the page markup). use "show me on leaderboard" to opt in.'
            : 'anonymous wallet — only the wallet owner can opt in to show their address'
        }
      >
        {anonymousPseudonym(row.wallet)}
        <span className="ml-1.5 text-[9px] uppercase tracking-[2px] opacity-60">
          {isMe ? 'you · anon' : 'anon'}
        </span>
      </span>
    )
  }
  const label = row.displayName ? row.displayName : shortPk(row.wallet)
  return (
    <span className={`flex items-center gap-2 flex-wrap ${className}`}>
      <a
        href={`https://solscan.io/account/${row.wallet}`}
        target="_blank"
        rel="noopener noreferrer"
        className="text-[var(--color-fg)] hover:text-[var(--color-hot)] no-underline truncate"
        title={row.wallet}
      >
        {label}
      </a>
      {row.displayName && (
        <span className="text-[9px] text-[var(--color-dim)] font-mono">
          {shortPk(row.wallet)}
        </span>
      )}
      <button
        type="button"
        onClick={() => copy(row.wallet)}
        className="text-[9px] uppercase tracking-[2px] text-[var(--color-dim)] hover:text-[var(--color-ember)]"
        aria-label="copy address"
      >
        {copiedKey === row.wallet ? '✓' : 'copy'}
      </button>
      {isMe && (
        <span className="text-[9px] uppercase tracking-[2px] text-[var(--color-ember)]">
          you
        </span>
      )}
    </span>
  )
}

/**
 * Opt-in / opt-out doxx toggle for the connected wallet's own row.
 * Triggers a signMessage popup and POSTs to /api/doxx. After success,
 * calls `onChanged()` so the parent can refetch and re-render with the
 * updated identity.
 */
export function DoxxToggle({
  row,
  onChanged,
}: {
  row: DoxxIdentity
  onChanged: () => void
}) {
  const wallet = useWallet()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [editingName, setEditingName] = useState(false)
  const [draftName, setDraftName] = useState(row.displayName ?? '')

  const onClick = async (action: 'doxx' | 'undoxx', displayName?: string | null) => {
    if (!wallet.publicKey || !wallet.signMessage) {
      setErr('connect a wallet that supports signMessage')
      return
    }
    setBusy(true)
    setErr(null)
    try {
      const { submitDoxx } = await import('../lib/doxx')
      await submitDoxx(wallet, action, displayName ?? null)
      setEditingName(false)
      onChanged()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  if (row.isDoxxed) {
    return (
      <div className="flex flex-col items-end gap-1 text-[10px]">
        <div className="flex items-center gap-2 flex-wrap">
          {!editingName ? (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={() => setEditingName(true)}
                className="uppercase tracking-[2px] text-[var(--color-ember)] hover:text-[var(--color-hot)] disabled:opacity-40"
                title="set a display name shown on the leaderboard"
              >
                {row.displayName ? 'edit name' : 'set name'}
              </button>
              <span className="text-[var(--color-dim)]">·</span>
            </>
          ) : (
            <>
              <input
                type="text"
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                placeholder="display name"
                maxLength={32}
                className="w-32 px-2 py-0.5 rounded border border-[rgb(255_34_0_/_0.4)] bg-[var(--color-bg)] text-[11px] text-[var(--color-fg)] placeholder:text-[var(--color-dim)] focus:outline-none focus:border-[var(--color-hot)]"
              />
              <button
                type="button"
                disabled={busy}
                onClick={() => onClick('doxx', draftName)}
                className="uppercase tracking-[2px] text-[var(--color-green)] hover:text-[var(--color-fg)] disabled:opacity-40"
              >
                save
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setEditingName(false)
                  setDraftName(row.displayName ?? '')
                }}
                className="uppercase tracking-[2px] text-[var(--color-dim)] hover:text-[var(--color-fg)] disabled:opacity-40"
              >
                cancel
              </button>
            </>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={() => onClick('undoxx')}
            className="uppercase tracking-[2px] text-[var(--color-dim)] hover:text-[var(--color-warn)] disabled:opacity-40"
            title="hide your address from the public leaderboard"
          >
            {busy ? '…' : 'go anonymous'}
          </button>
        </div>
        {err && (
          <span className="text-[9px] text-[var(--color-warn)] normal-case tracking-normal">
            {err}
          </span>
        )}
      </div>
    )
  }
  return (
    <div className="flex flex-col items-end gap-1 text-[10px]">
      <button
        type="button"
        disabled={busy}
        onClick={() => onClick('doxx')}
        className="uppercase tracking-[2px] text-[var(--color-ember)] hover:text-[var(--color-hot)] disabled:opacity-40"
        title="reveal your wallet address on the public leaderboard. signature-gated; you can flip back to anonymous at any time."
      >
        {busy ? 'signing…' : 'show me on leaderboard'}
      </button>
      {err && (
        <span className="text-[9px] text-[var(--color-warn)] normal-case tracking-normal">
          {err}
        </span>
      )}
    </div>
  )
}
