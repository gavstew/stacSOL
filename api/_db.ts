import { Pool } from 'pg'

// Neon pooled connection. Note: this module is imported by every serverless
// function — pg.Pool internally caches connections per-process, so even
// though Vercel may cold-start a fresh handler, repeated invocations on the
// same warm container reuse the same TCP connections.
let pool: Pool | null = null
export function getPool(): Pool {
  if (pool) return pool
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL not set')
  pool = new Pool({ connectionString: url, max: 3 })
  return pool
}

/**
 * Idempotent schema migration. Called on every snapshot/history request so
 * we don't need a separate migration step for the initial deploy. The
 * `IF NOT EXISTS` makes this safe to call concurrently.
 */
export async function ensureSchema() {
  const sql = `
    CREATE TABLE IF NOT EXISTS pool_snapshots (
      id SERIAL PRIMARY KEY,
      ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      total_lamports NUMERIC NOT NULL,
      pool_token_supply NUMERIC NOT NULL,
      mint_supply NUMERIC NOT NULL,
      reserve_lamports NUMERIC NOT NULL,
      rate DOUBLE PRECISION NOT NULL,
      last_update_epoch BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS pool_snapshots_ts_idx ON pool_snapshots(ts DESC);
    ALTER TABLE pool_snapshots ADD COLUMN IF NOT EXISTS lp_price_sol DOUBLE PRECISION;

    CREATE TABLE IF NOT EXISTS referral_credits (
      sig TEXT PRIMARY KEY,
      slot BIGINT NOT NULL,
      ts TIMESTAMPTZ NOT NULL,
      referrer TEXT NOT NULL,
      referrer_ata TEXT NOT NULL,
      depositor TEXT NOT NULL,
      sol_lamports NUMERIC NOT NULL,
      fee_stacsol NUMERIC NOT NULL
    );
    CREATE INDEX IF NOT EXISTS referral_credits_referrer_idx ON referral_credits(referrer);
    CREATE INDEX IF NOT EXISTS referral_credits_ts_idx ON referral_credits(ts DESC);

    CREATE TABLE IF NOT EXISTS referral_index_state (
      id INT PRIMARY KEY DEFAULT 1,
      newest_sig TEXT,
      oldest_sig TEXT,
      backfill_done BOOLEAN NOT NULL DEFAULT FALSE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    INSERT INTO referral_index_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
  `
  await getPool().query(sql)
}
