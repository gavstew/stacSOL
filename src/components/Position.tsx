import { useEffect, useState } from 'react'
import { useWallet } from '@solana/wallet-adapter-react'
import { LAMPORTS_PER_SOL } from '@solana/web3.js'
import { Card } from './Stats'
import type { PoolState } from '../lib/pool'
import { fmtAmount } from '../lib/format'
import type { LpExposure } from '../hooks/useLpExposure'

const fmtSol = (lamports: bigint) =>
  (Number(lamports) / LAMPORTS_PER_SOL).toLocaleString(undefined, {
    maximumFractionDigits: 6,
    minimumFractionDigits: 6,
  })

const fmtSolNum = (n: number) =>
  n.toLocaleString(undefined, {
    maximumFractionDigits: 6,
    minimumFractionDigits: 6,
  })

function fmtAgo(ts: number | null): string {
  if (ts == null) return '—'
  const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000))
  if (sec < 2) return 'just now'
  if (sec < 60) return `${sec}s ago`
  return `${Math.floor(sec / 60)}m ago`
}

export function Position({
  pool,
  position,
  loading,
  error,
  lastBalanceTickAt,
  lpExposure,
}: {
  pool: PoolState | null
  position: import('../lib/position').Position | null
  loading: boolean
  error: string | null
  lastBalanceTickAt: number | null
  /** Hoisted from App.tsx so this card AND the burn Action card share one
   *  subscription instead of fanning out duplicate fetches. */
  lpExposure: LpExposure
}) {
  const { publicKey } = useWallet()

  // NAV (= protocol's WithdrawSol redemption rate). `null` until the pool
  // RPC fetch lands — we MUST NOT default this to 1.0 because that makes
  // every value/P&L cell render as if the user had lost 35% of their
  // stake for the ~1-3s while the pool data is still in flight. Heart-
  // attack UX. We render skeleton placeholders for value cells until
  // `pool != null`.
  const currentRate: number | null =
    pool && pool.poolTokenSupplyAccounting > 0n
      ? Number(pool.poolTotalLamports) / Number(pool.poolTokenSupplyAccounting)
      : null

  // Tick a clock so the "Xs ago" label re-renders even when nothing else changes.
  const [, setNow] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setNow((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [])

  if (!publicKey) return null

  if (loading && !position) {
    return (
      <Card title="Your position">
        <p className="m-0 text-[12px] text-[var(--color-dim)]">scanning chain history…</p>
      </Card>
    )
  }
  if (error) {
    return (
      <Card title="Your position">
        <p className="m-0 text-[12px] text-[var(--color-warn)]">error: {error}</p>
      </Card>
    )
  }

  const walletBalance = position?.balance ?? 0n
  const lpStacAtom = lpExposure.stacsolAtom
  const totalStacHolding = walletBalance + lpStacAtom

  if (totalStacHolding === 0n && lpExposure.totalValueInSol === 0) {
    return (
      <Card title="Your position">
        <p className="m-0 text-[12px] text-[var(--color-dim)]">
          no stacSOL in this wallet — mint below to take a position.
        </p>
      </Card>
    )
  }

  // Net SOL the user has actually paid in (mints) minus received (burns +
  // out-of-LP redemptions that happened to deposit SOL back). The on-chain
  // tx parser counts as a "mint" any tx where SOL went out and stacSOL came
  // in — which UNFORTUNATELY includes Jupiter zap-in swaps as part of the
  // /singlesided + /liquidity flows. We surface the count with a caveat
  // rather than try to perfectly classify each tx.
  const totalSolIn = position?.totalSolIn ?? 0n
  const totalSolOut = position?.totalSolOut ?? 0n
  const netSolPaidLamports =
    totalSolIn > totalSolOut ? totalSolIn - totalSolOut : 0n
  const netSolPaid = Number(netSolPaidLamports) / LAMPORTS_PER_SOL

  // Two close-value numbers — the headline P&L tracks the burn-net one
  // because that's the actual cash a user receives if they hit Burn right
  // now. Previously we showed mark-to-NAV (gross) which understated losses
  // by ~6.9% and led to "huh, I thought I'd get more SOL than this" when
  // the wallet popup quoted the real payout.
  //
  //   walletNavValue   = wallet stacSOL × NAV                     (gross)
  //   walletBurnValue  = wallet stacSOL × NAV × 0.931             (net of burn fee)
  //   totalCloseGross  = walletNavValue  + lpExposure.totalValueInSol
  //   totalCloseBurn   = walletBurnValue + lpExposure.totalValueInSol
  //
  // We DON'T discount LP-side value by 0.931 because LPs withdraw via
  // Meteora/Raydium (no stake-pool burn fee on the way out). The 6.9%
  // only applies to wallet stacSOL going through WithdrawSol.
  const navLoading = currentRate == null
  const BURN_PAYOUT = 0.931 // 1 - 6.9% withdrawal fee on the stake pool
  const walletSolValue =
    !navLoading
      ? (Number(walletBalance) / Math.pow(10, 9)) * currentRate!
      : null
  const walletBurnValueSol =
    walletSolValue != null ? walletSolValue * BURN_PAYOUT : null
  const totalCloseGrossSol =
    walletSolValue != null
      ? walletSolValue + lpExposure.totalValueInSol
      : null
  const totalCloseBurnSol =
    walletBurnValueSol != null
      ? walletBurnValueSol + lpExposure.totalValueInSol
      : null

  // PnL is now BURN-NET — the realizable number, matches what the wallet
  // popup will quote when the user clicks Burn. We surface the gross
  // (mark-to-NAV) value as a sub-line so the user sees both: "you have N
  // SOL of value at NAV, you'd realize M SOL on burn (M = N × 0.931)".
  const hasCostBasis = netSolPaidLamports > 0n
  const pnlSol =
    hasCostBasis && totalCloseBurnSol != null
      ? totalCloseBurnSol - netSolPaid
      : null
  const pnlPct =
    pnlSol != null && netSolPaid > 0 ? pnlSol / netSolPaid : null
  const profitable = pnlSol != null && pnlSol >= 0
  const pnlColor =
    pnlSol == null
      ? 'text-[var(--color-fg)]'
      : profitable
      ? 'text-[var(--color-green)]'
      : 'text-[var(--color-warn)]'
  const pnlPrefix = pnlSol == null ? '' : pnlSol >= 0 ? '+' : '−'
  const pnlAbs = pnlSol == null ? null : Math.abs(pnlSol)

  return (
    <Card title="Your position">
      <div className="grid grid-cols-2 gap-3 mb-3">
        <Cell label="stacSOL claim">
          <FlashOnChange value={totalStacHolding.toString()}>
            <strong className="text-2xl text-[var(--color-fg)]">{fmtAmount(totalStacHolding)}</strong>
          </FlashOnChange>
          <span className="text-xs text-[var(--color-dim)] ml-1">stacSOL</span>
          <div className="text-[11px] text-[var(--color-dim)] mt-1">
            wallet {fmtAmount(walletBalance)}
            {lpStacAtom > 0n
              ? ` · in LPs ${fmtAmount(lpStacAtom)}`
              : ''}
          </div>
        </Cell>
        <Cell label="Net SOL paid">
          <strong className="text-2xl text-[var(--color-fg)]">
            {fmtSolNum(netSolPaid)}
          </strong>
          <span className="text-xs text-[var(--color-dim)] ml-1">SOL</span>
          <div className="text-[11px] text-[var(--color-dim)] mt-1">
            in {fmtSol(totalSolIn)} · out {fmtSol(totalSolOut)}
            {position
              ? ` · ${position.mintCount + position.burnCount} on-site flows*`
              : ''}
          </div>
        </Cell>
        <Cell label="Burn payout (net)">
          {totalCloseBurnSol != null &&
          walletBurnValueSol != null &&
          totalCloseGrossSol != null &&
          walletSolValue != null ? (
            <>
              <FlashOnChange value={totalCloseBurnSol.toFixed(6)}>
                <strong className="text-2xl text-[var(--color-fg)]">
                  {fmtSolNum(totalCloseBurnSol)}
                </strong>
              </FlashOnChange>
              <span className="text-xs text-[var(--color-dim)] ml-1">SOL</span>
              <div className="text-[11px] text-[var(--color-dim)] mt-1">
                wallet burn{' '}
                <span className="text-[var(--color-fg)]">
                  {fmtSolNum(walletBurnValueSol)}
                </span>
                {lpExposure.totalValueInSol > 0
                  ? ` · LPs ${fmtSolNum(lpExposure.totalValueInSol)}`
                  : ''}
                <br />
                gross @ NAV {fmtSolNum(totalCloseGrossSol)} (before 6.9% burn fee)
              </div>
            </>
          ) : (
            <>
              <strong className="text-2xl text-[var(--color-dim)]">…</strong>
              <span className="text-xs text-[var(--color-dim)] ml-1">SOL</span>
              <div className="text-[11px] text-[var(--color-dim)] mt-1">
                waiting for NAV — don&apos;t panic
              </div>
            </>
          )}
        </Cell>
        <Cell label="P&amp;L on burn">
          {navLoading ? (
            <>
              <strong className="text-2xl text-[var(--color-dim)]">…</strong>
              <span className="text-xs text-[var(--color-dim)] ml-1">SOL</span>
              <div className="text-[11px] text-[var(--color-dim)] mt-1">
                computing — NAV loading
              </div>
            </>
          ) : (
            <>
              <FlashOnChange value={pnlSol == null ? '—' : pnlSol.toFixed(6)}>
                <strong className={`text-2xl ${pnlColor}`}>
                  {pnlSol == null ? '—' : `${pnlPrefix}${fmtSolNum(pnlAbs!)}`}
                </strong>
              </FlashOnChange>
              <span className="text-xs text-[var(--color-dim)] ml-1">SOL</span>
              <div className="text-[11px] text-[var(--color-dim)] mt-1">
                {pnlPct != null
                  ? `${(pnlPct * 100).toFixed(2)}% vs net SOL paid (after 6.9% burn fee)`
                  : hasCostBasis
                  ? 'computing…'
                  : 'no cost basis'}
              </div>
            </>
          )}
        </Cell>
      </div>

      {lpExposure.breakdown.length > 0 && (
        <div className="text-[11px] text-[var(--color-dim)] bg-[var(--color-bg)] rounded p-2 mb-3 space-y-1">
          <div className="text-[10px] uppercase tracking-wider text-[var(--color-dim)] mb-1">
            LP positions ({lpExposure.breakdown.length})
          </div>
          {lpExposure.breakdown.map((b, i) => (
            <div key={`${b.poolId}-${i}`} className="flex items-center justify-between gap-2">
              <span className="text-[var(--color-fg)] truncate">
                {b.source === 'meteora-dlmm' ? '◆' : '○'} {b.pairLabel}
              </span>
              <span className="font-mono text-[var(--color-dim)] shrink-0">
                {b.stacsolUi.toFixed(4)} stac + {b.otherUi.toLocaleString(undefined, { maximumFractionDigits: 4 })} {b.otherSymbol} ≈ {fmtSolNum(b.valueInSol)} SOL
              </span>
            </div>
          ))}
          <div className="pt-1.5 mt-1 border-t border-[rgb(255_34_0_/_0.12)] text-[10px] leading-relaxed">
            <span className="text-[var(--color-green)]">earning:</span> NAV
            climbs against every stacSOL above — wallet AND LP — so yield
            accrues on the full holding. The LP side just delays when you can
            redeem it via burn (withdraw the LP first).{' '}
            <span className="text-[var(--color-warn)]">IL risk:</span> the
            paired token in each LP moves on its own. If it dumps or goes to
            0, that position is fcukered regardless of how much the
            stacSOL/SOL rate climbed in the meantime.
          </div>
        </div>
      )}

      <p className="m-0 text-[10px] text-[var(--color-dim)] leading-relaxed">
        * "On-site flows" counts every wallet tx where SOL and stacSOL moved
        in opposite directions. This includes Jupiter zap-swaps from{' '}
        <code className="text-[var(--color-fg)]">/liquidity</code> and{' '}
        <code className="text-[var(--color-fg)]">/singlesided</code> alongside
        actual protocol mints/burns — they're indistinguishable from a wallet
        tx-history scan alone. The "Net SOL paid" + "Total close value" + P&amp;L
        are still correct since they're balance-difference based.
      </p>

      <p className="mt-3 text-[10px] text-[var(--color-dim)] flex items-center gap-2">
        <span className="inline-block w-1.5 h-1.5 rounded-full bg-[var(--color-hot)] animate-pulse" />
        live · balance polled every 10s · LPs every 30s · last tick {fmtAgo(lastBalanceTickAt)}
      </p>
    </Card>
  )
}

function Cell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="bg-[var(--color-bg)] rounded p-3">
      <div className="text-[11px] uppercase tracking-wider text-[var(--color-dim)]">{label}</div>
      {children}
    </div>
  )
}

/**
 * Wraps a child element with a brief flash animation whenever the rendered
 * `value` (a stable string key) changes. We re-mount via `key` so the
 * animation re-runs without manual state plumbing.
 */
function FlashOnChange({ value, children }: { value: string; children: React.ReactNode }) {
  return (
    <span key={value} className="inline-block animate-[flash_0.7s_ease-out]">
      {children}
    </span>
  )
}
