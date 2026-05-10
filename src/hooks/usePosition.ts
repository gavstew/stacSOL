import { useCallback, useEffect, useState } from 'react'
import { useConnection, useWallet } from '@solana/wallet-adapter-react'
import { fetchPosition, type Position } from '../lib/position'
import { deriveAta } from '../lib/ix'
import { MINT } from '../lib/constants'

/**
 * Two-tier fetch strategy:
 *   - **Heavy fetch** (balance + tx history scan): runs on mount, on wallet
 *     change, and whenever `refreshTick` increments (caller bumps it after a
 *     successful mint/burn).
 *   - **Light poll** (balance only): cheap `getAccountInfo` every `pollMs`.
 *     Updates only the `balance` field in place. If we detect a balance
 *     change that *didn't* come from our own action (i.e., an external
 *     transfer in/out), we trigger a heavy re-scan to reconcile counts and
 *     cost basis.
 */
export function usePosition(refreshTick: number, pollMs = 10_000) {
  const { connection } = useConnection()
  const { publicKey } = useWallet()
  const [position, setPosition] = useState<Position | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [lastBalanceTickAt, setLastBalanceTickAt] = useState<number | null>(null)

  // ---------- heavy fetch ------------------------------------------------
  const refetchAll = useCallback(async () => {
    if (!publicKey) {
      setPosition(null)
      return
    }
    setLoading(true)
    try {
      const p = await fetchPosition(connection, publicKey)
      setPosition(p)
      setLastBalanceTickAt(Date.now())
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [connection, publicKey])

  useEffect(() => {
    refetchAll()
  }, [publicKey, refreshTick, refetchAll])

  // ---------- light balance poll ----------------------------------------
  useEffect(() => {
    if (!publicKey) return
    const ata = deriveAta(publicKey, MINT)
    let cancelled = false

    const pollOnce = async () => {
      try {
        const acc = await connection.getAccountInfo(ata, 'processed')
        const newBalance = acc ? acc.data.readBigUInt64LE(64) : 0n
        if (cancelled) return
        setPosition((p) => {
          if (!p) return p
          if (p.balance === newBalance) return p
          // Mint/burn through this UI bumps `refreshTick`, which already
          // triggers `refetchAll`. If the balance changed but `refreshTick`
          // didn't, it's an external transfer — kick a full re-scan so the
          // counts and cost basis stay consistent.
          const localTotal = p.totalTokensIn - p.totalTokensOut
          if (newBalance !== localTotal) {
            // schedule async, don't block render
            setTimeout(() => { if (!cancelled) refetchAll() }, 0)
          }
          return { ...p, balance: newBalance }
        })
        setLastBalanceTickAt(Date.now())
      } catch {
        /* RPC blip — try again next tick */
      }
    }

    const id = setInterval(pollOnce, pollMs)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [connection, publicKey, pollMs, refetchAll])

  return { position, loading, error, lastBalanceTickAt }
}
