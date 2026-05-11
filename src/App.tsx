import { useCallback, useState } from 'react'
import { Stats, Card } from './components/Stats'
import { YieldCalc } from './components/YieldCalc'
import { Action } from './components/Action'
import { Referral } from './components/Referral'
import { Leaderboard } from './components/Leaderboard'
import { Manifesto } from './components/Manifesto'
import { Position } from './components/Position'
import { HowItWorks } from './components/HowItWorks'
import { TweetButton } from './components/TweetButton'
import { HistoryCharts } from './components/HistoryCharts'
import { AprDecay } from './components/AprDecay'
import { NavVsLp } from './components/NavVsLp'
import { Markets } from './components/Markets'
import { WalletCard } from './components/WalletCard'
import { usePool } from './hooks/usePool'
import { usePosition } from './hooks/usePosition'
import { useLpExposure } from './hooks/useLpExposure'
import { useMyHolderRow } from './hooks/useMyHolderRow'

export default function App() {
  const { pool, error, refresh } = usePool()
  const [log, setLog] = useState<string[]>([])
  const [posTick, setPosTick] = useState(0)
  const { position, loading: posLoading, error: posError, lastBalanceTickAt } = usePosition(posTick)
  // Hoisted: same hook used by Position card for the breakdown AND by the
  // Burn action card so it can show "wallet X · in LPs Y" instead of just
  // the raw wallet ATA balance. Without this, users who LP'd their stacSOL
  // see their burn-card balance drop and panic. One subscription, two
  // consumers.
  const currentRate =
    pool && pool.poolTokenSupplyAccounting > 0n
      ? Number(pool.poolTotalLamports) / Number(pool.poolTokenSupplyAccounting)
      : 1
  const lpExposure = useLpExposure(currentRate)
  // Authoritative cost basis from the indexer — same source as the
  // holders leaderboard, so the Position card's P&L now matches the
  // leaderboard P&L exactly. Falls through to fetchPosition()'s ATA-walk
  // numbers only if the indexer hasn't seen this wallet yet.
  const { row: holderRow } = useMyHolderRow()

  const append = useCallback((msg: string) => {
    const ts = new Date().toLocaleTimeString()
    setLog((l) => [`[${ts}] ${msg}`, ...l].slice(0, 50))
  }, [])

  const onAction = useCallback(() => {
    refresh()
    setPosTick((t) => t + 1)
  }, [refresh])

  return (
    <div className="max-w-[720px] mx-auto px-4 py-6">
      {/* Hero — compact so action cards fit above the fold */}
      <h1 className="m-0 mb-2 text-6xl font-black tracking-[-0.05em] text-[var(--color-hot)] [text-shadow:0_0_18px_rgba(255,34,0,0.7),0_0_48px_rgba(255,34,0,0.35),0_0_2px_rgba(255,34,0,1)] [animation:flicker_5s_ease-in-out_infinite]">
        stacSOL
      </h1>
      <div className="mb-6 flex items-center gap-3">
        <span className="inline-block w-6 h-[2px] bg-[var(--color-hot)]" />
        <p className="m-0 text-[var(--color-ember)] uppercase tracking-[6px] text-xs font-black">
          everything&nbsp;burns. eventually.
        </p>
        <span className="inline-block w-6 h-[2px] bg-[var(--color-hot)]" />
      </div>

      {/* Quick-jump nav: the three things that actually matter (mint, burn,
          your position) come FIRST, oversized + filled, so a returning user
          can hit the action they want in one tap regardless of scroll
          position. The route chips below stay smaller — secondary surfaces. */}
      <div className="mb-3 grid grid-cols-3 gap-2">
        <a
          href="#mint"
          className="flex items-center justify-center gap-1.5 px-3 py-3 rounded border-2 border-[var(--color-hot)] bg-[var(--color-hot)] text-black text-[11px] font-black uppercase tracking-[2px] no-underline hover:brightness-110 transition"
        >
          ↓ mint
        </a>
        <a
          href="#burn"
          className="flex items-center justify-center gap-1.5 px-3 py-3 rounded border-2 border-[var(--color-warn)] bg-[var(--color-warn)] text-black text-[11px] font-black uppercase tracking-[2px] no-underline hover:brightness-110 transition"
        >
          ↓ burn
        </a>
        <a
          href="#position"
          className="flex items-center justify-center gap-1.5 px-3 py-3 rounded border-2 border-[var(--color-ember)] bg-[var(--color-ember)] text-black text-[11px] font-black uppercase tracking-[2px] no-underline hover:brightness-110 transition"
        >
          ↓ position
        </a>
      </div>

      <div className="mb-6 flex flex-wrap gap-2">
        <a
          href="/guide"
          className="inline-flex items-center gap-2 px-3 py-2 rounded border border-[rgb(255_34_0_/_0.4)] bg-[rgb(255_34_0_/_0.06)] text-[10px] font-black uppercase tracking-[3px] text-[var(--color-hot)] no-underline hover:bg-[rgb(255_34_0_/_0.12)] transition"
        >
          <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-hot)]" />
          guide: SOL of the thystaccfloweth →
        </a>
        <a
          href="/liquidity"
          className="inline-flex items-center gap-2 px-3 py-2 rounded border border-[rgb(255_204_0_/_0.4)] bg-[rgb(255_204_0_/_0.06)] text-[10px] font-black uppercase tracking-[3px] text-[var(--color-warn)] no-underline hover:bg-[rgb(255_204_0_/_0.12)] transition"
        >
          <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-warn)]" />
          liquidity: add / remove (IL risk) →
        </a>
        <a
          href="/singlesided"
          className="inline-flex items-center gap-2 px-3 py-2 rounded border border-[rgb(255_34_0_/_0.4)] bg-[rgb(255_34_0_/_0.06)] text-[10px] font-black uppercase tracking-[3px] text-[var(--color-hot)] no-underline hover:bg-[rgb(255_34_0_/_0.12)] transition"
        >
          <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-hot)]" />
          single-sided: directional bet →
        </a>
        <a
          href="/portfolio"
          className="inline-flex items-center gap-2 px-3 py-2 rounded border border-[rgb(255_119_51_/_0.4)] bg-[rgb(255_119_51_/_0.06)] text-[10px] font-black uppercase tracking-[3px] text-[var(--color-ember)] no-underline hover:bg-[rgb(255_119_51_/_0.12)] transition"
        >
          <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-ember)]" />
          portfolio: positions + fees →
        </a>
        <a
          href="/liqmonsta"
          className="inline-flex items-center gap-2 px-3 py-2 rounded border border-[var(--color-hot)] bg-[rgb(255_34_0_/_0.12)] text-[10px] font-black uppercase tracking-[3px] text-[var(--color-hot)] no-underline hover:bg-[rgb(255_34_0_/_0.2)] transition"
          style={{ boxShadow: '0 0 16px rgba(255,34,0,0.25)' }}
        >
          <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-hot)] [box-shadow:0_0_6px_var(--color-hot)]" />
          liqmonsta: smash your LPs →
        </a>
        <a
          href="/leaderboard"
          className="inline-flex items-center gap-2 px-3 py-2 rounded border border-[rgb(255_204_0_/_0.4)] bg-[rgb(255_204_0_/_0.06)] text-[10px] font-black uppercase tracking-[3px] text-[var(--color-warn)] no-underline hover:bg-[rgb(255_204_0_/_0.12)] transition"
        >
          <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-warn)]" />
          leaderboard: holders P&amp;L →
        </a>
        <a
          href="/faq"
          className="inline-flex items-center gap-2 px-3 py-2 rounded border border-[rgb(34_238_136_/_0.4)] bg-[rgb(34_238_136_/_0.06)] text-[10px] font-black uppercase tracking-[3px] text-[var(--color-green)] no-underline hover:bg-[rgb(34_238_136_/_0.12)] transition"
        >
          <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-green)]" />
          faq: bankrun math + safety →
        </a>
      </div>

      {/* MINT → BURN → POSITION — grouped together so the three things a
          user actually does on this page are the first three cards after
          stats + wallet. Yield calc, referral, leaderboard, charts all
          moved below this triplet. */}
      <Stats pool={pool} />

      <WalletCard />

      <section id="mint" className="scroll-mt-4">
        <Action mode="mint" pool={pool} onDone={onAction} appendLog={append} />
      </section>

      <section id="burn" className="scroll-mt-4">
        <Action
          mode="burn"
          pool={pool}
          position={position}
          onDone={onAction}
          appendLog={append}
          lpStacAtom={lpExposure.stacsolAtom}
        />
      </section>

      <section id="position" className="scroll-mt-4">
        <Position
          pool={pool}
          position={position}
          loading={posLoading}
          error={posError}
          lastBalanceTickAt={lastBalanceTickAt}
          lpExposure={lpExposure}
          // Without holderRow, Position falls through to the on-chain tx walk
          // for cost basis, which over-counts Jupiter zap-in fees + Jito tips
          // + compute-budget as "SOL in". That makes the Position card's P&L
          // diverge from the leaderboard P&L by the bundle overhead. Passing
          // it keeps both surfaces showing the same indexed grossSolIn.
          holderRow={holderRow}
        />
      </section>

      {/* Below the fold — informational + secondary surfaces */}
      <YieldCalc pool={pool} />

      <Referral />

      <Leaderboard />

      <NavVsLp />

      <Markets />

      <AprDecay />

      <HistoryCharts />

      <TweetButton pool={pool} position={position} />

      <Manifesto />

      <HowItWorks />

      <Card title="Log">
        <pre className="m-0 p-3 bg-[var(--color-bg)] text-[11px] text-[var(--color-dim)] max-h-[200px] overflow-y-auto whitespace-pre-wrap break-all">
          {error ? `error: ${error}\n` : ''}
          {log.length ? log.join('\n') : '—'}
        </pre>
      </Card>
    </div>
  )
}
