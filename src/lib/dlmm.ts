// Meteora DLMM deposit helpers — built directly against @meteora-ag/dlmm 1.5.4
// to bypass HawkFi's combined-ix tx bloat for the create-position-and-deposit
// flow.
//
// Why bypass HawkFi here?
//
// HawkFi's `meteoraCreatePositionAndDeposit` returns a single transaction
// that bundles bin-array init + position init + addLiquidityByStrategy +
// (optional) WSOL wrap + ATA creates. At ≥40 bins per position the tx exceeds
// Solana's 1232-byte packet limit because of the bin-array init refs and
// preflight ixs.
//
// Submission strategy: two stage, single-tx-per-stage via Helius Sender
// (no Jito bundles — Sender accepts only one tx per call).
//
//   STAGE 1 — preflight, sent standalone via Helius Sender:
//     ATA creates + (optional) WSOL wrap + (optional) bin-array inits +
//     Helius tip ix. Always built (no-ops on existing accounts are cheap)
//     and always sent first; we wait for on-chain confirmation before
//     submitting any chunk so chunks have all their dependencies committed.
//
//   STAGE 2 — chunks, each sent independently via Helius Sender in parallel:
//     Per-chunk position init + addLiquidityByStrategy + Helius tip ix.
//     Chunks don't depend on each other (each creates its own position
//     keypair) so they can fan out and confirm in parallel.
//
// Each tx carries its own Helius tip (HELIUS_SENDER_TIP_LAMPORTS = 0.001
// SOL each); for a 1-preflight + 4-chunk deposit that's 0.005 SOL in tips
// total — meaningfully cheaper than the previous Jito bundle (0.01 SOL per
// bundle, two bundles = 0.02 SOL).

import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js'

const COMPUTE_BUDGET_PROGRAM_ID = new PublicKey(
  'ComputeBudget111111111111111111111111111111',
)
import {
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
} from '@solana/spl-token'
import BN from 'bn.js'
import { heliusTipIx } from './zap'

export interface DlmmChunk {
  minBinId: number
  maxBinId: number
}

export interface DlmmDepositPlan {
  pool: PublicKey
  chunks: DlmmChunk[]
  /** Per-chunk amounts. If a chunk's totals are zero on one side it's
   *  single-sided. */
  perChunkXAtomic: bigint[]
  perChunkYAtomic: bigint[]
  /** Strategy type as expected by Meteora SDK 1.5.4 (e.g. BidAsk). */
  strategyType: number
  /** Slippage in 0.01% units; 5000 = 50%. */
  slippage: number
}

export interface DlmmDepositResult {
  /** Standalone preflight tx — ATAs + (optional) WSOL wrap + (optional)
   *  bin-array inits + Helius tip ix. Send this FIRST via Helius Sender and
   *  wait for on-chain confirmation before submitting any chunk. Always
   *  non-null: even when nothing strictly needs initializing, we still
   *  create both ATAs idempotently as a safety net. */
  preflightTx: VersionedTransaction
  /** Chunk txs — send each one INDEPENDENTLY via Helius Sender (in parallel
   *  is fine; each carries its own Helius tip and references its own fresh
   *  position keypair, so there are no inter-chunk dependencies). Position
   *  keypairs are pre-signed by this helper; the user's wallet signs as
   *  fee payer. */
  chunkTxs: VersionedTransaction[]
  /** Position keypairs created — one per chunk. After
   *  wallet.signAllTransactions you MUST call `reattachChunkSigs` to
   *  re-attach these signatures, since some wallet adapters clear partial
   *  signatures during bulk signing. */
  positionKeys: Keypair[]
  /** Re-attach position-key signatures to chunk txs. Call AFTER
   *  wallet.signAllTransactions and BEFORE submitting any chunk. Idempotent. */
  reattachChunkSigs: (signedChunks: VersionedTransaction[]) => void
}

/**
 * Build a Meteora DLMM single-sided / multi-chunk deposit, ready to be
 * submitted via Helius Sender. Returns the preflight tx (always present)
 * plus N chunk txs (one per `plan.chunks` entry). Caller signs them all in
 * a single `signAllTransactions` popup, sends preflight first, waits for
 * confirmation, then sends chunks in parallel.
 */
export async function buildDlmmDepositBundle(
  connection: Connection,
  owner: PublicKey,
  plan: DlmmDepositPlan,
): Promise<DlmmDepositResult> {
  if (plan.chunks.length === 0) throw new Error('no chunks to deposit')
  if (plan.chunks.length > 4) throw new Error('max 4 chunks per bundle')
  if (
    plan.chunks.length !== plan.perChunkXAtomic.length ||
    plan.chunks.length !== plan.perChunkYAtomic.length
  ) {
    throw new Error('chunk count mismatch with per-chunk amounts')
  }

  const DLMMmod = await import('@meteora-ag/dlmm')
  const DLMM = DLMMmod.default
  const dlmm = await DLMM.create(connection, plan.pool)

  // Token program IDs come from the pool's token info.
  const tokenXMint = dlmm.tokenX.publicKey as PublicKey
  const tokenYMint = dlmm.tokenY.publicKey as PublicKey
  const tokenXProgram = dlmm.tokenX.owner as PublicKey
  const tokenYProgram = dlmm.tokenY.owner as PublicKey

  const userAtaX = getAssociatedTokenAddressSync(
    tokenXMint,
    owner,
    true,
    tokenXProgram,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )
  const userAtaY = getAssociatedTokenAddressSync(
    tokenYMint,
    owner,
    true,
    tokenYProgram,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )

  // Compute total amounts so we can wrap a single combined SOL → WSOL if
  // either side is wsol and we're depositing it across chunks.
  const totalX = plan.perChunkXAtomic.reduce((s, n) => s + n, 0n)
  const totalY = plan.perChunkYAtomic.reduce((s, n) => s + n, 0n)
  const isXWsol = tokenXMint.equals(NATIVE_MINT) && totalX > 0n
  const isYWsol = tokenYMint.equals(NATIVE_MINT) && totalY > 0n

  // ----- Preflight ixs ----------------------------------------------------
  const preflightIxs: TransactionInstruction[] = []

  // ATA creates (idempotent — no-op if exists). One per token.
  preflightIxs.push(
    createAssociatedTokenAccountIdempotentInstruction(
      owner,
      userAtaX,
      owner,
      tokenXMint,
      tokenXProgram,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    ),
  )
  preflightIxs.push(
    createAssociatedTokenAccountIdempotentInstruction(
      owner,
      userAtaY,
      owner,
      tokenYMint,
      tokenYProgram,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    ),
  )

  // WSOL wrap (transfer SOL into the WSOL ATA + sync_native). The amount we
  // wrap is the user's deposit total on the wsol side.
  if (isXWsol) {
    preflightIxs.push(
      SystemProgram.transfer({
        fromPubkey: owner,
        toPubkey: userAtaX,
        lamports: Number(totalX),
      }),
    )
    preflightIxs.push(createSyncNativeInstruction(userAtaX, TOKEN_PROGRAM_ID))
  }
  if (isYWsol) {
    preflightIxs.push(
      SystemProgram.transfer({
        fromPubkey: owner,
        toPubkey: userAtaY,
        lamports: Number(totalY),
      }),
    )
    preflightIxs.push(createSyncNativeInstruction(userAtaY, TOKEN_PROGRAM_ID))
  }

  // ----- Build per-chunk SDK txs FIRST so we can extract their bin-array
  // init ixs into our shared preflight. Driving extraction off the SDK's
  // actual output avoids brittle naive index calculations — the SDK knows
  // exactly which bin arrays addLiquidity will reference. ----------------
  const positionKeys: Keypair[] = []
  // Map of bin-array address -> init ix, deduped across chunks.
  const binArrayInitsByKey = new Map<string, TransactionInstruction>()
  const perChunkKeptIxs: TransactionInstruction[][] = []

  for (let i = 0; i < plan.chunks.length; i++) {
    const chunk = plan.chunks[i]
    const positionKey = Keypair.generate()
    positionKeys.push(positionKey)

    const sdkTx = await dlmm.initializePositionAndAddLiquidityByStrategy({
      positionPubKey: positionKey.publicKey,
      totalXAmount: new BN(plan.perChunkXAtomic[i].toString()),
      totalYAmount: new BN(plan.perChunkYAtomic[i].toString()),
      strategy: {
        minBinId: chunk.minBinId,
        maxBinId: chunk.maxBinId,
        strategyType: plan.strategyType,
      },
      user: owner,
      slippage: plan.slippage,
    })

    const sdkIxs = sdkTx.instructions
    const refsPosition = (ix: TransactionInstruction) =>
      ix.keys.some((k) => k.pubkey.equals(positionKey.publicKey))

    const keptForChunk: TransactionInstruction[] = []
    for (const ix of sdkIxs) {
      // Drop the SDK's ComputeBudget ix — we add our own at higher CU.
      if (ix.programId.equals(COMPUTE_BUDGET_PROGRAM_ID)) continue

      // DLMM program ixs:
      //   • initializePosition / addLiquidityByStrategy → reference
      //     positionKey (KEEP in chunk tx)
      //   • initializeBinArray → does NOT reference positionKey. Move to
      //     shared preflight (deduped). The first writable account of a
      //     bin-array-init ix is the bin array address — use that as the
      //     dedup key so we don't init the same bin array twice.
      if (ix.programId.equals(dlmm.program.programId)) {
        if (refsPosition(ix)) {
          keptForChunk.push(ix)
        } else {
          const binArrayAccount = ix.keys.find(
            (k) => k.isWritable && !k.isSigner,
          )
          const dedupKey = binArrayAccount
            ? binArrayAccount.pubkey.toBase58()
            : `idx-${binArrayInitsByKey.size}`
          if (!binArrayInitsByKey.has(dedupKey)) {
            binArrayInitsByKey.set(dedupKey, ix)
          }
        }
        continue
      }

      // ATA-create-idempotent → preflight handles it (we already added
      // both ATAs above).
      if (ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)) continue

      // SystemProgram.transfer (variant u32=2) is the SOL→WSOL wrap. Drop
      // when we wrapped in preflight.
      if (
        ix.programId.equals(SystemProgram.programId) &&
        (isXWsol || isYWsol) &&
        ix.data.length >= 4 &&
        ix.data.readUInt32LE(0) === 2
      ) {
        continue
      }

      // syncNative (TOKEN_PROGRAM ix variant 17) — drop when preflight
      // wrapped.
      if (
        ix.programId.equals(TOKEN_PROGRAM_ID) &&
        (isXWsol || isYWsol) &&
        ix.data.length === 1 &&
        ix.data[0] === 17
      ) {
        continue
      }

      // closeAccount (TOKEN_PROGRAM ix variant 9) — drop when WSOL is
      // involved. The Meteora SDK appends `unwrapSOLInstruction` as a
      // postInstruction to close the WSOL ATA after the deposit, refunding
      // its rent to the user. With chunks fanning out in parallel via
      // Helius Sender, this races: whichever chunk lands first closes the
      // WSOL ATA, then later chunks try to debit it and trip
      // AccountNotInitialized (Custom 3012) on addLiquidityByStrategy.
      // Stripping it leaves the (likely-empty) WSOL ATA open after the
      // deposit; that's ~0.002 SOL of locked rent, but the ATA gets reused
      // on any future WSOL operation. Acceptable trade-off vs the
      // alternative (forcing chunks sequential, which doubles deposit time).
      if (
        ix.programId.equals(TOKEN_PROGRAM_ID) &&
        (isXWsol || isYWsol) &&
        ix.data.length === 1 &&
        ix.data[0] === 9
      ) {
        continue
      }

      keptForChunk.push(ix)
    }
    perChunkKeptIxs.push(keptForChunk)
  }

  // Add the SDK-extracted bin-array inits to the preflight tx.
  for (const ix of binArrayInitsByKey.values()) preflightIxs.push(ix)

  // ----- Build per-chunk deposit txs --------------------------------------
  // Single blockhash shared across preflight + all chunks — fetched as close
  // to wallet signing as we reasonably can. Caller is expected to sign and
  // submit promptly; if signing takes >50s, blockhash may expire.
  const chunkTxs: VersionedTransaction[] = []
  const { blockhash } = await connection.getLatestBlockhash('confirmed')

  for (let i = 0; i < plan.chunks.length; i++) {
    const positionKey = positionKeys[i]
    const keptIxs = perChunkKeptIxs[i]

    const ixsThisTx: TransactionInstruction[] = [
      // CU limit — Meteora addLiquidityByStrategy at 70 bins + strategy
      // distribution math + Token-2022 hooks can spike well past 1M CU.
      // Set to Solana's max (1.4M) so the worst case completes; cheap CU
      // allocation, expensive only on actual usage.
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
      ...keptIxs,
      // Each chunk is sent INDEPENDENTLY via Helius Sender (no atomic
      // bundle), so each chunk needs its own tip ix or the Sender rejects
      // it with "no tip transfer to a Helius tip account".
      heliusTipIx(owner),
    ]

    const message = new TransactionMessage({
      payerKey: owner,
      recentBlockhash: blockhash,
      instructions: ixsThisTx,
    }).compileToV0Message()
    const vtx = new VersionedTransaction(message)
    // Sign with position keypair now (user signs as fee payer later).
    vtx.sign([positionKey])
    chunkTxs.push(vtx)
  }

  // ----- Build preflight tx ------------------------------------------------
  // Always built. Even when nothing strictly needs initializing (ATAs exist,
  // bin arrays exist, no WSOL wrap needed), the idempotent ATA-create ixs
  // are no-ops on chain — cheap insurance against the user being on a pool
  // they've never touched, where one of their ATAs could be missing and
  // would otherwise trip AccountNotInitialized in every chunk.
  //
  // The preflight ALWAYS carries a Helius tip ix — we submit it as a single
  // tx via Helius Sender (no Jito bundles) for fast inclusion. Sender
  // requires a tip transfer in the tx or it rejects.
  //
  // 1.4M CU because Meteora `initializeBinArray` runs ~100-200K CU in
  // practice (more with Token-2022 hooks). A 4-chunk plan can span 5
  // bin-arrays — worst-case bin-array work alone is ~1M CU. Add ATA creates
  // (~25K each) and the WSOL wrap and we need the full network budget.
  const preflightIxsAll: TransactionInstruction[] = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
    ...preflightIxs,
    heliusTipIx(owner),
  ]
  const preflightMessage = new TransactionMessage({
    payerKey: owner,
    recentBlockhash: blockhash,
    instructions: preflightIxsAll,
  }).compileToV0Message()
  const preflightTx = new VersionedTransaction(preflightMessage)

  // Map: chunk index → position keypair, used by reattachChunkSigs to
  // re-apply position signatures after the wallet signs. Some wallet adapters
  // (notably some mobile and WalletConnect backends) clear partial signatures
  // during signAllTransactions; without re-attaching them the chunk's
  // position-account signature slot is zeroed and the leader rejects the
  // tx as malformed (Helius Sender returns "transaction signature verification
  // failure" in that case).
  const reattachChunkSigs = (signedChunks: VersionedTransaction[]): void => {
    if (signedChunks.length !== positionKeys.length) {
      throw new Error(
        `reattachChunkSigs: expected ${positionKeys.length} chunks, got ${signedChunks.length}`,
      )
    }
    for (let i = 0; i < signedChunks.length; i++) {
      // VersionedTransaction.sign(signers) updates only the signature slots
      // for the supplied signer pubkeys; user's signature in slot 0 is
      // untouched. Idempotent if sigs are already correct.
      signedChunks[i].sign([positionKeys[i]])
    }
  }

  return { preflightTx, chunkTxs, positionKeys, reattachChunkSigs }
}

// Re-export the strategy enum constants used by stacSOL single-sided flows
// so callers don't need to import @meteora-ag/dlmm directly.
export const STRATEGY_TYPES = {
  Spot: 0,
  Curve: 1,
  BidAsk: 2,
} as const
// Token-2022 helper: re-export so callers that import dlmm.ts get a single
// shared source of TOKEN_2022 program id.
export { TOKEN_2022_PROGRAM_ID }

// =============================================================================
// Withdraw / claim helpers — native Meteora SDK, NO HawkFi
// =============================================================================
//
// We previously routed withdraws and claims through HawkFi's `meteoraWithdraw`
// / `meteoraClaim` endpoints because they returned a single combined tx and
// handled the bin-array account derivation for us. But HawkFi's automation
// contract requires a per-user `user_pda` to be initialized on the iyf-main
// program, which only happens the first time you interact with HawkFi.
// Positions opened directly through the Meteora SDK (which is what
// buildDlmmDepositBundle does) have NO matching user_pda, so HawkFi rejects
// withdraws with `Custom 3012 — AnchorError caused by account: user_pda.
// Error Code: AccountNotInitialized`.
//
// These helpers go straight to the DLMM program, mirroring buildDlmmDeposit
// Bundle's approach. The resulting tx fits comfortably under 1232 bytes for
// our pools (no LM rewards on stacSOL/* pairs, so the SDK never has to split
// claim+close into a second tx).

/**
 * Build a single tx that:
 *   • removes ALL liquidity from `position` (bps = 10000)
 *   • claims accrued swap fees
 *   • closes the position account (refunds rent to the position owner)
 *   • includes a Helius tip ix so the tx is Helius-Sender-eligible
 *
 * Strips the SDK's WSOL close + sync ixs because parallel withdraws across
 * multiple positions would race on the user's WSOL ATA — the first to land
 * closes it and the rest fail with AccountNotInitialized.
 */
export async function buildDlmmWithdrawCloseTx(
  connection: Connection,
  owner: PublicKey,
  args: {
    pool: PublicKey
    position: PublicKey
    /** Position's lower/upper bin IDs from on-chain state. We pass the full
     *  range; the SDK clamps to bins that actually have liquidity. */
    lowerBinId: number
    upperBinId: number
  },
): Promise<VersionedTransaction> {
  const DLMMmod = await import('@meteora-ag/dlmm')
  const DLMM = DLMMmod.default
  const dlmm = await DLMM.create(connection, args.pool)

  const sdkResult = await dlmm.removeLiquidity({
    user: owner,
    position: args.position,
    fromBinId: args.lowerBinId,
    toBinId: args.upperBinId,
    bps: new BN(10_000),
    shouldClaimAndClose: true,
  })

  // SDK returns Transaction OR Transaction[] (latter when LM rewards exist;
  // never the case for stacSOL pairs). Treat both shapes uniformly.
  const sdkTxs = Array.isArray(sdkResult) ? sdkResult : [sdkResult]
  if (sdkTxs.length > 1) {
    // If we ever do hit this, bail loudly so we know to extend the helper
    // to return multiple txs rather than silently dropping the LM-claim tx.
    throw new Error(
      `dlmm.removeLiquidity returned ${sdkTxs.length} txs (LM rewards path) — withdraw helper needs to be extended`,
    )
  }
  const sdkTx = sdkTxs[0]

  const tokenXMint = dlmm.tokenX.publicKey as PublicKey
  const tokenYMint = dlmm.tokenY.publicKey as PublicKey
  const isXWsol = tokenXMint.equals(NATIVE_MINT)
  const isYWsol = tokenYMint.equals(NATIVE_MINT)

  const keptIxs: TransactionInstruction[] = []
  for (const ix of sdkTx.instructions) {
    // Strip SDK's compute budget — we add our own (1.4M, max).
    if (ix.programId.equals(COMPUTE_BUDGET_PROGRAM_ID)) continue
    // Strip SDK's WSOL close (variant 9) AND syncNative (variant 17) when
    // either side is WSOL. Parallel withdraws would race on closing the
    // user's WSOL ATA. Leftover WSOL stays in the ATA after withdraw —
    // harmless and reusable on the next deposit.
    if (
      ix.programId.equals(TOKEN_PROGRAM_ID) &&
      (isXWsol || isYWsol) &&
      ix.data.length === 1 &&
      (ix.data[0] === 9 || ix.data[0] === 17)
    ) {
      continue
    }
    keptIxs.push(ix)
  }

  const ixs: TransactionInstruction[] = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
    ...keptIxs,
    heliusTipIx(owner),
  ]
  const { blockhash } = await connection.getLatestBlockhash('confirmed')
  const message = new TransactionMessage({
    payerKey: owner,
    recentBlockhash: blockhash,
    instructions: ixs,
  }).compileToV0Message()
  return new VersionedTransaction(message)
}

/**
 * Build a single tx that claims accrued swap fees on `position` (without
 * removing liquidity or closing). Includes a Helius tip ix.
 *
 * Uses the SDK's `claimSwapFee` rather than the bulk `claimAllSwapFee` so
 * we get one tx per position; the caller fan-outs in parallel via Helius
 * Sender for bulk-claim flows.
 */
export async function buildDlmmClaimFeesTx(
  connection: Connection,
  owner: PublicKey,
  args: {
    pool: PublicKey
    position: PublicKey
  },
): Promise<VersionedTransaction> {
  const DLMMmod = await import('@meteora-ag/dlmm')
  const DLMM = DLMMmod.default
  const dlmm = await DLMM.create(connection, args.pool)

  // claimSwapFee wants a position object shaped like {publicKey, positionData}.
  // The SDK has getPosition() but it's heavy; we can pass a minimal shape
  // since claimSwapFee only reads publicKey + position lower/upper bin ids
  // from positionData. Easiest is to fetch via the SDK helper.
  const positionInfo = await dlmm.getPosition(args.position)
  const sdkResult = await dlmm.claimSwapFee({
    owner,
    position: positionInfo,
  })
  const sdkTxs = Array.isArray(sdkResult) ? sdkResult : [sdkResult]
  if (sdkTxs.length !== 1) {
    throw new Error(
      `dlmm.claimSwapFee returned ${sdkTxs.length} txs — claim helper needs to be extended`,
    )
  }
  const sdkTx = sdkTxs[0]

  const tokenXMint = dlmm.tokenX.publicKey as PublicKey
  const tokenYMint = dlmm.tokenY.publicKey as PublicKey
  const isXWsol = tokenXMint.equals(NATIVE_MINT)
  const isYWsol = tokenYMint.equals(NATIVE_MINT)

  const keptIxs: TransactionInstruction[] = []
  for (const ix of sdkTx.instructions) {
    if (ix.programId.equals(COMPUTE_BUDGET_PROGRAM_ID)) continue
    if (
      ix.programId.equals(TOKEN_PROGRAM_ID) &&
      (isXWsol || isYWsol) &&
      ix.data.length === 1 &&
      (ix.data[0] === 9 || ix.data[0] === 17)
    ) {
      continue
    }
    keptIxs.push(ix)
  }

  const ixs: TransactionInstruction[] = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }),
    ...keptIxs,
    heliusTipIx(owner),
  ]
  const { blockhash } = await connection.getLatestBlockhash('confirmed')
  const message = new TransactionMessage({
    payerKey: owner,
    recentBlockhash: blockhash,
    instructions: ixs,
  }).compileToV0Message()
  return new VersionedTransaction(message)
}
