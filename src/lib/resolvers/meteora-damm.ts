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
import { PublicKey } from '@solana/web3.js'
import { findTarget, openOnTarget } from './targets'
import type {
  AmmResolver,
  CloseResult,
  OpenResult,
  RawPosition,
} from './index'

const STACSOL_MINT = '6K4xdfEk5rvySM496rxm4x8AgC9wVt7N4C7mFFpNAj5f'
const WSOL = NATIVE_MINT.toBase58()

// Meteora Dynamic-AMM (DAMM v1) program. Pool account layout:
//   [0..8]    anchor discriminator
//   [8..40]   lp_mint        ← memcmp here to reverse-lookup pool from LP mint
//   [40..72]  token_a_mint
//   [72..104] token_b_mint
//   ... (vaults / lp vaults / fees follow)
const METEORA_DAMM_PROGRAM = new PublicKey(
  'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB',
)
const LP_MINT_OFFSET = 8

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
    open: 'live',
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

    // Meteora removed the `?lp_mints=...` bulk lookup; the public API now
    // only takes `?address=<POOL_ADDR>`. Reverse-lookup path: memcmp the
    // pool struct at offset 8 (lp_mint field) for each held LP balance.
    // That's one cheap RPC call per balance, vs paginating ~58k SOL pools.
    const mints = Array.from(balances.keys())
    const matches = await Promise.allSettled(
      mints.map(async (mint) => {
        const res = await connection.getProgramAccounts(METEORA_DAMM_PROGRAM, {
          commitment: 'confirmed',
          dataSlice: { offset: 0, length: 0 },
          filters: [{ memcmp: { offset: LP_MINT_OFFSET, bytes: mint } }],
        })
        return { mint, pool: res[0]?.pubkey.toBase58() }
      }),
    )
    const poolByLp = new Map<string, string>()
    for (const m of matches) {
      if (m.status === 'fulfilled' && m.value.pool) {
        poolByLp.set(m.value.mint, m.value.pool)
      }
    }
    if (poolByLp.size === 0) return []

    // Bulk-fetch pool metadata in one call. The API accepts comma-separated
    // `address=A,B,C` and returns an array.
    const addrs = Array.from(poolByLp.values()).join(',')
    const out: RawPosition[] = []
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let pools: any[] = []
    try {
      const r = await fetch(
        `https://amm-v2.meteora.ag/pools?address=${addrs}`,
        { signal: AbortSignal.timeout(10_000) },
      )
      if (r.ok) {
        const j = await r.json()
        pools = Array.isArray(j) ? j : j.data ?? j.pools ?? []
      }
    } catch {
      /* network blip — degrade to empty rather than block other resolvers */
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
      // The current API response doesn't ship per-token decimals; reasonable
      // defaults until/unless we read the mint accounts directly.
      const decA: number = p.pool_token_decimals?.[0] ?? 9
      const decB: number = p.pool_token_decimals?.[1] ?? 9
      const otherSymbol: string = (() => {
        const name: string | undefined = p.pool_name
        if (!name) return otherMint.slice(0, 6) + '…'
        // "FOO-SOL" → other side = "FOO". Strip the "-SOL" / "SOL-" half.
        const parts = name.split('-')
        if (parts.length === 2) return solIsA ? parts[1] : parts[0]
        return parts.find((s) => s !== 'SOL') ?? otherMint.slice(0, 6) + '…'
      })()

      out.push({
        amm: 'meteora-damm',
        positionId: lpMint,
        poolAddress: p.pool_address ?? p.address ?? poolByLp.get(lpMint) ?? lpMint,
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
          poolId: p.pool_address ?? p.address ?? poolByLp.get(lpMint) ?? lpMint,
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
    return out
  },

  async buildCloseTxs(connection, wallet, pos): Promise<CloseResult> {
    if (pos.state === 'already-stacsol') {
      throw new Error('position is already stacSOL — nothing to migrate')
    }
    const r = pos.raw as DammRaw
    // Lazy-load the Meteora DAMM SDK so it doesn't bloat the initial bundle.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sdk = (await import('@meteora-ag/dynamic-amm-sdk').catch(() => null)) as any
    if (!sdk) throw new Error('meteora dynamic-amm SDK not loaded')
    const AmmImpl = sdk.default ?? sdk
    if (!AmmImpl?.create) throw new Error('meteora SDK shape unexpected — no AmmImpl.create')
    const { PublicKey } = await import('@solana/web3.js')

    const pool = await AmmImpl.create(connection, new PublicKey(r.poolId))
    // removeLiquidity(owner, lpAtom, slippage) — slippage is BPS (0 = no min)
    const tx = await pool.removeLiquidity(wallet, r.lpAtom, 0)
    return {
      txs: Array.isArray(tx) ? tx : [tx],
      estSolAtom: pos.solAtom,
      estOtherAtom: pos.otherAtom,
    }
  },

  async buildOpenTxs(connection, wallet, pos, stacAtomEstimate): Promise<OpenResult> {
    // No curated stacSOL DAMM target today — route to the cross-AMM router.
    const target = findTarget(pos.otherMint)
    if (!target) {
      throw new Error(
        `no curated stacSOL/${pos.otherSymbol} target on any AMM — auto-init pending`,
      )
    }
    return await openOnTarget(connection, wallet, target, stacAtomEstimate, pos.otherAtom)
  },
}

export default resolver
