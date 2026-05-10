import { useEffect, useState } from 'react'

export interface Snapshot {
  ts: number
  totalLamports: string
  poolTokenSupply: string
  mintSupply: string
  reserveLamports: string
  rate: number
  lastUpdateEpoch: number
  /** Jupiter spot price in SOL/stacSOL at snapshot time. Null for old rows
   *  recorded before the LP price column existed, or if Jupiter had no route. */
  lpPriceSol: number | null
}

export function useHistory(refreshMs = 60_000) {
  const [history, setHistory] = useState<Snapshot[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    let cancelled = false
    const fetchOnce = async () => {
      try {
        setLoading(true)
        const r = await fetch('/api/history?limit=500')
        if (!r.ok) throw new Error(`history ${r.status}`)
        const data: Snapshot[] = await r.json()
        if (!cancelled) {
          setHistory(data)
          setError(null)
        }
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
  }, [refreshMs])

  return { history, error, loading }
}
