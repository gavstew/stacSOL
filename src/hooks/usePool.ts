import { useEffect, useState } from 'react'
import { useConnection } from '@solana/wallet-adapter-react'
import { fetchPool, type PoolState } from '../lib/pool'

export function usePool(refreshMs = 10_000) {
  const { connection } = useConnection()
  const [pool, setPool] = useState<PoolState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    let cancelled = false
    fetchPool(connection)
      .then((p) => { if (!cancelled) { setPool(p); setError(null) } })
      .catch((e: Error) => { if (!cancelled) setError(e.message) })
    return () => { cancelled = true }
  }, [connection, tick])

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), refreshMs)
    return () => clearInterval(id)
  }, [refreshMs])

  return { pool, error, refresh: () => setTick((t) => t + 1) }
}
