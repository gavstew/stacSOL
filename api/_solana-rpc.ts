// Lightweight Solana RPC helpers for Vercel serverless functions.
//
// We can't import @solana/web3.js directly here because its transitive
// dep chain (rpc-websockets → uuid@14) breaks under @vercel/node's CJS
// runtime: `Error [ERR_REQUIRE_ESM]: require() of ES Module ... uuid ...`.
// Hitting that wedge took down /api/snapshot and /api/referral-index
// in production. This module bypasses the problem entirely by talking
// raw JSON-RPC over fetch + computing PDAs / ATAs against tweetnacl
// (already in the dep tree as a sibling of @solana/wallet-adapter).

import { createHash } from 'crypto'
import bs58 from 'bs58'

const PDA_MARKER_BYTES = Buffer.from('ProgramDerivedAddress')
// Matches the curve check that PublicKey.findProgramAddressSync uses
// internally: a candidate is a valid PDA iff it's NOT a point on the
// ed25519 curve. tweetnacl exposes the curve-decompress check via
// `nacl.sign.detached.verify` indirectly — but the cleanest direct
// route is to attempt point decompression. We do this by treating the
// 32 bytes as a compressed ed25519 public key and checking whether
// scalar-multiplication can recover a valid point. tweetnacl doesn't
// expose that directly, so we fall back to the simpler check used by
// `@solana/web3.js`: try `nacl.sign.keyPair.fromSeed(...)` on the bytes
// — that always succeeds. Instead, follow web3.js's approach: a
// candidate is on-curve iff `nacl.lowlevel.unpack(Y, …)` returns 0.
// Since tweetnacl doesn't export `lowlevel`, we re-implement the
// minimal curve check here using the standard ed25519 decompression
// algorithm.

// ed25519 prime p = 2^255 - 19
const P = (1n << 255n) - 19n
// d = -121665/121666 mod p
const D = (-121665n * modInverse(121666n, P)) % P + P

function mod(a: bigint, m: bigint): bigint {
  const r = a % m
  return r < 0n ? r + m : r
}

function modInverse(a: bigint, m: bigint): bigint {
  // Extended Euclidean algorithm.
  let [old_r, r] = [a, m]
  let [old_s, s] = [1n, 0n]
  while (r !== 0n) {
    const q = old_r / r
    ;[old_r, r] = [r, old_r - q * r]
    ;[old_s, s] = [s, old_s - q * s]
  }
  return mod(old_s, m)
}

function modPow(b: bigint, e: bigint, m: bigint): bigint {
  let result = 1n
  let base = mod(b, m)
  let exp = e
  while (exp > 0n) {
    if (exp & 1n) result = mod(result * base, m)
    exp >>= 1n
    base = mod(base * base, m)
  }
  return result
}

/**
 * ed25519 point-decompression test. Returns true iff the 32 bytes
 * represent a valid point on the curve. PDAs must NOT be on-curve —
 * findProgramAddress rejects on-curve candidates.
 *
 * Algorithm: parse y from the low 255 bits, x_sign from bit 255, then
 * solve for x in `y² - 1 = (d·y² + 1) · x²` (mod p). The candidate is
 * on-curve iff that equation has a solution and the recovered x has the
 * expected parity bit.
 */
function isOnCurveEd25519(bytes: Uint8Array): boolean {
  if (bytes.length !== 32) return false
  // Read y as little-endian, top bit is x_sign.
  let y = 0n
  for (let i = 0; i < 32; i++) {
    y |= BigInt(bytes[i]) << BigInt(i * 8)
  }
  const sign = Number((y >> 255n) & 1n)
  y &= (1n << 255n) - 1n
  if (y >= P) return false
  const y2 = (y * y) % P
  const u = mod(y2 - 1n, P)
  const v = mod(D * y2 + 1n, P)
  // x = u * v^3 * (u * v^7)^((p-5)/8)
  const v3 = (v * v * v) % P
  const v7 = (v3 * v3 * v) % P
  const exp = (P - 5n) / 8n
  let x = (u * v3 * modPow(u * v7, exp, P)) % P
  // Validate x² · v == u (mod p). If not, multiply by sqrt(-1).
  const vx2 = (v * x * x) % P
  if (mod(vx2 - u, P) !== 0n) {
    if (mod(vx2 + u, P) === 0n) {
      // x = x * 2^((p-1)/4)
      const I = modPow(2n, (P - 1n) / 4n, P)
      x = (x * I) % P
    } else {
      return false
    }
  }
  if (x === 0n && sign === 1) return false
  if (Number(x & 1n) !== sign) x = P - x
  return mod(x * x * v - u, P) === 0n
}

function sha256(...chunks: Uint8Array[]): Buffer {
  const h = createHash('sha256')
  for (const c of chunks) h.update(c)
  return h.digest()
}

export class RpcPubkey {
  public readonly bytes: Uint8Array
  constructor(input: string | Uint8Array) {
    if (typeof input === 'string') {
      this.bytes = bs58.decode(input)
    } else if (input.length === 32) {
      this.bytes = input
    } else {
      throw new Error(`bad pubkey length ${input.length}`)
    }
    if (this.bytes.length !== 32) {
      throw new Error(`bad pubkey length ${this.bytes.length}`)
    }
  }
  toBytes(): Uint8Array {
    return this.bytes
  }
  toString(): string {
    return bs58.encode(this.bytes)
  }
  equals(other: RpcPubkey): boolean {
    if (this.bytes.length !== other.bytes.length) return false
    for (let i = 0; i < 32; i++) {
      if (this.bytes[i] !== other.bytes[i]) return false
    }
    return true
  }
}

/**
 * Mirror of `PublicKey.findProgramAddressSync` — walk bumps from 255
 * downwards, hashing `seeds || programId || bump || "ProgramDerivedAddress"`,
 * and return the first hash that's NOT on the ed25519 curve.
 */
export function findProgramAddressSync(
  seeds: (Uint8Array | Buffer)[],
  programId: RpcPubkey,
): { pubkey: RpcPubkey; bump: number } {
  for (let bump = 255; bump >= 0; bump--) {
    const candidate = sha256(
      ...seeds.map((s) => Buffer.from(s)),
      Buffer.from([bump]),
      programId.toBytes(),
      PDA_MARKER_BYTES,
    )
    if (!isOnCurveEd25519(new Uint8Array(candidate))) {
      return { pubkey: new RpcPubkey(new Uint8Array(candidate)), bump }
    }
  }
  throw new Error('Unable to find PDA')
}

const ATA_PROGRAM = new RpcPubkey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')

/** Token-2022 / SPL-Token associated token account derivation. */
export function deriveAssociatedTokenAddress(
  owner: RpcPubkey,
  mint: RpcPubkey,
  tokenProgram: RpcPubkey,
): RpcPubkey {
  return findProgramAddressSync(
    [owner.toBytes(), tokenProgram.toBytes(), mint.toBytes()],
    ATA_PROGRAM,
  ).pubkey
}

// ─── JSON-RPC plumbing ─────────────────────────────────────────────────

interface RpcResponse<T> {
  jsonrpc: '2.0'
  id: number
  result?: T
  error?: { code: number; message: string; data?: unknown }
}

let counter = 0

export async function rpcCall<T>(
  endpoint: string,
  method: string,
  params: unknown[],
): Promise<T> {
  counter += 1
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: counter,
      method,
      params,
    }),
  })
  if (!res.ok) {
    throw new Error(`RPC ${method} HTTP ${res.status}`)
  }
  const json = (await res.json()) as RpcResponse<T>
  if (json.error) {
    throw new Error(`RPC ${method}: ${json.error.message}`)
  }
  if (json.result === undefined) {
    throw new Error(`RPC ${method}: empty response`)
  }
  return json.result
}

/**
 * Batched JSON-RPC. Each entry must use a unique numeric id (we generate
 * them here). Returns results in the same order as `requests`.
 */
export async function rpcBatch<T>(
  endpoint: string,
  requests: { method: string; params: unknown[] }[],
): Promise<T[]> {
  if (requests.length === 0) return []
  const ids = requests.map(() => {
    counter += 1
    return counter
  })
  const body = requests.map((r, i) => ({
    jsonrpc: '2.0',
    id: ids[i],
    method: r.method,
    params: r.params,
  }))
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    throw new Error(`RPC batch HTTP ${res.status}`)
  }
  const json = (await res.json()) as RpcResponse<T>[]
  const byId = new Map<number, RpcResponse<T>>()
  for (const r of json) byId.set(r.id, r)
  const out: T[] = []
  for (let i = 0; i < requests.length; i++) {
    const entry = byId.get(ids[i])
    if (!entry) throw new Error(`RPC batch missing response id=${ids[i]}`)
    if (entry.error) {
      throw new Error(`RPC ${requests[i].method}: ${entry.error.message}`)
    }
    if (entry.result === undefined) {
      throw new Error(`RPC ${requests[i].method}: empty response`)
    }
    out.push(entry.result)
  }
  return out
}

// ─── Typed RPC wrappers ────────────────────────────────────────────────

export interface SignatureInfo {
  signature: string
  slot: number
  blockTime: number | null
  err: unknown | null
  memo: string | null
  confirmationStatus?: string
}

export async function getSignaturesForAddress(
  endpoint: string,
  address: string,
  opts: { before?: string; until?: string; limit?: number } = {},
): Promise<SignatureInfo[]> {
  const params: unknown[] = [address]
  const cfg: Record<string, unknown> = { commitment: 'confirmed' }
  if (opts.before) cfg.before = opts.before
  if (opts.until) cfg.until = opts.until
  if (opts.limit) cfg.limit = opts.limit
  params.push(cfg)
  return rpcCall<SignatureInfo[]>(endpoint, 'getSignaturesForAddress', params)
}

// Subset of the parsed-tx schema we actually use in the indexer.
export interface ParsedAccountKey {
  pubkey: string
  signer: boolean
  writable: boolean
  source?: string
}

export interface ParsedInstructionRpc {
  program?: string
  programId?: string
  accounts?: string[]
  data?: string
  parsed?: unknown
}

export interface InnerInstructionsRpc {
  index: number
  instructions: ParsedInstructionRpc[]
}

export interface TokenBalanceRpc {
  accountIndex: number
  mint: string
  owner?: string
  programId?: string
  uiTokenAmount: { amount: string; decimals: number; uiAmount: number | null }
}

export interface ParsedTransactionRpc {
  slot: number
  blockTime: number | null
  meta: {
    err: unknown | null
    fee: number
    preBalances: number[]
    postBalances: number[]
    preTokenBalances?: TokenBalanceRpc[]
    postTokenBalances?: TokenBalanceRpc[]
    innerInstructions?: InnerInstructionsRpc[]
  } | null
  transaction: {
    message: {
      accountKeys: ParsedAccountKey[]
      instructions: ParsedInstructionRpc[]
    }
    signatures: string[]
  }
}

export async function getParsedTransaction(
  endpoint: string,
  sig: string,
): Promise<ParsedTransactionRpc | null> {
  const res = await rpcCall<ParsedTransactionRpc | null>(
    endpoint,
    'getTransaction',
    [
      sig,
      {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
        encoding: 'jsonParsed',
      },
    ],
  )
  return res
}

export interface AccountInfoRpc {
  data: [string, string] // [base64, "base64"]
  executable: boolean
  lamports: number
  owner: string
  rentEpoch: number
  space: number
}

export async function getAccountInfoBase64(
  endpoint: string,
  address: string,
  commitment: 'processed' | 'confirmed' | 'finalized' = 'processed',
): Promise<AccountInfoRpc | null> {
  const res = await rpcCall<{ value: AccountInfoRpc | null }>(
    endpoint,
    'getAccountInfo',
    [address, { commitment, encoding: 'base64' }],
  )
  return res.value
}

export async function getMultipleAccountsBase64(
  endpoint: string,
  addresses: string[],
  commitment: 'processed' | 'confirmed' | 'finalized' = 'processed',
): Promise<(AccountInfoRpc | null)[]> {
  if (addresses.length === 0) return []
  const res = await rpcCall<{ value: (AccountInfoRpc | null)[] }>(
    endpoint,
    'getMultipleAccounts',
    [addresses, { commitment, encoding: 'base64' }],
  )
  return res.value
}

export function decodeAccountData(acc: AccountInfoRpc): Buffer {
  return Buffer.from(acc.data[0], 'base64')
}

