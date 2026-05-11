// Per-AMM resolver registry. Each AMM plugs into liqmonsta's smash
// orchestrator via this interface.
//
// A resolver knows how to:
//   1. SCAN  — enumerate the user's positions on this AMM where one side is
//      wSOL (or an LST we know how to unwrap).
//   2. CLOSE — build the tx(s) that withdraw + close one position, recovering
//      tokenA + tokenB to the user's wallet.
//   3. OPEN  — build the tx(s) that open the mirrored position on the equivalent
//      stacSOL pair (same pool type if a stacSOL/X pool exists, otherwise
//      init a new one).
//
// Liqmonsta.tsx renders ALL positions from ALL resolvers in a single list and
// the SMASH button iterates them, building the per-position bundle.

import type { Connection, PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js'

export type AmmType =
  | 'meteora-dlmm'
  | 'raydium-cpmm'
  | 'raydium-clmm'
  | 'orca-whirlpool'
  | 'meteora-damm'

export type WireStatus = 'live' | 'next' | 'wiring'

export interface ResolverMeta {
  amm: AmmType
  label: string
  /** Position-discovery wiring state. */
  scan: WireStatus
  /** Close-tx wiring state. */
  close: WireStatus
  /** Open-tx wiring state. */
  open: WireStatus
}

/** Position found in the wild. AMM-agnostic shape consumed by the page. */
export interface RawPosition {
  amm: AmmType
  /** Position identifier — NFT mint, LP mint+pool, or position pubkey, depending on AMM. */
  positionId: string
  /** Source pool address (so we can show it on solscan). */
  poolAddress: string
  /** Human label like "SOL / USDC". */
  poolLabel: string
  /** Amount of SOL inside this position (lamports). */
  solAtom: bigint
  /** Counterparty mint (the side that isn't SOL). */
  otherMint: string
  /** UI symbol for the counterparty (best-effort; falls back to "?"). */
  otherSymbol: string
  /** Counterparty decimals. */
  otherDecimals: number
  /** Counterparty atomic amount in the position. */
  otherAtom: bigint
  /** For range-based positions (DLMM bins, CLMM ticks): the position range. */
  range?: { lower: number; upper: number }
  /** Whether the target stacSOL/X pool exists today on this AMM. */
  hasTarget: boolean
  /** Free-form AMM-specific data the close/open builders need. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  raw: any
}

export interface CloseResult {
  txs: (VersionedTransaction | Transaction)[]
  /** Estimated SOL recovered (lamports), used to size the SOL → stacSOL mint. */
  estSolAtom: bigint
  /** Estimated other-token recovered (atoms), used for the open leg. */
  estOtherAtom: bigint
}

export interface OpenResult {
  txs: (VersionedTransaction | Transaction)[]
  /** Optional pre-signed keypairs (e.g. DLMM position keypair). The signer pulls
   *  them after the wallet signs so injected partial sigs aren't dropped. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  reattach?: (signedTxs: any[]) => void
  /** Index range in the `txs` array that needs `reattach()` to be invoked on. */
  reattachRange?: [number, number]
}

export interface AmmResolver {
  meta: ResolverMeta

  /** Discover user's eligible positions on this AMM. Throw to surface errors;
   *  return [] for "nothing found." */
  scan(connection: Connection, wallet: PublicKey): Promise<RawPosition[]>

  /** Build the txs that close one position. Throw if not yet wired. */
  buildCloseTxs(
    connection: Connection,
    wallet: PublicKey,
    pos: RawPosition,
  ): Promise<CloseResult>

  /** Build the txs that open the mirrored stacSOL/X position equivalent to
   *  `pos`. `stacAtomEstimate` is the stacSOL we expect to have post-mint. */
  buildOpenTxs(
    connection: Connection,
    wallet: PublicKey,
    pos: RawPosition,
    stacAtomEstimate: bigint,
  ): Promise<OpenResult>
}

/**
 * Resolver registry. New AMMs land here. Order = render order on the page.
 *
 * IMPORTANT: each resolver is imported via dynamic `await import()` inside its
 * own implementation file (not statically here) so that the heavy AMM SDKs
 * are only pulled into the bundle when the resolver is actually USED.
 *
 * To add a new AMM:
 *   1. Implement an `AmmResolver` in src/lib/resolvers/<amm>.ts
 *   2. Export it as the module default
 *   3. Add it to `loadResolvers()` below
 *   4. Done — Liqmonsta picks it up automatically
 */
export async function loadResolvers(): Promise<AmmResolver[]> {
  const [dlmm, cpmm, clmm, whirl, damm] = await Promise.all([
    import('./meteora-dlmm').then((m) => m.default),
    import('./raydium-cpmm').then((m) => m.default),
    import('./raydium-clmm').then((m) => m.default),
    import('./orca-whirlpool').then((m) => m.default),
    import('./meteora-damm').then((m) => m.default),
  ])
  return [dlmm, cpmm, clmm, whirl, damm]
}
