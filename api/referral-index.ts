import type { VercelRequest, VercelResponse } from '@vercel/node'
import {
  Connection,
  PublicKey,
  type ConfirmedSignatureInfo,
  type ParsedTransactionWithMeta,
  type ParsedInstruction,
  type PartiallyDecodedInstruction,
} from '@solana/web3.js'
import bs58 from 'bs58'
import { ensureSchema, getPool } from './_db.js'

// Sanctum/spl-stake-pool program + the stacSOL pool address. Hard-coded
// here (not imported from src/) because Vercel functions live outside the
// Vite alias graph.
const POOL_PROGRAM = new PublicKey('SP12tWFxD9oJsVWNavTTBZvMbA6gkAmxtVgxdqvyvhY')
const POOL = new PublicKey('E6oqvrLKexQwFJyCnQ8ewx8xt9tQo7uezat24f5Qixqb')
const MINT = new PublicKey('6K4xdfEk5rvySM496rxm4x8AgC9wVt7N4C7mFFpNAj5f')

// DepositSol = variant 14, DepositSolWithSlippage = variant 24. Both have
// the same account layout (pool, withdraw_auth, reserve, depositor,
// dest_user_ata, manager_fee_ata, referrer_ata, mint, system, token).
const DEPOSIT_SOL_VARIANTS = new Set([14, 24])
const REFERRER_ACCOUNT_INDEX = 6
const DEPOSITOR_ACCOUNT_INDEX = 3

// Per-invocation budget. Vercel Hobby is 300s, but we keep this tight so
// we can do both a "tail" pass (newer txs) and a "backfill" pass (older
// txs) in the same run without timing out.
const MAX_SIGS_PER_PASS = 150
const MAX_TX_RPC_CONCURRENCY = 5

interface IndexerCursor {
  newest_sig: string | null
  oldest_sig: string | null
  backfill_done: boolean
}

interface ReferralRow {
  sig: string
  slot: number
  ts: Date
  referrer: string
  referrerAta: string
  depositor: string
  solLamports: bigint
  feeStacsol: bigint
}

function decodeIxData(data: string | undefined): Uint8Array | null {
  if (!data) return null
  // web3.js returns base58 for partially-decoded ixs.
  try {
    return bs58.decode(data)
  } catch {
    return null
  }
}

function isDepositSolIx(
  ix: ParsedInstruction | PartiallyDecodedInstruction,
): ix is PartiallyDecodedInstruction {
  if (!('programId' in ix) || !ix.programId.equals(POOL_PROGRAM)) return false
  if (!('data' in ix) || !ix.data || !('accounts' in ix)) return false
  const bytes = decodeIxData(ix.data)
  if (!bytes || bytes.length < 9) return false
  return DEPOSIT_SOL_VARIANTS.has(bytes[0])
}

function readU64LE(b: Uint8Array, offset: number): bigint {
  let n = 0n
  for (let i = 0; i < 8; i++) n |= BigInt(b[offset + i]) << BigInt(i * 8)
  return n
}

async function loadCursor(): Promise<IndexerCursor> {
  const r = await getPool().query(
    'SELECT newest_sig, oldest_sig, backfill_done FROM referral_index_state WHERE id = 1',
  )
  const row = r.rows[0]
  return {
    newest_sig: row?.newest_sig ?? null,
    oldest_sig: row?.oldest_sig ?? null,
    backfill_done: row?.backfill_done ?? false,
  }
}

async function saveCursor(c: IndexerCursor): Promise<void> {
  await getPool().query(
    `UPDATE referral_index_state
     SET newest_sig = $1, oldest_sig = $2, backfill_done = $3, updated_at = NOW()
     WHERE id = 1`,
    [c.newest_sig, c.oldest_sig, c.backfill_done],
  )
}

async function fetchSignatures(
  conn: Connection,
  opts: { before?: string; until?: string; limit: number },
): Promise<ConfirmedSignatureInfo[]> {
  return conn.getSignaturesForAddress(
    POOL,
    {
      before: opts.before,
      until: opts.until,
      limit: opts.limit,
    },
    'confirmed',
  )
}

async function fetchTxsConcurrent(
  conn: Connection,
  sigs: string[],
): Promise<Array<{ sig: string; tx: ParsedTransactionWithMeta | null }>> {
  const out: Array<{ sig: string; tx: ParsedTransactionWithMeta | null }> = []
  for (let i = 0; i < sigs.length; i += MAX_TX_RPC_CONCURRENCY) {
    const chunk = sigs.slice(i, i + MAX_TX_RPC_CONCURRENCY)
    const results = await Promise.all(
      chunk.map((sig) =>
        conn
          .getParsedTransaction(sig, {
            commitment: 'confirmed',
            maxSupportedTransactionVersion: 0,
          })
          .then((tx) => ({ sig, tx }))
          .catch(() => ({ sig, tx: null as ParsedTransactionWithMeta | null })),
      ),
    )
    out.push(...results)
  }
  return out
}

/**
 * Walk all top-level + inner ixs in a tx and return any DepositSol ixs
 * found, along with a function to look up token-balance deltas on a given
 * account index.
 */
function extractReferralCredits(
  sig: string,
  tx: ParsedTransactionWithMeta,
): ReferralRow[] {
  if (tx.meta?.err) return []
  const allIxs: PartiallyDecodedInstruction[] = []
  const top = tx.transaction.message.instructions
  for (const ix of top) {
    if (isDepositSolIx(ix)) allIxs.push(ix)
  }
  for (const inner of tx.meta?.innerInstructions ?? []) {
    for (const ix of inner.instructions) {
      if (isDepositSolIx(ix)) allIxs.push(ix)
    }
  }
  if (allIxs.length === 0) return []

  // Build map: ATA address -> token-balance delta in atomic units.
  // postTokenBalances - preTokenBalances on accounts owned by MINT.
  const pre = tx.meta?.preTokenBalances ?? []
  const post = tx.meta?.postTokenBalances ?? []
  const accountKeys = tx.transaction.message.accountKeys.map((k) =>
    typeof k === 'string' ? k : k.pubkey.toBase58(),
  )
  const balByAta = new Map<string, bigint>()
  for (const p of post) {
    if (p.mint !== MINT.toBase58()) continue
    const ata = accountKeys[p.accountIndex]
    const preEntry = pre.find(
      (x) => x.accountIndex === p.accountIndex && x.mint === p.mint,
    )
    const before = BigInt(preEntry?.uiTokenAmount.amount ?? '0')
    const after = BigInt(p.uiTokenAmount.amount)
    balByAta.set(ata, after - before)
  }

  const slot = tx.slot
  const ts = new Date((tx.blockTime ?? Math.floor(Date.now() / 1000)) * 1000)
  const rows: ReferralRow[] = []

  for (const ix of allIxs) {
    const accounts = ix.accounts
    if (accounts.length <= REFERRER_ACCOUNT_INDEX) continue
    const referrerAta = accounts[REFERRER_ACCOUNT_INDEX].toBase58()
    const depositor = accounts[DEPOSITOR_ACCOUNT_INDEX].toBase58()
    const bytes = decodeIxData(ix.data)
    if (!bytes) continue
    const solLamports = readU64LE(bytes, 1)
    const feeDelta = balByAta.get(referrerAta) ?? 0n
    if (feeDelta <= 0n) continue
    rows.push({
      sig,
      slot,
      ts,
      referrer: '', // filled in after we resolve ATA -> owner
      referrerAta,
      depositor,
      solLamports,
      feeStacsol: feeDelta,
    })
  }
  return rows
}

/**
 * Resolve referrer ATA -> owner pubkey by reading the SPL Token-2022
 * account. Owner lives at bytes 32..64 in the standard token account
 * layout. Batched via getMultipleAccountsInfo to amortize RPC cost.
 */
async function resolveAtaOwners(
  conn: Connection,
  atas: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (atas.length === 0) return out
  const unique = Array.from(new Set(atas))
  const CHUNK = 100
  for (let i = 0; i < unique.length; i += CHUNK) {
    const slice = unique.slice(i, i + CHUNK)
    const infos = await conn.getMultipleAccountsInfo(
      slice.map((a) => new PublicKey(a)),
      'confirmed',
    )
    for (let j = 0; j < slice.length; j++) {
      const info = infos[j]
      if (!info || info.data.length < 64) continue
      const owner = new PublicKey(info.data.subarray(32, 64)).toBase58()
      out.set(slice[j], owner)
    }
  }
  return out
}

async function processBatch(
  conn: Connection,
  sigInfos: ConfirmedSignatureInfo[],
): Promise<{ inserted: number; rows: ReferralRow[] }> {
  if (sigInfos.length === 0) return { inserted: 0, rows: [] }

  const txs = await fetchTxsConcurrent(
    conn,
    sigInfos.map((s) => s.signature),
  )

  const candidateRows: ReferralRow[] = []
  for (const { sig, tx } of txs) {
    if (!tx) continue
    candidateRows.push(...extractReferralCredits(sig, tx))
  }

  if (candidateRows.length === 0) return { inserted: 0, rows: [] }

  const ataOwners = await resolveAtaOwners(
    conn,
    candidateRows.map((r) => r.referrerAta),
  )

  const filledRows = candidateRows
    .map((r) => ({ ...r, referrer: ataOwners.get(r.referrerAta) ?? '' }))
    .filter((r) => r.referrer !== '')

  let inserted = 0
  for (const r of filledRows) {
    const result = await getPool().query(
      `INSERT INTO referral_credits
        (sig, slot, ts, referrer, referrer_ata, depositor, sol_lamports, fee_stacsol)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (sig) DO NOTHING`,
      [
        r.sig,
        r.slot,
        r.ts,
        r.referrer,
        r.referrerAta,
        r.depositor,
        r.solLamports.toString(),
        r.feeStacsol.toString(),
      ],
    )
    inserted += result.rowCount ?? 0
  }
  return { inserted, rows: filledRows }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    await ensureSchema()
    const rpc = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com'
    const conn = new Connection(rpc, 'confirmed')

    const cursor = await loadCursor()
    let inserted = 0
    let scanned = 0
    let tailFetched = 0
    let backfillFetched = 0
    let newNewest: string | null = cursor.newest_sig
    let newOldest: string | null = cursor.oldest_sig
    let backfillDone = cursor.backfill_done

    // ---- Tail: fetch any signatures newer than newest_sig.
    // First call with `until` returns sigs newer-than-`until` in
    // newest-first order. Process in reverse-chronological order is fine
    // since each row is keyed by sig (unique).
    if (cursor.newest_sig) {
      const tail = await fetchSignatures(conn, {
        until: cursor.newest_sig,
        limit: MAX_SIGS_PER_PASS,
      })
      tailFetched = tail.length
      scanned += tail.length
      const result = await processBatch(conn, tail)
      inserted += result.inserted
      if (tail.length > 0) newNewest = tail[0].signature
    } else {
      // Cold start: grab the most recent batch and treat it as the seed.
      // Both newest and oldest cursors get set from this batch.
      const seed = await fetchSignatures(conn, { limit: MAX_SIGS_PER_PASS })
      tailFetched = seed.length
      scanned += seed.length
      const result = await processBatch(conn, seed)
      inserted += result.inserted
      if (seed.length > 0) {
        newNewest = seed[0].signature
        newOldest = seed[seed.length - 1].signature
      } else {
        backfillDone = true
      }
    }

    // ---- Backfill: fetch signatures older than oldest_sig until exhausted.
    if (!backfillDone && newOldest) {
      const older = await fetchSignatures(conn, {
        before: newOldest,
        limit: MAX_SIGS_PER_PASS,
      })
      backfillFetched = older.length
      scanned += older.length
      const result = await processBatch(conn, older)
      inserted += result.inserted
      if (older.length === 0) {
        backfillDone = true
      } else {
        newOldest = older[older.length - 1].signature
      }
    }

    await saveCursor({
      newest_sig: newNewest,
      oldest_sig: newOldest,
      backfill_done: backfillDone,
    })

    res.status(200).json({
      ok: true,
      scanned,
      tailFetched,
      backfillFetched,
      inserted,
      cursor: { newest_sig: newNewest, oldest_sig: newOldest, backfill_done: backfillDone },
    })
  } catch (e) {
    console.error('referral-index error:', e)
    res.status(500).json({ ok: false, error: (e as Error).message })
  }
}
