// APNs for the iOS app: one HTTP/2 connection to Apple, token-based auth
// (a JWT signed with the team's .p8 key, reused for 50 minutes), one POST per
// device token. Configured by `apns` in config.json:
//   { "keyId": "ABC123DEFG", "teamId": "TEAM123456", "keyPath": "/path/AuthKey_ABC123DEFG.p8",
//     "bundleId": "io.jingtao.boop", "sandbox": true }
// `sandbox` is for builds installed from Xcode; TestFlight and App Store
// builds use the production host. The key is read once from keyPath and never
// logged or written anywhere else.
import { createPrivateKey, randomUUID, sign, type KeyObject } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import http2, { type ClientHttp2Session } from 'node:http2'

export interface ApnsConfig {
  /** The 10-character key id of the APNs auth key (Apple Developer → Keys). */
  keyId: string
  /** The 10-character team id. */
  teamId: string
  /** Path to the `.p8` file; read-only, contents never logged. */
  keyPath: string
  /** The app's bundle id, the `apns-topic`. */
  bundleId: string
  /** `true` for development builds (api.sandbox.push.apple.com). Default: production. */
  sandbox?: boolean
}

export interface ApnsNotification { title: string; body: string; url?: string; tag?: string }

export const APNS_PRODUCTION = 'https://api.push.apple.com'
export const APNS_SANDBOX = 'https://api.sandbox.push.apple.com'
/** Apple accepts a token for an hour; refresh before that, not more often than every 20 minutes. */
const JWT_LIFETIME_S = 50 * 60
/** Hex of any length Apple hands out: 32 bytes on devices, 80 on the simulator (measured 2026-10-27); Apple says not to assume a length. */
export const TOKEN_RE = /^[0-9a-f]{16,512}$/

export class ApnsError extends Error {
  statusCode: number
  reason: string
  constructor(statusCode: number, reason: string) { super(`APNs ${statusCode} ${reason}`); this.statusCode = statusCode; this.reason = reason }
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url')

/** The provider token: ES256 over `{alg,kid}` and `{iss,iat}`, signature as raw r||s. */
export function apnsJwt(key: KeyObject | string, cfg: Pick<ApnsConfig, 'keyId' | 'teamId'>, issuedAt = Math.floor(Date.now() / 1000)) {
  const k = typeof key === 'string' ? createPrivateKey(key) : key
  const header = b64url(JSON.stringify({ alg: 'ES256', kid: cfg.keyId }))
  const payload = b64url(JSON.stringify({ iss: cfg.teamId, iat: issuedAt }))
  const sig = sign('sha256', Buffer.from(`${header}.${payload}`), { key: k, dsaEncoding: 'ieee-p1363' })
  return `${header}.${payload}.${b64url(sig)}`
}

/** One request to `/3/device/<token>`: pseudo-headers, APNs headers and the JSON body. */
export function apnsRequest(cfg: Pick<ApnsConfig, 'bundleId'>, token: string, n: ApnsNotification, jwt: string, now = Math.floor(Date.now() / 1000)) {
  const t = token.toLowerCase()
  if (!TOKEN_RE.test(t)) throw new Error('APNs device token must be hex')
  const headers: Record<string, string> = {
    ':method': 'POST',
    ':path': `/3/device/${t}`,
    authorization: `bearer ${jwt}`,
    'apns-topic': cfg.bundleId,
    'apns-push-type': 'alert',
    'apns-priority': '10',
    'apns-expiration': String(now + 3600),
    'apns-id': randomUUID(),
    'content-type': 'application/json',
  }
  if (n.tag) headers['apns-collapse-id'] = n.tag.slice(0, 64)
  const body = JSON.stringify({ aps: { alert: { title: n.title, body: n.body }, sound: 'default', ...(n.tag ? { 'thread-id': n.tag } : {}) }, url: n.url ?? '/' })
  return { headers, body }
}

export class ApnsSender {
  readonly origin: string
  private readonly cfg: ApnsConfig
  private readonly key: KeyObject
  private readonly now: () => number
  private jwt: { value: string; at: number } | null = null
  private session: ClientHttp2Session | null = null

  constructor(cfg: ApnsConfig, keyPem: string, opts: { origin?: string; now?: () => number } = {}) {
    this.cfg = cfg
    this.key = createPrivateKey(keyPem)
    this.origin = opts.origin ?? (cfg.sandbox ? APNS_SANDBOX : APNS_PRODUCTION)
    this.now = opts.now ?? (() => Math.floor(Date.now() / 1000))
  }

  /** Reads the `.p8` at `cfg.keyPath`. Fails with the path, never the contents. */
  static async fromConfig(cfg: ApnsConfig) {
    for (const k of ['keyId', 'teamId', 'keyPath', 'bundleId'] as const) if (!cfg[k]) throw new Error(`apns.${k} missing in config.json`)
    let pem: string
    try { pem = await readFile(cfg.keyPath, 'utf8') } catch (e) { throw new Error(`cannot read APNs key ${cfg.keyPath}: ${(e as Error).message}`) }
    try { return new ApnsSender(cfg, pem) } catch { throw new Error(`${cfg.keyPath} is not a PEM private key`) }
  }

  private token() {
    const now = this.now()
    if (!this.jwt || now - this.jwt.at >= JWT_LIFETIME_S) this.jwt = { value: apnsJwt(this.key, this.cfg, now), at: now }
    return this.jwt.value
  }

  private connect() {
    if (this.session && !this.session.closed && !this.session.destroyed) return this.session
    const s = http2.connect(this.origin)
    s.on('error', () => { if (this.session === s) this.session = null })
    s.on('close', () => { if (this.session === s) this.session = null })
    this.session = s
    return s
  }

  /** Resolves on 200; rejects with `ApnsError { statusCode, reason }` otherwise (410 Unregistered: drop the token). */
  send(token: string, n: ApnsNotification): Promise<void> {
    const { headers, body } = apnsRequest(this.cfg, token, n, this.token(), this.now())
    return new Promise((resolve, reject) => {
      const session = this.connect()
      const req = session.request(headers)
      let status = 0
      let text = ''
      req.setEncoding('utf8')
      req.on('response', (h) => { status = Number(h[':status'] ?? 0) })
      req.on('data', (c) => { text += c })
      req.on('error', (e) => reject(e))
      req.on('end', () => {
        if (status === 200) return resolve()
        let reason = ''
        try { reason = String(JSON.parse(text).reason ?? '') } catch { /* no JSON */ }
        reject(new ApnsError(status, reason || `HTTP ${status}`))
      })
      req.end(body)
    })
  }

  close() { this.session?.close(); this.session = null }
}

/** What PushService needs from an APNs sender: Apple directly (ApnsSender) or through a host (RelayApnsSender). */
export interface ApnsTransport { readonly origin: string; send(token: string, n: ApnsNotification): Promise<void>; close(): void }

// [host] Inside a hosted sandbox the bot has no APNs key: the host that runs it
// does. Started with DEEPSEEK_BOT_PUSH_RELAY=<host url> and
// DEEPSEEK_BOT_HOST_SECRET, the bot posts each notification to the host's
// POST /host/push and the host talks to Apple (src/host/server.ts).
export class RelayApnsSender implements ApnsTransport {
  readonly origin: string
  private readonly secret: string
  private readonly fetchImpl: typeof fetch
  constructor(hostUrl: string, hostSecret: string, fetchImpl: typeof fetch = fetch) { this.origin = hostUrl.replace(/\/$/, ''); this.secret = hostSecret; this.fetchImpl = fetchImpl }

  async send(token: string, n: ApnsNotification): Promise<void> {
    const t = token.toLowerCase()
    if (!TOKEN_RE.test(t)) throw new Error('APNs device token must be hex')
    const res = await this.fetchImpl(`${this.origin}/host/push`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.secret}` },
      body: JSON.stringify({ kind: 'apns', token: t, title: n.title, body: n.body, url: n.url ?? '/', tag: n.tag }),
    })
    if (res.ok) return
    let reason = ''
    try { reason = String((await res.json() as { error?: string; reason?: string }).error ?? '') } catch { /* no JSON */ }
    throw new ApnsError(res.status, reason || `HTTP ${res.status}`)
  }

  close() {}
}
