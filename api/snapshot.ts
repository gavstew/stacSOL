import type { VercelRequest, VercelResponse } from '@vercel/node'
import { Connection, PublicKey } from '@solana/web3.js'
import { ensureSchema, getPool } from './_db.js'
import { fetchAllStacsolMarkets, pickLpPriceSol } from './_birdeye.js'

const POOL = new PublicKey('E6oqvrLKexQwFJyCnQ8ewx8xt9tQo7uezat24f5Qixqb')
const MINT = new PublicKey('6K4xdfEk5rvySM496rxm4x8AgC9wVt7N4C7mFFpNAj5f')

// Get the deepest SOL-paired LP price (excluding the Sanctum protocol pool
// itself, which would just be NAV). Falls back to null on any error so the
// snapshot still records pool state even if Birdeye is down.
async function fetchLpPriceSol(): Promise<number | null> {
  try {
    const apiKey = process.env.BIRDEYE_API_KEY
    if (!apiKey) return null
    const markets = await fetchAllStacsolMarkets(apiKey)
    const fromMarkets = pickLpPriceSol(markets)
    if (fromMarkets != null && isFinite(fromMarkets) && fromMarkets > 0) {
      return fromMarkets
    }
    // Fallback: ask Jupiter (paid tier) for an actual quote — handles cases
    // where Birdeye lists no SOL-paired market but Jupiter can still route.
    const jup = process.env.JUPITER_API_KEY
    if (!jup) return null
    const q = await fetch(
      'https://api.jup.ag/swap/v1/quote' +
        '?inputMint=' + MINT.toBase58() +
        '&outputMint=So11111111111111111111111111111111111111112' +
        '&amount=1000000000' +
        '&slippageBps=500' +
        '&swapMode=ExactIn',
      { headers: { 'x-api-key': jup }, signal: AbortSignal.timeout(8000) },
    )
    if (!q.ok) return null
    const j = (await q.json()) as { outAmount?: string }
    if (!j.outAmount) return null
    return Number(j.outAmount) / 1e9
  } catch {
    return null
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    await ensureSchema()

    const rpc = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com'
    const conn = new Connection(rpc, 'confirmed')

    const [poolAcc, mintAcc, lpPriceSol] = await Promise.all([
      conn.getAccountInfo(POOL, 'processed'),
      conn.getAccountInfo(MINT, 'processed'),
      fetchLpPriceSol(),
    ])
    if (!poolAcc) throw new Error('pool not found')
    if (!mintAcc) throw new Error('mint not found')

    const d = poolAcc.data
    const reserveStake = new PublicKey(d.subarray(130, 162))
    const totalLamports = d.readBigUInt64LE(258)
    const poolTokenSupply = d.readBigUInt64LE(266)
    const lastUpdateEpoch = d.readBigUInt64LE(274)

    const reserveAcc = await conn.getAccountInfo(reserveStake, 'processed')
    if (!reserveAcc) throw new Error('reserve not found')

    const reserveLamports = BigInt(reserveAcc.lamports)
    const mintSupply = mintAcc.data.readBigUInt64LE(36)
    const rate = Number(totalLamports) / Number(poolTokenSupply || 1n)

    await getPool().query(
      `INSERT INTO pool_snapshots
        (total_lamports, pool_token_supply, mint_supply, reserve_lamports, rate, last_update_epoch, lp_price_sol)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        totalLamports.toString(),
        poolTokenSupply.toString(),
        mintSupply.toString(),
        reserveLamports.toString(),
        rate,
        Number(lastUpdateEpoch),
        lpPriceSol,
      ],
    )

    res.status(200).json({
      ok: true,
      ts: new Date().toISOString(),
      rate,
      lp_price_sol: lpPriceSol,
      total_lamports: totalLamports.toString(),
      pool_token_supply: poolTokenSupply.toString(),
      mint_supply: mintSupply.toString(),
      reserve_lamports: reserveLamports.toString(),
    })
  } catch (e) {
    console.error('snapshot error:', e)
    res.status(500).json({ ok: false, error: (e as Error).message })
  }
}
