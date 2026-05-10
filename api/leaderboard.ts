import type { VercelRequest, VercelResponse } from '@vercel/node'
import { ensureSchema, getPool } from './_db.js'

const MARKETING_REFERRER = 'Bq4KMaVvzemx4tyfoyhZ7Kooo494GEv1xq9MLgRkfF6j'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    await ensureSchema()
    const limit = Math.min(
      Math.max(parseInt(String(req.query.limit ?? '50'), 10) || 50, 1),
      500,
    )
    const includeMarketing = String(req.query.includeMarketing ?? 'true') !== 'false'

    const where = includeMarketing ? '' : 'WHERE referrer != $2'
    const params: (string | number)[] = [limit]
    if (!includeMarketing) params.push(MARKETING_REFERRER)

    const sql = `
      SELECT
        referrer,
        SUM(fee_stacsol)::TEXT       AS fee_stacsol,
        SUM(sol_lamports)::TEXT      AS sol_referred,
        COUNT(*)::INT                AS deposits,
        COUNT(DISTINCT depositor)::INT AS unique_depositors,
        EXTRACT(EPOCH FROM MIN(ts)) * 1000 AS first_at,
        EXTRACT(EPOCH FROM MAX(ts)) * 1000 AS last_at
      FROM referral_credits
      ${where}
      GROUP BY referrer
      ORDER BY SUM(fee_stacsol) DESC
      LIMIT $1
    `
    const r = await getPool().query(sql, params)

    const totalSql = `
      SELECT
        COUNT(*)::INT             AS total_deposits,
        COUNT(DISTINCT referrer)::INT AS total_referrers,
        COUNT(DISTINCT depositor)::INT AS total_depositors,
        SUM(fee_stacsol)::TEXT    AS total_fee_stacsol,
        SUM(sol_lamports)::TEXT   AS total_sol_referred
      FROM referral_credits
    `
    const totals = await getPool().query(totalSql)

    res.setHeader(
      'Cache-Control',
      'public, max-age=30, s-maxage=30, stale-while-revalidate=120',
    )
    res.status(200).json({
      marketingReferrer: MARKETING_REFERRER,
      totals: {
        deposits: totals.rows[0]?.total_deposits ?? 0,
        referrers: totals.rows[0]?.total_referrers ?? 0,
        depositors: totals.rows[0]?.total_depositors ?? 0,
        feeStacsol: totals.rows[0]?.total_fee_stacsol ?? '0',
        solReferred: totals.rows[0]?.total_sol_referred ?? '0',
      },
      rows: r.rows.map((row, i) => ({
        rank: i + 1,
        referrer: row.referrer,
        feeStacsol: row.fee_stacsol,
        solReferred: row.sol_referred,
        deposits: row.deposits,
        uniqueDepositors: row.unique_depositors,
        firstAt: Number(row.first_at),
        lastAt: Number(row.last_at),
        isMarketing: row.referrer === MARKETING_REFERRER,
      })),
    })
  } catch (e) {
    console.error('leaderboard error:', e)
    res.status(500).json({ ok: false, error: (e as Error).message })
  }
}
