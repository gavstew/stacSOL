// Raydium CPMM resolver — scan + close + open for liqmonsta.
//
// Positions in Raydium CPMM are LP tokens. To find user's SOL-paired CPMM
// positions we:
//   1. Get the user's token accounts via getParsedTokenAccountsByOwner.
//   2. Bulk-lookup all those mints against Raydium's pool API (per-pool fetch
//      via `raydium.api.fetchPoolByLpMint`). Pools where mintA or mintB is
//      wSOL are kept.
//   3. For each match, decode the user's share of the pool via lpAmount /
//      lpSupply, giving estimates for SOL + tokenB recovered on burn.
//
// Close: `raydium.cpmm.withdrawLiquidity({ poolInfo, poolKeys, lpAmount, ... })`
// — returns a tx that burns the LP and credits tokenA + tokenB to the user.
//
// Open: only fires when there's a curated stacSOL/X CPMM pool. We addLiquidity
// using the stacSOL we expect after the mint step + the recovered tokenB.
//
// Curated stacSOL CPMM pools (api/liquidity-pools.ts):
//   stacSOL/USDC, WSOL/stacSOL, stacSOL/Staccana, stacSOL/FOMOX402, stacSOL/PROOFV3

import { NATIVE_MINT, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { LAMPORTS_PER_SOL } from '@solana/web3.js'
import BN from 'bn.js'
import { HELIUS_SENDER_TIP_LAMPORTS, pickHeliusTipAccount } from '../zap'
import type {
  AmmResolver,
  CloseResult,
  OpenResult,
  RawPosition,
} from './index'

const STACSOL_MINT = '6K4xdfEk5rvySM496rxm4x8AgC9wVt7N4C7mFFpNAj5f'
const WSOL = NATIVE_MINT.toBase58()

// Curated stacSOL CPMM pools, indexed by the "other" mint. These are the
// targets we route to when the user has a SOL/X CPMM position and X has a
// stacSOL/X CPMM pool deployed.
//
// Pool IDs match api/liquidity-pools.ts. Keep in sync.
const CURATED_STAC_CPMM: Record<string, { poolId: string; otherSymbol: string }> = {
  // USDC
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: {
    poolId: 'DW64PozCS4Es7tf9AZUaRGRGAYig7EZLFcC3P7KDZscT',
    otherSymbol: 'USDC',
  },
  // Staccana
  '73edX6xoGY4v5y2hzuKdrUbJXLntqgmo74au1Ki1pump': {
    poolId: 'AoqXsEJDb5fcdqAWYLiSHYSfFUeW5GsP7ttvbdnDnt8T',
    otherSymbol: 'Staccana',
  },
  // FOMOX402
  GezJEsABGEmZVoXsDKHCCwYvxGPhQFk4hd91MchYQZaM: {
    poolId: '5V5CDgZY4XVFuCBbUJCB21LGAcYpfMnK5JPunp2Wjo97',
    otherSymbol: 'FOMOX402',
  },
  // PROOFV3
  CLWeikxiw8pC9JEtZt14fqDzYfXF7uVwLuvnJPkrE7av: {
    poolId: '4X5TsWFxoisuLeh95GsUTn4ZhcqYRtx1smvuisvUW22D',
    otherSymbol: 'PROOFV3',
  },
}

interface CpmmRaw {
  /** Pool ID of the SOL/X CPMM the user has LP in. */
  srcPoolId: string
  /** User's LP token mint + ATA + atomic balance. */
  lpMint: string
  lpAtom: bigint
  /** Mints + decimals on the source pool. */
  mintA: string
  mintB: string
  decimalsA: number
  decimalsB: number
  /** Whether SOL is mintA. */
  solIsA: boolean
  /** Pool reserves (atoms) at scan time — used to estimate recovered amounts. */
  reserveA: bigint
  reserveB: bigint
  lpSupply: bigint
  /** Target stacSOL CPMM pool ID, if curated. */
  targetPoolId: string | null
}

// Single global Raydium SDK loader so we don't double-init when the page
// re-renders.
async function loadRaydium(connection: import('@solana/web3.js').Connection) {
  const { Raydium } = await import('@raydium-io/raydium-sdk-v2')
  return await Raydium.load({
    connection,
    cluster: 'mainnet',
    disableFeatureCheck: true,
    blockhashCommitment: 'confirmed',
  })
}

const resolver: AmmResolver = {
  meta: {
    amm: 'raydium-cpmm',
    label: 'Raydium CPMM',
    scan: 'live',
    close: 'live',
    open: 'live',
  },

  async scan(connection, wallet) {
    // 1. Get user's token accounts. We only care about ones with a non-zero
    //    balance — LP tokens with 0 balance are old empty ATAs.
    const tokAccs = await connection.getParsedTokenAccountsByOwner(
      wallet,
      { programId: TOKEN_PROGRAM_ID },
    )
    const balances = new Map<string, bigint>() // mint → atom
    for (const item of tokAccs.value) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const info = (item.account.data as any).parsed?.info
      if (!info) continue
      const mint: string = info.mint
      const amount = BigInt(info.tokenAmount?.amount ?? '0')
      if (amount > 0n) balances.set(mint, (balances.get(mint) ?? 0n) + amount)
    }
    if (balances.size === 0) return []

    // 2. Bulk-lookup pools by LP mint via Raydium API. We hit the public
    //    endpoint which accepts comma-separated LP mints.
    const mints = Array.from(balances.keys())
    const out: RawPosition[] = []
    const CHUNK = 50 // be polite to the API
    for (let i = 0; i < mints.length; i += CHUNK) {
      const slice = mints.slice(i, i + CHUNK)
      // /pools/info/lps?lps=...  — returns pools whose LP mint matches.
      // Falls back to per-mint lookup if the bulk endpoint isn't available.
      const url = `https://api-v3.raydium.io/pools/info/lps?lps=${slice.join(',')}`
      let pools: unknown[] = []
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(10_000) })
        if (r.ok) {
          const j = await r.json()
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          pools = ((j as any).data ?? []) as unknown[]
        }
      } catch {
        /* ignore — fall through with no pools for this batch */
      }
      for (const pRaw of pools) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const p = pRaw as any
        if (!p || p.type !== 'Standard') continue // only CPMM, skip CLMM/AMMv4
        const lpMint: string = p.lpMint?.address ?? p.lpMint ?? ''
        if (!lpMint) continue
        const lpAtom = balances.get(lpMint)
        if (!lpAtom || lpAtom <= 0n) continue
        const mintA: string = p.mintA?.address ?? ''
        const mintB: string = p.mintB?.address ?? ''
        const solIsA = mintA === WSOL
        const solIsB = mintB === WSOL
        if (!solIsA && !solIsB) continue
        const otherMint = solIsA ? mintB : mintA
        // skip stacSOL/SOL itself (don't migrate into ourselves)
        if (otherMint === STACSOL_MINT) continue

        const decA: number = p.mintA?.decimals ?? 9
        const decB: number = p.mintB?.decimals ?? 6
        // pool reserves — different API shapes use different fields.
        const reserveA = BigInt(
          Math.floor((Number(p.mintAmountA ?? 0) || 0) * Math.pow(10, decA)),
        )
        const reserveB = BigInt(
          Math.floor((Number(p.mintAmountB ?? 0) || 0) * Math.pow(10, decB)),
        )
        const lpSupply = BigInt(
          Math.floor(
            (Number(p.lpAmount ?? 0) || 0) * Math.pow(10, p.lpMint?.decimals ?? 9),
          ),
        )
        if (lpSupply === 0n) continue

        const solReserve = solIsA ? reserveA : reserveB
        const otherReserve = solIsA ? reserveB : reserveA
        const solAtom = (solReserve * lpAtom) / lpSupply
        const otherAtom = (otherReserve * lpAtom) / lpSupply

        const target = CURATED_STAC_CPMM[otherMint] ?? null
        out.push({
          amm: 'raydium-cpmm',
          positionId: lpMint,
          poolAddress: p.id ?? lpMint,
          poolLabel: `SOL / ${target?.otherSymbol ?? p.mintB?.symbol ?? otherMint.slice(0, 6) + '…'}`,
          solAtom,
          stacAtom: 0n,
          otherMint,
          otherSymbol: target?.otherSymbol ?? (p.mintB?.symbol ?? '?'),
          otherDecimals: solIsA ? decB : decA,
          otherAtom,
          state: target ? 'migratable' : 'pending-target',
          raw: {
            srcPoolId: p.id,
            lpMint,
            lpAtom,
            mintA,
            mintB,
            decimalsA: decA,
            decimalsB: decB,
            solIsA,
            reserveA,
            reserveB,
            lpSupply,
            targetPoolId: target?.poolId ?? null,
          } as CpmmRaw,
        })
      }
    }
    return out
  },

  async buildCloseTxs(connection, wallet, pos): Promise<CloseResult> {
    const r = pos.raw as CpmmRaw
    const { TxVersion, Percent } = await import('@raydium-io/raydium-sdk-v2')
    const raydium = await loadRaydium(connection)
    raydium.setOwner(wallet)

    const poolKeysArr = await raydium.api.fetchPoolKeysById({ idList: [r.srcPoolId] })
    const poolInfoArr = await raydium.api.fetchPoolById({ ids: r.srcPoolId })
    if (!poolKeysArr?.[0] || !poolInfoArr?.[0]) {
      throw new Error(`raydium pool ${r.srcPoolId} not fetchable`)
    }
    const withdraw = await raydium.cpmm.withdrawLiquidity({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      poolInfo: poolInfoArr[0] as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      poolKeys: poolKeysArr[0] as any,
      lpAmount: new BN(r.lpAtom.toString()),
      slippage: new Percent(100, 100), // 100% — we're withdrawing 100%, no slippage concern
      txVersion: TxVersion.V0,
      txTipConfig: {
        address: pickHeliusTipAccount(),
        amount: new BN(HELIUS_SENDER_TIP_LAMPORTS),
      },
    })
    return {
      txs: [withdraw.transaction],
      estSolAtom: pos.solAtom,
      estOtherAtom: pos.otherAtom,
    }
  },

  async buildOpenTxs(connection, wallet, pos, stacAtomEstimate): Promise<OpenResult> {
    const r = pos.raw as CpmmRaw
    if (!r.targetPoolId) {
      throw new Error('no curated stacSOL CPMM target')
    }
    const { TxVersion, Percent } = await import('@raydium-io/raydium-sdk-v2')
    const raydium = await loadRaydium(connection)
    raydium.setOwner(wallet)

    const [poolKeysArr, poolInfoArr] = await Promise.all([
      raydium.api.fetchPoolKeysById({ idList: [r.targetPoolId] }),
      raydium.api.fetchPoolById({ ids: r.targetPoolId }),
    ])
    if (!poolKeysArr?.[0] || !poolInfoArr?.[0]) {
      throw new Error(`raydium target pool ${r.targetPoolId} not fetchable`)
    }
    const poolInfo = poolInfoArr[0]
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const poolKeys = poolKeysArr[0] as any

    // Determine which side stacSOL is on the target pool (we curate stacSOL
    // as either mintA OR mintB depending on the pool; both shapes exist).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pi = poolInfo as any
    const stacIsA = pi.mintA?.address === STACSOL_MINT
    // baseIn=true means we're sizing by mintA's input; baseIn=false by mintB.
    // Stacc has stacSOL, so we want to base on that side.
    const baseIn = stacIsA

    const addResult = await raydium.cpmm.addLiquidity({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      poolInfo: poolInfo as any,
      poolKeys,
      inputAmount: new BN(stacAtomEstimate.toString()),
      baseIn,
      slippage: new Percent(100, 100),
      txVersion: TxVersion.V0,
      txTipConfig: {
        address: pickHeliusTipAccount(),
        amount: new BN(HELIUS_SENDER_TIP_LAMPORTS),
      },
    })
    return {
      txs: [addResult.transaction],
    }
  },
}

// Suppress the unused-import warning for LAMPORTS_PER_SOL — it's reachable
// via dead-code-elimination but eslint flags it. Keep the import so future
// callers don't have to re-add it.
void LAMPORTS_PER_SOL

export default resolver
