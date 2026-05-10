/**
 * Hand-rolled HawkFi v2 instruction builders, ported from
 * fun-launch/src/lib/hawkfi/v2_builder.ts.
 *
 * The published `@hawksightco/hawk-sdk` JS path is broken for our use case
 * (SDK emits v1-shape ixs that the on-chain program rejects with an Anchor
 * sighash mismatch on `AddLiquidityByStrategy2Pda` and adjacent ixs). The
 * fun-launch project reverse-engineered the working ix layouts from a
 * captured live mainnet tx (sig 5LhGA7Qhbj6y…HYEk on 2026-04-25) and we
 * inherit those verified discriminators / account orderings here.
 *
 * Local extensions (not in fun-launch's file):
 *   • `buildMeteoraRemoveLiquidityByRange2Ix` — withdraw bps from a range
 *   • `buildMeteoraClosePositionIfEmptyIx`   — close position + refund rent
 *   These two complete the "withdraw + close" flow that fun-launch didn't
 *   need (their use case opens permanent-locked positions that never close).
 */

import {
  PublicKey,
  TransactionInstruction,
  SYSVAR_RENT_PUBKEY,
  SystemProgram,
  AddressLookupTableAccount,
  Connection,
} from '@solana/web3.js'
import type { AccountMeta } from '@solana/web3.js'
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token'
import BN from 'bn.js'

// ── Constants (verified from program dump) ────────────────────────────────

export const IYF_MAIN = new PublicKey('FqGg2Y1FNxMiGd51Q6UETixQWkF5fB92MysbYogRJb3P')
export const IYF_EXTENSION = new PublicKey('EZiUb6ydWpR3ciizBTJ1J36KCqLyPKVjh4yZEJbs5Uno')
export const HAWK_FARM = new PublicKey('7jLQhREMxXjKdpwVuN6gwsWt3BNfAg9WqbepffPbi4ww')
export const HAWK_FEE_OWNER = new PublicKey('4K3a2ucXiGvuMJMPNneRDyzmNp6i4RdzXJmBdWwGwPEh')
export const METEORA_DLMM = new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo')
export const METEORA_DLMM_EVENT_AUTHORITY = new PublicKey(
  'D1ZN9Wj1fRSUQfCjhvnu1hqDMT7hzjzBBpi12nVniYD6',
)

/** USDC + USDT — HawkFi pre-derives storage accounts for these in `newUser`. */
export const HAWK_STABLE_MINT_1 = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')
export const HAWK_STABLE_MINT_2 = new PublicKey('Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB')

/** HawkFi's global ALTs — reusing them keeps tx size down. */
export const HAWK_GLOBAL_ALT_PUBKEYS = [
  new PublicKey('5FrgBCVUtwD1cFw39PZxnUsBaAecZVxmaYEcvv6y7b1h'),
  new PublicKey('AC3t5k5PUTJirxGEHgGGQStafu1vXkvddPyqVNDrRQDt'),
  new PublicKey('F2gRaSdfWYucAMAKv3CHReKMHvPkE3sNWrQPPPPR6UMV'),
  new PublicKey('FQHdXaRjfKxEfqDXMs6L1gfx2wwa6idDVB8hdQuf6eSD'),
]

export const MEMO_PROGRAM = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr')

// ── Anchor sighashes (verified) ───────────────────────────────────────────

const DISC = {
  newUser: Buffer.from('9e84e0dbd4a30700', 'hex'),
  initializeStorageTokenAccount: Buffer.from('dc4b2d99c15bb7a8', 'hex'),
  depositMultipleTokenWithToken2022: Buffer.from('40dbde3179177838', 'hex'),
  meteoraDynamicCpi: Buffer.from('93af1972a63628fe', 'hex'),
  withdrawTokenFromUserPda: Buffer.from('73c63e79af1fee92', 'hex'),

  // Inner Meteora DLMM sighashes (verified from live txs / IDL).
  innerInitializePosition: Buffer.from('dbc0ea47bebf6650', 'hex'),
  innerInitializeBinArray: Buffer.from('235613b94ed44bd3', 'hex'),
  innerAddLiquidityByStrategy2: Buffer.from('03dd95da6f8d76d5', 'hex'),
  innerClaimFee2: Buffer.from('70bf65ab1c907fbb', 'hex'),
  // Anchor disc = sha256("global:remove_liquidity_by_range2")[:8]. Verified
  // by node crypto (NOT a guess — fun-launch didn't need this one for
  // their locked-billie use case).
  innerRemoveLiquidityByRange2: Buffer.from('cc02c391359191cd', 'hex'),
  // Anchor disc = sha256("global:close_position_if_empty")[:8]. Verified.
  innerClosePositionIfEmpty: Buffer.from('3b7cd4765b986e9d', 'hex'),
}

// ── PDA derivations ───────────────────────────────────────────────────────

/** HawkFi's userPda for a wallet.
 *  VERIFIED via on-chain ConstraintSeeds error: seeds = ["multi-user", HAWK_FARM, authority]. */
export function deriveUserPda(authority: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('multi-user'), HAWK_FARM.toBuffer(), authority.toBuffer()],
    IYF_MAIN,
  )
}

/** userPda's per-mint storage account (used by the `newUser` ix only —
 *  regular deposits go through ATAs, not storage accounts). */
export function deriveStorageTokenAccount(
  userPda: PublicKey,
  mint: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('storage-token'), mint.toBuffer(), userPda.toBuffer()],
    IYF_MAIN,
  )
}

// ── newUser (one-time per wallet) ─────────────────────────────────────────

export function buildNewUserIx(authority: PublicKey): TransactionInstruction {
  const [userPda] = deriveUserPda(authority)
  const [stableToken] = deriveStorageTokenAccount(userPda, HAWK_STABLE_MINT_1)
  const [stableToken2] = deriveStorageTokenAccount(userPda, HAWK_STABLE_MINT_2)

  const keys: AccountMeta[] = [
    // farm MUST be writable — IYF program bumps a counter on it.
    { pubkey: HAWK_FARM, isSigner: false, isWritable: true },
    { pubkey: userPda, isSigner: false, isWritable: true },
    { pubkey: authority, isSigner: true, isWritable: true },
    { pubkey: stableToken, isSigner: false, isWritable: true },
    { pubkey: HAWK_STABLE_MINT_1, isSigner: false, isWritable: false },
    { pubkey: stableToken2, isSigner: false, isWritable: true },
    { pubkey: HAWK_STABLE_MINT_2, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
  ]

  return new TransactionInstruction({
    programId: IYF_MAIN,
    keys,
    data: DISC.newUser,
  })
}

// ── DepositMultipleTokenWithToken2022 ─────────────────────────────────────
// Pulls user wallet → userPda's per-mint ATA. Handles SPL + T22 simultaneously.
// 2-mint case verified live; one amount can be 0 for single-sided deposits.

export interface DepositMultipleArgs {
  authority: PublicKey
  /** Exactly two entries (X then Y). One amount may be `new BN(0)` for single-sided. */
  deposits: Array<{
    mint: PublicKey
    amountAtoms: BN
    tokenProgram: PublicKey
  }>
}

export function buildDepositMultipleTokenWithToken2022Ix(
  args: DepositMultipleArgs,
): TransactionInstruction {
  if (args.deposits.length !== 2) {
    throw new Error(
      `DepositMultipleTokenWithToken2022 builds the 2-mint case only ` +
        `(got ${args.deposits.length}). Pad single-sided with amount=0.`,
    )
  }
  const [userPda] = deriveUserPda(args.authority)
  const [d0, d1] = args.deposits

  // Verified per-mint layout from captured tx 5LhGA7…HYEk:
  //   [mint, userWalletATA, userPdaATA, treasuryATA]
  // userPda ATAs use allowOwnerOffCurve=true since userPda is a PDA.
  const userAtaX = getAssociatedTokenAddressSync(d0.mint, args.authority, false, d0.tokenProgram)
  const userAtaY = getAssociatedTokenAddressSync(d1.mint, args.authority, false, d1.tokenProgram)
  const userPdaAtaX = getAssociatedTokenAddressSync(d0.mint, userPda, true, d0.tokenProgram)
  const userPdaAtaY = getAssociatedTokenAddressSync(d1.mint, userPda, true, d1.tokenProgram)
  const treasuryX = getAssociatedTokenAddressSync(d0.mint, HAWK_FEE_OWNER, true, d0.tokenProgram)
  const treasuryY = getAssociatedTokenAddressSync(d1.mint, HAWK_FEE_OWNER, true, d1.tokenProgram)

  const keys: AccountMeta[] = [
    { pubkey: HAWK_FARM, isSigner: false, isWritable: false },
    { pubkey: userPda, isSigner: false, isWritable: true },
    { pubkey: args.authority, isSigner: true, isWritable: true },
    { pubkey: HAWK_FEE_OWNER, isSigner: false, isWritable: false },
    { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: d0.mint, isSigner: false, isWritable: true },
    { pubkey: userAtaX, isSigner: false, isWritable: true },
    { pubkey: userPdaAtaX, isSigner: false, isWritable: true },
    { pubkey: treasuryX, isSigner: false, isWritable: true },
    { pubkey: d1.mint, isSigner: false, isWritable: true },
    { pubkey: userAtaY, isSigner: false, isWritable: true },
    { pubkey: userPdaAtaY, isSigner: false, isWritable: true },
    { pubkey: treasuryY, isSigner: false, isWritable: true },
  ]

  // Args layout (29 bytes total):
  //   [8 sighash][4 LE variant=2][8 amount_x LE][8 amount_y LE][1 trailing flag]
  const data = Buffer.alloc(29)
  data.set(DISC.depositMultipleTokenWithToken2022, 0)
  data.writeUInt32LE(2, 8)
  d0.amountAtoms.toArrayLike(Buffer, 'le', 8).copy(data, 12)
  d1.amountAtoms.toArrayLike(Buffer, 'le', 8).copy(data, 20)
  data[28] = 0

  return new TransactionInstruction({ programId: IYF_MAIN, keys, data })
}

// ── meteoraDynamicCpi (wrapper) ───────────────────────────────────────────

/** Wraps a Meteora DLMM ix in a HawkFi-program call so the userPda can sign
 *  for accounts via `invoke_signed`. The `inner` ix's programId MUST be
 *  METEORA_DLMM. Any inner accounts marked as signers that are the userPda
 *  are demoted at the outer level (PDAs can never be top-level signers). */
export function buildMeteoraDynamicCpiIx(args: {
  userPda: PublicKey
  authority: PublicKey
  inner: TransactionInstruction
}): TransactionInstruction {
  if (!args.inner.programId.equals(METEORA_DLMM)) {
    throw new Error(
      `meteoraDynamicCpi: inner programId must be METEORA_DLMM, got ${args.inner.programId.toBase58()}`,
    )
  }

  const demotedInnerKeys = args.inner.keys.map((k) =>
    k.pubkey.equals(args.userPda) ? { ...k, isSigner: false } : k,
  )
  const outerKeys: AccountMeta[] = [
    { pubkey: args.userPda, isSigner: false, isWritable: true },
    { pubkey: args.authority, isSigner: true, isWritable: true },
    { pubkey: METEORA_DLMM, isSigner: false, isWritable: false },
    ...demotedInnerKeys,
  ]

  // Outer data: [8 sighash][4 LE inner_size][inner_full_ix_data]
  const innerData = args.inner.data
  const data = Buffer.alloc(8 + 4 + innerData.length)
  DISC.meteoraDynamicCpi.copy(data, 0)
  data.writeUInt32LE(innerData.length, 8)
  innerData.copy(data, 12)

  return new TransactionInstruction({ programId: IYF_MAIN, keys: outerKeys, data })
}

// ── Inner Meteora DLMM ix builders ────────────────────────────────────────

export function buildMeteoraInitializePositionIx(args: {
  payer: PublicKey
  position: PublicKey // fresh keypair, signer
  lbPair: PublicKey
  owner: PublicKey // userPda
  lowerBinId: number
  width: number
}): TransactionInstruction {
  const keys: AccountMeta[] = [
    { pubkey: args.payer, isSigner: true, isWritable: true },
    { pubkey: args.position, isSigner: true, isWritable: true },
    { pubkey: args.lbPair, isSigner: false, isWritable: true },
    { pubkey: args.owner, isSigner: true, isWritable: false }, // demoted by dynamicCpi wrapper
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    { pubkey: METEORA_DLMM_EVENT_AUTHORITY, isSigner: false, isWritable: false },
    { pubkey: METEORA_DLMM, isSigner: false, isWritable: false },
  ]
  const data = Buffer.alloc(8 + 4 + 4)
  DISC.innerInitializePosition.copy(data, 0)
  data.writeInt32LE(args.lowerBinId, 8)
  data.writeInt32LE(args.width, 12)
  return new TransactionInstruction({ programId: METEORA_DLMM, keys, data })
}

export interface AddLiquidityByStrategy2Args {
  position: PublicKey
  lbPair: PublicKey
  binArrayBitmapExtension: PublicKey
  userPdaTokenX: PublicKey
  userPdaTokenY: PublicKey
  reserveX: PublicKey
  reserveY: PublicKey
  tokenXMint: PublicKey
  tokenYMint: PublicKey
  userPda: PublicKey
  tokenXProgram: PublicKey
  tokenYProgram: PublicKey
  binArrays: PublicKey[]
  amountX: BN
  amountY: BN
  activeId: number
  maxActiveBinSlippage: number
  minBinId: number
  maxBinId: number
  /** 0=SpotOneSide, 1=CurveOneSide, 2=BidAskOneSide, 3=SpotBalanced,
   *  4=CurveBalanced, 5=BidAskBalanced, 6=SpotImBalanced, 7=CurveImBalanced,
   *  8=BidAskImBalanced. */
  strategyType: number
  strategyParameters?: Uint8Array
}

export function buildMeteoraAddLiquidityByStrategy2Ix(
  args: AddLiquidityByStrategy2Args,
): TransactionInstruction {
  const fixedKeys: AccountMeta[] = [
    { pubkey: args.position, isSigner: false, isWritable: true },
    { pubkey: args.lbPair, isSigner: false, isWritable: true },
    { pubkey: args.binArrayBitmapExtension, isSigner: false, isWritable: true },
    { pubkey: args.userPdaTokenX, isSigner: false, isWritable: true },
    { pubkey: args.userPdaTokenY, isSigner: false, isWritable: true },
    { pubkey: args.reserveX, isSigner: false, isWritable: true },
    { pubkey: args.reserveY, isSigner: false, isWritable: true },
    { pubkey: args.tokenXMint, isSigner: false, isWritable: true },
    { pubkey: args.tokenYMint, isSigner: false, isWritable: true },
    { pubkey: args.userPda, isSigner: true, isWritable: true }, // demoted by dynamicCpi
    { pubkey: args.tokenXProgram, isSigner: false, isWritable: false },
    { pubkey: args.tokenYProgram, isSigner: false, isWritable: false },
    { pubkey: METEORA_DLMM_EVENT_AUTHORITY, isSigner: false, isWritable: false },
    { pubkey: METEORA_DLMM, isSigner: false, isWritable: false },
  ]
  const remainingKeys: AccountMeta[] = args.binArrays.map((b) => ({
    pubkey: b,
    isSigner: false,
    isWritable: true,
  }))

  const params = args.strategyParameters ?? new Uint8Array(64)
  if (params.length !== 64) {
    throw new Error(`strategyParameters must be 64 bytes, got ${params.length}`)
  }
  // 113 bytes total — see fun-launch v2_builder for full layout doc.
  const data = Buffer.alloc(8 + 8 + 8 + 4 + 4 + 4 + 4 + 1 + 64 + 4 + 4)
  let p = 0
  DISC.innerAddLiquidityByStrategy2.copy(data, p); p += 8
  args.amountX.toArrayLike(Buffer, 'le', 8).copy(data, p); p += 8
  args.amountY.toArrayLike(Buffer, 'le', 8).copy(data, p); p += 8
  data.writeInt32LE(args.activeId, p); p += 4
  data.writeInt32LE(args.maxActiveBinSlippage, p); p += 4
  data.writeInt32LE(args.minBinId, p); p += 4
  data.writeInt32LE(args.maxBinId, p); p += 4
  data.writeUInt8(args.strategyType, p); p += 1
  Buffer.from(params).copy(data, p); p += 64
  // RemainingAccountsInfo: 2 transfer-hook slices, length 0 each.
  data.writeUInt32LE(2, p); p += 4
  data.writeUInt8(0, p); data.writeUInt8(0, p + 1); p += 2
  data.writeUInt8(1, p); data.writeUInt8(0, p + 1)

  return new TransactionInstruction({
    programId: METEORA_DLMM,
    keys: [...fixedKeys, ...remainingKeys],
    data,
  })
}

// ── Bin-array helpers ─────────────────────────────────────────────────────

export const BIN_ARRAY_BIN_COUNT = 70

export function deriveBinArray(lbPair: PublicKey, binArrayIndex: number): [PublicKey, number] {
  const idxBuf = Buffer.alloc(8)
  idxBuf.writeBigInt64LE(BigInt(binArrayIndex))
  return PublicKey.findProgramAddressSync(
    [Buffer.from('bin_array'), lbPair.toBuffer(), idxBuf],
    METEORA_DLMM,
  )
}

export function deriveBinArraysForRange(
  lbPair: PublicKey,
  minBinId: number,
  maxBinId: number,
): PublicKey[] {
  const minIdx = Math.floor(minBinId / BIN_ARRAY_BIN_COUNT)
  const maxIdx = Math.floor(maxBinId / BIN_ARRAY_BIN_COUNT)
  const out: PublicKey[] = []
  for (let i = minIdx; i <= maxIdx; i++) {
    const [pda] = deriveBinArray(lbPair, i)
    out.push(pda)
  }
  return out
}

export function deriveBinArrayBitmapExtension(lbPair: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('bitmap'), lbPair.toBuffer()],
    METEORA_DLMM,
  )
}

/** Default bin-array bitmap covers bin-array indices [-512, 511]. Anything
 *  outside that range needs the bin-array-bitmap-extension PDA to also be
 *  on chain — for indices inside the default range, Meteora's IDL marks
 *  the extension as optional and Anchor expects the **program ID itself**
 *  as the sentinel value (NOT the derived PDA, which doesn't exist on
 *  chain for default-range positions and trips
 *  `AccountOwnedByWrongProgram` (3007) at runtime).
 *
 *  Use this when filling the `binArrayBitmapExtension` slot for any
 *  Meteora ix — it returns either the program ID sentinel or the derived
 *  PDA depending on whether the position's range overflows the default
 *  bitmap. */
const BIN_ARRAY_BITMAP_SIZE = 512
export function resolveBinArrayBitmapExtension(
  lbPair: PublicKey,
  minBinId: number,
  maxBinId: number,
): PublicKey {
  const minIdx = Math.floor(minBinId / BIN_ARRAY_BIN_COUNT)
  const maxIdx = Math.floor(maxBinId / BIN_ARRAY_BIN_COUNT)
  const overflow =
    minIdx < -BIN_ARRAY_BITMAP_SIZE ||
    minIdx >= BIN_ARRAY_BITMAP_SIZE ||
    maxIdx < -BIN_ARRAY_BITMAP_SIZE ||
    maxIdx >= BIN_ARRAY_BITMAP_SIZE
  if (!overflow) return METEORA_DLMM
  return deriveBinArrayBitmapExtension(lbPair)[0]
}

export function deriveReservePda(lbPair: PublicKey, mint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [lbPair.toBuffer(), mint.toBuffer()],
    METEORA_DLMM,
  )
}

export function buildMeteoraInitializeBinArrayIx(args: {
  funder: PublicKey
  lbPair: PublicKey
  binArray: PublicKey
  index: number
}): TransactionInstruction {
  const keys: AccountMeta[] = [
    { pubkey: args.lbPair, isSigner: false, isWritable: false },
    { pubkey: args.binArray, isSigner: false, isWritable: true },
    { pubkey: args.funder, isSigner: true, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ]
  const data = Buffer.alloc(8 + 8)
  DISC.innerInitializeBinArray.copy(data, 0)
  data.writeBigInt64LE(BigInt(args.index), 8)
  return new TransactionInstruction({ programId: METEORA_DLMM, keys, data })
}

// ── claim_fee2 (T22-aware fee claim) ──────────────────────────────────────

export interface ClaimFee2Args {
  lbPair: PublicKey
  position: PublicKey
  userPda: PublicKey
  reserveX: PublicKey
  reserveY: PublicKey
  userTokenX: PublicKey
  userTokenY: PublicKey
  tokenXMint: PublicKey
  tokenYMint: PublicKey
  tokenXProgram: PublicKey
  tokenYProgram: PublicKey
  binArrays: PublicKey[]
  minBinId: number
  maxBinId: number
}

export function buildMeteoraClaimFee2Ix(args: ClaimFee2Args): TransactionInstruction {
  const keys: AccountMeta[] = [
    { pubkey: args.lbPair, isSigner: false, isWritable: true },
    { pubkey: args.position, isSigner: false, isWritable: true },
    { pubkey: args.userPda, isSigner: true, isWritable: false }, // demoted by dynamicCpi
    { pubkey: args.reserveX, isSigner: false, isWritable: true },
    { pubkey: args.reserveY, isSigner: false, isWritable: true },
    { pubkey: args.userTokenX, isSigner: false, isWritable: true },
    { pubkey: args.userTokenY, isSigner: false, isWritable: true },
    { pubkey: args.tokenXMint, isSigner: false, isWritable: false },
    { pubkey: args.tokenYMint, isSigner: false, isWritable: false },
    { pubkey: args.tokenXProgram, isSigner: false, isWritable: false },
    { pubkey: args.tokenYProgram, isSigner: false, isWritable: false },
    { pubkey: MEMO_PROGRAM, isSigner: false, isWritable: false },
    { pubkey: METEORA_DLMM_EVENT_AUTHORITY, isSigner: false, isWritable: false },
    { pubkey: METEORA_DLMM, isSigner: false, isWritable: false },
    ...args.binArrays.map((b) => ({
      pubkey: b,
      isSigner: false,
      isWritable: true,
    })),
  ]
  const data = Buffer.alloc(8 + 4 + 4 + 4 + 4)
  let p = 0
  DISC.innerClaimFee2.copy(data, p); p += 8
  data.writeInt32LE(args.minBinId, p); p += 4
  data.writeInt32LE(args.maxBinId, p); p += 4
  data.writeUInt32LE(2, p); p += 4
  data.writeUInt8(0, p); data.writeUInt8(0, p + 1); p += 2
  data.writeUInt8(1, p); data.writeUInt8(0, p + 1)
  return new TransactionInstruction({ programId: METEORA_DLMM, keys, data })
}

// ── remove_liquidity_by_range2 (T22-aware liquidity removal) ──────────────
// Local extension — fun-launch's locked-billie use case never withdraws,
// so this builder isn't in v2_builder.ts. Layout derived from the Meteora
// DLMM 1.5.4 IDL (`removeLiquidityByRange2`) and accounts mirror
// `addLiquidityByStrategy2` exactly.

export interface RemoveLiquidityByRange2Args {
  position: PublicKey
  lbPair: PublicKey
  binArrayBitmapExtension: PublicKey
  userPdaTokenX: PublicKey
  userPdaTokenY: PublicKey
  reserveX: PublicKey
  reserveY: PublicKey
  tokenXMint: PublicKey
  tokenYMint: PublicKey
  userPda: PublicKey
  tokenXProgram: PublicKey
  tokenYProgram: PublicKey
  binArrays: PublicKey[]
  fromBinId: number
  toBinId: number
  /** Basis points to remove per bin. 10000 = 100%. */
  bpsToRemove: number
}

export function buildMeteoraRemoveLiquidityByRange2Ix(
  args: RemoveLiquidityByRange2Args,
): TransactionInstruction {
  const keys: AccountMeta[] = [
    { pubkey: args.position, isSigner: false, isWritable: true },
    { pubkey: args.lbPair, isSigner: false, isWritable: true },
    { pubkey: args.binArrayBitmapExtension, isSigner: false, isWritable: true },
    { pubkey: args.userPdaTokenX, isSigner: false, isWritable: true },
    { pubkey: args.userPdaTokenY, isSigner: false, isWritable: true },
    { pubkey: args.reserveX, isSigner: false, isWritable: true },
    { pubkey: args.reserveY, isSigner: false, isWritable: true },
    { pubkey: args.tokenXMint, isSigner: false, isWritable: false },
    { pubkey: args.tokenYMint, isSigner: false, isWritable: false },
    { pubkey: args.userPda, isSigner: true, isWritable: true }, // demoted by dynamicCpi
    { pubkey: args.tokenXProgram, isSigner: false, isWritable: false },
    { pubkey: args.tokenYProgram, isSigner: false, isWritable: false },
    { pubkey: MEMO_PROGRAM, isSigner: false, isWritable: false },
    { pubkey: METEORA_DLMM_EVENT_AUTHORITY, isSigner: false, isWritable: false },
    { pubkey: METEORA_DLMM, isSigner: false, isWritable: false },
    ...args.binArrays.map((b) => ({
      pubkey: b,
      isSigner: false,
      isWritable: true,
    })),
  ]

  // Args (28 bytes):
  //   [8 sighash][4 from_bin_id i32][4 to_bin_id i32][2 bps u16]
  //   [4 RemainingAccountsInfo.slices.len = 2][2 {Hook X, 0}][2 {Hook Y, 0}]
  const data = Buffer.alloc(8 + 4 + 4 + 2 + 4 + 4)
  let p = 0
  DISC.innerRemoveLiquidityByRange2.copy(data, p); p += 8
  data.writeInt32LE(args.fromBinId, p); p += 4
  data.writeInt32LE(args.toBinId, p); p += 4
  data.writeUInt16LE(args.bpsToRemove, p); p += 2
  data.writeUInt32LE(2, p); p += 4
  data.writeUInt8(0, p); data.writeUInt8(0, p + 1); p += 2
  data.writeUInt8(1, p); data.writeUInt8(0, p + 1)

  return new TransactionInstruction({ programId: METEORA_DLMM, keys, data })
}

// ── close_position_if_empty ───────────────────────────────────────────────

export function buildMeteoraClosePositionIfEmptyIx(args: {
  position: PublicKey
  /** Where the rent goes — the original position owner (= userPda). */
  rentReceiver: PublicKey
  /** Signer authorized to close. For HawkFi positions this is userPda
   *  (signed via meteoraDynamicCpi). */
  sender: PublicKey
}): TransactionInstruction {
  const keys: AccountMeta[] = [
    { pubkey: args.position, isSigner: false, isWritable: true },
    { pubkey: args.rentReceiver, isSigner: false, isWritable: true },
    { pubkey: args.sender, isSigner: true, isWritable: false }, // demoted by dynamicCpi
    { pubkey: METEORA_DLMM_EVENT_AUTHORITY, isSigner: false, isWritable: false },
    { pubkey: METEORA_DLMM, isSigner: false, isWritable: false },
  ]
  return new TransactionInstruction({
    programId: METEORA_DLMM,
    keys,
    data: DISC.innerClosePositionIfEmpty,
  })
}

// ── HawkFi `withdraw_token_from_user_pda` ─────────────────────────────────
// Forwards the userPda's per-mint ATA balance into the user wallet's ATA,
// after taking a HawkFi fee skim into ownerFeeToken.

export function buildHawkfiWithdrawTokenIx(args: {
  authority: PublicKey
  mint: PublicKey
  tokenProgram: PublicKey
}): TransactionInstruction {
  const [userPda] = deriveUserPda(args.authority)
  const userToken = getAssociatedTokenAddressSync(args.mint, args.authority, false, args.tokenProgram)
  const userPdaToken = getAssociatedTokenAddressSync(args.mint, userPda, true, args.tokenProgram)
  const ownerFeeToken = getAssociatedTokenAddressSync(args.mint, HAWK_FEE_OWNER, true, args.tokenProgram)

  const keys: AccountMeta[] = [
    { pubkey: HAWK_FARM, isSigner: false, isWritable: false },
    { pubkey: userPda, isSigner: false, isWritable: true },
    { pubkey: args.authority, isSigner: true, isWritable: true },
    { pubkey: userToken, isSigner: false, isWritable: true },
    { pubkey: userPdaToken, isSigner: false, isWritable: true },
    { pubkey: ownerFeeToken, isSigner: false, isWritable: true },
    { pubkey: args.tokenProgram, isSigner: false, isWritable: false },
  ]

  return new TransactionInstruction({
    programId: IYF_MAIN,
    keys,
    data: DISC.withdrawTokenFromUserPda,
  })
}

// ── ALT helpers ───────────────────────────────────────────────────────────

export async function fetchHawkGlobalAlts(
  connection: Connection,
): Promise<AddressLookupTableAccount[]> {
  const out: AddressLookupTableAccount[] = []
  for (const pubkey of HAWK_GLOBAL_ALT_PUBKEYS) {
    const r = await connection.getAddressLookupTable(pubkey)
    if (r.value) out.push(r.value)
  }
  return out
}
