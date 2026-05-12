// Save Finance (formerly Solend) data shapes — mirrors the response from
// https://api.solend.fi/v1/markets/configs?scope=all&deployment=production
//
// The API returns an array of "markets" (a.k.a. pools). Each market has a
// `reserves` array; each reserve is one mint listed for lending/borrowing.
// Permissionless pools — what we care about — have `isPermissionless: true`.
//
// We keep camelCase types matching the wire format so you can pass the
// payload straight into UI without renaming. The optional `token2022Mint`
// field flags Token-2022 listings (Save's own permissionless ops are SPL
// only — wrapped Token-2022 like wstacSOL is the right path).

export interface SaveLiquidityToken {
  coingeckoID: string
  decimals: number
  logo: string
  /** SPL mint pubkey (or Token-2022 wrapped mint). */
  mint: string
  name: string
  symbol: string
  /** Stringified USD 24h volume; '' when unknown. */
  volume24h: string
  /** Set when the listed mint is itself Token-2022; absent for plain SPL. */
  token2022Mint?: string
}

export interface SaveReserve {
  liquidityToken: SaveLiquidityToken
  /** Primary oracle source. Pyth pubkey or `nu11…` placeholder when absent. */
  pythOracle: string
  /** Fallback oracle. Same placeholder convention. */
  switchboardOracle: string
  /** Extra Save-specific oracle (rare). All-ones placeholder when absent. */
  extraOracle: string
  /** Reserve PDA on the Save program. */
  address: string
  /** cToken (collateral) mint that this reserve issues to lenders. */
  collateralMintAddress: string
  /** Reserve account that holds the cToken supply. */
  collateralSupplyAddress: string
  /** Reserve account that holds the underlying liquidity. */
  liquidityAddress: string
  /** Treasury account that collects protocol fees. */
  liquidityFeeReceiverAddress: string
  /** Optional per-user borrow cap (stringified atom). */
  userBorrowCap?: string
  /** Optional per-user supply cap (stringified atom). */
  userSupplyCap?: string
}

export interface SavePool {
  /** Display name for the pool. e.g. "Main", "EUROe", "JLP". */
  name: string
  /** True for the Save canonical pool. */
  isPrimary: boolean
  /** Human description shown in the pool picker. */
  description: string
  /** Wallet that initialized the pool. */
  creator: string
  /** Pool (market) PDA on the Save program. */
  address: string
  /** True if Save admins have hidden the pool from default discovery. */
  hidden: boolean
  /** True if anyone could create / manage the pool (paid the SLND fee). */
  isPermissionless: boolean
  /** Lending market authority PDA — used as cToken / vault authority. */
  authorityAddress: string
  /** Pool owner — usually `creator` for permissionless pools. */
  owner: string
  reserves: SaveReserve[]
  /** Optional v0 lookup table to compress instruction account lists. */
  lookupTableAddress: string | null
}

// Sentinels Save uses to mean "no oracle of this type wired" — easier to
// special-case in UI than checking string equality everywhere.
export const NULL_PYTH_ORACLE = 'nu11111111111111111111111111111111111111111'
export const NULL_SOL_ADDR = '11111111111111111111111111111111'

export function hasPythOracle(r: SaveReserve): boolean {
  return r.pythOracle !== NULL_PYTH_ORACLE
}

export function hasSwitchboardOracle(r: SaveReserve): boolean {
  return r.switchboardOracle !== NULL_PYTH_ORACLE
}

export function reserveIsToken2022(r: SaveReserve): boolean {
  return r.liquidityToken.token2022Mint !== undefined
}

/** Quick-find: get reserve by liquidity mint (the listed asset). */
export function findReserveByMint(
  pool: SavePool,
  mint: string,
): SaveReserve | undefined {
  return pool.reserves.find((r) => r.liquidityToken.mint === mint)
}

/** Quick-find: get any pool that lists the given mint. */
export function findPoolByMint(
  pools: SavePool[],
  mint: string,
): SavePool | undefined {
  return pools.find((p) =>
    p.reserves.some((r) => r.liquidityToken.mint === mint),
  )
}

// Known mints we care about across the staccoverflow stack — these aren't
// listed by Save themselves; we hard-code so the UI can label rows even
// before/while the listing flow happens.
export const KNOWN_MINTS = {
  WSOL: 'So11111111111111111111111111111111111111112',
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  WSTAC_SOL: 'GB2Y9s7N9HcpCmrqyByygMfRsJDLH1Gt7wasTtczohYL',
  STAC_SOL_T22: '6K4xdfEk5rvySM496rxm4x8AgC9wVt7N4C7mFFpNAj5f',
} as const
