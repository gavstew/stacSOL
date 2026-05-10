import { useEffect, useState } from 'react'
import { useConnection, useWallet } from '@solana/wallet-adapter-react'
import { PublicKey } from '@solana/web3.js'
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token'
import { MINT } from '../lib/constants'
import { METEORA_POOLS, type MeteoraPool } from '../lib/meteora-pools'

const STACSOL = MINT.toBase58()
const WSOL = 'So11111111111111111111111111111111111111112'

interface LpBreakdownItem {
  source: 'raydium-cpmm' | 'meteora-dlmm'
  poolId: string
  pairLabel: string
  /** Approximate SOL-equivalent value of the user's claim on this position. */
  valueInSol: number
  /** stacSOL claim from this position (atomic). */
  stacsolAtom: bigint
  stacsolUi: number
  /** Other-side amount + symbol. */
  otherSymbol: string
  otherUi: number
  otherDecimals: number
}

export interface LpExposure {
  /** Total stacSOL claimable (sum across Raydium + DLMM). */
  stacsolAtom: bigint
  stacsolUi: number
  /** Total SOL-equivalent value of all positions (both sides combined). */
  totalValueInSol: number
  breakdown: LpBreakdownItem[]
  loading: boolean
  error: string | null
}

interface ApiPool {
  id: string
  mintA: { address: string; symbol: string; decimals: number }
  mintB: { address: string; symbol: string; decimals: number }
  mintAmountA: number
  mintAmountB: number
  lpAmount: number
  lpMint: { address: string; decimals: number; programId: string }
  // Some Raydium pools include lpPrice (USD per LP) and tvl (USD).
  // We use lpAmount fraction × tvl for total value, then convert USD→SOL.
  tvl?: number
}

/**
 * Read all stacSOL LP positions across both Raydium CPMM and Meteora DLMM,
 * then compute:
 *   - total stacSOL claim (the side denominated in stacSOL)
 *   - total SOL-equivalent value of every position (BOTH sides combined)
 *
 * The second number is the one that actually answers "how much SOL would I
 * have if I closed everything right now"; the existing position tracker only
 * read the stacSOL leg which made post-LP P&L look catastrophic.
 *
 * Pricing strategy:
 *   - stacSOL → SOL: use NAV (≈1.4 SOL per stacSOL)
 *   - WSOL → SOL: 1:1
 *   - Other tokens → SOL: lookup via Jupiter quote (server-proxied)
 */
export function useLpExposure(navSolPerStacsol = 1.0, refreshMs = 30_000): LpExposure {
  const { connection } = useConnection()
  const { publicKey } = useWallet()
  const [stacsolAtom, setStacsolAtom] = useState<bigint>(0n)
  const [totalValueInSol, setTotalValueInSol] = useState(0)
  const [breakdown, setBreakdown] = useState<LpBreakdownItem[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!publicKey) {
      setStacsolAtom(0n)
      setBreakdown([])
      setTotalValueInSol(0)
      return
    }
    let cancelled = false

    const run = async () => {
      try {
        setLoading(true)
        const items: LpBreakdownItem[] = []
        let totalStac = 0n
        let totalSol = 0

        // Cache other-token SOL prices for the duration of this fetch.
        const priceInSol = new Map<string, number>()
        priceInSol.set(WSOL, 1)
        priceInSol.set(STACSOL, navSolPerStacsol)

        const ensurePrice = async (mint: string): Promise<number> => {
          if (priceInSol.has(mint)) return priceInSol.get(mint)!
          try {
            // Jupiter quote: 1 unit of `mint` (in its smallest fractional terms) → SOL.
            // We instead query 1 SOL → mint and invert to avoid having to know
            // the token's decimals here.
            const qs = new URLSearchParams({
              inputMint: WSOL,
              outputMint: mint,
              amount: String(1_000_000_000), // 1 SOL in lamports
              slippageBps: '100',
              swapMode: 'ExactIn',
            })
            const r = await fetch(`/api/jup-quote?${qs.toString()}`)
            if (!r.ok) throw new Error(`jup ${r.status}`)
            const j = await r.json()
            const out = Number(j.outAmount)
            if (out > 0) {
              // outAmount is in `mint`'s atomic units, for 1 SOL input.
              // We want SOL per UI unit of `mint`. Need decimals.
              // Look up decimals from the swap response (j.swapInfo? — fallback
              // to checking the mint account). For simplicity here, query the
              // mint to get decimals.
              const acc = await connection.getAccountInfo(new PublicKey(mint))
              const decimals = acc ? acc.data[44] : 9 // mint layout: decimals at byte 44
              const outUi = out / Math.pow(10, decimals)
              const solPerUi = outUi > 0 ? 1 / outUi : 0
              priceInSol.set(mint, solPerUi)
              return solPerUi
            }
          } catch {
            // fall through, mark as 0
          }
          priceInSol.set(mint, 0)
          return 0
        }

        // ============== Raydium CPMM ==============
        try {
          const r = await fetch('/api/liquidity-pools')
          if (r.ok) {
            const j = (await r.json()) as { pools: ApiPool[] }
            for (const p of j.pools ?? []) {
              if (
                p.mintA.address !== STACSOL &&
                p.mintB.address !== STACSOL
              ) {
                continue
              }
              let myLpAtom = 0n
              try {
                const ata = getAssociatedTokenAddressSync(
                  new PublicKey(p.lpMint.address),
                  publicKey,
                  false,
                  new PublicKey(p.lpMint.programId),
                  ASSOCIATED_TOKEN_PROGRAM_ID,
                )
                const acc = await connection.getAccountInfo(ata)
                if (acc) myLpAtom = acc.data.readBigUInt64LE(64)
              } catch {
                myLpAtom = 0n
              }
              if (myLpAtom === 0n) continue

              const myLpUi = Number(myLpAtom) / Math.pow(10, p.lpMint.decimals)
              const fraction = p.lpAmount > 0 ? myLpUi / p.lpAmount : 0
              if (fraction === 0) continue

              const isStacA = p.mintA.address === STACSOL
              const stacReserveUi = isStacA ? p.mintAmountA : p.mintAmountB
              const stacDecimals = isStacA ? p.mintA.decimals : p.mintB.decimals
              const otherReserveUi = isStacA ? p.mintAmountB : p.mintAmountA
              const otherDecimals = isStacA ? p.mintB.decimals : p.mintA.decimals
              const otherSymbol = isStacA ? p.mintB.symbol : p.mintA.symbol
              const otherMint = isStacA ? p.mintB.address : p.mintA.address

              const stacsolUi = stacReserveUi * fraction
              const stacAtom = BigInt(
                Math.floor(stacsolUi * Math.pow(10, stacDecimals)),
              )
              const otherUi = otherReserveUi * fraction

              const otherSolPrice = await ensurePrice(otherMint)
              const valueInSol =
                stacsolUi * navSolPerStacsol + otherUi * otherSolPrice

              totalStac += stacAtom
              totalSol += valueInSol

              items.push({
                source: 'raydium-cpmm',
                poolId: p.id,
                pairLabel: `${p.mintA.symbol}/${p.mintB.symbol}`,
                valueInSol,
                stacsolAtom: stacAtom,
                stacsolUi,
                otherSymbol,
                otherUi,
                otherDecimals,
              })
            }
          }
        } catch {
          // continue — raydium fetch is best-effort
        }

        // ============== Meteora DLMM ==============
        try {
          const DLMMmod = await import('@meteora-ag/dlmm')
          const DLMM = DLMMmod.default
          // Include both direct and HawkFi-managed positions in exposure.
          const { deriveUserPda } = await import('../lib/hawkfi-flows')
          const [userPda] = deriveUserPda(publicKey)
          for (const mp of METEORA_POOLS as MeteoraPool[]) {
            try {
              const dlmm = await DLMM.create(connection, new PublicKey(mp.poolAddress))
              type DlmmFetchResult = Awaited<
                ReturnType<typeof dlmm.getPositionsByUserAndLbPair>
              >
              const [direct, hawk] = (await Promise.all([
                dlmm.getPositionsByUserAndLbPair(publicKey).catch(() => null),
                dlmm.getPositionsByUserAndLbPair(userPda).catch(() => null),
              ])) as [DlmmFetchResult | null, DlmmFetchResult | null]
              if (cancelled) return
              const seen = new Set<string>()
              const allPositions: DlmmFetchResult['userPositions'] = []
              for (const src of [direct, hawk]) {
                if (!src) continue
                for (const p of src.userPositions) {
                  const k = p.publicKey.toBase58()
                  if (seen.has(k)) continue
                  seen.add(k)
                  allPositions.push(p)
                }
              }
              for (const pos of allPositions) {
                const lb = pos.positionData
                const xAtom = BigInt(lb.totalXAmount.toString())
                const yAtom = BigInt(lb.totalYAmount.toString())
                if (xAtom === 0n && yAtom === 0n) continue

                const isStacX = mp.tokenX === STACSOL
                const stacAtom = isStacX ? xAtom : yAtom
                const otherAtom = isStacX ? yAtom : xAtom
                const stacDecimals = isStacX
                  ? 9 /* stacSOL */
                  : mp.decimals
                const otherDecimals = isStacX ? mp.decimals : 9
                const stacsolUi =
                  Number(stacAtom) / Math.pow(10, stacDecimals)
                const otherUi =
                  Number(otherAtom) / Math.pow(10, otherDecimals)

                const otherMint = isStacX ? mp.tokenY : mp.tokenX
                const otherSolPrice = await ensurePrice(otherMint)
                const valueInSol =
                  stacsolUi * navSolPerStacsol + otherUi * otherSolPrice

                totalStac += stacAtom
                totalSol += valueInSol

                items.push({
                  source: 'meteora-dlmm',
                  poolId: mp.poolAddress,
                  pairLabel: `stacSOL/${mp.name}`,
                  valueInSol,
                  stacsolAtom: stacAtom,
                  stacsolUi,
                  otherSymbol: mp.name,
                  otherUi,
                  otherDecimals,
                })
              }
            } catch {
              // skip pool on RPC blip
            }
            if (cancelled) return
          }
        } catch {
          // DLMM SDK failed to import — skip dlmm exposure
        }

        if (!cancelled) {
          setStacsolAtom(totalStac)
          setBreakdown(items)
          setTotalValueInSol(totalSol)
          setError(null)
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    // Defer the initial fetch by ~1.5s to spread out the on-connect RPC
    // burst. On Phantom's mobile in-app browser, firing all of WalletCard
    // + Action + usePool + usePosition + this hook simultaneously can
    // crash the webview (tight memory budget + parallel TLS handshakes
    // to a non-Phantom RPC). Desktop users won't notice the lag; mobile
    // users get a much more stable connect experience.
    const startTimer = setTimeout(run, 1500)
    const id = setInterval(run, refreshMs)
    return () => {
      cancelled = true
      clearTimeout(startTimer)
      clearInterval(id)
    }
  }, [publicKey, connection, refreshMs, navSolPerStacsol])

  return {
    stacsolAtom,
    stacsolUi: Number(stacsolAtom) / 1e9,
    totalValueInSol,
    breakdown,
    loading,
    error,
  }
}
