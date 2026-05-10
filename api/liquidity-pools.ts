import type { VercelRequest, VercelResponse } from '@vercel/node'

// The five Raydium CPMM pools that hold stacSOL liquidity. Server-side
// proxy so we can cache and so the client doesn't have to know the list.
const POOL_IDS = [
  'DW64PozCS4Es7tf9AZUaRGRGAYig7EZLFcC3P7KDZscT', // stacSOL/USDC
  'nMzTESMbiYFeQ4XT6vf3JsUH4c9M2HkWz8kmRBSLgjR', // WSOL/stacSOL
  'AoqXsEJDb5fcdqAWYLiSHYSfFUeW5GsP7ttvbdnDnt8T', // stacSOL/Staccana
  '5V5CDgZY4XVFuCBbUJCB21LGAcYpfMnK5JPunp2Wjo97', // stacSOL/FOMOX402
  '4X5TsWFxoisuLeh95GsUTn4ZhcqYRtx1smvuisvUW22D', // stacSOL/PROOFV3
]

export default async function handler(_req: VercelRequest, res: VercelResponse) {
  try {
    const url = `https://api-v3.raydium.io/pools/info/ids?ids=${POOL_IDS.join(',')}`
    const r = await fetch(url, { signal: AbortSignal.timeout(10_000) })
    if (!r.ok) {
      res.status(502).json({ ok: false, error: `raydium ${r.status}` })
      return
    }
    const j = await r.json()
    res.setHeader('Cache-Control', 'public, max-age=20, s-maxage=20, stale-while-revalidate=60')
    res.status(200).json({
      ok: true,
      pools: j.data ?? [],
    })
  } catch (e) {
    console.error('liquidity-pools error:', e)
    res.status(500).json({ ok: false, error: (e as Error).message })
  }
}

export { POOL_IDS }
