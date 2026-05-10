import type { VercelRequest, VercelResponse } from '@vercel/node'

// Server-side proxy for Jupiter Swap v1 /quote on the paid api.jup.ag tier.
// Keeps JUPITER_API_KEY out of the client bundle. Client passes the same
// query params they would to lite-api.jup.ag; we just forward them with the
// auth header to the higher-tier endpoint that has access to deeper routes.
//
// Lite-api (free) frequently returns "no routes found" on thin pairs because
// it gates the multi-hop router. The paid tier can route through multiple
// hops (e.g. SOL → USDC → stacSOL) which is what we actually want for zaps.

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const apiKey = process.env.JUPITER_API_KEY
    if (!apiKey) {
      res.status(500).json({ error: 'JUPITER_API_KEY not set' })
      return
    }
    const qs = new URLSearchParams()
    for (const [k, v] of Object.entries(req.query)) {
      if (typeof v === 'string') qs.set(k, v)
      else if (Array.isArray(v) && v.length > 0) qs.set(k, String(v[0]))
    }
    const url = `https://api.jup.ag/swap/v1/quote?${qs.toString()}`
    const r = await fetch(url, {
      headers: { 'x-api-key': apiKey },
      signal: AbortSignal.timeout(10_000),
    })
    const text = await r.text()
    res.setHeader('Content-Type', 'application/json')
    res.status(r.status).send(text)
  } catch (e) {
    console.error('jup-quote error:', e)
    res.status(500).json({ error: (e as Error).message })
  }
}
