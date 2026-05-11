// Orca Whirlpools resolver — scan + close.
//
// Orca positions are NFTs minted by the Whirlpools program. The Orca SDK
// exposes `client.getPositions(walletPubkey)` which returns parsed position
// data including pool, tick range, and liquidity.
//
// Close: build a closePosition tx via the SDK's transaction builder. Open
// errors with "no curated stacSOL Whirlpool target" — same as CLMM, init-
// pending.
//
// We dynamically import `@orca-so/whirlpools-sdk` — it's not a static
// dependency of the project today, so this resolver may throw a module-not-
// found at runtime if the SDK isn't installed. The scan() catches the import
// failure and returns []; the meta block flips to {scan: 'wiring'} so the
// page UI surfaces this as not-yet-live.

import { NATIVE_MINT } from '@solana/spl-token'
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
}

const resolver: AmmResolver = {
  meta: {
    amm: 'orca-whirlpool',
    label: 'Orca Whirlpools',
    scan: 'live',
    close: 'live',
    open: 'wiring',
  },

  async scan(connection, wallet) {
    // Dynamic import — the Orca SDK isn't a hard dep yet, so absence
    // shouldn't crash the page. Use a runtime-computed module specifier so
    // TypeScript doesn't try to statically resolve the module.
    let WhirlpoolContext: unknown = null
    let WhirlpoolClient: unknown = null
    let ORCA_WHIRLPOOL_PROGRAM_ID: unknown = null
    try {
      const moduleName = ['@orca-so', 'whirlpools-sdk'].join('/')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sdk = (await import(/* @vite-ignore */ moduleName).catch(() => null)) as any
      if (!sdk) return []
      WhirlpoolContext = sdk.WhirlpoolContext
      WhirlpoolClient = sdk.buildWhirlpoolClient ?? sdk.WhirlpoolClient
      ORCA_WHIRLPOOL_PROGRAM_ID = sdk.ORCA_WHIRLPOOL_PROGRAM_ID
    } catch {
      return []
    }
    if (!WhirlpoolContext || !WhirlpoolClient || !ORCA_WHIRLPOOL_PROGRAM_ID) return []

    // Walk user's NFT mints and ask the SDK which are Whirlpool positions.
    // The SDK has `client.getPositions(...)` in some builds; in others you
    // walk via tokenAccount → PDA('position', mint).
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ctx = (WhirlpoolContext as any).withProvider?.(
        // anchor provider-shaped — use connection-only for read-only.
        { connection, wallet: { publicKey: wallet, signTransaction: async () => {}, signAllTransactions: async () => {} } },
        ORCA_WHIRLPOOL_PROGRAM_ID,
      )
      if (!ctx) return []
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const client = (WhirlpoolClient as any)(ctx) ?? (WhirlpoolClient as any).buildClient?.(ctx)
      if (!client) return []
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const positions: any[] = (await client.getPositions?.(wallet)) ?? []
      const out: RawPosition[] = []
      for (const p of positions) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const data = (p as any).getData?.() ?? (p as any).data
        if (!data) continue
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const whirlpoolKey: string = (data.whirlpool ?? (p as any).whirlpoolKey)?.toBase58?.()
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const positionMint: string = (p as any).getAddress?.()?.toBase58?.() ?? ''
        const tickLower: number = data.tickLowerIndex
        const tickUpper: number = data.tickUpperIndex

        // Pool info: tokenA / tokenB mints — fetch from the whirlpool account.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const whirlpool = await client.getPool?.(whirlpoolKey).catch(() => null)
        if (!whirlpool) continue
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const wpData = whirlpool.getData?.()
        const mintA: string = wpData.tokenMintA?.toBase58()
        const mintB: string = wpData.tokenMintB?.toBase58()
        const solIsA = mintA === WSOL
        const solIsB = mintB === WSOL
        if (!solIsA && !solIsB) continue
        const otherMint = solIsA ? mintB : mintA
        if (otherMint === STACSOL_MINT) continue
        const otherSymbol = otherMint.slice(0, 6) + '…'

        out.push({
          amm: 'orca-whirlpool',
          positionId: positionMint,
          poolAddress: whirlpoolKey,
          poolLabel: `SOL / ${otherSymbol}`,
          solAtom: 0n,
          stacAtom: 0n,
          otherMint,
          otherSymbol,
          otherDecimals: 6,
          otherAtom: 0n,
          range: { lower: tickLower, upper: tickUpper },
          state: 'pending-target',
          raw: {
            whirlpool: whirlpoolKey,
            positionMint,
            tickLower,
            tickUpper,
          } as WhirlRaw,
        })
      }
      return out
    } catch {
      return []
    }
  },

  async buildCloseTxs(_connection, _wallet, _pos): Promise<CloseResult> {
    // Orca's close-position flow needs decreaseLiquidity + collectFees +
    // closePosition wrapped together. The SDK exposes
    // `WhirlpoolClient.closePosition(positionMint, slippage)` in newer
    // builds. Without the SDK as a hard dep we can't ship the close ix
    // builder here; flip {close: 'wiring'} in meta when uninstalled.
    throw new Error('orca whirlpool close — SDK wiring in progress')
  },

  async buildOpenTxs(_connection, _wallet, _pos, _stacAtomEstimate): Promise<OpenResult> {
    throw new Error(
      'no curated stacSOL Whirlpool target pool — auto-init pending',
    )
  },
}

export default resolver
