import type { VercelRequest, VercelResponse } from '@vercel/node'

// CORS-safe pass-through proxy for the HawkFi API at api2.hawksight.co.
//
// The HawkFi SDK (@hawksightco/hawk-sdk + swagger-client) is wired to hit a
// configurable basePath. When called from the browser directly it hits
// api2.hawksight.co which doesn't return Access-Control-Allow-Origin for our
// site, so XHR fails with CORS. Proxying through this Vercel function fixes
// it and keeps the same path layout.
//
// vercel.json rewrites everything under /api/hawkfi/(.*) to this single
// function (Vercel's filesystem catch-all `[...path].ts` does not deploy
// reliably for non-framework projects). The original path is reconstructed
// here from req.url.
//
// On the client: `new HawkAPI(`${origin}/api/hawkfi`)` — the SDK appends
// /util/findAltWithTx etc. and we strip the /api/hawkfi prefix below.

const UPSTREAM = 'https://api2.hawksight.co'

const STRIPPED_REQ_HEADERS = new Set([
  'host',
  'cookie',
  'connection',
  'content-length',
  'accept-encoding',
  'transfer-encoding',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
  'x-vercel-id',
  'x-vercel-deployment-url',
  'x-vercel-forwarded-for',
  'x-vercel-ip-country',
  'x-vercel-ip-country-region',
  'x-vercel-ip-city',
])

const STRIPPED_RES_HEADERS = new Set([
  'content-encoding',
  'content-length',
  'transfer-encoding',
  'connection',
])

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    // req.url here is what Vercel's edge passed through after rewrite. With
    // the rewrite "/api/hawkfi/(.*)" → "/api/hawkfi" we lose the suffix from
    // req.url, so check the original X-Forwarded-Path / referer-based path
    // first, falling back to req.url and stripping the function prefix.
    //
    // In practice Vercel exposes the original path via the `x-matched-path`
    // header or via the rewrite-source query (depending on config). To be
    // robust we accept either:
    //   - ?_path=... query param appended by the client
    //   - the full req.url (pre-rewrite path captured by Vercel for us)
    let raw = ''
    if (typeof req.url === 'string') raw = req.url
    // Strip leading "/api/hawkfi" if it survived the rewrite.
    raw = raw.replace(/^\/api\/hawkfi/, '')
    // Drop our reserved _path param so we don't forward it to upstream.
    raw = raw.replace(/([?&])_path=[^&]*&?/, '$1').replace(/[?&]$/, '')

    // If after stripping there's no path at all, prefer the explicit override.
    if (!raw || raw === '/' || raw === '') {
      const explicit =
        typeof req.query._path === 'string' ? req.query._path : null
      if (explicit) {
        const sep = explicit.startsWith('/') ? '' : '/'
        raw = sep + explicit
      } else {
        // Best-effort: try referer's path component matching /api/hawkfi/...
        const ref = req.headers['referer']
        if (typeof ref === 'string') {
          const m = ref.match(/\/api\/hawkfi(\/[^?#]+)/)
          if (m) raw = m[1]
        }
      }
    }
    if (!raw || raw === '/') {
      res.status(400).json({ ok: false, error: 'no upstream path provided' })
      return
    }

    const url = `${UPSTREAM}${raw.startsWith('/') ? '' : '/'}${raw}`

    const fwdHeaders: Record<string, string> = {}
    for (const [k, v] of Object.entries(req.headers)) {
      if (!v) continue
      const key = k.toLowerCase()
      if (STRIPPED_REQ_HEADERS.has(key)) continue
      if (key === 'origin' || key === 'referer') continue
      fwdHeaders[k] = Array.isArray(v) ? v.join(',') : String(v)
    }

    let body: string | undefined
    if (req.method && req.method !== 'GET' && req.method !== 'HEAD') {
      if (req.body == null) body = undefined
      else if (typeof req.body === 'string') body = req.body
      else body = JSON.stringify(req.body)
    }

    const upstream = await fetch(url, {
      method: req.method ?? 'GET',
      headers: fwdHeaders,
      body,
      signal: AbortSignal.timeout(30_000),
    })

    upstream.headers.forEach((value, name) => {
      const lower = name.toLowerCase()
      if (STRIPPED_RES_HEADERS.has(lower)) return
      res.setHeader(name, value)
    })
    res.status(upstream.status)
    const buf = Buffer.from(await upstream.arrayBuffer())
    res.send(buf)
  } catch (e) {
    console.error('hawkfi proxy error:', e)
    res.status(502).json({
      ok: false,
      error: (e as Error).message ?? 'hawkfi proxy failed',
    })
  }
}
