// HawkFi v0-tx flow builders — ready to sign + send via Helius Sender.
//
// Two layers stacked here:
//
//   1. `buildEnsureUserPdaTx` — initializes the per-wallet HawkFi userPda
//      via the `newUser` ix. Returns null if the userPda already exists.
//      Required before any other HawkFi flow can run for a given wallet.
//
//   2. Deposit / claim / withdraw flows — wrap Meteora DLMM ixs through
//      HawkFi's `meteoraDynamicCpi` so the userPda signs (as the position
//      owner) via invoke_signed inside HawkFi's program. The result:
//      positions land owned by the userPda, are visible in HawkFi's UI,
//      and become eligible for HawkFi's auto-rebalance / auto-compound.
//
// We intentionally use `@hawksightco/hawk-sdk`'s `MeteoraDLMM.initialize
// PositionAndAddLiquidityByStrategy(..., meteoraToHawksightAutomationIxs)`
// for the deposit path because it correctly wraps the inner Meteora ixs
// (the SDK's `meteoraToHawksightPdaIxs` is broken — see fun-launch's
// v2_builder.ts comment for the on-chain rejection details).
//
// For withdraw/claim, we hand-roll via `hawkfi-v2.ts` because the SDK's
// equivalent endpoints can produce stale account orderings.

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
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token'
import BN from 'bn.js'
import {
  HELIUS_SENDER_TIP_LAMPORTS,
  heliusTipIx,
} from './zap'
import {
  buildDepositMultipleTokenWithToken2022Ix,
  buildHawkfiWithdrawTokenIx,
  buildMeteoraAddLiquidityByStrategy2Ix,
  buildMeteoraClaimFee2Ix,
  buildMeteoraClosePositionIfEmptyIx,
  buildMeteoraDynamicCpiIx,
  buildMeteoraInitializeBinArrayIx,
  buildMeteoraInitializePositionIx,
  buildMeteoraRemoveLiquidityByRange2Ix,
  buildNewUserIx,
  deriveBinArraysForRange,
  deriveReservePda,
  deriveUserPda,
  fetchHawkGlobalAlts,
  resolveBinArrayBitmapExtension,
  IYF_MAIN,
  METEORA_DLMM,
} from './hawkfi-v2'

// -----------------------------------------------------------------------------
// User-PDA setup
// -----------------------------------------------------------------------------

/** Cheap on-chain check: does this wallet have a HawkFi userPda yet? */
export async function userPdaExists(
  connection: Connection,
  authority: PublicKey,
): Promise<boolean> {
  const [userPda] = deriveUserPda(authority)
  const info = await connection.getAccountInfo(userPda, 'confirmed')
  return info != null
}

/**
 * Build a tx that initializes the wallet's HawkFi userPda. Returns null when
 * the userPda already exists (no-op) so callers can `if (tx) push(tx)`.
 *
 * The tx carries a Helius tip ix so it can be sent via Helius Sender.
 */
export async function buildEnsureUserPdaTx(
  connection: Connection,
  authority: PublicKey,
): Promise<VersionedTransaction | null> {
  if (await userPdaExists(connection, authority)) return null

  const ixs: TransactionInstruction[] = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
    buildNewUserIx(authority),
    heliusTipIx(authority),
  ]
  const { blockhash } = await connection.getLatestBlockhash('confirmed')
  const message = new TransactionMessage({
    payerKey: authority,
    recentBlockhash: blockhash,
    instructions: ixs,
  }).compileToV0Message()
  return new VersionedTransaction(message)
}

// -----------------------------------------------------------------------------
// HawkFi-wrapped deposit (positions land owned by userPda)
// -----------------------------------------------------------------------------

export interface HawkDepositChunk {
  minBinId: number
  maxBinId: number
}

export interface HawkDepositPlan {
  pool: PublicKey
  chunks: HawkDepositChunk[]
  /** Per-chunk amount distribution. One side may be zero for single-sided. */
  perChunkXAtomic: bigint[]
  perChunkYAtomic: bigint[]
  /** Anchor enum variant for `StrategyType`:
   *    0 SpotOneSide       3 SpotBalanced       6 SpotImBalanced
   *    1 CurveOneSide      4 CurveBalanced      7 CurveImBalanced
   *    2 BidAskOneSide     5 BidAskBalanced     8 BidAskImBalanced
   *
   *  ⚠ Meteora's official SDK ALWAYS converts whatever you pass into the
   *  ImBalanced variant of the same family (Spot=2 SDK enum → 8 on chain).
   *  Pass the on-chain variant directly here. For our SingleSided flow the
   *  right value is 8 (BidAskImBalanced). */
  strategyType: number
  /** True when depositing only the X-side token (sets parameters[0] = 1
   *  per Meteora's SDK convention). False (default) for Y-side single-
   *  sided or balanced deposits. Required for correct liquidity
   *  distribution on single-sided BidAsk positions. */
  singleSidedX?: boolean
  /** Slippage in bin units. Meteora's default is 50; we use 1000 to be
   *  permissive for chunks far from active. */
  maxActiveBinSlippage?: number
}

export interface HawkDepositResult {
  /** Init userPda tx — null if already initialized. Send first. */
  ensureUserPdaTx: VersionedTransaction | null
  /** Preflight: ATA creates on user wallet + userPda + treasury, optional
   *  WSOL wrap, bin array inits, deposit-tokens-to-userPda, plus a Helius
   *  tip. Send second; wait for confirmation before chunks. */
  preflightTx: VersionedTransaction
  /** Per-chunk init position + add liquidity wrapped through HawkFi's CPI
   *  so userPda owns the position. Each chunk is independent and carries
   *  its own Helius tip; fan out via Promise.all. */
  chunkTxs: VersionedTransaction[]
  /** Position keypairs — pre-signed by this builder; user wallet signs as
   *  fee payer. Reattach via `reattachChunkSigs` after signAllTransactions. */
  positionKeys: Keypair[]
  reattachChunkSigs: (signedChunks: VersionedTransaction[]) => void
  /** Computed userPda for convenience (Portfolio shows it as "managed"). */
  userPda: PublicKey
}

/**
 * Build the full HawkFi-wrapped deposit txset for a Meteora DLMM single-
 * sided / multi-chunk position. Positions land owned by the wallet's
 * HawkFi userPda → automation eligible.
 */
export async function buildHawkDepositTxs(
  connection: Connection,
  authority: PublicKey,
  plan: HawkDepositPlan,
): Promise<HawkDepositResult> {
  if (plan.chunks.length === 0) throw new Error('no chunks to deposit')
  if (plan.chunks.length > 4) throw new Error('max 4 chunks per deposit')
  if (
    plan.chunks.length !== plan.perChunkXAtomic.length ||
    plan.chunks.length !== plan.perChunkYAtomic.length
  ) {
    throw new Error('chunk count mismatch with per-chunk amounts')
  }

  const [userPda] = deriveUserPda(authority)
  const ensureUserPdaTx = await buildEnsureUserPdaTx(connection, authority)

  // Resolve pool token info from chain via DLMM SDK. We only need mints,
  // their owning token programs (SPL vs T22), and the activeId for
  // slippage. Cheap; DLMM.create caches the lbPair.
  const DLMMmod = await import('@meteora-ag/dlmm')
  const DLMM = DLMMmod.default
  const dlmm = await DLMM.create(connection, plan.pool)
  const tokenXMint = dlmm.tokenX.publicKey as PublicKey
  const tokenYMint = dlmm.tokenY.publicKey as PublicKey
  const tokenXProgram = dlmm.tokenX.owner as PublicKey
  const tokenYProgram = dlmm.tokenY.owner as PublicKey
  const activeId = dlmm.lbPair.activeId

  const totalX = plan.perChunkXAtomic.reduce((s, n) => s + n, 0n)
  const totalY = plan.perChunkYAtomic.reduce((s, n) => s + n, 0n)
  const isXWsol = tokenXMint.equals(NATIVE_MINT) && totalX > 0n
  const isYWsol = tokenYMint.equals(NATIVE_MINT) && totalY > 0n

  // ATAs for both mints on user wallet AND userPda. allowOwnerOffCurve=true
  // for userPda since it's a PDA (getAssociatedTokenAddressSync requires it).
  const userAtaX = getAssociatedTokenAddressSync(tokenXMint, authority, false, tokenXProgram)
  const userAtaY = getAssociatedTokenAddressSync(tokenYMint, authority, false, tokenYProgram)
  const userPdaAtaX = getAssociatedTokenAddressSync(tokenXMint, userPda, true, tokenXProgram)
  const userPdaAtaY = getAssociatedTokenAddressSync(tokenYMint, userPda, true, tokenYProgram)

  const reserveX = deriveReservePda(plan.pool, tokenXMint)[0]
  const reserveY = deriveReservePda(plan.pool, tokenYMint)[0]

  // ----- Preflight ixs ----------------------------------------------------
  const preflightIxs: TransactionInstruction[] = []

  // Idempotent ATA creates — no-op if exists. We need ATAs on both user
  // wallet (source for transfers) AND userPda (destination + Meteora
  // deposit source). Treasury ATAs are created lazily by the deposit ix.
  preflightIxs.push(
    createAssociatedTokenAccountIdempotentInstruction(
      authority, userAtaX, authority, tokenXMint, tokenXProgram, ASSOCIATED_TOKEN_PROGRAM_ID,
    ),
    createAssociatedTokenAccountIdempotentInstruction(
      authority, userAtaY, authority, tokenYMint, tokenYProgram, ASSOCIATED_TOKEN_PROGRAM_ID,
    ),
    createAssociatedTokenAccountIdempotentInstruction(
      authority, userPdaAtaX, userPda, tokenXMint, tokenXProgram, ASSOCIATED_TOKEN_PROGRAM_ID,
    ),
    createAssociatedTokenAccountIdempotentInstruction(
      authority, userPdaAtaY, userPda, tokenYMint, tokenYProgram, ASSOCIATED_TOKEN_PROGRAM_ID,
    ),
  )

  // WSOL wrap on user wallet's WSOL ATA. After this, the deposit ix moves
  // the wrapped WSOL → userPda's WSOL ATA. We do NOT close the user's WSOL
  // ATA in the preflight — chunks need it to stay open in case any chunk
  // sim runs. Closing it later (manual) is the user's call.
  if (isXWsol) {
    preflightIxs.push(
      SystemProgram.transfer({ fromPubkey: authority, toPubkey: userAtaX, lamports: Number(totalX) }),
      createSyncNativeInstruction(userAtaX, TOKEN_PROGRAM_ID),
    )
  }
  if (isYWsol) {
    preflightIxs.push(
      SystemProgram.transfer({ fromPubkey: authority, toPubkey: userAtaY, lamports: Number(totalY) }),
      createSyncNativeInstruction(userAtaY, TOKEN_PROGRAM_ID),
    )
  }

  // Bin array inits for the entire range covered across all chunks.
  // Skip ones that already exist (cheap chain check).
  const overallMin = Math.min(...plan.chunks.map((c) => c.minBinId))
  const overallMax = Math.max(...plan.chunks.map((c) => c.maxBinId))
  const binArrayKeys = deriveBinArraysForRange(plan.pool, overallMin, overallMax)
  const binArrayInfos = await connection.getMultipleAccountsInfo(binArrayKeys, 'confirmed')
  const minIdx = Math.floor(overallMin / 70)
  for (let i = 0; i < binArrayKeys.length; i++) {
    if (binArrayInfos[i] != null) continue
    preflightIxs.push(
      buildMeteoraInitializeBinArrayIx({
        funder: authority,
        lbPair: plan.pool,
        binArray: binArrayKeys[i],
        index: minIdx + i,
      }),
    )
  }

  // Move tokens user wallet → userPda's per-mint ATAs. Single ix handles
  // both X and Y atomically; pad single-sided with amount=0.
  preflightIxs.push(
    buildDepositMultipleTokenWithToken2022Ix({
      authority,
      deposits: [
        { mint: tokenXMint, amountAtoms: new BN(totalX.toString()), tokenProgram: tokenXProgram },
        { mint: tokenYMint, amountAtoms: new BN(totalY.toString()), tokenProgram: tokenYProgram },
      ],
    }),
  )

  // Helius Sender tip (required — Sender rejects txs without a tip).
  preflightIxs.push(heliusTipIx(authority))

  const altAccounts = await fetchHawkGlobalAlts(connection)
  const { blockhash } = await connection.getLatestBlockhash('confirmed')

  const preflightMsg = new TransactionMessage({
    payerKey: authority,
    recentBlockhash: blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
      ...preflightIxs,
    ],
  }).compileToV0Message(altAccounts)
  const preflightTx = new VersionedTransaction(preflightMsg)

  // ----- Per-chunk position init + add liquidity --------------------------
  const positionKeys: Keypair[] = []
  const chunkTxs: VersionedTransaction[] = []

  for (let i = 0; i < plan.chunks.length; i++) {
    const chunk = plan.chunks[i]
    const positionKey = Keypair.generate()
    positionKeys.push(positionKey)

    const binArraysForChunk = deriveBinArraysForRange(plan.pool, chunk.minBinId, chunk.maxBinId)

    // Initialize the position (owner = userPda; signed via dynamicCpi).
    const initInner = buildMeteoraInitializePositionIx({
      payer: authority,
      position: positionKey.publicKey,
      lbPair: plan.pool,
      owner: userPda,
      lowerBinId: chunk.minBinId,
      width: chunk.maxBinId - chunk.minBinId + 1,
    })
    const initWrapped = buildMeteoraDynamicCpiIx({ userPda, authority, inner: initInner })

    // Add liquidity (sender = userPda; signed via dynamicCpi). Liquidity
    // is sourced from the userPda's ATAs that we filled in the preflight.
    // Build the StrategyParameters [u8; 64]. parameters[0] = 1 when this
    // is a single-sided X-only deposit; rest of the bytes are zero. This
    // matches Meteora's SDK `toStrategyParameters` output.
    const strategyParameters = new Uint8Array(64)
    strategyParameters[0] = plan.singleSidedX ? 1 : 0

    const addInner = buildMeteoraAddLiquidityByStrategy2Ix({
      position: positionKey.publicKey,
      lbPair: plan.pool,
      // Resolve per-chunk because each chunk has its own bin range. For
      // ranges inside the default ±512 bin-array bitmap (almost all
      // real positions), this returns the program ID sentinel — passing
      // the derived PDA when it doesn't exist on chain trips
      // AccountOwnedByWrongProgram (3007).
      binArrayBitmapExtension: resolveBinArrayBitmapExtension(
        plan.pool,
        chunk.minBinId,
        chunk.maxBinId,
      ),
      userPdaTokenX: userPdaAtaX,
      userPdaTokenY: userPdaAtaY,
      reserveX,
      reserveY,
      tokenXMint,
      tokenYMint,
      userPda,
      tokenXProgram,
      tokenYProgram,
      binArrays: binArraysForChunk,
      amountX: new BN(plan.perChunkXAtomic[i].toString()),
      amountY: new BN(plan.perChunkYAtomic[i].toString()),
      activeId,
      maxActiveBinSlippage: plan.maxActiveBinSlippage ?? 50,
      minBinId: chunk.minBinId,
      maxBinId: chunk.maxBinId,
      strategyType: plan.strategyType,
      strategyParameters,
    })
    const addWrapped = buildMeteoraDynamicCpiIx({ userPda, authority, inner: addInner })

    const ixs: TransactionInstruction[] = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
      initWrapped,
      addWrapped,
      heliusTipIx(authority),
    ]
    const message = new TransactionMessage({
      payerKey: authority,
      recentBlockhash: blockhash,
      instructions: ixs,
    }).compileToV0Message(altAccounts)
    const vtx = new VersionedTransaction(message)
    vtx.sign([positionKey])
    chunkTxs.push(vtx)
  }

  const reattachChunkSigs = (signedChunks: VersionedTransaction[]): void => {
    if (signedChunks.length !== positionKeys.length) {
      throw new Error(
        `reattachChunkSigs: expected ${positionKeys.length} chunks, got ${signedChunks.length}`,
      )
    }
    for (let i = 0; i < signedChunks.length; i++) {
      signedChunks[i].sign([positionKeys[i]])
    }
  }

  return {
    ensureUserPdaTx,
    preflightTx,
    chunkTxs,
    positionKeys,
    reattachChunkSigs,
    userPda,
  }
}

// -----------------------------------------------------------------------------
// HawkFi-wrapped claim fees
// -----------------------------------------------------------------------------

/**
 * Build a single tx that claims accrued swap fees from a HawkFi-owned
 * position (owner == userPda). Fees first land in the userPda's per-mint
 * ATAs via `claim_fee2`, then `withdraw_token_from_user_pda` forwards them
 * (minus a HawkFi fee skim) to the user wallet's ATAs.
 *
 * Fails on direct-owned positions (use the native helper from `dlmm.ts`
 * for those — `buildDlmmClaimFeesTx`).
 */
export async function buildHawkClaimTx(
  connection: Connection,
  authority: PublicKey,
  args: {
    pool: PublicKey
    position: PublicKey
    tokenXMint: PublicKey
    tokenYMint: PublicKey
    tokenXProgram: PublicKey
    tokenYProgram: PublicKey
    /** Position's lower/upper bin IDs from on-chain state. */
    lowerBinId: number
    upperBinId: number
  },
): Promise<VersionedTransaction> {
  const [userPda] = deriveUserPda(authority)

  const userPdaAtaX = getAssociatedTokenAddressSync(args.tokenXMint, userPda, true, args.tokenXProgram)
  const userPdaAtaY = getAssociatedTokenAddressSync(args.tokenYMint, userPda, true, args.tokenYProgram)
  const userAtaX = getAssociatedTokenAddressSync(args.tokenXMint, authority, false, args.tokenXProgram)
  const userAtaY = getAssociatedTokenAddressSync(args.tokenYMint, authority, false, args.tokenYProgram)

  const reserveX = deriveReservePda(args.pool, args.tokenXMint)[0]
  const reserveY = deriveReservePda(args.pool, args.tokenYMint)[0]
  const binArrays = deriveBinArraysForRange(args.pool, args.lowerBinId, args.upperBinId)

  const claimInner = buildMeteoraClaimFee2Ix({
    lbPair: args.pool,
    position: args.position,
    userPda,
    reserveX,
    reserveY,
    userTokenX: userPdaAtaX,
    userTokenY: userPdaAtaY,
    tokenXMint: args.tokenXMint,
    tokenYMint: args.tokenYMint,
    tokenXProgram: args.tokenXProgram,
    tokenYProgram: args.tokenYProgram,
    binArrays,
    minBinId: args.lowerBinId,
    maxBinId: args.upperBinId,
  })

  const ixs: TransactionInstruction[] = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }),
    // Make sure user wallet ATAs exist for the eventual sweep.
    createAssociatedTokenAccountIdempotentInstruction(
      authority, userAtaX, authority, args.tokenXMint, args.tokenXProgram, ASSOCIATED_TOKEN_PROGRAM_ID,
    ),
    createAssociatedTokenAccountIdempotentInstruction(
      authority, userAtaY, authority, args.tokenYMint, args.tokenYProgram, ASSOCIATED_TOKEN_PROGRAM_ID,
    ),
    // Claim fees → userPda's ATAs.
    buildMeteoraDynamicCpiIx({ userPda, authority, inner: claimInner }),
    // Forward each token (with HawkFi fee skim) → user wallet ATA.
    buildHawkfiWithdrawTokenIx({ authority, mint: args.tokenXMint, tokenProgram: args.tokenXProgram }),
    buildHawkfiWithdrawTokenIx({ authority, mint: args.tokenYMint, tokenProgram: args.tokenYProgram }),
    heliusTipIx(authority),
  ]

  const altAccounts = await fetchHawkGlobalAlts(connection)
  const { blockhash } = await connection.getLatestBlockhash('confirmed')
  const message = new TransactionMessage({
    payerKey: authority,
    recentBlockhash: blockhash,
    instructions: ixs,
  }).compileToV0Message(altAccounts)
  return new VersionedTransaction(message)
}

// -----------------------------------------------------------------------------
// HawkFi-wrapped withdraw + close
// -----------------------------------------------------------------------------

/**
 * Build a single tx that:
 *   • removes ALL liquidity from a HawkFi-owned position (bps = 10000)
 *   • claims accrued swap fees
 *   • closes the position (refunds rent to userPda)
 *   • forwards both token balances userPda → user wallet (minus HawkFi fee)
 *
 * Fails on direct-owned positions (use `buildDlmmWithdrawCloseTx` instead).
 */
export async function buildHawkWithdrawCloseTx(
  connection: Connection,
  authority: PublicKey,
  args: {
    pool: PublicKey
    position: PublicKey
    tokenXMint: PublicKey
    tokenYMint: PublicKey
    tokenXProgram: PublicKey
    tokenYProgram: PublicKey
    lowerBinId: number
    upperBinId: number
  },
): Promise<VersionedTransaction> {
  const [userPda] = deriveUserPda(authority)
  // Sentinel-or-PDA depending on whether the position's range overflows
  // the default bin-array bitmap. For default-range positions Meteora
  // expects the program ID sentinel (= METEORA_DLMM), not the derived
  // PDA — passing the PDA when no extension account exists trips
  // AccountOwnedByWrongProgram (3007) at runtime.
  const bitmapExtension = resolveBinArrayBitmapExtension(
    args.pool,
    args.lowerBinId,
    args.upperBinId,
  )

  const userPdaAtaX = getAssociatedTokenAddressSync(args.tokenXMint, userPda, true, args.tokenXProgram)
  const userPdaAtaY = getAssociatedTokenAddressSync(args.tokenYMint, userPda, true, args.tokenYProgram)
  const userAtaX = getAssociatedTokenAddressSync(args.tokenXMint, authority, false, args.tokenXProgram)
  const userAtaY = getAssociatedTokenAddressSync(args.tokenYMint, authority, false, args.tokenYProgram)
  const reserveX = deriveReservePda(args.pool, args.tokenXMint)[0]
  const reserveY = deriveReservePda(args.pool, args.tokenYMint)[0]
  const binArrays = deriveBinArraysForRange(args.pool, args.lowerBinId, args.upperBinId)

  const removeInner = buildMeteoraRemoveLiquidityByRange2Ix({
    position: args.position,
    lbPair: args.pool,
    binArrayBitmapExtension: bitmapExtension,
    userPdaTokenX: userPdaAtaX,
    userPdaTokenY: userPdaAtaY,
    reserveX,
    reserveY,
    tokenXMint: args.tokenXMint,
    tokenYMint: args.tokenYMint,
    userPda,
    tokenXProgram: args.tokenXProgram,
    tokenYProgram: args.tokenYProgram,
    binArrays,
    fromBinId: args.lowerBinId,
    toBinId: args.upperBinId,
    bpsToRemove: 10_000,
  })

  const claimInner = buildMeteoraClaimFee2Ix({
    lbPair: args.pool,
    position: args.position,
    userPda,
    reserveX,
    reserveY,
    userTokenX: userPdaAtaX,
    userTokenY: userPdaAtaY,
    tokenXMint: args.tokenXMint,
    tokenYMint: args.tokenYMint,
    tokenXProgram: args.tokenXProgram,
    tokenYProgram: args.tokenYProgram,
    binArrays,
    minBinId: args.lowerBinId,
    maxBinId: args.upperBinId,
  })

  const closeInner = buildMeteoraClosePositionIfEmptyIx({
    position: args.position,
    rentReceiver: userPda,
    sender: userPda,
  })

  const ixs: TransactionInstruction[] = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
    createAssociatedTokenAccountIdempotentInstruction(
      authority, userAtaX, authority, args.tokenXMint, args.tokenXProgram, ASSOCIATED_TOKEN_PROGRAM_ID,
    ),
    createAssociatedTokenAccountIdempotentInstruction(
      authority, userAtaY, authority, args.tokenYMint, args.tokenYProgram, ASSOCIATED_TOKEN_PROGRAM_ID,
    ),
    buildMeteoraDynamicCpiIx({ userPda, authority, inner: removeInner }),
    buildMeteoraDynamicCpiIx({ userPda, authority, inner: claimInner }),
    buildMeteoraDynamicCpiIx({ userPda, authority, inner: closeInner }),
    buildHawkfiWithdrawTokenIx({ authority, mint: args.tokenXMint, tokenProgram: args.tokenXProgram }),
    buildHawkfiWithdrawTokenIx({ authority, mint: args.tokenYMint, tokenProgram: args.tokenYProgram }),
    heliusTipIx(authority),
  ]

  const altAccounts = await fetchHawkGlobalAlts(connection)
  const { blockhash } = await connection.getLatestBlockhash('confirmed')
  const message = new TransactionMessage({
    payerKey: authority,
    recentBlockhash: blockhash,
    instructions: ixs,
  }).compileToV0Message(altAccounts)
  return new VersionedTransaction(message)
}

// -----------------------------------------------------------------------------
// Position-owner detection
// -----------------------------------------------------------------------------

/** Position account layout: discriminator (8) + lb_pair (32) + owner (32) + ... */
export async function readPositionOwner(
  connection: Connection,
  position: PublicKey,
): Promise<PublicKey | null> {
  const info = await connection.getAccountInfo(position, 'confirmed')
  if (!info) return null
  if (info.data.length < 8 + 32 + 32) return null
  return new PublicKey(info.data.subarray(8 + 32, 8 + 32 + 32))
}

export type PositionOwnership = 'hawkfi' | 'direct' | 'unknown'

export async function classifyPositionOwnership(
  connection: Connection,
  position: PublicKey,
  authority: PublicKey,
): Promise<{ kind: PositionOwnership; owner: PublicKey | null; userPda: PublicKey }> {
  const [userPda] = deriveUserPda(authority)
  const owner = await readPositionOwner(connection, position)
  if (!owner) return { kind: 'unknown', owner: null, userPda }
  if (owner.equals(userPda)) return { kind: 'hawkfi', owner, userPda }
  if (owner.equals(authority)) return { kind: 'direct', owner, userPda }
  return { kind: 'unknown', owner, userPda }
}

// Re-exports for convenience.
export { deriveUserPda, IYF_MAIN, METEORA_DLMM, HELIUS_SENDER_TIP_LAMPORTS }
