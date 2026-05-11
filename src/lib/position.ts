import { Connection, PublicKey } from '@solana/web3.js'
import { MINT } from './constants'
import { deriveAta } from './ix'

/**
 * Per-user position derived purely from chain tx history. No database, no
 * backend — every mint/burn event leaves a delta in the wallet's pre/post
 * balances and the ATA's pre/post token balances, which `getParsedTransactions`
 * surfaces directly.
 */
/**
 * One mint deposit event observed against the user's ATA. We recover
 * `solIn` and `stacOut` from balance deltas (so this row is true cost
 * basis, not an estimate). `impliedMintNav = solIn / stacOut` is the
 * post-fee NAV the user effectively paid; `costPerStac` is the per-stac
 * cost in SOL — same number, surfaced under both labels because the
 * Position card uses one for the table and one for the break-even
 * column.
 */
export interface MintTranche {
  ts: number             // ms since epoch
  sig: string
  solIn: bigint          // lamports paid (signed positive)
  stacOut: bigint        // stacSOL received (atomic)
  impliedMintNav: number // SOL per stacSOL (= solIn / stacOut)
  costPerStac: number    // alias of impliedMintNav (in SOL/stacSOL)
}

export interface Position {
  ata: PublicKey
  /** Live balance from the ATA. */
  balance: bigint
  /** Sum of SOL paid into mints (lamports, includes tx fees — close enough). */
  totalSolIn: bigint
  /** Sum of stacSOL credited to the user's ATA from mints (post deposit-fee). */
  totalTokensIn: bigint
  /** Sum of stacSOL burned (sent to WithdrawSol). */
  totalTokensOut: bigint
  /** Sum of SOL received from burns. */
  totalSolOut: bigint
  /** Number of mint events found. */
  mintCount: number
  /** Number of burn events found. */
  burnCount: number
  /** Per-mint cost-basis records, oldest first. */
  mintTranches: MintTranche[]
}

/** Fetch the wallet's stacSOL position summary. */
export async function fetchPosition(conn: Connection, wallet: PublicKey): Promise<Position> {
  const ata = deriveAta(wallet, MINT)

  // Live balance — `processed` to reflect post-mint state instantly.
  const ataAcc = await conn.getAccountInfo(ata, 'processed')
  const balance = ataAcc ? ataAcc.data.readBigUInt64LE(64) : 0n

  // Pull every signature touching the ATA. RPC caps at 1000 per call; paginate
  // with `before` to walk all the way back. Power users with LP activity easily
  // blow past 1000 sigs (each addLiquidity/withdraw/swap touches the ATA).
  type SigRow = Awaited<ReturnType<typeof conn.getSignaturesForAddress>>[number]
  const sigs: SigRow[] = []
  let before: string | undefined = undefined
  // Cap pagination at 20 pages × 1000 = 20k sigs. Way past anything realistic.
  for (let page = 0; page < 20; page++) {
    const batch = await conn.getSignaturesForAddress(ata, { limit: 1000, before })
    if (batch.length === 0) break
    sigs.push(...batch)
    if (batch.length < 1000) break
    before = batch[batch.length - 1].signature
  }
  if (sigs.length === 0) {
    return {
      ata, balance,
      totalSolIn: 0n, totalTokensIn: 0n,
      totalTokensOut: 0n, totalSolOut: 0n,
      mintCount: 0, burnCount: 0,
      mintTranches: [],
    }
  }

  // getParsedTransactions caps at ~250 sigs per call — chunk it. We keep
  // the original signature list aligned to txs so we can attach the sig
  // back onto each mint-tranche row below.
  const sigList = sigs.map((s) => s.signature)
  const txs: Awaited<ReturnType<typeof conn.getParsedTransactions>> = []
  const CHUNK = 100
  for (let i = 0; i < sigList.length; i += CHUNK) {
    const batch = await conn.getParsedTransactions(sigList.slice(i, i + CHUNK), {
      maxSupportedTransactionVersion: 0,
      commitment: 'confirmed',
    })
    txs.push(...batch)
  }

  let totalSolIn = 0n
  let totalTokensIn = 0n
  let totalTokensOut = 0n
  let totalSolOut = 0n
  let mintCount = 0
  let burnCount = 0
  const mintTranches: MintTranche[] = []

  for (let txIdx = 0; txIdx < txs.length; txIdx++) {
    const tx = txs[txIdx]
    if (!tx || !tx.meta || tx.meta.err) continue

    // Wallet's SOL delta this tx (signed, includes paid tx fee).
    const accKeys = tx.transaction.message.accountKeys
    const walletIdx = accKeys.findIndex(
      (k) => (typeof k === 'string' ? k : k.pubkey.toBase58()) === wallet.toBase58(),
    )
    if (walletIdx === -1) continue
    const solDelta =
      BigInt(tx.meta.postBalances[walletIdx]) - BigInt(tx.meta.preBalances[walletIdx])

    // ATA's stacSOL delta this tx.
    const preTok = tx.meta.preTokenBalances?.find(
      (b) =>
        b.mint === MINT.toBase58() && b.owner === wallet.toBase58(),
    )
    const postTok = tx.meta.postTokenBalances?.find(
      (b) =>
        b.mint === MINT.toBase58() && b.owner === wallet.toBase58(),
    )
    const preTokens = preTok ? BigInt(preTok.uiTokenAmount.amount) : 0n
    const postTokens = postTok ? BigInt(postTok.uiTokenAmount.amount) : 0n
    const tokenDelta = postTokens - preTokens

    if (tokenDelta > 0n && solDelta < 0n) {
      // Mint: SOL went out, stacSOL came in.
      const solIn = -solDelta
      totalSolIn += solIn
      totalTokensIn += tokenDelta
      mintCount++
      const sigInfo = sigs[txIdx]
      const tsSec = sigInfo?.blockTime ?? tx.blockTime ?? null
      const impliedMintNav = Number(solIn) / Number(tokenDelta)
      mintTranches.push({
        ts: tsSec != null ? tsSec * 1000 : Date.now(),
        sig: sigInfo?.signature ?? '',
        solIn,
        stacOut: tokenDelta,
        impliedMintNav,
        costPerStac: impliedMintNav,
      })
    } else if (tokenDelta < 0n && solDelta > 0n) {
      // Burn: stacSOL went out, SOL came in.
      totalTokensOut += -tokenDelta
      totalSolOut += solDelta
      burnCount++
    }
    // Transfers in/out from third parties are ignored for cost-basis purposes —
    // we don't know what the counterparty paid for them.
  }

  // Sort tranches oldest → newest so the Position card renders mints in
  // the order they happened. `getSignaturesForAddress` returns newest-first.
  mintTranches.sort((a, b) => a.ts - b.ts)

  return {
    ata,
    balance,
    totalSolIn,
    totalTokensIn,
    totalTokensOut,
    totalSolOut,
    mintCount,
    burnCount,
    mintTranches,
  }
}

/**
 * On-chain measurement showed sol_withdrawal_fee is effectively 0 on this
 * pool (a 0.1 stacSOL WithdrawSol paid out exactly 0.1 SOL, not 0.0931).
 * Honor that on breakeven math.
 */
export const WITHDRAWAL_FEE_FRACTION = 0

export interface PnL {
  /**
   * Effective cost in lamports per *currently-held* token. Computed as
   * `(totalSolIn − totalSolOut) / balance`, not the historical average over
   * all minted tokens. This matters when the user has destroyed tokens via
   * WithdrawSol+sendback cycles (no SOL back), because their original SOL
   * outlay is now spread over fewer tokens — actual cost per held is higher
   * than `totalSolIn / totalTokensIn` would suggest.
   */
  effectiveCostPerHeld: number | null
  /** Total SOL the wallet has net paid for the current position (lamports). */
  netSolPaidLamports: bigint
  /** Gross value of held position at current rate (no fee). */
  grossValueLamports: bigint
  /** Net value if user burned right now (post withdrawal fee). */
  netValueOnBurnLamports: bigint
  /** Profit/loss vs net SOL paid if user burned now (lamports). */
  pnlOnBurnLamports: bigint | null
  /** Same as %, signed. */
  pnlOnBurnPct: number | null
  /** Rate threshold above which a burn breaks even on cost. */
  breakevenBurnRate: number | null
  /** Whether burning now exits at a profit. */
  profitableToBurn: boolean | null
}

export function computePnL(p: Position, currentRate: number): PnL {
  const grossValueLamports =
    p.balance > 0n
      ? BigInt(Math.round(Number(p.balance) * currentRate))
      : 0n
  const netValueOnBurnLamports = BigInt(
    Math.round(Number(grossValueLamports) * (1 - WITHDRAWAL_FEE_FRACTION)),
  )

  // Net SOL the user actually spent on the current position. WithdrawSol
  // proceeds that landed back in their wallet count as cost recovery; cycles
  // that bounced SOL straight to the reserve don't (totalSolOut ≈ 0 there).
  const netSolPaidLamports =
    p.totalSolIn > p.totalSolOut ? p.totalSolIn - p.totalSolOut : 0n

  if (p.balance === 0n || netSolPaidLamports === 0n) {
    return {
      effectiveCostPerHeld: null,
      netSolPaidLamports,
      grossValueLamports,
      netValueOnBurnLamports,
      pnlOnBurnLamports: null,
      pnlOnBurnPct: null,
      breakevenBurnRate: null,
      profitableToBurn: null,
    }
  }

  const effectiveCostPerHeld = Number(netSolPaidLamports) / Number(p.balance)
  const pnlOnBurnLamports = netValueOnBurnLamports - netSolPaidLamports
  const pnlOnBurnPct = Number(pnlOnBurnLamports) / Number(netSolPaidLamports)
  const breakevenBurnRate = effectiveCostPerHeld / (1 - WITHDRAWAL_FEE_FRACTION)
  const profitableToBurn = currentRate > breakevenBurnRate

  return {
    effectiveCostPerHeld,
    netSolPaidLamports,
    grossValueLamports,
    netValueOnBurnLamports,
    pnlOnBurnLamports,
    pnlOnBurnPct,
    breakevenBurnRate,
    profitableToBurn,
  }
}
