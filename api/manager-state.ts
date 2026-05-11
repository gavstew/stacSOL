import type { VercelRequest, VercelResponse } from '@vercel/node'
import { ensureSchema, getPool } from './_db.js'

// Shared secret between the bait-loop / burn-loop daemons and this endpoint.
// Set as MANAGER_STATE_SECRET in Vercel env. Required for POST (write) ops.
// GET is open so the dashboard can read the counter for display.
const SECRET = process.env.MANAGER_STATE_SECRET

interface ManagerStateRow {
  outstanding_bait_cost_lamports: string
  lifetime_bait_cost_lamports: string
  lifetime_bait_recovered_lamports: string
  lifetime_bait_cycles: number
  lifetime_recovery_cycles: number
  last_bait_at: Date | null
  last_recovery_at: Date | null
  updated_at: Date
}

async function readState(): Promise<ManagerStateRow> {
  const r = await getPool().query<ManagerStateRow>(
    `SELECT outstanding_bait_cost_lamports::text AS outstanding_bait_cost_lamports,
            lifetime_bait_cost_lamports::text     AS lifetime_bait_cost_lamports,
            lifetime_bait_recovered_lamports::text AS lifetime_bait_recovered_lamports,
            lifetime_bait_cycles, lifetime_recovery_cycles,
            last_bait_at, last_recovery_at, updated_at
       FROM manager_state WHERE id = 1`,
  )
  return r.rows[0]
}

function serialize(row: ManagerStateRow) {
  return {
    outstandingBaitCostLamports: row.outstanding_bait_cost_lamports,
    lifetimeBaitCostLamports: row.lifetime_bait_cost_lamports,
    lifetimeBaitRecoveredLamports: row.lifetime_bait_recovered_lamports,
    lifetimeBaitCycles: row.lifetime_bait_cycles,
    lifetimeRecoveryCycles: row.lifetime_recovery_cycles,
    lastBaitAt: row.last_bait_at?.toISOString() ?? null,
    lastRecoveryAt: row.last_recovery_at?.toISOString() ?? null,
    updatedAt: row.updated_at.toISOString(),
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    await ensureSchema()

    if (req.method === 'GET') {
      const row = await readState()
      res.setHeader('Cache-Control', 'no-store')
      res.status(200).json({ ok: true, ...serialize(row) })
      return
    }

    if (req.method === 'POST') {
      if (!SECRET) {
        res.status(500).json({ ok: false, error: 'MANAGER_STATE_SECRET not set on server' })
        return
      }
      const auth = req.headers['x-manager-secret']
      if (typeof auth !== 'string' || auth !== SECRET) {
        res.status(401).json({ ok: false, error: 'unauthorized' })
        return
      }

      const body = (typeof req.body === 'string' ? JSON.parse(req.body) : req.body) as {
        kind?: 'bait' | 'recover' | 'burn'
        // For 'bait' and 'recover'. For 'bait' = SOL cost (positive when COST,
        // 0 when profit — profit cycles still record in bait_events for
        // attribution but don't affect the cost counter).
        lamports?: string | number
        // Optional detail fields for 'bait' — captured in bait_events
        // regardless of whether lamports>0 (so profit cycles get recorded too).
        venueLabel?: string
        intermediateSymbol?: string
        direction?: 'mint_sell' | 'buy_burn'
        sizeLamports?: string | number
        solDeltaLamports?: string | number // signed; positive = cost, negative = profit
        route?: string
        // Optional detail for 'burn' (kind = 'burn' is a separate ingest
        // path used by burn-loop's tick summary, distinct from 'recover').
        // 'recover' moves the outstanding counter; 'burn' just logs a
        // burn_events row (NAV growth telemetry).
        harvestedAtom?: string | number
        recoveredAtom?: string | number
        burnedAtom?: string | number
        navBefore?: number
        navAfter?: number
        candidateCount?: number
        note?: string
      }
      if (!body || (body.kind !== 'bait' && body.kind !== 'recover' && body.kind !== 'burn')) {
        res.status(400).json({ ok: false, error: 'kind must be "bait" | "recover" | "burn"' })
        return
      }

      const pool = getPool()

      if (body.kind === 'bait') {
        // Insert detail row regardless of cost/profit so the dashboard sees
        // both. The cost counter only advances when delta is positive (we
        // floor at 0 to avoid negative outstanding from profitable cycles).
        const sizeL = BigInt(body.sizeLamports ?? body.lamports ?? 0)
        const deltaL = BigInt(body.solDeltaLamports ?? body.lamports ?? 0)
        const costL = deltaL > 0n ? deltaL : 0n
        await pool.query(
          `INSERT INTO bait_events
             (venue_label, intermediate_symbol, direction, size_lamports, sol_delta_lamports, route)
           VALUES ($1, $2, $3, $4::numeric, $5::numeric, $6)`,
          [
            body.venueLabel ?? '(unknown)',
            body.intermediateSymbol ?? 'SOL',
            body.direction ?? 'mint_sell',
            sizeL.toString(),
            deltaL.toString(),
            body.route ?? null,
          ],
        )
        if (costL > 0n) {
          await pool.query(
            `UPDATE manager_state
                SET outstanding_bait_cost_lamports = outstanding_bait_cost_lamports + $1::numeric,
                    lifetime_bait_cost_lamports    = lifetime_bait_cost_lamports + $1::numeric,
                    lifetime_bait_cycles           = lifetime_bait_cycles + 1,
                    last_bait_at                   = NOW(),
                    updated_at                     = NOW()
              WHERE id = 1`,
            [costL.toString()],
          )
        } else {
          // Still bump cycle counter on profitable cycles so the "cycles"
          // count matches the bait_events count.
          await pool.query(
            `UPDATE manager_state
                SET lifetime_bait_cycles = lifetime_bait_cycles + 1,
                    last_bait_at         = NOW(),
                    updated_at           = NOW()
              WHERE id = 1`,
          )
        }
      } else if (body.kind === 'recover') {
        // Recovery WithdrawSol just landed; decrement outstanding (floored at 0),
        // accumulate lifetime recovered.
        let lamports: bigint
        try {
          lamports = BigInt(body.lamports ?? 0)
        } catch {
          res.status(400).json({ ok: false, error: 'lamports must be integer-string' })
          return
        }
        if (lamports <= 0n) {
          res.status(400).json({ ok: false, error: 'lamports must be > 0' })
          return
        }
        await pool.query(
          `UPDATE manager_state
              SET outstanding_bait_cost_lamports = GREATEST(0::numeric, outstanding_bait_cost_lamports - $1::numeric),
                  lifetime_bait_recovered_lamports = lifetime_bait_recovered_lamports + $1::numeric,
                  lifetime_recovery_cycles         = lifetime_recovery_cycles + 1,
                  last_recovery_at                 = NOW(),
                  updated_at                       = NOW()
            WHERE id = 1`,
          [lamports.toString()],
        )
      } else {
        // burn — log a burn_events telemetry row (NAV growth attribution).
        const harvested = BigInt(body.harvestedAtom ?? 0)
        const recovered = BigInt(body.recoveredAtom ?? 0)
        const burned = BigInt(body.burnedAtom ?? 0)
        if (harvested === 0n && burned === 0n && recovered === 0n) {
          res.status(400).json({ ok: false, error: 'burn event needs harvestedAtom / burnedAtom / recoveredAtom' })
          return
        }
        await pool.query(
          `INSERT INTO burn_events
             (harvested_atom, recovered_atom, burned_atom, nav_before, nav_after, candidate_count)
           VALUES ($1::numeric, $2::numeric, $3::numeric, $4, $5, $6)`,
          [
            harvested.toString(),
            recovered.toString(),
            burned.toString(),
            body.navBefore ?? null,
            body.navAfter ?? null,
            body.candidateCount ?? 0,
          ],
        )
      }

      const row = await readState()
      res.status(200).json({ ok: true, ...serialize(row) })
      return
    }

    res.status(405).json({ ok: false, error: 'method not allowed' })
  } catch (e) {
    console.error('manager-state error:', e)
    res.status(500).json({ ok: false, error: (e as Error).message })
  }
}
