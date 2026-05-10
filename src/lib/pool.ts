import { Connection, PublicKey } from '@solana/web3.js'
import { MINT, POOL } from './constants'

export interface PoolState {
  // from StakePool account
  validatorList: PublicKey
  reserveStake: PublicKey
  poolMint: PublicKey
  managerFeeAccount: PublicKey
  tokenProgramId: PublicKey
  // The pool's own accounting — these are the values the program uses to
  // compute redemption math on WithdrawSol. They're synced to chain reality
  // by UpdateStakePoolBalance (which also reconciles pool_token_supply with
  // mint.supply, so any drift from out-of-band burns auto-heals at update).
  poolTotalLamports: bigint
  poolTokenSupplyAccounting: bigint
  lastUpdateEpoch: bigint
  epochFeeDenom: bigint
  epochFeeNumer: bigint
  // Reference values, useful to show drift between syncs.
  mintSupply: bigint        // Token-2022 mint.supply (live)
  reserveLamports: bigint   // reserve stake account .lamports (live)
}

// StakePool offsets — spl-stake-pool v1.0.0 layout, fixed-position prefix
// (parsed manually to avoid pulling in borsh-deserialize for the whole struct)
export async function fetchPool(conn: Connection): Promise<PoolState> {
  // Use 'processed' commitment everywhere so mint.supply / reserve.lamports
  // reflect the latest in-flight state — `confirmed` can lag by a slot or two
  // and made post-mint refreshes look stale. Three independent calls (no
  // batching) so each account is read fresh on its own slot snapshot.
  const [poolAcc, mintAcc] = await Promise.all([
    conn.getAccountInfo(POOL, 'processed'),
    conn.getAccountInfo(MINT, 'processed'),
  ])
  if (!poolAcc) throw new Error(`pool not found at ${POOL.toBase58()}`)
  if (!mintAcc) throw new Error(`mint not found at ${MINT.toBase58()}`)

  const d = poolAcc.data
  const pk = (off: number) => new PublicKey(d.subarray(off, off + 32))
  const u64 = (off: number) => d.readBigUInt64LE(off)

  const validatorList = pk(98)
  const reserveStake = pk(130)
  const poolMint = pk(162)
  const managerFeeAccount = pk(194)
  const tokenProgramId = pk(226)
  const poolTotalLamports = u64(258)
  const poolTokenSupplyAccounting = u64(266)
  const lastUpdateEpoch = u64(274)
  const epochFeeDenom = u64(330)
  const epochFeeNumer = u64(338)

  // Token (and Token-2022) mint base layout: mint_authority option @ 0..36,
  // supply (u64) @ 36..44, decimals @ 44, is_initialized @ 45, ...
  const mintSupply = mintAcc.data.readBigUInt64LE(36)

  // Reserve stake account (address only known after parsing pool).
  const reserveAcc = await conn.getAccountInfo(reserveStake, 'processed')
  if (!reserveAcc) throw new Error(`reserve stake not found at ${reserveStake.toBase58()}`)
  const reserveLamports = BigInt(reserveAcc.lamports)

  return {
    validatorList,
    reserveStake,
    poolMint,
    managerFeeAccount,
    tokenProgramId,
    poolTotalLamports,
    poolTokenSupplyAccounting,
    lastUpdateEpoch,
    epochFeeDenom,
    epochFeeNumer,
    mintSupply,
    reserveLamports,
  }
}
