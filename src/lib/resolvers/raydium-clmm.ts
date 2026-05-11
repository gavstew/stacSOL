// Raydium CLMM resolver — scan + close + open.
//
// Raydium CLMM positions are NFTs. To find user's CLMM positions:
//   1. Walk user's token accounts.
//   2. For each NFT-shaped balance (amount = 1, decimals = 0), check if the
//      mint is a Raydium CLMM position NFT. The SDK exposes
//      `raydium.clmm.getOwnerPositionInfo({ programId })` which does this
//      walk for us and returns parsed position data.
//   3. Filter to positions whose pool has wSOL on one side.
//
// Close: `raydium.clmm.decreaseLiquidity({ closePosition: true, ... })` —
// removes 100% of liquidity + claims fees + burns the position NFT.
//
// Open: there is no curated stacSOL/X CLMM pool today; this resolver scans
// positions but its `buildOpenTxs` throws because the curated target doesn't
// exist. The page surfaces this as "scan-only" until target pools are init'd.

import { NATIVE_MINT } from '@solana/spl-token'
import BN from 'bn.js'
import { HELIUS_SENDER_TIP_LAMPORTS, pickHeliusTipAccount } from '../zap'
import { findTarget, openOnTarget } from './targets'
import type {
  AmmResolver,
  CloseResult,
  OpenResult,
  RawPosition,
} from './index'

const STACSOL_MINT = '6K4xdfEk5rvySM496rxm4x8AgC9wVt7N4C7mFFpNAj5f'
const WSOL = NATIVE_MINT.toBase58()

interface ClmmRaw {
  poolId: string
  positionNftMint: string
  tickLower: number
  tickUpper: number
  mintA: string
  mintB: string
  decimalsA: number
  decimalsB: number
  solIsA: boolean
}

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
    amm: 'raydium-clmm',
    label: 'Raydium CLMM',
    scan: 'live',
    close: 'live',
    open: 'live',
  },

  async scan(connection, wallet) {
    const raydium = await loadRaydium(connection)
    raydium.setOwner(wallet)

    // Walk user's CLMM positions via the SDK. Different SDK builds expose
    // this under different names; try the most common shapes.
    type SDKPos = {
      poolId?: string
      tickLower: number
      tickUpper: number
      nftMint?: string
      positionNftMint?: string
    }
    let positions: SDKPos[] = []
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const r = await (raydium.clmm as any).getOwnerPositionInfo?.({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        programId: (raydium.clmm as any).clmmProgramId,
      })
      if (Array.isArray(r)) positions = r as SDKPos[]
    } catch {
      /* fall through */
    }
    if (positions.length === 0) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const r = await (raydium.account as any).fetchWalletTokenAccounts?.()
        // Older SDK shape: returns { positionAccounts }
        if (r?.positionAccounts) {
          positions = (r.positionAccounts as SDKPos[]).map((p) => ({
            poolId: (p as { poolId?: string }).poolId,
            tickLower: p.tickLower,
            tickUpper: p.tickUpper,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            nftMint: (p as any).nftMint?.toBase58?.() ?? (p as any).nftMint,
          }))
        }
      } catch {
        /* nothing */
      }
    }
    if (positions.length === 0) return []

    const out: RawPosition[] = []
    // Resolve pool info for each unique poolId.
    const poolIds = Array.from(
      new Set(positions.map((p) => p.poolId).filter((v): v is string => !!v)),
    )
    let poolInfos: Record<string, unknown> = {}
    if (poolIds.length > 0) {
      try {
        const fetched = await raydium.api.fetchPoolById({ ids: poolIds.join(',') })
        if (Array.isArray(fetched)) {
          for (const pi of fetched) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            if (pi && (pi as any).id) poolInfos[(pi as any).id] = pi
          }
        }
      } catch {
        /* keep empty — positions still show with unknown pool */
      }
    }

    for (const pos of positions) {
      const poolId = pos.poolId
      if (!poolId) continue
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pi = poolInfos[poolId] as any
      if (!pi) continue
      const mintA: string = pi.mintA?.address ?? ''
      const mintB: string = pi.mintB?.address ?? ''
      const solIsA = mintA === WSOL
      const solIsB = mintB === WSOL
      if (!solIsA && !solIsB) continue
      const otherMint = solIsA ? mintB : mintA
      if (otherMint === STACSOL_MINT) continue
      const decA: number = pi.mintA?.decimals ?? 9
      const decB: number = pi.mintB?.decimals ?? 6
      const otherSymbol: string =
        (solIsA ? pi.mintB?.symbol : pi.mintA?.symbol) ?? otherMint.slice(0, 6) + '…'

      // We don't easily get accurate atom-amounts per position from the SDK
      // without on-chain math. Surface 0 estimates for now; the close path
      // returns the real numbers via decreaseLiquidity's expected output.
      // Showing 0 in the UI is OK — the page still surfaces the position and
      // lets the user smash it.
      const nftMint = pos.positionNftMint ?? pos.nftMint ?? ''
      out.push({
        amm: 'raydium-clmm',
        positionId: nftMint,
        poolAddress: poolId,
        poolLabel: `SOL / ${otherSymbol}`,
        solAtom: 0n,
        stacAtom: 0n,
        otherMint,
        otherSymbol,
        otherDecimals: solIsA ? decB : decA,
        otherAtom: 0n,
        range: { lower: pos.tickLower, upper: pos.tickUpper },
        state: 'pending-target', // no curated stacSOL CLMM pools yet
        raw: {
          poolId,
          positionNftMint: nftMint,
          tickLower: pos.tickLower,
          tickUpper: pos.tickUpper,
          mintA,
          mintB,
          decimalsA: decA,
          decimalsB: decB,
          solIsA,
        } as ClmmRaw,
      })
    }
    return out
  },

  async buildCloseTxs(connection, wallet, pos): Promise<CloseResult> {
    const r = pos.raw as ClmmRaw
    const { TxVersion } = await import('@raydium-io/raydium-sdk-v2')
    const raydium = await loadRaydium(connection)
    raydium.setOwner(wallet)
    const [poolInfoArr, poolKeysArr] = await Promise.all([
      raydium.api.fetchPoolById({ ids: r.poolId }),
      raydium.api.fetchPoolKeysById({ idList: [r.poolId] }),
    ])
    if (!poolInfoArr?.[0] || !poolKeysArr?.[0]) {
      throw new Error(`raydium clmm pool ${r.poolId} not fetchable`)
    }
    // decreaseLiquidity with closePosition=true removes 100% + claims + burns NFT.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await (raydium.clmm as any).decreaseLiquidity({
      poolInfo: poolInfoArr[0],
      poolKeys: poolKeysArr[0],
      ownerPosition: { nftMint: r.positionNftMint },
      liquidity: new BN('0'), // 0 = withdraw all when closePosition=true
      amountMinA: new BN('0'),
      amountMinB: new BN('0'),
      closePosition: true,
      txVersion: TxVersion.V0,
      txTipConfig: {
        address: pickHeliusTipAccount(),
        amount: new BN(HELIUS_SENDER_TIP_LAMPORTS),
      },
    })
    return {
      txs: [res.transaction ?? res.tx],
      estSolAtom: pos.solAtom,
      estOtherAtom: pos.otherAtom,
    }
  },

  async buildOpenTxs(
    connection: import('@solana/web3.js').Connection,
    wallet: import('@solana/web3.js').PublicKey,
    pos: RawPosition,
    stacAtomEstimate: bigint,
  ): Promise<OpenResult> {
    // No curated stacSOL CLMM target today. Route to the cross-AMM target
    // router instead — recovered tokenB lands on DLMM/CPMM where we have
    // curated stacSOL/X pools.
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
