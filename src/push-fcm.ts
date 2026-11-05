// FCM for the Android app, through Firebase's HTTP v1 API: an OAuth access token from the project's service
// account (a JWT signed with its key, exchanged at Google's token endpoint, reused until five minutes before it
// expires), then one POST per device token. Configured by `fcm` in config.json:
//   { "serviceAccountPath": "/path/firebase-service-account.json" }
// The file is the one Firebase console → Project settings → Service accounts → Generate new private key gives;
// it is read once and its key never logged.
//
// The message is data-only (title, body, url, tag) with high priority: the app's FirebaseMessagingService builds
// the notification itself, in the foreground and the background alike, so a tap always carries the url
// (android/app/src/main/java/dev/deepseekbot/app/PushService.java).
import { createPrivateKey, sign, type KeyObject } from 'node:crypto'
import { readFile } from 'node:fs/promises'

export interface FcmConfig { serviceAccountPath: string }
interface ServiceAccount { project_id: string; client_email: string; private_key: string; token_uri?: string }
export interface FcmNotification { title: string; body: string; url?: string; tag?: string }

export const FCM_ORIGIN = 'https://fcm.googleapis.com'
export const GOOGLE_TOKEN_URI = 'https://oauth2.googleapis.com/token'
const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging'
/** FCM registration tokens: URL-safe base64 plus `:`; ~160 characters today, no fixed length promised. */
export const FCM_TOKEN_RE = /^[A-Za-z0-9_:\-]{20,4096}$/

export class FcmError extends Error {
  statusCode: number
  reason: string
  constructor(statusCode: number, reason: string) { super(`FCM ${statusCode} ${reason}`); this.statusCode = statusCode; this.reason = reason }
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url')

/** The assertion for Google's token endpoint: RS256 over {alg,typ} / {iss,scope,aud,iat,exp}. */
export function fcmAssertion(key: KeyObject | string, account: Pick<ServiceAccount, 'client_email' | 'token_uri'>, issuedAt = Math.floor(Date.now() / 1000)) {
  const k = typeof key === 'string' ? createPrivateKey(key) : key
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const claims = b64url(JSON.stringify({ iss: account.client_email, scope: SCOPE, aud: account.token_uri || GOOGLE_TOKEN_URI, iat: issuedAt, exp: issuedAt + 3600 }))
  return `${header}.${claims}.${b64url(sign('sha256', Buffer.from(`${header}.${claims}`), k))}`
}

/** One `messages:send` body for one token. */
export function fcmMessage(token: string, n: FcmNotification) {
  if (!FCM_TOKEN_RE.test(token)) throw new Error('FCM token has unexpected characters')
  const data: Record<string, string> = { title: n.title, body: n.body, url: n.url ?? '/' }
  if (n.tag) data.tag = n.tag
  return { message: { token, data, android: { priority: 'HIGH', ttl: '3600s', ...(n.tag ? { collapse_key: n.tag.slice(0, 64) } : {}) } } }
}

/** What PushService needs from an FCM sender: Google directly (FcmSender) or through a host (RelayFcmSender). */
export interface FcmTransport { readonly origin: string; send(token: string, n: FcmNotification): Promise<void>; close(): void }

export class FcmSender implements FcmTransport {
  readonly origin: string
  private readonly account: ServiceAccount
  private readonly key: KeyObject
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number
  private access: { value: string; until: number } | null = null

  constructor(account: ServiceAccount, opts: { origin?: string; fetch?: typeof fetch; now?: () => number } = {}) {
    this.account = account
    this.key = createPrivateKey(account.private_key)
    this.origin = (opts.origin ?? FCM_ORIGIN).replace(/\/$/, '')
    this.fetchImpl = opts.fetch ?? fetch
    this.now = opts.now ?? (() => Math.floor(Date.now() / 1000))
  }

  /** Reads the service account file. Fails with the path, never the contents. */
  static async fromConfig(cfg: FcmConfig) {
    if (!cfg.serviceAccountPath) throw new Error('fcm.serviceAccountPath missing in config.json')
    let account: ServiceAccount
    try { account = JSON.parse(await readFile(cfg.serviceAccountPath, 'utf8')) } catch (e) { throw new Error(`cannot read the FCM service account ${cfg.serviceAccountPath}: ${(e as Error).message.split('\n')[0]}`) }
    for (const k of ['project_id', 'client_email', 'private_key'] as const) if (!account[k]) throw new Error(`${cfg.serviceAccountPath} has no ${k}: is it a service account key?`)
    try { return new FcmSender(account) } catch { throw new Error(`${cfg.serviceAccountPath}: private_key is not a PEM private key`) }
  }

  private async token() {
    const now = this.now()
    if (this.access && now < this.access.until) return this.access.value
    const res = await this.fetchImpl(this.account.token_uri || GOOGLE_TOKEN_URI, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: fcmAssertion(this.key, this.account, now) }).toString(),
    })
    const body = await res.json().catch(() => ({})) as { access_token?: string; expires_in?: number; error?: string }
    if (!res.ok || !body.access_token) throw new FcmError(res.status || 502, `token: ${body.error ?? 'no access_token'}`)
    this.access = { value: body.access_token, until: now + Math.max(60, (body.expires_in ?? 3600) - 300) }
    return this.access.value
  }

  /** Resolves on 200; rejects with `FcmError { statusCode, reason }` otherwise (404 / UNREGISTERED: drop the token). */
  async send(token: string, n: FcmNotification): Promise<void> {
    const body = JSON.stringify(fcmMessage(token, n))
    const res = await this.fetchImpl(`${this.origin}/v1/projects/${encodeURIComponent(this.account.project_id)}/messages:send`, {
      method: 'POST', headers: { authorization: `Bearer ${await this.token()}`, 'content-type': 'application/json' }, body,
    })
    if (res.ok) return
    // {error: {code, status, details: [{'@type': '...FcmError', errorCode: 'UNREGISTERED'}]}}
    const e = await res.json().catch(() => ({})) as { error?: { status?: string; details?: { errorCode?: string }[] } }
    const reason = e.error?.details?.find((d) => d.errorCode)?.errorCode ?? e.error?.status ?? `HTTP ${res.status}`
    throw new FcmError(res.status, reason)
  }

  close() {}
}

/** Gone for good: Firebase says the app was uninstalled or the token expired. */
export const fcmTokenGone = (e: { statusCode?: number; reason?: string }) => e.statusCode === 404 || e.reason === 'UNREGISTERED'

// [host] Inside a hosted sandbox the bot has no service account: the host does. Same relay as APNs
// (src/push-apns.ts RelayApnsSender), with kind 'fcm'.
export class RelayFcmSender implements FcmTransport {
  readonly origin: string
  private readonly secret: string
  private readonly fetchImpl: typeof fetch
  constructor(hostUrl: string, hostSecret: string, fetchImpl: typeof fetch = fetch) { this.origin = hostUrl.replace(/\/$/, ''); this.secret = hostSecret; this.fetchImpl = fetchImpl }

  async send(token: string, n: FcmNotification): Promise<void> {
    if (!FCM_TOKEN_RE.test(token)) throw new Error('FCM token has unexpected characters')
    const res = await this.fetchImpl(`${this.origin}/host/push`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.secret}` },
      body: JSON.stringify({ kind: 'fcm', token, title: n.title, body: n.body, url: n.url ?? '/', tag: n.tag }),
    })
    if (res.ok) return
    let reason = ''
    try { reason = String((await res.json() as { error?: string }).error ?? '') } catch { /* no JSON */ }
    throw new FcmError(res.status, reason || `HTTP ${res.status}`)
  }

  close() {}
}
