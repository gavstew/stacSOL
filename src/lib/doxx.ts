import bs58 from 'bs58'
import type { WalletContextState } from '@solana/wallet-adapter-react'

// Client helper for the /api/doxx opt-in flow.
//
// The user signs a fresh message proving custody of the wallet, then POSTs
// the signature + message + action to the API. The server verifies the
// signature and flips the is_doxxed flag (and optional display_name) in
// holder_summary.

export interface DoxxResponse {
  ok: boolean
  wallet?: string
  isDoxxed?: boolean
  displayName?: string | null
  error?: string
}

function buildMessage(action: 'doxx' | 'undoxx', wallet: string): string {
  const ts = Math.floor(Date.now() / 1000)
  return `stacsol-leaderboard:${action}:${wallet}:${ts}`
}

/**
 * Sign + submit a doxx opt-in (or opt-out). Throws on user rejection /
 * network errors so the caller can show a status message. Returns the
 * server's response on success.
 */
export async function submitDoxx(
  wallet: WalletContextState,
  action: 'doxx' | 'undoxx',
  displayName?: string | null,
): Promise<DoxxResponse> {
  if (!wallet.publicKey) throw new Error('no wallet connected')
  if (!wallet.signMessage) {
    throw new Error('this wallet does not support signMessage')
  }

  const walletAddr = wallet.publicKey.toBase58()
  const message = buildMessage(action, walletAddr)
  const messageBytes = new TextEncoder().encode(message)

  const signatureBytes = await wallet.signMessage(messageBytes)
  const signatureBase58 = bs58.encode(signatureBytes)

  const r = await fetch('/api/doxx', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      wallet: walletAddr,
      action,
      message,
      signatureBase58,
      displayName: action === 'doxx' ? displayName ?? null : null,
    }),
  })
  const j = (await r.json()) as DoxxResponse
  if (!r.ok || !j.ok) {
    throw new Error(j.error ?? `doxx HTTP ${r.status}`)
  }
  return j
}
