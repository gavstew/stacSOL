// Pump AMM resolver — scan + close + cross-AMM reopen.
//
// Pump AMM positions are LP tokens minted by `lpMintPda(pool)`. Pool PDA for
// canonical pools = `canonicalPumpPoolPda(baseMint)` — derived purely from
// the base meme mint. That lets us discover positions cheaply:
//
//   1. Walk every token account the user owns.
//   2. For each non-zero token, treat the mint as a candidate baseMint and
//      derive (canonicalPool, lpMint).
//   3. If the user ALSO holds a non-zero balance of that derived lpMint, they
//      have a position in that Pump AMM pool.
//
// Quote is wSOL in nearly all Pump AMM pools (every graduated pump.fun
// memecoin pairs against wSOL post-bonding-curve). We surface the user's
// LP-implied SOL + base amounts at scan time so the UI can render real
// numbers.
//
// Close: build via `PumpAmmSdk.withdrawInstructions(liquiditySolanaState,
// lpToken, slippage)` — withdraws 100% of the LP, returns base + quote to
// the user's ATAs.
//
// Open: no Pump AMM target for stacSOL today (Pump AMM is one-mint-per-pool
// and stacSOL isn't a pump.fun coin). Routes through targets.openOnTarget to
// reopen on a curated Meteora DLMM or Raydium CPMM stacSOL/X pool.

import { NATIVE_MINT, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { PublicKey } from '@solana/web3.js'
import BN from 'bn.js'
import { findTarget, openOnTarget } from './targets'
import type {
  AmmResolver,
  CloseResult,
  OpenResult,
  RawPosition,
} from './index'

const STACSOL_MINT = '6K4xdfEk5rvySM496rxm4x8AgC9wVt7N4C7mFFpNAj5f'
const WSOL = NATIVE_MINT.toBase58()

interface PumpRaw {
  poolId: string
  lpMint: string
  lpAtom: bigint
  baseMint: string
  quoteMint: string
  baseDecimals: number
  quoteDecimals: number
  /** Whether SOL is the quote (true for nearly all Pump AMM pools). */
  solIsQuote: boolean
}

async function loadPumpSdk() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sdk = (await import('@pump-fun/pump-swap-sdk').catch(() => null)) as any
  if (!sdk) return null
  return sdk
}

const resolver: AmmResolver = {
  meta: {
    amm: 'pump-amm',
    label: 'Pump AMM',
    scan: 'live',
    close: 'live',
    open: 'live',
  },

  async scan(connection, wallet) {
    const sdk = await loadPumpSdk()
    if (!sdk) return []
    const { canonicalPumpPoolPda, lpMintPda, OnlinePumpAmmSdk } = sdk
    if (!canonicalPumpPoolPda || !lpMintPda || !OnlinePumpAmmSdk) return []

    // 1. Walk user's token accounts. For Pump AMM the LP token uses the
    //    classic SPL Token program (not Token-2022), so we only need to
    //    query that one program.
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

    // 2. For each mint the user holds, derive the canonical Pump AMM pool
    //    and its LP mint. If the user ALSO holds the derived LP mint, they
    //    have a position. Skip wSOL, stacSOL, and well-known stables.
    const SKIP_BASE_MINTS = new Set([
      WSOL,
      STACSOL_MINT,
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
      'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
    ])
    type Candidate = {
      poolId: string
      lpMint: string
      lpAtom: bigint
      baseMint: string
    }
    const candidates: Candidate[] = []
    for (const [mint, _amount] of balances) {
      if (SKIP_BASE_MINTS.has(mint)) continue
      void _amount
      try {
        const baseMintPk = new PublicKey(mint)
        const poolPk: PublicKey = canonicalPumpPoolPda(baseMintPk)
        const lpMintPk: PublicKey = lpMintPda(poolPk)
        const lpMintStr = lpMintPk.toBase58()
        const lpBalance = balances.get(lpMintStr)
        if (!lpBalance || lpBalance <= 0n) continue
        candidates.push({
          poolId: poolPk.toBase58(),
          lpMint: lpMintStr,
          lpAtom: lpBalance,
          baseMint: mint,
        })
      } catch {
        /* not a valid PublicKey or PDA derivation failed; skip */
      }
    }
    if (candidates.length === 0) return []

    // 3. Fetch pool state for each candidate to confirm it's a real Pump AMM
    //    pool (not just a derived PDA that happens to exist) AND to read
    //    pool reserves so we can compute the user's implied SOL + base.
    const online = new OnlinePumpAmmSdk(connection)
    const out: RawPosition[] = []
    for (const c of candidates) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let pool: any = null
      try {
        pool = await online.fetchPool(new PublicKey(c.poolId))
      } catch {
        /* pool doesn't exist on chain — skip */
        continue
      }
      if (!pool) continue
      const baseMint: string =
        pool.baseMint?.toBase58?.() ?? pool.base_mint?.toBase58?.() ?? c.baseMint
      const quoteMint: string =
        pool.quoteMint?.toBase58?.() ?? pool.quote_mint?.toBase58?.() ?? WSOL
      const solIsQuote = quoteMint === WSOL
      // Pump AMM pools only pair with SOL on the quote side in canonical
      // deployments; if not, skip (we don't migrate non-SOL-paired here).
      if (!solIsQuote) continue
      // Pool reserves + LP supply for share math.
      const baseReserve = BigInt(
        (pool.poolBaseTokenReserves ?? pool.pool_base_token_reserves ?? '0').toString(),
      )
      const quoteReserve = BigInt(
        (pool.poolQuoteTokenReserves ?? pool.pool_quote_token_reserves ?? '0').toString(),
      )
      const lpSupply = BigInt(
        (pool.lpSupply ?? pool.lp_supply ?? pool.poolLpSupply ?? '0').toString(),
      )
      if (lpSupply === 0n) continue
      const solAtom = (quoteReserve * c.lpAtom) / lpSupply
      const otherAtom = (baseReserve * c.lpAtom) / lpSupply

      const baseDecimals = pool.baseMintDecimals ?? pool.base_decimals ?? 6
      const baseSymbol = baseMint.slice(0, 6) + '…'

      const tgt = findTarget(baseMint)
      const state = tgt ? 'migratable' : 'pending-target'

      out.push({
        amm: 'pump-amm',
        positionId: c.lpMint,
        poolAddress: c.poolId,
        poolLabel: `SOL / ${tgt?.otherSymbol ?? baseSymbol}`,
        solAtom,
        stacAtom: 0n,
        otherMint: baseMint,
        otherSymbol: tgt?.otherSymbol ?? baseSymbol,
        otherDecimals: baseDecimals,
        otherAtom,
        state,
        raw: {
          poolId: c.poolId,
          lpMint: c.lpMint,
          lpAtom: c.lpAtom,
          baseMint,
          quoteMint,
          baseDecimals,
          quoteDecimals: 9,
          solIsQuote,
        } as PumpRaw,
      })
    }
    return out
  },

  async buildCloseTxs(connection, wallet, pos): Promise<CloseResult> {
    if (pos.state === 'already-stacsol') {
      throw new Error('position is already stacSOL — nothing to migrate')
    }
    const r = pos.raw as PumpRaw
    const sdk = await loadPumpSdk()
    if (!sdk) throw new Error('pump-swap-sdk not loaded')
    const { OnlinePumpAmmSdk, PumpAmmSdk } = sdk

    const online = new OnlinePumpAmmSdk(connection)
    const offline = new PumpAmmSdk()
    const liqState = await online.liquiditySolanaState(
      new PublicKey(r.poolId),
      wallet,
    )
    // 100% slippage = withdraw whatever the pool gives us at current ratio.
    // 100bps would also work for tight withdrawals; we're closing the whole
    // position so we accept whatever the AMM pays out.
    const ixs = await offline.withdrawInstructions(liqState, new BN(r.lpAtom.toString()), 100)

    // Wrap the ix list into a v0 VersionedTransaction with a Helius tip.
    const { heliusTipIx, HELIUS_SENDER_TIP_LAMPORTS } = await import('../zap')
    const { TransactionMessage, VersionedTransaction, ComputeBudgetProgram } = await import('@solana/web3.js')
    const { blockhash } = await connection.getLatestBlockhash('confirmed')
    const msg = new TransactionMessage({
      payerKey: wallet,
      recentBlockhash: blockhash,
      instructions: [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }),
        ...ixs,
        heliusTipIx(wallet, HELIUS_SENDER_TIP_LAMPORTS),
      ],
    }).compileToV0Message()
    return {
      txs: [new VersionedTransaction(msg)],
      estSolAtom: pos.solAtom,
      estOtherAtom: pos.otherAtom,
    }
  },

  async buildOpenTxs(connection, wallet, pos, stacAtomEstimate): Promise<OpenResult> {
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
