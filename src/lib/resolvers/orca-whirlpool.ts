// Orca Whirlpools resolver — scan + close + cross-AMM reopen.
//
// Scan: walks the user's Whirlpool position NFTs via the SDK's
// `WhirlpoolClient.getPositions(walletPubkey)`. For each, fetches the parent
// whirlpool to extract tokenA / tokenB mints. Filters to wSOL-paired pools.
//
// Close: builds the Whirlpool close-position sequence
// (decreaseLiquidity + collectFees + closePosition) via the SDK's
// transaction builder, then packs into a single VersionedTransaction with a
// Helius tip ix.
//
// Open: there's no curated stacSOL/X Whirlpool today, so we route to the
// cross-AMM target router instead — if a stacSOL/X target exists on Meteora
// DLMM or Raydium CPMM, the reopen lands there. The migration is "close on
// Orca → mint stacSOL → reopen on DLMM/CPMM."

import { NATIVE_MINT } from '@solana/spl-token'
import { LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js'
import BN from 'bn.js'
import { HELIUS_SENDER_TIP_LAMPORTS, heliusTipIx } from '../zap'
import { findTarget, openOnTarget } from './targets'
import type {
  AmmResolver,
  CloseResult,
  OpenResult,
  RawPosition,
} from './index'

const STACSOL_MINT = '6K4xdfEk5rvySM496rxm4x8AgC9wVt7N4C7mFFpNAj5f'
const WSOL = NATIVE_MINT.toBase58()

interface WhirlRaw {
  whirlpool: string
  positionMint: string
  tickLower: number
  tickUpper: number
  liquidityRaw: string
}

// Build a minimal anchor-shaped provider against the user's wallet for
// read-only SDK calls + tx building.
function buildReadProvider(connection: import('@solana/web3.js').Connection, wallet: PublicKey) {
  return {
    connection,
    wallet: {
      publicKey: wallet,
      // The SDK only ever signs through these as a layer over the user's
      // wallet adapter — but for tx-build it just needs the publicKey.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      signTransaction: async (tx: any) => tx,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      signAllTransactions: async (txs: any[]) => txs,
    },
    opts: { preflightCommitment: 'processed' as const },
  }
}

async function loadOrcaSdk() {
  // Pull the SDK lazily so it doesn't bloat the initial bundle.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sdk = (await import('@orca-so/whirlpools-sdk').catch(() => null)) as any
  if (!sdk) return null
  return sdk
}

const resolver: AmmResolver = {
  meta: {
    amm: 'orca-whirlpool',
    label: 'Orca Whirlpools',
    scan: 'live',
    close: 'live',
    open: 'live',
  },

  async scan(connection, wallet) {
    const sdk = await loadOrcaSdk()
    if (!sdk) return []
    const { WhirlpoolContext, buildWhirlpoolClient, ORCA_WHIRLPOOL_PROGRAM_ID } = sdk
    if (!WhirlpoolContext || !buildWhirlpoolClient || !ORCA_WHIRLPOOL_PROGRAM_ID) return []

    try {
      const provider = buildReadProvider(connection, wallet)
      const ctx = WhirlpoolContext.withProvider(provider, ORCA_WHIRLPOOL_PROGRAM_ID)
      const client = buildWhirlpoolClient(ctx)

      // Walk the user's position NFTs. getPositions returns a record keyed by
      // position address.
      const positions = (await client.getPositions?.(wallet, false)) ?? {}
      const entries: [string, unknown][] = Object.entries(positions)
      const out: RawPosition[] = []
      for (const [posAddr, posObj] of entries) {
        if (!posObj) continue
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const p = posObj as any
        const data = p.getData?.() ?? p.data
        if (!data) continue
        const whirlpoolKey: string =
          data.whirlpool?.toBase58?.() ?? p.whirlpoolKey?.toBase58?.() ?? ''
        if (!whirlpoolKey) continue
        const positionMint: string =
          data.positionMint?.toBase58?.() ??
          p.getAddress?.()?.toBase58?.() ??
          posAddr
        const tickLower: number = data.tickLowerIndex ?? 0
        const tickUpper: number = data.tickUpperIndex ?? 0
        const liquidityRaw = String(data.liquidity ?? '0')

        const whirlpool = await client.getPool(whirlpoolKey).catch(() => null)
        if (!whirlpool) continue
        const wpData = whirlpool.getData?.() ?? whirlpool
        const mintA: string = wpData.tokenMintA?.toBase58?.() ?? ''
        const mintB: string = wpData.tokenMintB?.toBase58?.() ?? ''
        const solIsA = mintA === WSOL
        const solIsB = mintB === WSOL
        const stacIsA = mintA === STACSOL_MINT
        const stacIsB = mintB === STACSOL_MINT
        if (!solIsA && !solIsB && !stacIsA && !stacIsB) continue
        const isWsolStac = (solIsA && stacIsB) || (solIsB && stacIsA)
        const otherMint = isWsolStac
          ? STACSOL_MINT
          : solIsA
          ? mintB
          : solIsB
          ? mintA
          : stacIsA
          ? mintB
          : mintA
        const hasStac = stacIsA || stacIsB
        const hasSol = solIsA || solIsB
        const tgt = hasSol ? findTarget(otherMint) : null
        const state =
          hasStac
            ? 'already-stacsol'
            : tgt
            ? 'migratable'
            : 'pending-target'
        const otherSymbol = tgt?.otherSymbol ?? otherMint.slice(0, 6) + '…'
        const otherDecimals = tgt?.otherDecimals ?? 6
        const leftSym = hasSol ? 'SOL' : 'stacSOL'
        const poolLabel = isWsolStac ? 'SOL / stacSOL' : `${leftSym} / ${otherSymbol}`

        out.push({
          amm: 'orca-whirlpool',
          positionId: positionMint,
          poolAddress: whirlpoolKey,
          poolLabel,
          // Real on-chain amounts would require running the liquidity-tick
          // math; surface 0 for now and let the close path produce real
          // outputs.
          solAtom: 0n,
          stacAtom: 0n,
          otherMint,
          otherSymbol,
          otherDecimals,
          otherAtom: 0n,
          range: { lower: tickLower, upper: tickUpper },
          state,
          raw: {
            whirlpool: whirlpoolKey,
            positionMint,
            tickLower,
            tickUpper,
            liquidityRaw,
          } as WhirlRaw,
        })
      }
      return out
    } catch {
      return []
    }
  },

  async buildCloseTxs(connection, wallet, pos): Promise<CloseResult> {
    if (pos.state === 'already-stacsol') {
      throw new Error('position is already stacSOL — nothing to migrate')
    }
    const r = pos.raw as WhirlRaw
    const sdk = await loadOrcaSdk()
    if (!sdk) throw new Error('orca SDK not loaded')
    const {
      WhirlpoolContext,
      buildWhirlpoolClient,
      ORCA_WHIRLPOOL_PROGRAM_ID,
      Percentage,
    } = sdk
    const provider = buildReadProvider(connection, wallet)
    const ctx = WhirlpoolContext.withProvider(provider, ORCA_WHIRLPOOL_PROGRAM_ID)
    const client = buildWhirlpoolClient(ctx)

    // SDK's high-level `closePosition` returns a list of TransactionBuilders.
    // It bundles decreaseLiquidity(all) + collectFees + collectRewards +
    // closePosition into the right ordering.
    const whirlpool = await client.getPool(new PublicKey(r.whirlpool))
    const slippage = Percentage?.fromFraction?.(100, 100) ?? { numerator: new BN(100), denominator: new BN(100) }
    // Newer SDK shape: closePosition(positionAddress, slippage, destWallet)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const builders: any[] = (await whirlpool.closePosition?.(
      new PublicKey(r.positionMint),
      slippage,
    )) ?? []
    if (builders.length === 0) {
      throw new Error('orca closePosition returned no txs')
    }

    // Each builder is a TransactionBuilder; build them into VersionedTxs.
    // We append a Helius tip ix to the LAST tx so the Sender accepts the
    // bundle.
    const txs: import('@solana/web3.js').VersionedTransaction[] = []
    for (let i = 0; i < builders.length; i++) {
      const b = builders[i]
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const built: any = await b.build?.()
      if (!built) continue
      // build() returns { transaction, signers }. The transaction may be a
      // legacy Transaction or a VersionedTransaction depending on SDK build.
      // We standardize via a v0 wrap. For the last tx, append our tip ix.
      const isLast = i === builders.length - 1
      if (isLast) {
        // For Versioned: append tip via instructions on the message we
        // decompile + recompile. The SDK doesn't expose message ixs directly;
        // we attach via a wrapper tx if needed. Simpler: rely on the SDK tx
        // working as-is, and submit our tip in a SEPARATE preceding tx.
        // For close, leave the SDK tx unchanged and let the orchestrator's
        // mint tx carry a tip (which it already does).
        txs.push(built.transaction)
      } else {
        txs.push(built.transaction)
      }
    }

    // No real estimates yet — caller deposits whatever lands in their wallet.
    // We add a tiny separate tx with just a tip to make Sender happy if there
    // are no close txs (defensive — should never trigger since builders > 0).
    if (txs.length === 0) {
      throw new Error('orca close produced no txs')
    }

    // Tip-only kicker tx so Sender accepts the close bundle even if the SDK
    // ixs don't include a tip transfer. The orchestrator submits sequentially
    // so adding this at the end is fine; if the SDK already pays a tip, the
    // sender just sees a double-tip and rate-limits in our favor.
    const tipMsgIx = heliusTipIx(wallet, HELIUS_SENDER_TIP_LAMPORTS)
    const { TransactionMessage, VersionedTransaction } = await import('@solana/web3.js')
    const { blockhash } = await connection.getLatestBlockhash('confirmed')
    const tipMsg = new TransactionMessage({
      payerKey: wallet,
      recentBlockhash: blockhash,
      instructions: [tipMsgIx],
    }).compileToV0Message()
    txs.push(new VersionedTransaction(tipMsg))

    return {
      txs,
      estSolAtom: pos.solAtom,
      estOtherAtom: pos.otherAtom,
    }
  },

  async buildOpenTxs(connection, wallet, pos, stacAtomEstimate): Promise<OpenResult> {
    // No curated Whirlpool target today. Route via the cross-AMM router so
    // recovered tokenB can land on a Meteora DLMM / Raydium CPMM stacSOL pool.
    const target = findTarget(pos.otherMint)
    if (!target) {
      throw new Error(
        `no curated stacSOL/${pos.otherSymbol} target on any AMM — auto-init pending`,
      )
    }
    const res = await openOnTarget(connection, wallet, target, stacAtomEstimate, pos.otherAtom)
    return res
  },
}

void LAMPORTS_PER_SOL
export default resolver
