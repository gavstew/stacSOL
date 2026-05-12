import { useEffect, useState } from 'react'
import type { SavePool } from '../lib/saveFinance'

interface UseSavePoolsOptions {
  /** Only fetch permissionless pools. Default false (all pools). */
  onlyPermissionless?: boolean
  /** Only return pools that list this mint. Optional. */
  withMint?: string
  /** Refresh cadence in ms. Default 5min (matches edge cache lifetime). */
  refreshMs?: number
}

interface SavePoolsResponse {
  ok: boolean
  asOf: number
  pools: SavePool[]
  count: number
}

interface UseSavePoolsResult {
  pools: SavePool[]
  loading: boolean
  error: string | null
  asOf: number | null
  /** Trigger a manual refresh. */
  refresh: () => void
}

/**
 * Fetch + cache Save Finance's market configs through our /api/save-pools
 * proxy. The proxy already caches 60s shared across users; this hook adds
 * a per-client poll so the data stays warm in long-lived tabs.
 */
export function useSavePools(opts: UseSavePoolsOptions = {}): UseSavePoolsResult {
  const { onlyPermissionless = false, withMint = null, refreshMs = 5 * 60_000 } = opts
  const [pools, setPools] = useState<SavePool[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [asOf, setAsOf] = useState<number | null>(null)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    let cancelled = false
    const fetchOnce = async () => {
      try {
        setLoading(true)
        const qs = new URLSearchParams()
        if (onlyPermissionless) qs.set('onlyPermissionless', 'true')
        if (withMint) qs.set('withMint', withMint)
        const url = `/api/save-pools${qs.toString() ? `?${qs.toString()}` : ''}`
        const r = await fetch(url)
        if (!r.ok) throw new Error(`save-pools HTTP ${r.status}`)
        const j = (await r.json()) as SavePoolsResponse
        if (!cancelled) {
          setPools(j.pools ?? [])
          setAsOf(j.asOf ?? null)
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
  }, [onlyPermissionless, withMint, refreshMs, tick])

  return {
    pools,
    loading,
    error,
    asOf,
    refresh: () => setTick((t) => t + 1),
  }
}
