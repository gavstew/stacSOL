import type { VercelRequest, VercelResponse } from '@vercel/node'
import { fetchAllStacsolMarkets, pickLpPriceSol, SANCTUM_POOL, WSOL, STACSOL } from './_birdeye.js'

// Returns the full markets list for stacSOL plus the picked "best LP price".
// Proxies Birdeye so the API key stays server-side.
//
// Response:
// {
//   bestLpSol: number | null,          // deepest SOL-paired LP price (SOL/stacSOL)
//   markets: [{
//     address, source, name, liquidity, volume24h,
//     price, base, quote,
//     isSolPair, isProtocolPool
//   }]
// }
export default async function handler(_req: VercelRequest, res: VercelResponse) {
  try {
    const apiKey = process.env.BIRDEYE_API_KEY
    if (!apiKey) {
      res.status(500).json({ ok: false, error: 'BIRDEYE_API_KEY not set' })
      return
    }
    const all = await fetchAllStacsolMarkets(apiKey)
    const bestLpSol = pickLpPriceSol(all)

    res.setHeader('Cache-Control', 'public, max-age=20, s-maxage=20, stale-while-revalidate=60')
    res.status(200).json({
      ok: true,
      bestLpSol,
      markets: all.map((m) => ({
        address: m.address,
        source: m.source,
        name: m.name,
        liquidity: m.liquidity,
        volume24h: m.volume24h,
        price: m.price,
        base: { address: m.base.address, symbol: m.base.symbol },
        quote: { address: m.quote.address, symbol: m.quote.symbol },
        isSolPair: m.base.address === WSOL || m.quote.address === WSOL,
        isProtocolPool: m.address === SANCTUM_POOL,
        isStacsolBase: m.base.address === STACSOL,
      })),
    })
  } catch (e) {
    console.error('lp error:', e)
    res.status(500).json({ ok: false, error: (e as Error).message })
  }
}
