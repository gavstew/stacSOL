import { useEffect, useState } from 'react'

export interface LpMarket {
  address: string
  source: string
  name: string
  liquidity: number
  volume24h: number
  price: number
  base: { address: string; symbol: string }
  quote: { address: string; symbol: string }
  isSolPair: boolean
  isProtocolPool: boolean
  isStacsolBase: boolean
}

export interface LpResponse {
  ok: boolean
  bestLpSol: number | null
  markets: LpMarket[]
}

// Live LP price + markets list. Proxied through /api/lp so the Birdeye
// key stays server-side. Refreshes every 30s.
export function useLpPrice(refreshMs = 30_000) {
  const [price, setPrice] = useState<number | null>(null)
  const [markets, setMarkets] = useState<LpMarket[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const fetchOnce = async () => {
      try {
        setLoading(true)
        const r = await fetch('/api/lp')
        if (!r.ok) throw new Error(`lp ${r.status}`)
        const j = (await r.json()) as LpResponse
        if (!cancelled) {
          setPrice(j.bestLpSol)
          setMarkets(j.markets ?? [])
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

  return { price, markets, loading, error }
}
