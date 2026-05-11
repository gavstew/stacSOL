// Cross-AMM target registry + dispatch.
//
// Every smash flow follows the same shape: close on source AMM → mint
// SOL→stacSOL → reopen on a curated stacSOL/X pool. The "reopen on a curated
// stacSOL/X pool" step doesn't have to land on the SAME AMM the user came
// from. A user who closes a Raydium CLMM SOL/USDC position can still get a
// stacSOL position because we have a curated stacSOL/USDC Meteora DLMM pool
// (and a curated stacSOL/USDC Raydium CPMM pool).
//
// This module:
//   1. Knows every curated stacSOL/X pool across AMMs (DLMM + CPMM today).
//   2. Resolves "best target for tokenB" — prefers Meteora DLMM (deepest
//      liquidity + uses our Hawkfi-managed flow), falls back to Raydium CPMM
//      (broader symmetric AMM).
//   3. Exposes `openOnTarget(...)` which builds the open tx for whichever
//      AMM the target lives on.
//
// Adding a new target = one entry in CURATED_TARGETS. New target AMMs require
// extending the openOnTarget switch.

import { LAMPORTS_PER_SOL, PublicKey, type Connection, type Transaction, type VersionedTransaction } from '@solana/web3.js'
import BN from 'bn.js'
import { METEORA_POOLS, STACSOL_MINT } from '../meteora-pools'
import {
  HELIUS_SENDER_TIP_LAMPORTS,
  pickHeliusTipAccount,
} from '../zap'
import { buildHawkDepositTxs } from '../hawkfi-flows'

export type TargetVenue = 'meteora-dlmm' | 'raydium-cpmm'

export interface CuratedTarget {
  venue: TargetVenue
  /** Pool address on the venue. */
  poolId: string
  /** Counterparty mint (the side paired with stacSOL on this pool). */
  otherMint: string
  otherSymbol: string
  otherDecimals: number
  /** DLMM-only: bin step (in 0.01% units). */
  binStep?: number
  /** DLMM-only: active id at deploy — used to seed a "centered" bin range
   *  when we don't have a same-AMM mirror to copy. */
  activeId?: number
  /** DLMM-only: initial price (tokenY per tokenX). Useful for the centered-
   *  range fallback. */
  initialPriceYPerX?: number
}

/**
 * Curated stacSOL targets across every venue we know how to open into.
 *
 * Meteora DLMM targets come from src/lib/meteora-pools.ts (auto-imported
 * below). Raydium CPMM targets are listed inline since we don't have a
 * client-side curated module for them — pool IDs match api/liquidity-pools.ts.
 */
const CURATED_DLMM: CuratedTarget[] = METEORA_POOLS
  .filter((p) => p.tokenX === STACSOL_MINT || p.tokenY === STACSOL_MINT)
  .map((p): CuratedTarget => {
    const otherMint = p.tokenX === STACSOL_MINT ? p.tokenY : p.tokenX
    return {
      venue: 'meteora-dlmm',
      poolId: p.poolAddress,
      otherMint,
      otherSymbol: p.name,
      otherDecimals: p.decimals,
      binStep: p.binStep,
      activeId: p.activeId,
      initialPriceYPerX: p.initialPriceYPerX,
    }
  })

const CURATED_CPMM: CuratedTarget[] = [
  {
    venue: 'raydium-cpmm',
    poolId: 'DW64PozCS4Es7tf9AZUaRGRGAYig7EZLFcC3P7KDZscT',
    otherMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    otherSymbol: 'USDC',
    otherDecimals: 6,
  },
  {
    venue: 'raydium-cpmm',
    poolId: 'AoqXsEJDb5fcdqAWYLiSHYSfFUeW5GsP7ttvbdnDnt8T',
    otherMint: '73edX6xoGY4v5y2hzuKdrUbJXLntqgmo74au1Ki1pump',
    otherSymbol: 'Staccana',
    otherDecimals: 6,
  },
  {
    venue: 'raydium-cpmm',
    poolId: '5V5CDgZY4XVFuCBbUJCB21LGAcYpfMnK5JPunp2Wjo97',
    otherMint: 'GezJEsABGEmZVoXsDKHCCwYvxGPhQFk4hd91MchYQZaM',
    otherSymbol: 'FOMOX402',
    otherDecimals: 9,
  },
  {
    venue: 'raydium-cpmm',
    poolId: '4X5TsWFxoisuLeh95GsUTn4ZhcqYRtx1smvuisvUW22D',
    otherMint: 'CLWeikxiw8pC9JEtZt14fqDzYfXF7uVwLuvnJPkrE7av',
    otherSymbol: 'PROOFV3',
    otherDecimals: 6,
  },
  // WSOL/stacSOL exists on Raydium too but doesn't count as a migration
  // target — there's no SOL-paired-with-something-else position that wants
  // to land in a WSOL/stacSOL pool.
]

const ALL_TARGETS: CuratedTarget[] = [...CURATED_DLMM, ...CURATED_CPMM]

/**
 * Find the best curated target for a given counterparty mint. Prefers Meteora
 * DLMM (Hawkfi-managed, deeper for our cross-pair flywheel) over Raydium CPMM
 * (broader CFMM, easier to ladder into).
 */
export function findTarget(otherMint: string): CuratedTarget | null {
  const dlmm = CURATED_DLMM.find((t) => t.otherMint === otherMint)
  if (dlmm) return dlmm
  const cpmm = CURATED_CPMM.find((t) => t.otherMint === otherMint)
  if (cpmm) return cpmm
  return null
}

/** Returns every curated target, useful for diagnostics / UI. */
export function listTargets(): CuratedTarget[] {
  return ALL_TARGETS.slice()
}

/**
 * Open a position on the given curated target. Routes to the right AMM's open
 * builder. Returns the same OpenResult shape every resolver returns.
 *
 * This is called both:
 *   - directly by the orchestrator for cross-AMM smashes (close on CLMM, open
 *     on DLMM), and
 *   - by same-AMM resolvers as a fallback when they don't have specific
 *     same-AMM range data to mirror.
 */
export async function openOnTarget(
  connection: Connection,
  wallet: PublicKey,
  target: CuratedTarget,
  stacAtomEstimate: bigint,
  otherAtomEstimate: bigint,
): Promise<{
  txs: (VersionedTransaction | Transaction)[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  reattach?: (signed: any[]) => void
}> {
  if (target.venue === 'meteora-dlmm') {
    return openOnDlmmTarget(connection, wallet, target, stacAtomEstimate, otherAtomEstimate)
  }
  if (target.venue === 'raydium-cpmm') {
    return openOnCpmmTarget(connection, wallet, target, stacAtomEstimate)
  }
  throw new Error(`unsupported target venue: ${(target as CuratedTarget).venue}`)
}

async function openOnDlmmTarget(
  connection: Connection,
  wallet: PublicKey,
  target: CuratedTarget,
  stacAtomEstimate: bigint,
  otherAtomEstimate: bigint,
) {
  // For a cross-AMM smash we don't have a "mirror" source bin range — the
  // source position lives on a different AMM with different price math. Land
  // a balanced SpotBalanced position centered around the target pool's
  // active bin, ±25 bins (a conservative spread that captures swap fees
  // without going wildly out of range).
  const activeId = target.activeId ?? 0
  const SPREAD = 25
  const lower = activeId - SPREAD
  const upper = activeId + SPREAD
  const dep = await buildHawkDepositTxs(connection, wallet, {
    pool: new PublicKey(target.poolId),
    chunks: [{ minBinId: lower, maxBinId: upper }],
    perChunkXAtomic: [stacAtomEstimate],
    perChunkYAtomic: [otherAtomEstimate],
    strategyType: 3, // SpotBalanced
    singleSidedX: false,
    maxActiveBinSlippage: 1000,
  })
  const txs: (VersionedTransaction | Transaction)[] = []
  if (dep.ensureUserPdaTx) txs.push(dep.ensureUserPdaTx)
  txs.push(dep.preflightTx)
  const chunkStart = txs.length
  for (const c of dep.chunkTxs) txs.push(c)
  return {
    txs,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    reattach: (signed: any[]) => {
      const signedChunks = signed.slice(chunkStart, chunkStart + dep.chunkTxs.length)
      dep.reattachChunkSigs(signedChunks)
    },
  }
}

async function openOnCpmmTarget(
  connection: Connection,
  wallet: PublicKey,
  target: CuratedTarget,
  stacAtomEstimate: bigint,
) {
  const { TxVersion, Percent, Raydium } = await import('@raydium-io/raydium-sdk-v2')
  const raydium = await Raydium.load({
    connection,
    cluster: 'mainnet',
    disableFeatureCheck: true,
    blockhashCommitment: 'confirmed',
  })
  raydium.setOwner(wallet)
  const [poolKeysArr, poolInfoArr] = await Promise.all([
    raydium.api.fetchPoolKeysById({ idList: [target.poolId] }),
    raydium.api.fetchPoolById({ ids: target.poolId }),
  ])
  if (!poolKeysArr?.[0] || !poolInfoArr?.[0]) {
    throw new Error(`raydium target pool ${target.poolId} not fetchable`)
  }
  const poolInfo = poolInfoArr[0]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const poolKeys = poolKeysArr[0] as any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pi = poolInfo as any
  const stacIsA = pi.mintA?.address === STACSOL_MINT
  const addResult = await raydium.cpmm.addLiquidity({
    poolInfo: pi,
    poolKeys,
    inputAmount: new BN(stacAtomEstimate.toString()),
    baseIn: stacIsA,
    slippage: new Percent(100, 100),
    txVersion: TxVersion.V0,
    txTipConfig: {
      address: pickHeliusTipAccount(),
      amount: new BN(HELIUS_SENDER_TIP_LAMPORTS),
    },
  })
  return {
    txs: [addResult.transaction as VersionedTransaction | Transaction],
  }
}

// Suppress unused warnings for imports that future callers may need but
// aren't reachable from this entry today.
void LAMPORTS_PER_SOL
