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

const YEAR_SECONDS = 365.25 * 24 * 3600
const MIN_ELAPSED_SEC = 60 * 30 // skip the first 30min — APR math is too noisy

// "If NAV had stopped right here, implied APR would decay like 1/t." We pick
// that anchor as the *first* snapshot that's reasonably past the launch-day
// bump, and use its rate as the freeze baseline.

interface Row {
  ts: number
  hours: number
  actualPct: number
  expectedPct: number | null
}

export function AprDecay() {
  const { history, error, loading } = useHistory()
  const deployTs = useDeployTs()

  const { rows, freezeRate, freezeHours, latest } = useMemo(() => {
    if (history.length === 0) {
      return { rows: [] as Row[], freezeRate: null, freezeHours: null, latest: null }
    }

    // Build one row per snapshot.
    const all = history
      .map((s) => {
        const elapsedSec = (s.ts - deployTs) / 1000
        if (elapsedSec < MIN_ELAPSED_SEC) return null
        const hours = elapsedSec / 3600
        const ratio = s.rate
        const actual = (ratio - 1) * (YEAR_SECONDS / elapsedSec)
        return { ts: s.ts, hours, rate: ratio, actualPct: actual * 100 }
      })
      .filter((x): x is { ts: number; hours: number; rate: number; actualPct: number } => x != null)

    if (all.length === 0) {
      return { rows: [] as Row[], freezeRate: null, freezeHours: null, latest: null }
    }

    // Anchor: rate observed at the earliest qualifying snapshot. This is "what
    // the rate was when we started measuring" — the frozen-NAV decay assumes
    // it would have stopped there.
    const anchor = all[0]
    const fr = anchor.rate
    const fh = anchor.hours

    const rows: Row[] = all.map((s) => {
      const elapsedSec = s.hours * 3600
      const expected = (fr - 1) * (YEAR_SECONDS / elapsedSec) * 100
      return {
        ts: s.ts,
        hours: s.hours,
        actualPct: s.actualPct,
        expectedPct: expected,
      }
    })

    const last = rows[rows.length - 1]

    return {
      rows,
      freezeRate: fr,
      freezeHours: fh,
      latest: last,
    }
  }, [history, deployTs])

  const premium =
    latest && latest.expectedPct != null
      ? latest.actualPct - latest.expectedPct
      : null

  return (
    <Card title="APR decay vs reality">
      <p className="m-0 mb-3 text-[12px] text-[var(--color-dim)] leading-relaxed">
        If NAV had frozen at deploy, implied APR would decay as{' '}
        <span className="text-[var(--color-fg)]">(rate−1) × 365 / days</span>.
        That&apos;s the dashed line. The solid line is what implied APR
        actually did. The gap is{' '}
        <span className="text-[var(--color-green)] font-black">
          sustained yield
        </span>{' '}
        — NAV kept growing instead of stopping.
      </p>

      {error && (
        <p className="m-0 mb-2 text-[11px] text-[var(--color-warn)]">
          history fetch error: {error}
        </p>
      )}

      {!error && rows.length === 0 && !loading && (
        <p className="m-0 text-[11px] text-[var(--color-dim)]">
          waiting for first snapshot past the noise window…
        </p>
      )}

      {rows.length > 0 && (
        <>
          <div className="grid grid-cols-3 gap-2 mb-3">
            <Mini
              label="Actual now"
              value={fmtPct(latest!.actualPct)}
              tone="hot"
            />
            <Mini
              label="Expected (frozen)"
              value={
                latest!.expectedPct != null
                  ? fmtPct(latest!.expectedPct)
                  : '—'
              }
              tone="dim"
            />
            <Mini
              label="Yield premium"
              value={premium != null ? fmtPct(premium) : '—'}
              tone="green"
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
                tickFormatter={(v: number) => fmtPct(v)}
                width={70}
                scale="log"
                domain={[
                  (dataMin: number) => Math.max(1, dataMin * 0.5),
                  (dataMax: number) => dataMax * 1.5,
                ]}
                allowDataOverflow
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
                  `${(Number(v)).toFixed(2)}h since deploy`
                }
                formatter={(v, name) => [fmtPct(Number(v)), name]}
              />
              <Legend
                wrapperStyle={{ fontSize: 11, color: '#ffaa66' }}
                iconType="plainline"
              />
              {freezeHours != null && (
                <ReferenceLine
                  x={freezeHours}
                  stroke="rgb(34 238 136 / 0.4)"
                  strokeDasharray="3 3"
                  label={{
                    value: 'anchor',
                    position: 'insideTopLeft',
                    fill: '#22ee88',
                    fontSize: 10,
                  }}
                />
              )}
              <Line
                type="monotone"
                dataKey="expectedPct"
                stroke="#884422"
                strokeWidth={1.5}
                strokeDasharray="6 4"
                dot={false}
                isAnimationActive={false}
                name="Expected (NAV frozen)"
              />
              <Line
                type="monotone"
                dataKey="actualPct"
                stroke="#ff3300"
                strokeWidth={2.5}
                dot={false}
                isAnimationActive={false}
                name="Actual"
              />
            </LineChart>
          </ResponsiveContainer>

          {freezeRate != null && (
            <p className="mt-3 text-[10px] text-[var(--color-dim)] uppercase tracking-wider">
              anchor: rate {freezeRate.toFixed(6)} at{' '}
              {freezeHours!.toFixed(1)}h · {history.length} snapshots · log y-axis
            </p>
          )}
        </>
      )}
    </Card>
  )
}

function Mini({
  label,
  value,
  tone,
}: {
  label: string
  value: string
  tone: 'hot' | 'green' | 'dim'
}) {
  const color =
    tone === 'hot'
      ? 'var(--color-hot)'
      : tone === 'green'
      ? 'var(--color-green)'
      : 'var(--color-dim)'
  return (
    <div className="bg-[var(--color-bg)] rounded p-3 border border-[rgb(255_34_0_/_0.1)]">
      <div className="text-[10px] uppercase tracking-wider text-[var(--color-dim)]">
        {label}
      </div>
      <div
        className="tabular-mono text-base font-black mt-0.5"
        style={{ color }}
      >
        {value}
      </div>
    </div>
  )
}

function fmtPct(n: number) {
  if (!isFinite(n)) return '—'
  if (Math.abs(n) >= 1000) return `${(n / 1000).toFixed(1)}k%`
  if (Math.abs(n) >= 100) return `${n.toFixed(0)}%`
  return `${n.toFixed(2)}%`
}
