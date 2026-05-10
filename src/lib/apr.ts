import { Connection } from '@solana/web3.js'
import { POOL } from './constants'

// LST exchange rate starts at 1.0 SOL/stacSOL when a stake pool is first
// initialized. We measure implied APR as the simple-interest annualization of
// the rate change since deploy. Deploy time is read once from chain via
// getSignaturesForAddress (oldest sig's blockTime) and cached forever.

const YEAR_SECONDS = 365.25 * 24 * 3600
const MIN_ELAPSED_SEC = 10
const DEPLOY_TS_KEY = 'stacsol:pool-deploy-ts-v1'

// Fallback for first paint while we fetch the real value (replace if known).
const FALLBACK_DEPLOY_TS_MS = Date.UTC(2026, 4, 8, 7, 27, 53)

export interface AprResult {
  apr: number | null
  baselineRate: number
  baselineTs: number
  elapsedSec: number
}

export function loadCachedDeployTs(): number | null {
  try {
    const v = localStorage.getItem(DEPLOY_TS_KEY)
    return v ? Number(v) || null : null
  } catch {
    return null
  }
}

export function saveDeployTs(ms: number) {
  try {
    localStorage.setItem(DEPLOY_TS_KEY, String(ms))
  } catch {
    /* ignore */
  }
}

/**
 * Walks getSignaturesForAddress backwards (it returns descending) until the
 * tail page; the last entry is the oldest tx, which for our pool is the
 * Initialize. Returns blockTime as ms or null if RPC has no blockTime.
 */
export async function fetchPoolDeployTs(conn: Connection): Promise<number | null> {
  let before: string | undefined = undefined
  let oldestBlockTime: number | null = null
  // Cap iterations to avoid runaway pagination on very active pools.
  for (let i = 0; i < 10; i++) {
    const sigs = await conn.getSignaturesForAddress(POOL, { limit: 1000, before })
    if (sigs.length === 0) break
    const last = sigs[sigs.length - 1]
    if (last.blockTime != null) oldestBlockTime = last.blockTime
    if (sigs.length < 1000) break
    before = last.signature
  }
  return oldestBlockTime != null ? oldestBlockTime * 1000 : null
}

export function computeApr(currentRate: number, deployTsMs: number): AprResult {
  const elapsedSec = (Date.now() - deployTsMs) / 1000
  if (elapsedSec < MIN_ELAPSED_SEC || currentRate <= 0) {
    return { apr: null, baselineRate: 1.0, baselineTs: deployTsMs, elapsedSec }
  }
  const ratio = currentRate / 1.0
  const apr = (ratio - 1) * (YEAR_SECONDS / elapsedSec)
  return { apr, baselineRate: 1.0, baselineTs: deployTsMs, elapsedSec }
}

export function fmtElapsed(sec: number) {
  if (sec < 60) return `${Math.floor(sec)}s`
  if (sec < 3600) return `${Math.floor(sec / 60)}m`
  if (sec < 86400) return `${(sec / 3600).toFixed(1)}h`
  return `${(sec / 86400).toFixed(1)}d`
}

export const FALLBACK_DEPLOY_TS = FALLBACK_DEPLOY_TS_MS
