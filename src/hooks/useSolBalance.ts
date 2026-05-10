// Shared SOL-balance polling hook. Multiple consumers can call this and
// only one underlying `getBalance` request fires per poll cycle (cached
// per connection+pubkey via a tiny module-level cache).
//
// Pre-existing `Action.tsx` and `WalletCard.tsx` each polled separately,
// which doubled the on-connect RPC burst — fine on desktop but observed
// to crash Phantom's mobile in-app webview (tight memory budget + parallel
// TLS handshakes to non-Phantom RPC). Sharing this hook collapses the two
// pollers into one.
//
// Returns a (lamports | null) state. null = haven't fetched yet (or
// disconnected). Callers should treat null as "loading".

import { useEffect, useState } from 'react'
import { useConnection } from '@solana/wallet-adapter-react'
import { Connection, PublicKey } from '@solana/web3.js'

interface CacheEntry {
  lamports: number | null
  ts: number
  inflight: Promise<number> | null
  subscribers: Set<(lamports: number) => void>
  intervalId: ReturnType<typeof setInterval> | null
  intervalMs: number
}

// Module-level cache keyed by `${connection.endpoint}:${pubkey.toBase58()}`.
// Survives component unmounts so a quick re-mount doesn't re-fetch.
const cache = new Map<string, CacheEntry>()

const KEY_FN = (connection: Connection, pubkey: PublicKey): string =>
  `${connection.rpcEndpoint}:${pubkey.toBase58()}`

/**
 * Subscribe to SOL balance for `publicKey`. The first subscriber starts a
 * polling loop at `pollMs`; subsequent subscribers join the same loop.
 * When the last subscriber unsubscribes, the loop stops.
 *
 * Returns the latest known balance in lamports, or null until the first
 * fetch resolves.
 */
export function useSolBalance(
  publicKey: PublicKey | null,
  pollMs = 12_000,
): number | null {
  const [lamports, setLamports] = useState<number | null>(null)
  const { connection } = useConnection()

  useEffect(() => {
    if (!publicKey) {
      setLamports(null)
      return
    }
    const key = KEY_FN(connection, publicKey)
    let entry = cache.get(key)
    if (!entry) {
      entry = {
        lamports: null,
        ts: 0,
        inflight: null,
        subscribers: new Set(),
        intervalId: null,
        intervalMs: pollMs,
      }
      cache.set(key, entry)
    }

    const tick = async () => {
      if (!entry || entry.inflight) return
      entry.inflight = connection.getBalance(publicKey, 'processed')
      try {
        const v = await entry.inflight
        entry.lamports = v
        entry.ts = Date.now()
        entry.subscribers.forEach((s) => s(v))
      } catch {
        // swallow — keep last known value, retry on next interval
      } finally {
        if (entry) entry.inflight = null
      }
    }

    const onUpdate = (v: number) => setLamports(v)
    entry.subscribers.add(onUpdate)

    // If we already have a recent value (cached within the poll window),
    // surface it immediately without re-fetching.
    if (entry.lamports != null && Date.now() - entry.ts < pollMs) {
      setLamports(entry.lamports)
    } else {
      // First subscriber kicks off the poller; later subscribers join.
      void tick()
      if (!entry.intervalId) {
        entry.intervalId = setInterval(tick, pollMs)
      }
    }

    return () => {
      if (!entry) return
      entry.subscribers.delete(onUpdate)
      if (entry.subscribers.size === 0 && entry.intervalId) {
        clearInterval(entry.intervalId)
        entry.intervalId = null
      }
    }
  }, [connection, publicKey, pollMs])

  return lamports
}
