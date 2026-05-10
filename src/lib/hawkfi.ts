// Single source of truth for the HawkFi SDK base URL.
//
// `new HawkAPI()` with no argument defaults to https://api2.hawksight.co —
// which CORS-blocks any browser request from our origin. Always go through
// our /api/hawkfi proxy (see api/hawkfi.ts + vercel.json rewrite).
//
// Use `createHawkApi()` instead of constructing HawkAPI directly anywhere.

import type { HawkAPI as HawkAPICtor } from '@hawksightco/hawk-sdk'

export function hawkfiBaseUrl(): string {
  // Same-origin during runtime; tests/SSR fall back to a placeholder that
  // would 404 — better than silently CORS-leaking to upstream.
  if (typeof window !== 'undefined' && window.location?.origin) {
    return `${window.location.origin}/api/hawkfi`
  }
  return '/api/hawkfi'
}

/** Lazy-import + construct so the SDK chunk only loads when actually needed. */
export async function createHawkApi(): Promise<InstanceType<typeof HawkAPICtor>> {
  const { HawkAPI } = await import('@hawksightco/hawk-sdk')
  return new HawkAPI(hawkfiBaseUrl())
}
