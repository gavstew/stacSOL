import type { VercelRequest, VercelResponse } from '@vercel/node'
import * as fs from 'fs'
import * as path from 'path'

// Returns the manifest of Meteora DLMM pools deployed by
// scripts/init-meteora-pools.ts. Read from the JSON file checked into the
// repo. Pool addresses are deterministic — they're correct even if the
// pools haven't been initialized on-chain yet (the UI gracefully handles
// that case).

let cached: unknown = null

export default async function handler(_req: VercelRequest, res: VercelResponse) {
  try {
    if (!cached) {
      const manifestPath = path.join(process.cwd(), 'scripts', 'meteora-pools.json')
      if (fs.existsSync(manifestPath)) {
        cached = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
      } else {
        cached = []
      }
    }
    res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=60')
    res.status(200).json({ ok: true, pools: cached })
  } catch (e) {
    res.status(500).json({ ok: false, error: (e as Error).message })
  }
}
