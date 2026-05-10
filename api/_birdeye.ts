// Shared Birdeye markets fetcher.
//
// stacSOL has multiple LPs across venues — Sanctum (the protocol pool itself,
// which equals NAV), several Raydium CP pools paired with thystaccfloweth-family
// memecoins (FOMOX402, Staccana, PROOFV3, etc.), and a real SOL/stacSOL pool.
//
// For "LP price in SOL" we want the deepest SOL-paired market that isn't the
// Sanctum protocol pool. That's the honest "secondary market is saying X" number.

const STACSOL = '6K4xdfEk5rvySM496rxm4x8AgC9wVt7N4C7mFFpNAj5f'
const WSOL = 'So11111111111111111111111111111111111111112'
const SANCTUM_POOL = 'E6oqvrLKexQwFJyCnQ8ewx8xt9tQo7uezat24f5Qixqb'

export interface BirdeyeMarket {
  address: string
  source: string
  liquidity: number
  volume24h: number
  price: number
  base: { address: string; symbol: string; decimals: number }
  quote: { address: string; symbol: string; decimals: number }
  name: string
}

interface BirdeyeMarketsResponse {
  success: boolean
  data?: { items: BirdeyeMarket[]; hasNext?: boolean }
  message?: string
}

// Page through all markets for stacSOL. Birdeye caps limit at 20 per page.
export async function fetchAllStacsolMarkets(apiKey: string): Promise<BirdeyeMarket[]> {
  const all: BirdeyeMarket[] = []
  let offset = 0
  const limit = 20
  for (let page = 0; page < 10; page++) {
    const url = `https://public-api.birdeye.so/defi/v2/markets?address=${STACSOL}&limit=${limit}&offset=${offset}&sort_by=liquidity&sort_type=desc`
    const r = await fetch(url, {
      headers: { 'X-API-KEY': apiKey, 'x-chain': 'solana' },
      signal: AbortSignal.timeout(10_000),
    })
    if (!r.ok) break
    const j = (await r.json()) as BirdeyeMarketsResponse
    if (!j.success || !j.data) break
    all.push(...j.data.items)
    if (!j.data.hasNext || j.data.items.length < limit) break
    offset += limit
  }
  return all
}

/**
 * Pick the deepest SOL-paired LP, excluding the Sanctum protocol pool itself.
 * Returns SOL price per stacSOL (i.e. how many SOL you'd get for 1 stacSOL on
 * that LP at current spot), or null if no such market exists.
 */
export function pickLpPriceSol(markets: BirdeyeMarket[]): number | null {
  const candidates = markets
    .filter((m) => m.address !== SANCTUM_POOL)
    .filter((m) => m.base.address === WSOL || m.quote.address === WSOL)
    .filter((m) => m.liquidity > 0)
    .sort((a, b) => b.liquidity - a.liquidity)

  if (candidates.length === 0) return null
  const top = candidates[0]
  // Birdeye `price` semantics: price of base in terms of quote.
  // We want SOL per stacSOL. If base is stacSOL and quote is SOL, price IS what
  // we want. If base is SOL and quote is stacSOL, invert.
  if (top.base.address === STACSOL) return top.price
  if (top.quote.address === STACSOL) return 1 / top.price
  return null
}

export { STACSOL, WSOL, SANCTUM_POOL }
