import type { VercelRequest, VercelResponse } from '@vercel/node'

// Server-side proxy for Jupiter Swap v1 /swap (POST) on the paid tier.
// See api/jup-quote.ts for rationale.

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const apiKey = process.env.JUPITER_API_KEY
    if (!apiKey) {
      res.status(500).json({ error: 'JUPITER_API_KEY not set' })
      return
    }
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'POST only' })
      return
    }
    const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body)
    const r = await fetch('https://api.jup.ag/swap/v1/swap', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
      },
      body,
      signal: AbortSignal.timeout(15_000),
    })
    const text = await r.text()
    res.setHeader('Content-Type', 'application/json')
    res.status(r.status).send(text)
  } catch (e) {
    console.error('jup-swap error:', e)
    res.status(500).json({ error: (e as Error).message })
  }
}
