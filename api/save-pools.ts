import type { VercelRequest, VercelResponse } from '@vercel/node'

// Proxy + cache for Save Finance's market configs endpoint.
//
// Source: https://api.solend.fi/v1/markets/configs?scope=all&deployment=production
// Direct browser fetches work today (no CORS issues observed), but proxying
// gives us:
//   - one consistent latency profile via Vercel edge
//   - shared 60s cache across all clients
//   - the option to filter/transform before shipping to the client
//
// Query params:
//   ?onlyPermissionless=true  → drop the non-permissionless pools
//   ?withMint=<mint>          → only pools that list this mint as a reserve
//   ?refresh=1                → bypass the local cache (still cached by Save)

const SAVE_API =
  'https://api.solend.fi/v1/markets/configs?scope=all&deployment=production'

interface CacheEntry {
  ts: number
  body: unknown
}

const CACHE_TTL_MS = 60_000
let cache: CacheEntry | null = null

async function fetchSaveMarkets(): Promise<unknown> {
  const r = await fetch(SAVE_API, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  })
  if (!r.ok) throw new Error(`save HTTP ${r.status}`)
  return r.json()
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const refresh = String(req.query.refresh ?? '') === '1'
    const onlyPermissionless =
      String(req.query.onlyPermissionless ?? '').toLowerCase() === 'true'
    const withMint = req.query.withMint
      ? String(req.query.withMint).trim()
      : null

    const now = Date.now()
    if (refresh || !cache || now - cache.ts > CACHE_TTL_MS) {
      cache = { ts: now, body: await fetchSaveMarkets() }
    }

    // The Save endpoint returns an array of pool objects at the top level.
    // We tolerate either an array OR an envelope { data: [...] } in case
    // the response shape ever changes.
    type Pool = {
      isPermissionless?: boolean
      reserves?: { liquidityToken?: { mint?: string } }[]
    }
    let pools: Pool[] = Array.isArray(cache.body)
      ? (cache.body as Pool[])
      : ((cache.body as { data?: Pool[] }).data ?? [])

    if (onlyPermissionless) {
      pools = pools.filter((p) => p.isPermissionless === true)
    }
    if (withMint) {
      pools = pools.filter((p) =>
        (p.reserves ?? []).some(
          (r) => r.liquidityToken?.mint === withMint,
        ),
      )
    }

    res.setHeader(
      'Cache-Control',
      'public, max-age=60, s-maxage=60, stale-while-revalidate=300',
    )
    res.status(200).json({
      ok: true,
      asOf: cache.ts,
      pools,
      count: pools.length,
    })
  } catch (e) {
    console.error('save-pools error:', e)
    res.status(502).json({
      ok: false,
      error: (e as Error).message ?? 'save-pools fetch failed',
    })
  }
}
