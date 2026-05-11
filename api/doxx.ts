import type { VercelRequest, VercelResponse } from '@vercel/node'
import { webcrypto } from 'node:crypto'
import { ensureSchema, getPool } from './_db.js'

// NOTE on no @solana/web3.js import: pulling in PublicKey transitively
// loads @solana/rpc-websockets, which crashes the CJS @vercel/node
// runtime (ERR_REQUIRE_ESM on uuid). The holders-leaderboard endpoint
// has the same constraint and avoids it. We decode the wallet pubkey
// inline using the same base58 decoder we use for the signature.

// Opt-in / opt-out endpoint for leaderboard doxxing. Every wallet starts
// anonymous (rendered as a stable pseudonym derived from pubkey). To be
// shown on the leaderboard with their real address (and optional display
// name), the wallet owner POSTs here with a fresh signed message proving
// custody. Same flow to undoxx — just submit a signed message with the
// opposite action.
//
// The message format is intentionally human-readable so wallet popups
// show the user exactly what they're approving:
//
//   stacsol-leaderboard:doxx:<wallet>:<unix-seconds>
//   stacsol-leaderboard:undoxx:<wallet>:<unix-seconds>
//
// Timestamp must be within ±10min of now (replay prevention).
//
// Verification uses Node's built-in WebCrypto Ed25519 instead of
// tweetnacl. Avoids adding ESM-only deps that don't play nicely with the
// CJS @vercel/node function runtime.

const MESSAGE_WINDOW_SEC = 10 * 60
const DISPLAY_NAME_MAX = 32
const DISPLAY_NAME_RE = /^[\p{L}\p{N} _.\-]{1,32}$/u

// Inline base58 decoder. We only need this to read the wallet signature
// out of the request body — adding a dep just for this would be silly.
const BS58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const BS58_INDEX = (() => {
  const m: Record<string, number> = {}
  for (let i = 0; i < BS58_ALPHABET.length; i++) m[BS58_ALPHABET[i]] = i
  return m
})()
function bs58Decode(s: string): Uint8Array {
  if (s.length === 0) return new Uint8Array(0)
  let zeros = 0
  while (zeros < s.length && s[zeros] === '1') zeros++
  const size = Math.floor(((s.length - zeros) * 733) / 1000) + 1
  const b256 = new Uint8Array(size)
  for (let i = zeros; i < s.length; i++) {
    const idx = BS58_INDEX[s[i]]
    if (idx === undefined) throw new Error('invalid base58 character')
    let carry = idx
    for (let j = b256.length - 1; j >= 0; j--) {
      carry += 58 * b256[j]
      b256[j] = carry & 0xff
      carry >>= 8
    }
    if (carry !== 0) throw new Error('base58 overflow')
  }
  // Skip leading zero-bytes from the conversion buffer and prepend the
  // explicit leading-zero count from the input.
  let start = 0
  while (start < b256.length && b256[start] === 0) start++
  const out = new Uint8Array(zeros + (b256.length - start))
  out.set(b256.subarray(start), zeros)
  return out
}

interface DoxxBody {
  wallet?: string
  action?: 'doxx' | 'undoxx'
  message?: string
  signatureBase58?: string
  displayName?: string | null
}

function bad(res: VercelResponse, status: number, error: string) {
  res.status(status).json({ ok: false, error })
}

async function verifyEd25519(
  publicKeyBytes: Uint8Array,
  message: Uint8Array,
  signature: Uint8Array,
): Promise<boolean> {
  try {
    const subtle = (webcrypto as Crypto).subtle
    const key = await subtle.importKey(
      'raw',
      publicKeyBytes as BufferSource,
      { name: 'Ed25519' },
      false,
      ['verify'],
    )
    return await subtle.verify(
      { name: 'Ed25519' },
      key,
      signature as BufferSource,
      message as BufferSource,
    )
  } catch {
    return false
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    bad(res, 405, 'POST only')
    return
  }
  try {
    const body = (typeof req.body === 'string' ? JSON.parse(req.body) : req.body) as DoxxBody
    const wallet = body?.wallet
    const action = body?.action
    const message = body?.message
    const signatureBase58 = body?.signatureBase58
    const displayName = body?.displayName

    if (!wallet || !action || !message || !signatureBase58) {
      bad(res, 400, 'missing wallet, action, message, or signatureBase58')
      return
    }
    if (action !== 'doxx' && action !== 'undoxx') {
      bad(res, 400, "action must be 'doxx' or 'undoxx'")
      return
    }

    // Parse + validate the wallet pubkey. Solana pubkeys are exactly 32
    // bytes when base58-decoded.
    let walletPkBytes: Uint8Array
    try {
      walletPkBytes = bs58Decode(wallet)
    } catch {
      bad(res, 400, 'invalid wallet pubkey')
      return
    }
    if (walletPkBytes.length !== 32) {
      bad(res, 400, 'wallet pubkey must decode to 32 bytes')
      return
    }

    // Parse expected message: stacsol-leaderboard:<action>:<wallet>:<unix-secs>
    const m = message.match(/^stacsol-leaderboard:(doxx|undoxx):([A-Za-z0-9]{32,44}):(\d{9,11})$/)
    if (!m) {
      bad(res, 400, 'malformed message')
      return
    }
    const [, msgAction, msgWallet, msgTsStr] = m
    if (msgAction !== action) {
      bad(res, 400, 'action mismatch with message')
      return
    }
    if (msgWallet !== wallet) {
      bad(res, 400, 'wallet mismatch with message')
      return
    }
    const msgTs = Number(msgTsStr)
    const nowSec = Math.floor(Date.now() / 1000)
    if (!Number.isFinite(msgTs) || Math.abs(nowSec - msgTs) > MESSAGE_WINDOW_SEC) {
      bad(res, 400, 'message timestamp outside allowed window')
      return
    }

    // Verify signature: ed25519(message, walletPubkey).
    let signature: Uint8Array
    try {
      signature = bs58Decode(signatureBase58)
    } catch {
      bad(res, 400, 'signature is not valid base58')
      return
    }
    if (signature.length !== 64) {
      bad(res, 400, 'signature must be 64 bytes')
      return
    }
    const messageBytes = new TextEncoder().encode(message)
    const ok = await verifyEd25519(walletPkBytes, messageBytes, signature)
    if (!ok) {
      bad(res, 400, 'signature does not verify against wallet pubkey')
      return
    }

    // Validate optional display name when doxxing.
    let cleanDisplayName: string | null = null
    if (action === 'doxx' && displayName != null) {
      if (typeof displayName !== 'string') {
        bad(res, 400, 'displayName must be a string')
        return
      }
      const trimmed = displayName.trim()
      if (trimmed.length === 0) {
        cleanDisplayName = null
      } else if (trimmed.length > DISPLAY_NAME_MAX) {
        bad(res, 400, `displayName too long (max ${DISPLAY_NAME_MAX})`)
        return
      } else if (!DISPLAY_NAME_RE.test(trimmed)) {
        bad(res, 400, 'displayName contains invalid characters')
        return
      } else {
        cleanDisplayName = trimmed
      }
    }

    await ensureSchema()

    // Upsert: the row may not exist yet (wallet that signed up via /api/doxx
    // before ever interacting on-chain). We insert a stub holder_summary row
    // — the indexer will fill the rest of the columns once it sees activity.
    if (action === 'doxx') {
      await getPool().query(
        `INSERT INTO holder_summary (wallet, is_doxxed, display_name, updated_at)
         VALUES ($1, TRUE, $2, NOW())
         ON CONFLICT (wallet) DO UPDATE
           SET is_doxxed = TRUE,
               display_name = EXCLUDED.display_name,
               updated_at   = NOW()`,
        [wallet, cleanDisplayName],
      )
    } else {
      // undoxx: flip flag but don't drop the row — the indexer still needs it.
      await getPool().query(
        `INSERT INTO holder_summary (wallet, is_doxxed, display_name, updated_at)
         VALUES ($1, FALSE, NULL, NOW())
         ON CONFLICT (wallet) DO UPDATE
           SET is_doxxed = FALSE,
               display_name = NULL,
               updated_at   = NOW()`,
        [wallet],
      )
    }

    res.status(200).json({
      ok: true,
      wallet,
      isDoxxed: action === 'doxx',
      displayName: action === 'doxx' ? cleanDisplayName : null,
    })
  } catch (e) {
    console.error('doxx error:', e)
    res.status(500).json({ ok: false, error: (e as Error).message })
  }
}
