import { fmtAmount, shortPk } from '../lib/format'
import type { PoolState } from '../lib/pool'
import { POOL } from '../lib/constants'
import { computeApr, fmtElapsed } from '../lib/apr'
import { useDeployTs } from '../hooks/useDeployTs'

export function Stats({ pool }: { pool: PoolState | null }) {
  const deployTs = useDeployTs()

  // Authoritative rate is what the SPL stake pool program uses for redemption.
  // pool.total_lamports / pool.pool_token_supply. While pool is null (RPC
  // hasn't responded yet) we render "—" instead of "1.000000" — the latter
  // gives the user a brief panic that NAV crashed back to par.
  const reserves = pool ? fmtAmount(pool.poolTotalLamports) : '—'
  const supply = pool ? fmtAmount(pool.poolTokenSupplyAccounting) : '—'
  const rateLoaded = !!pool && pool.poolTokenSupplyAccounting > 0n
  const rateNum = rateLoaded
    ? Number(pool!.poolTotalLamports) / Number(pool!.poolTokenSupplyAccounting)
    : 1
  const rateStr = rateLoaded ? rateNum.toFixed(6) : '—'

  // Live mint.supply may diverge between UpdateStakePoolBalance calls due to
  // out-of-band burns; surface this so users can see whether a sync is pending.
  const mintLive = pool ? Number(pool.mintSupply) / 1e9 : null
  const accountingLive = pool ? Number(pool.poolTokenSupplyAccounting) / 1e9 : null
  const drift = mintLive != null && accountingLive != null ? accountingLive - mintLive : null
  const driftStr =
    drift != null && Math.abs(drift) > 1e-6
      ? `pending sync — Token-2022 mint.supply is ${mintLive!.toFixed(6)}, drift ${drift > 0 ? '+' : ''}${drift.toFixed(6)} stacSOL`
      : null

  const { apr, baselineRate, elapsedSec } = rateLoaded
    ? computeApr(rateNum, deployTs)
    : { apr: null, baselineRate: 0, elapsedSec: 0 }
  const aprDisplay = !rateLoaded
    ? '—'
    : apr !== null
    ? `${(apr * 100).toFixed(2)}%`
    : '…'
  const aprDetail = !rateLoaded
    ? 'waiting for pool state'
    : apr !== null
    ? `since deploy: ${baselineRate.toFixed(2)} → ${rateStr} over ${fmtElapsed(elapsedSec)}`
    : 'gathering data — need ≥10s elapsed since deploy'

  return (
    <Card title="Pool">
      <div className="grid grid-cols-2 gap-3">
        <Stat
          label="Backing"
          value={reserves}
          unit="SOL"
          sub="pool.total_lamports (program accounting)"
        />
        <Stat
          label="Supply"
          value={supply}
          unit="stacSOL"
          sub="pool.pool_token_supply"
        />
        <Stat
          label="Redemption rate (NAV)"
          value={rateStr}
          unit="SOL / stacSOL"
          sub="what WithdrawSol actually pays out"
        />
        <Stat label="Implied APR" value={aprDisplay} sub={aprDetail} />
      </div>
      {driftStr && (
        <p className="mt-3 text-[11px] text-[var(--color-warn)]">⏳ {driftStr}</p>
      )}
      <p className="mt-3 text-[11px] text-[var(--color-dim)]">
        Pool {shortPk(POOL.toBase58())} · last update epoch{' '}
        {pool ? pool.lastUpdateEpoch.toString() : '—'} · refreshes every 10s
      </p>
    </Card>
  )
}

export function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="card-hot bg-[var(--color-bg2)] border border-[rgb(255_34_0_/_0.22)] rounded-md p-5 mb-5">
      <h2 className="m-0 mb-4 text-base font-black uppercase tracking-[4px] text-[var(--color-hot)] [text-shadow:0_0_10px_rgba(255,34,0,0.5),0_0_2px_rgba(255,34,0,0.9)]">
        {title}
      </h2>
      {children}
    </section>
  )
}

function Stat({
  label,
  value,
  unit,
  sub,
}: {
  label: string
  value: string
  unit?: string
  sub?: string
}) {
  return (
    <div className="bg-[var(--color-bg)] rounded-md p-4 border border-[rgb(255_34_0_/_0.1)]">
      <div className="text-[10px] font-bold uppercase tracking-[2px] text-[var(--color-dim)]">{label}</div>
      <div className="mt-1.5 leading-none">
        <span className="tabular-mono text-3xl font-extrabold text-[var(--color-fg)]">{value}</span>
        {unit && <span className="text-[11px] text-[var(--color-dim)] ml-1.5 uppercase tracking-wider">{unit}</span>}
      </div>
      {sub && <div className="text-[11px] text-[var(--color-dim)] mt-2 leading-tight">{sub}</div>}
    </div>
  )
}
