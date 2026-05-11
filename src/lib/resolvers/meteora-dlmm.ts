// Meteora DLMM resolver — scan + close + open for liqmonsta.
//
// Scan: walks every DLMM pool the wallet holds positions in via
// DLMM.getAllLbPairPositionsByUser, then filters to SOL-paired pools. Also
// scans positions owned by the wallet's HawkFi userPda so auto-managed
// positions are migratable too.
//
// Close: buildHawkWithdrawCloseTx for Hawkfi-managed positions (the most
// common case in stacc-ui's user base). Direct-owned positions error with
// "wiring soon" — that close path uses a different ix layout.
//
// Open: buildHawkDepositTxs against the curated stacSOL/X DLMM target pool
// at the mirrored bin range (shifted by log_{1+binStep/10000}(NAV) to land
// at the equivalent price).

import { NATIVE_MINT } from '@solana/spl-token'
import { PublicKey } from '@solana/web3.js'
import {
  buildHawkDepositTxs,
  buildHawkWithdrawCloseTx,
  deriveUserPda,
} from '../hawkfi-flows'
import {
  METEORA_POOLS,
  STACSOL_MINT,
  type MeteoraPool,
} from '../meteora-pools'
import { fetchPool } from '../pool'
import type {
  AmmResolver,
  CloseResult,
  OpenResult,
  RawPosition,
} from './index'

interface DlmmRaw {
  ownership: 'hawkfi' | 'direct'
  /** Source pool's binStep (e.g. 25 = 0.25%). */
  srcBinStep: number
  /** Whether SOL is the X side of the source pool. */
  solIsX: boolean
  /** Mirrored bin range on the target stacSOL pool. */
  targetLower: number
  targetUpper: number
  /** Target pool reference (curated stacSOL/X). */
  targetPool: MeteoraPool
  /** Source position's bin range. */
  lowerBinId: number
  upperBinId: number
}

/**
 * DLMM bin price: price = (1 + binStep/10000)^binId, in tokenY-per-tokenX.
 * Mirror onto a stacSOL pool by scaling the price by 1/NAV (if SOL is tokenX)
 * or NAV (if SOL is tokenY), then re-binifying on the target pool's binStep.
 */
function mirrorBinRange(
  srcBinStep: number,
  srcLower: number,
  srcUpper: number,
  srcSolIsX: boolean,
  targetBinStep: number,
  nav: number,
): { lower: number; upper: number } {
  if (nav <= 0 || !Number.isFinite(nav)) {
    throw new Error('invalid NAV for bin mirror')
  }
  const srcStep = 1 + srcBinStep / 10_000
  const tgtStep = 1 + targetBinStep / 10_000
  const srcPriceLower = Math.pow(srcStep, srcLower)
  const srcPriceUpper = Math.pow(srcStep, srcUpper)
  const factor = srcSolIsX ? 1 / nav : nav
  const tgtPriceLower = srcPriceLower * factor
  const tgtPriceUpper = srcPriceUpper * factor
  const lower = Math.round(Math.log(tgtPriceLower) / Math.log(tgtStep))
  const upper = Math.round(Math.log(tgtPriceUpper) / Math.log(tgtStep))
  return { lower, upper }
}

const resolver: AmmResolver = {
  meta: {
    amm: 'meteora-dlmm',
    label: 'Meteora DLMM',
    scan: 'live',
    close: 'live',
    open: 'live',
  },

  async scan(connection, wallet) {
    // Current NAV is needed to mirror bin ranges; read once.
    const pool = await fetchPool(connection)
    const nav =
      pool.poolTokenSupplyAccounting > 0n
        ? Number(pool.poolTotalLamports) / Number(pool.poolTokenSupplyAccounting)
        : 1

    const DLMMmod = await import('@meteora-ag/dlmm')
    const DLMM = DLMMmod.default

    const [userPda] = deriveUserPda(wallet)
    const [direct, hawk] = await Promise.all([
      DLMM.getAllLbPairPositionsByUser(connection, wallet).catch(() => new Map()),
      DLMM.getAllLbPairPositionsByUser(connection, userPda).catch(() => new Map()),
    ])

    const targetByOther = new Map<string, MeteoraPool>()
    for (const p of METEORA_POOLS) {
      const otherMint = p.tokenX === STACSOL_MINT ? p.tokenY : p.tokenX
      targetByOther.set(otherMint, p)
    }

    const out: RawPosition[] = []
    const seen = new Set<string>()
    const wsol = NATIVE_MINT.toBase58()

    const ingest = (
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      m: Map<string, any>,
      ownership: 'hawkfi' | 'direct',
    ) => {
      for (const [poolKey, entry] of m) {
        const lbPair = entry.lbPair
        const xMint = lbPair.tokenXMint.toBase58()
        const yMint = lbPair.tokenYMint.toBase58()
        const solIsX = xMint === wsol
        const solIsY = yMint === wsol
        if (!solIsX && !solIsY) continue
        const otherMint = solIsX ? yMint : xMint
        if (otherMint === STACSOL_MINT) continue

        const target = targetByOther.get(otherMint)

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for (const pos of entry.lbPairPositionsData as any[]) {
          const key = pos.publicKey.toBase58()
          if (seen.has(key)) continue
          seen.add(key)
          const pd = pos.positionData
          const solAtom = solIsX
            ? BigInt(pd.totalXAmount.toString())
            : BigInt(pd.totalYAmount.toString())
          const otherAtom = solIsX
            ? BigInt(pd.totalYAmount.toString())
            : BigInt(pd.totalXAmount.toString())

          let mirrored: { lower: number; upper: number } | null = null
          if (target) {
            try {
              mirrored = mirrorBinRange(
                lbPair.binStep,
                pd.lowerBinId,
                pd.upperBinId,
                solIsX,
                target.binStep,
                nav,
              )
            } catch {
              mirrored = null
            }
          }

          out.push({
            amm: 'meteora-dlmm',
            positionId: key,
            poolAddress: poolKey,
            poolLabel: `SOL / ${target?.name ?? otherMint.slice(0, 6) + '…'}`,
            solAtom,
            otherMint,
            otherSymbol: target?.name ?? '?',
            otherDecimals: target?.decimals ?? 9,
            otherAtom,
            range: { lower: pd.lowerBinId, upper: pd.upperBinId },
            hasTarget: target != null && mirrored != null,
            raw: {
              ownership,
              srcBinStep: lbPair.binStep,
              solIsX,
              targetLower: mirrored?.lower ?? 0,
              targetUpper: mirrored?.upper ?? 0,
              targetPool: target!,
              lowerBinId: pd.lowerBinId,
              upperBinId: pd.upperBinId,
            } as DlmmRaw,
          })
        }
      }
    }
    ingest(direct, 'direct')
    ingest(hawk, 'hawkfi')
    return out
  },

  async buildCloseTxs(connection, wallet, pos): Promise<CloseResult> {
    const r = pos.raw as DlmmRaw
    if (r.ownership !== 'hawkfi') {
      throw new Error('direct-owned DLMM close — wiring soon')
    }
    const DLMMmod = await import('@meteora-ag/dlmm')
    const DLMM = DLMMmod.default
    const srcDlmm = await DLMM.create(connection, new PublicKey(pos.poolAddress))
    const tx = await buildHawkWithdrawCloseTx(connection, wallet, {
      pool: new PublicKey(pos.poolAddress),
      position: new PublicKey(pos.positionId),
      tokenXMint: srcDlmm.tokenX.publicKey as PublicKey,
      tokenYMint: srcDlmm.tokenY.publicKey as PublicKey,
      tokenXProgram: srcDlmm.tokenX.owner as PublicKey,
      tokenYProgram: srcDlmm.tokenY.owner as PublicKey,
      lowerBinId: r.lowerBinId,
      upperBinId: r.upperBinId,
    })
    return {
      txs: [tx],
      estSolAtom: pos.solAtom,
      estOtherAtom: pos.otherAtom,
    }
  },

  async buildOpenTxs(connection, wallet, pos, stacAtomEstimate): Promise<OpenResult> {
    const r = pos.raw as DlmmRaw
    if (!r.targetPool) throw new Error('no curated stacSOL DLMM target')
    const dep = await buildHawkDepositTxs(connection, wallet, {
      pool: new PublicKey(r.targetPool.poolAddress),
      chunks: [{ minBinId: r.targetLower, maxBinId: r.targetUpper }],
      perChunkXAtomic: [stacAtomEstimate],
      perChunkYAtomic: [pos.otherAtom],
      strategyType: 3, // SpotBalanced
      singleSidedX: false,
      maxActiveBinSlippage: 1000,
    })
    const txs: (import('@solana/web3.js').VersionedTransaction | import('@solana/web3.js').Transaction)[] = []
    if (dep.ensureUserPdaTx) txs.push(dep.ensureUserPdaTx)
    txs.push(dep.preflightTx)
    const chunkStart = txs.length
    for (const c of dep.chunkTxs) txs.push(c)
    return {
      txs,
      reattach: (signed) => {
        const signedChunks = signed.slice(
          chunkStart,
          chunkStart + dep.chunkTxs.length,
        )
        dep.reattachChunkSigs(signedChunks)
      },
      reattachRange: [chunkStart, chunkStart + dep.chunkTxs.length],
    }
  },
}

export default resolver
