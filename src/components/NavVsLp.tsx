import { useMemo } from 'react'
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { Card } from './Stats'
import { useHistory } from '../hooks/useHistory'
import { useDeployTs } from '../hooks/useDeployTs'
import { useLpPrice } from '../hooks/useLpPrice'

interface Row {
  ts: number
  hours: number
  nav: number
  lp: number | null
}

export function NavVsLp() {
  const { history, error, loading } = useHistory()
  const deployTs = useDeployTs()
  const { price: liveLp, error: lpErr } = useLpPrice()

  const { rows, lpFirstSeenHours } = useMemo(() => {
    if (history.length === 0) return { rows: [] as Row[], lpFirstSeenHours: null }

    const rows: Row[] = history.map((s) => ({
      ts: s.ts,
      hours: (s.ts - deployTs) / 3600_000,
      nav: s.rate,
      lp: s.lpPriceSol,
    }))

    const firstWithLp = rows.find((r) => r.lp != null)
    return { rows, lpFirstSeenHours: firstWithLp ? firstWithLp.hours : null }
  }, [history, deployTs])

  const latest = rows.length ? rows[rows.length - 1] : null
  // Use the live Jupiter price if available; fall back to most recent snapshot.
  const currentLp =
    liveLp ??
    [...rows].reverse().find((r) => r.lp != null)?.lp ??
    null

  const currentNav = latest?.nav ?? null
  const divergencePct =
    currentNav != null && currentLp != null && currentLp > 0
      ? ((currentNav - currentLp) / currentNav) * 100
      : null

  return (
    <Card title="NAV vs LP price">
      <p className="m-0 mb-3 text-[12px] text-[var(--color-dim)] leading-relaxed">
        The <span className="text-[var(--color-green)] font-black">green line</span>{' '}
        is NAV — what stacSOL redeems for on the official site. It only
        goes up, faster the more the family trades.{' '}
        The <span className="text-[var(--color-hot)] font-black">red line</span>{' '}
        is the thin Jupiter LP — secondary noise, not the protocol. Mint
        and burn on site stays on the green line.
      </p>

      {error && (
        <p className="m-0 mb-2 text-[11px] text-[var(--color-warn)]">
          history fetch error: {error}
        </p>
      )}

      {!error && rows.length === 0 && !loading && (
        <p className="m-0 text-[11px] text-[var(--color-dim)]">
          waiting for first snapshot…
        </p>
      )}

      {rows.length > 0 && (
        <>
          <div className="grid grid-cols-3 gap-2 mb-3">
            <Mini
              label="NAV (redemption)"
              value={currentNav != null ? currentNav.toFixed(6) : '—'}
              unit="SOL"
              tone="green"
            />
            <Mini
              label="LP (Jupiter)"
              value={
                currentLp != null
                  ? currentLp.toFixed(6)
                  : lpErr
                  ? 'no route'
                  : '…'
              }
              unit="SOL"
              tone="hot"
            />
            <Mini
              label="Divergence"
              value={
                divergencePct != null
                  ? `${divergencePct >= 0 ? '−' : '+'}${Math.abs(
                      divergencePct,
                    ).toFixed(1)}%`
                  : '—'
              }
              unit="LP vs NAV"
              tone="dim"
            />
          </div>

          <ResponsiveContainer width="100%" height={260}>
            <LineChart
              data={rows}
              margin={{ top: 8, right: 12, bottom: 4, left: 0 }}
            >
              <CartesianGrid stroke="rgb(255 51 0 / 0.08)" vertical={false} />
              <XAxis
                dataKey="hours"
                type="number"
                domain={['dataMin', 'dataMax']}
                tickFormatter={(v: number) =>
                  v >= 24 ? `${(v / 24).toFixed(1)}d` : `${v.toFixed(0)}h`
                }
                stroke="#884422"
                tick={{ fontSize: 10, fill: '#884422' }}
                minTickGap={40}
              />
              <YAxis
                stroke="#884422"
                tick={{ fontSize: 10, fill: '#884422' }}
                tickFormatter={(v: number) => v.toFixed(3)}
                width={70}
                domain={['auto', 'auto']}
              />
              <Tooltip
                contentStyle={{
                  background: '#1a0606',
                  border: '1px solid rgb(255 51 0 / 0.4)',
                  borderRadius: 4,
                  fontSize: 11,
                  color: '#ffaa66',
                }}
                labelFormatter={(v) =>
                  `${Number(v).toFixed(2)}h since deploy`
                }
                formatter={(v) =>
                  v == null ? ['—', ''] : [Number(v).toFixed(6) + ' SOL', '']
                }
              />
              <Legend
                wrapperStyle={{ fontSize: 11, color: '#ffaa66' }}
                iconType="plainline"
              />
              <ReferenceLine
                y={1}
                stroke="rgb(255 204 0 / 0.4)"
                strokeDasharray="3 3"
                label={{
                  value: 'deploy (1.0)',
                  position: 'insideBottomLeft',
                  fill: '#ffcc00',
                  fontSize: 10,
                }}
              />
              {currentLp != null && (
                <ReferenceLine
                  y={currentLp}
                  stroke="rgb(255 51 0 / 0.35)"
                  strokeDasharray="2 4"
                  label={{
                    value: `live LP ${currentLp.toFixed(4)}`,
                    position: 'insideTopRight',
                    fill: '#ff7733',
                    fontSize: 10,
                  }}
                />
              )}
              <Line
                type="monotone"
                dataKey="nav"
                stroke="#22ee88"
                strokeWidth={2.5}
                dot={false}
                isAnimationActive={false}
                name="NAV (redemption)"
              />
              <Line
                type="monotone"
                dataKey="lp"
                stroke="#ff3300"
                strokeWidth={2}
                dot={false}
                connectNulls
                isAnimationActive={false}
                name="LP price (Jupiter)"
              />
            </LineChart>
          </ResponsiveContainer>

          <p className="mt-3 text-[10px] text-[var(--color-dim)] uppercase tracking-wider">
            {lpFirstSeenHours != null
              ? `LP curve from ${lpFirstSeenHours.toFixed(1)}h. Live LP refreshes every 30s.`
              : 'LP history starts on next snapshot. Live LP shown as reference line.'}
          </p>
        </>
      )}
    </Card>
  )
}

function Mini({
  label,
  value,
  unit,
  tone,
}: {
  label: string
  value: string
  unit?: string
  tone: 'hot' | 'green' | 'dim'
}) {
  const color =
    tone === 'hot'
      ? 'var(--color-hot)'
      : tone === 'green'
      ? 'var(--color-green)'
      : 'var(--color-fg)'
  return (
    <div className="bg-[var(--color-bg)] rounded p-3 border border-[rgb(255_34_0_/_0.1)]">
      <div className="text-[10px] uppercase tracking-wider text-[var(--color-dim)]">
        {label}
      </div>
      <div className="mt-0.5 leading-tight">
        <span
          className="tabular-mono text-base font-black"
          style={{ color }}
        >
          {value}
        </span>
        {unit && (
          <span className="text-[10px] text-[var(--color-dim)] ml-1 uppercase tracking-wider">
            {unit}
          </span>
        )}
      </div>
    </div>
  )
}
