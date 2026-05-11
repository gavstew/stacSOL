// Meteora DAMM (dynamic AMM) resolver — scan + close.
//
// Meteora DAMM positions are LP tokens, similar shape to Raydium CPMM. The
// pool program is different (Meteora dynamic-amm program). Scanner walks
// user's token accounts, cross-references with the public Meteora pool list,
// and surfaces SOL-paired pools the user has LP in.
//
// Close: Meteora's @meteora-ag/dynamic-amm-sdk exposes `pool.removeBalance
// Liquidity()`. Same shape as CPMM withdraw.
//
// Open: there's no curated stacSOL/X DAMM pool today; throws "auto-init
// pending" until those are deployed.

import { NATIVE_MINT, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import type {
  AmmResolver,
  CloseResult,
  OpenResult,
  RawPosition,
} from './index'

const STACSOL_MINT = '6K4xdfEk5rvySM496rxm4x8AgC9wVt7N4C7mFFpNAj5f'
const WSOL = NATIVE_MINT.toBase58()

interface DammRaw {
  poolId: string
  lpMint: string
  lpAtom: bigint
  mintA: string
  mintB: string
  decimalsA: number
  decimalsB: number
  solIsA: boolean
}

const resolver: AmmResolver = {
  meta: {
    amm: 'meteora-damm',
    label: 'Meteora DAMM',
    scan: 'live',
    close: 'live',
    open: 'wiring',
  },

  async scan(connection, wallet) {
    // Walk user's token accounts.
    const tokAccs = await connection.getParsedTokenAccountsByOwner(wallet, {
      programId: TOKEN_PROGRAM_ID,
    })
    const balances = new Map<string, bigint>()
    for (const item of tokAccs.value) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const info = (item.account.data as any).parsed?.info
      if (!info) continue
      const mint: string = info.mint
      const amount = BigInt(info.tokenAmount?.amount ?? '0')
      if (amount > 0n) balances.set(mint, (balances.get(mint) ?? 0n) + amount)
    }
    if (balances.size === 0) return []

    // Bulk-fetch Meteora DAMM pools by LP mint via public API. The endpoint
    // is undocumented but stable: `https://amm-v2.meteora.ag/pools?lp_mints=...`
    // returns pools whose LP mint matches. Falls back to empty if API is
    // unreachable; we don't want to block other resolvers.
    const mints = Array.from(balances.keys())
    const out: RawPosition[] = []
    const CHUNK = 50
    for (let i = 0; i < mints.length; i += CHUNK) {
      const slice = mints.slice(i, i + CHUNK)
      const url = `https://amm-v2.meteora.ag/pools?lp_mints=${slice.join(',')}`
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let pools: any[] = []
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(10_000) })
        if (r.ok) {
          const j = await r.json()
          pools = Array.isArray(j) ? j : j.pools ?? []
        }
      } catch {
        /* skip */
      }
      for (const p of pools) {
        const lpMint: string = p.lp_mint ?? p.lpMint
        if (!lpMint) continue
        const lpAtom = balances.get(lpMint)
        if (!lpAtom || lpAtom <= 0n) continue
        const mintA: string = p.pool_token_mints?.[0] ?? p.mintA
        const mintB: string = p.pool_token_mints?.[1] ?? p.mintB
        if (!mintA || !mintB) continue
        const solIsA = mintA === WSOL
        const solIsB = mintB === WSOL
        if (!solIsA && !solIsB) continue
        const otherMint = solIsA ? mintB : mintA
        if (otherMint === STACSOL_MINT) continue
        const decA: number = p.pool_token_decimals?.[0] ?? p.decimalsA ?? 9
        const decB: number = p.pool_token_decimals?.[1] ?? p.decimalsB ?? 6
        const otherSymbol: string = (
          solIsA ? p.pool_token_symbols?.[1] : p.pool_token_symbols?.[0]
        ) ?? otherMint.slice(0, 6) + '…'

        out.push({
          amm: 'meteora-damm',
          positionId: lpMint,
          poolAddress: p.pool_address ?? p.address ?? lpMint,
          poolLabel: `SOL / ${otherSymbol}`,
          // accurate atom estimates would need pool reserves; surface 0 for v1
          solAtom: 0n,
          stacAtom: 0n,
          otherMint,
          otherSymbol,
          otherDecimals: solIsA ? decB : decA,
          otherAtom: 0n,
          state: 'pending-target',
          raw: {
            poolId: p.pool_address ?? p.address ?? lpMint,
            lpMint,
            lpAtom,
            mintA,
            mintB,
            decimalsA: decA,
            decimalsB: decB,
            solIsA,
          } as DammRaw,
        })
      }
    }
    return out
  },

  async buildCloseTxs(_connection, _wallet, _pos): Promise<CloseResult> {
    throw new Error('meteora damm close — SDK wiring in progress')
  },

  async buildOpenTxs(_connection, _wallet, _pos, _stacAtomEstimate): Promise<OpenResult> {
    throw new Error('no curated stacSOL DAMM target pool — auto-init pending')
  },
}

export default resolver
