// Sign in with Apple: verify the identity token the iOS app got from
// ASAuthorizationAppleIDCredential. Per Apple's "Verifying a user" docs
// (developer.apple.com/documentation/sign_in_with_apple/verifying_a_user,
// read 2026-10-27): the token is a JWT signed with one of the RS256 keys at
// https://appleid.apple.com/auth/keys (matched by `kid`); check `iss` is
// https://appleid.apple.com, `aud` is the app's bundle id, and `exp` is in the
// future. `sub` is the stable user id. Unit-tested against a locally generated
// key pair and JWKS (test/host.test.ts); not run against Apple itself.
import { createPublicKey, verify, type KeyObject } from 'node:crypto'

export const APPLE_JWKS_URL = 'https://appleid.apple.com/auth/keys'
export const APPLE_ISSUER = 'https://appleid.apple.com'

export interface AppleVerifyOptions {
  bundleId: string
  jwksUrl?: string
  fetchImpl?: typeof fetch
  now?: () => number
}

export interface AppleIdentity { sub: string; email?: string; emailVerified?: boolean }

interface Jwk { kid: string; kty: string; alg?: string; n?: string; e?: string; use?: string }

const cache = new Map<string, { keys: Jwk[]; at: number }>()

async function jwks(url: string, f: typeof fetch, force = false): Promise<Jwk[]> {
  const c = cache.get(url)
  if (c && !force && Date.now() - c.at < 60 * 60_000) return c.keys
  const res = await f(url)
  if (!res.ok) throw new Error(`Apple JWKS ${res.status}`)
  const body = await res.json() as { keys: Jwk[] }
  cache.set(url, { keys: body.keys, at: Date.now() })
  return body.keys
}

const b64json = (s: string) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8')) as Record<string, unknown>

export async function verifyAppleIdentityToken(token: string, o: AppleVerifyOptions): Promise<AppleIdentity> {
  const parts = String(token).split('.')
  if (parts.length !== 3) throw new Error('identity token is not a JWT')
  let header: { alg?: string; kid?: string }, claims: Record<string, unknown>
  try { header = b64json(parts[0]) as { alg?: string; kid?: string }; claims = b64json(parts[1]) } catch { throw new Error('identity token is not a JWT') }
  if (header.alg !== 'RS256') throw new Error(`unexpected algorithm ${header.alg}`)
  const f = o.fetchImpl ?? fetch
  const url = o.jwksUrl ?? APPLE_JWKS_URL
  let key = (await jwks(url, f)).find((k) => k.kid === header.kid)
  if (!key) key = (await jwks(url, f, true)).find((k) => k.kid === header.kid) // Apple rotates keys; refresh once
  if (!key) throw new Error(`no Apple key with kid ${header.kid}`)
  let pub: KeyObject
  try { pub = createPublicKey({ key: key as unknown as Record<string, string>, format: 'jwk' }) } catch { throw new Error('bad key in Apple JWKS') }
  const ok = verify('sha256', Buffer.from(`${parts[0]}.${parts[1]}`), pub, Buffer.from(parts[2], 'base64url'))
  if (!ok) throw new Error('identity token signature does not verify')
  if (claims.iss !== APPLE_ISSUER) throw new Error(`wrong issuer ${String(claims.iss)}`)
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
  if (!aud.includes(o.bundleId)) throw new Error(`wrong audience ${JSON.stringify(claims.aud)}`)
  const now = Math.floor((o.now ?? Date.now)() / 1000)
  if (typeof claims.exp !== 'number' || claims.exp <= now) throw new Error('identity token expired')
  if (typeof claims.sub !== 'string' || !claims.sub) throw new Error('identity token has no sub')
  return { sub: claims.sub, email: typeof claims.email === 'string' ? claims.email : undefined, emailVerified: claims.email_verified === true || claims.email_verified === 'true' }
}
