import { useEffect, useState } from 'react'
import { useWallet } from '@solana/wallet-adapter-react'

/**
 * Single-row read from /api/holders-leaderboard for the connected wallet.
 *
 * This is the authoritative cost-basis source — it parses on-chain DepositSol
 * ix data directly so `grossSolIn` is the actual deposit amount (no Jupiter
 * zap-in swaps, jito tips, compute-budget fees baked in). The on-chain ATA
 * walk in fetchPosition() can't distinguish those wrapping costs from the
 * deposit itself, so its `totalSolIn` overstates the cost basis when the user
 * minted via /liquidity, /singlesided, or any other zap-in path. Using this
 * hook means the Position card's P&L matches the holders leaderboard P&L
 * exactly — same formula, same inputs.
 *
 * Refreshes every 30s. Returns null while loading or when the wallet has
 * never minted (no row in the indexer).
 */

export interface HolderRow {
  wallet: string
  walletStacAtom: string
  hawkfiStacAtom: string
  totalStacAtom: string
  grossSolIn: string
  grossSolOut: string
  netSolIn: string
  pnlSol: number
  pnlPct: number | null
  burnNetSol: number
  breakevenNav: number | null
  mintCount: number
  burnCount: number
  referralEarnedAtom: string
  managerFeeEarnedAtom: string
  earnedSol: number
  transferredOutAtom: string
  transferredInAtom: string
  transferredOutSol: number
  transferredInSol: number
  firstEventAt: number
  lastEventAt: number
  /** When false, leaderboard renders this row as an anonymous pseudonym. */
  isDoxxed: boolean
  /** Optional display name shown on doxxed rows (set via /api/doxx). */
  displayName: string | null
}

export function useMyHolderRow(refreshMs = 30_000): {
  row: HolderRow | null
  rate: number | null
  loading: boolean
  error: string | null
} {
  const { publicKey } = useWallet()
  const [row, setRow] = useState<HolderRow | null>(null)
  const [rate, setRate] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!publicKey) {
      setRow(null)
      setRate(null)
      return
    }
    const wallet = publicKey.toBase58()
    let cancelled = false

    const fetchOnce = async () => {
      try {
        setLoading(true)
        const url = `/api/holders-leaderboard?my=${wallet}&limit=1`
        const r = await fetch(url)
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        const j = (await r.json()) as { my: HolderRow | null; rate: number | null }
        if (cancelled) return
        setRow(j.my ?? null)
        setRate(j.rate ?? null)
        setError(null)
      } catch (e) {
        if (!cancelled) setError((e as Error).message)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    fetchOnce()
    const id = setInterval(fetchOnce, refreshMs)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [publicKey, refreshMs])

  return { row, rate, loading, error }
}
