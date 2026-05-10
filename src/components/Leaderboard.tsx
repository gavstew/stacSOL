// Top referrers leaderboard.
//
// Backed by /api/leaderboard which aggregates the `referral_credits` table.
// Each row in that table is one DepositSol ix that credited the referrer's
// stacSOL ATA (variant 14, account index 6 — see api/referral-index.ts).
//
// Ranking is by lifetime referral fee earned in stacSOL. We include the
// marketing wallet by default (transparent about the unattributed-mint
// destination) and tag it with a "default" badge. There's an opt-out
// query param (?excludeMarketing=true → /api/leaderboard?includeMarketing=false)
// for users who want to see "real" referrers only.
//
// Refetches every 60s. The endpoint sets a 30s cache so this is cheap.

import { useEffect, useMemo, useState } from 'react'
import { useWallet } from '@solana/wallet-adapter-react'
import { Card } from './Stats'
import { fmtAmount, shortPk } from '../lib/format'

interface LeaderboardRow {
  rank: number
  referrer: string
  feeStacsol: string
  solReferred: string
  deposits: number
  uniqueDepositors: number
  firstAt: number
  lastAt: number
  isMarketing: boolean
}

interface LeaderboardResponse {
  marketingReferrer: string
  totals: {
    deposits: number
    referrers: number
    depositors: number
    feeStacsol: string
    solReferred: string
  }
  rows: LeaderboardRow[]
}

const REFRESH_MS = 60_000

export function Leaderboard() {
  const { publicKey } = useWallet()
  const [data, setData] = useState<LeaderboardResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [excludeMarketing, setExcludeMarketing] = useState(false)
  const [copiedKey, setCopiedKey] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const fetchOnce = async () => {
      try {
        const url = `/api/leaderboard?limit=25${
          excludeMarketing ? '&includeMarketing=false' : ''
        }`
        const res = await fetch(url)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const json = (await res.json()) as LeaderboardResponse
        if (!cancelled) {
          setData(json)
          setError(null)
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message)
      }
    }
    fetchOnce()
    const id = setInterval(fetchOnce, REFRESH_MS)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [excludeMarketing])

  const myPk = publicKey?.toBase58() ?? null
  const myRow = useMemo(
    () => data?.rows.find((r) => r.referrer === myPk) ?? null,
    [data, myPk],
  )

  const copy = async (pk: string) => {
    try {
      await navigator.clipboard.writeText(pk)
      setCopiedKey(pk)
      setTimeout(() => setCopiedKey((k) => (k === pk ? null : k)), 1500)
    } catch {
      /* ignore */
    }
  }

  return (
    <Card title="Leaderboard · top referrers by lifetime fees">
      {/* Filter toggle + totals strip */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <button
          type="button"
          onClick={() => setExcludeMarketing((v) => !v)}
          className="text-[10px] uppercase tracking-[2px] text-[var(--color-dim)] hover:text-[var(--color-fg)] underline-offset-2 hover:underline"
          title="Toggle marketing-wallet visibility"
        >
          {excludeMarketing
            ? 'show marketing default'
            : 'hide marketing default'}
        </button>
        {data && (
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-[10px] uppercase tracking-[2px] text-[var(--color-dim)]">
            <span>
              <span className="text-[var(--color-fg)] font-mono normal-case tracking-normal">
                {data.totals.referrers.toLocaleString()}
              </span>{' '}
              referrers
            </span>
            <span>
              <span className="text-[var(--color-fg)] font-mono normal-case tracking-normal">
                {data.totals.deposits.toLocaleString()}
              </span>{' '}
              deposits
            </span>
            <span>
              <span className="text-[var(--color-fg)] font-mono normal-case tracking-normal">
                {fmtAmount(BigInt(data.totals.feeStacsol))}
              </span>{' '}
              stacSOL paid
            </span>
            <span>
              <span className="text-[var(--color-fg)] font-mono normal-case tracking-normal">
                {fmtAmount(BigInt(data.totals.solReferred))}
              </span>{' '}
              SOL referred
            </span>
          </div>
        )}
      </div>

      {/* Sticky "your rank" banner when wallet is connected */}
      {myPk && (
        <div className="mb-3 px-3 py-2 rounded border border-[rgb(255_119_51_/_0.4)] bg-[rgb(255_119_51_/_0.08)] flex items-center justify-between gap-3">
          <div className="text-[11px] text-[var(--color-ember)]">
            {myRow ? (
              <>
                you&apos;re ranked{' '}
                <span className="font-black">#{myRow.rank}</span> ·{' '}
                <span className="font-mono">
                  {fmtAmount(BigInt(myRow.feeStacsol))}
                </span>{' '}
                stacSOL earned across {myRow.deposits} referred deposits
              </>
            ) : (
              <>
                your wallet hasn&apos;t earned any referral fees yet — share
                your link to get on the board
              </>
            )}
          </div>
        </div>
      )}

      {error && (
        <div className="text-[11px] text-[var(--color-warn)] mb-3">
          could not load leaderboard: {error}
        </div>
      )}

      {!data && !error && (
        <div className="text-[11px] text-[var(--color-dim)] uppercase tracking-[2px] py-3">
          loading…
        </div>
      )}

      {data && data.rows.length === 0 && (
        <div className="text-[11px] text-[var(--color-dim)] py-3">
          no referral credits indexed yet — backfill is still running. Check
          back in a few minutes.
        </div>
      )}

      {data && data.rows.length > 0 && (
        <div className="overflow-x-auto -mx-1">
          <table className="w-full text-[11px] tabular-mono">
            <thead>
              <tr className="text-[10px] uppercase tracking-[2px] text-[var(--color-dim)]">
                <th className="text-left pl-1 pr-3 py-1.5 font-black">#</th>
                <th className="text-left px-3 py-1.5 font-black">wallet</th>
                <th className="text-right px-3 py-1.5 font-black">
                  fee (stacSOL)
                </th>
                <th className="text-right px-3 py-1.5 font-black hidden sm:table-cell">
                  SOL referred
                </th>
                <th className="text-right px-3 py-1.5 font-black">deposits</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row) => {
                const isMe = row.referrer === myPk
                return (
                  <tr
                    key={row.referrer}
                    className={
                      isMe
                        ? 'bg-[rgb(255_119_51_/_0.08)] border-y border-[rgb(255_119_51_/_0.4)]'
                        : 'border-b border-[rgb(255_34_0_/_0.06)]'
                    }
                  >
                    <td className="text-left pl-1 pr-3 py-2 text-[var(--color-dim)] font-black">
                      {row.rank}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <a
                          href={`https://solscan.io/account/${row.referrer}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[var(--color-fg)] hover:text-[var(--color-hot)] no-underline"
                          title={row.referrer}
                        >
                          {shortPk(row.referrer)}
                        </a>
                        <button
                          type="button"
                          onClick={() => copy(row.referrer)}
                          className="text-[9px] uppercase tracking-[2px] text-[var(--color-dim)] hover:text-[var(--color-ember)]"
                          aria-label="copy address"
                        >
                          {copiedKey === row.referrer ? '✓' : 'copy'}
                        </button>
                        {row.isMarketing && (
                          <span className="px-1.5 py-0.5 rounded text-[8px] uppercase tracking-[2px] font-black border border-[var(--color-warn)] text-[var(--color-warn)] bg-[rgb(255_204_0_/_0.08)]">
                            default
                          </span>
                        )}
                        {isMe && (
                          <span className="px-1.5 py-0.5 rounded text-[8px] uppercase tracking-[2px] font-black border border-[var(--color-ember)] text-[var(--color-ember)] bg-[rgb(255_119_51_/_0.1)]">
                            you
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="text-right px-3 py-2 text-[var(--color-fg)] font-bold">
                      {fmtAmount(BigInt(row.feeStacsol))}
                    </td>
                    <td className="text-right px-3 py-2 text-[var(--color-dim)] hidden sm:table-cell">
                      {fmtAmount(BigInt(row.solReferred))}
                    </td>
                    <td className="text-right px-3 py-2 text-[var(--color-dim)]">
                      {row.deposits.toLocaleString()}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <p className="mt-4 text-[10px] text-[var(--color-dim)] leading-relaxed">
        Indexed from on-chain DepositSol ixs (program{' '}
        <span className="font-mono">SP12…vhY</span>, account slot 6 = referrer
        ATA). Updates every ~5min. Backfill from launch may take a few hours
        to complete after the first deploy.
      </p>
    </Card>
  )
}
