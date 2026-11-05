// The host: accounts → one sandbox each → the phone's requests forwarded to it.
//   POST /host/sign-in   {email} (dev) | {apple: identityToken}      → {accountToken}
//   POST /host/sandbox   create (or wake) this account's sandbox      → {state, origin, token, sandboxId}
//   GET  /host/sandbox   poll                                         → same
//   DELETE /host/sandbox remove it, data volume included
//   GET  /host/me        → {id, email}
//   POST /host/push      bearer = host secret; {kind:'apns'|'fcm', token, title, body, url, tag} → {ok}
//   POST /host/admin/rotate-tokens  bearer = admin token; {account} | {email} → new sandbox device tokens, old ones revoked (docs/hosting.md)
//   /s/<sandboxId>/*     HTTP + WebSocket to the sandbox's bot; the account token (x-account header,
//                        `account` cookie or ?account=) must own the sandbox; the bot inside checks the device token.
// Idle sandboxes are stopped (schedules read first); a request or a due
// schedule starts them again.
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import { timingSafeEqual, randomBytes, createHash } from 'node:crypto'
import { readFile, writeFile, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { WebSocketServer, WebSocket } from 'ws'
import { AccountStore, type Account, type SandboxRecord } from './accounts.ts'
import { verifyAppleIdentityToken } from './apple.ts'
import { waitHealthy, type SandboxProvider } from '../sandbox/provider.ts'
import { bearerToken } from '../devices.ts'
import { TOKEN_RE, type ApnsTransport } from '../push-apns.ts'
import { FCM_TOKEN_RE, type FcmTransport } from '../push-fcm.ts'
import { serveStatic } from '../server.ts'
import { uiLang } from '../lang.ts'
import type { Lang } from '../locales/index.ts'
import { deletePage, openPage, privacyPage, termsPage, type LegalInfo } from '../legal.ts' // [compliance]
import { REPORT_REASONS, type AiProvider } from '../compliance.ts' // [compliance]
import { pageLang } from '../oauth.ts'

export interface HostOptions {
  provider: SandboxProvider
  /** Image every sandbox runs. */
  image: string
  /** Where phones reach this host; sandbox origins are `<publicUrl>/s/<id>`. Default: the address this server binds. */
  publicUrl?: string
  accountsPath: string
  /** Shared with every sandbox as DEEPSEEK_BOT_HOST_SECRET: pairing on the account's behalf, and the push relay's bearer. */
  hostSecret: string
  /** Environment for the bot inside (model key and flags). */
  sandboxEnv: Record<string, string>
  /** DEEPSEEK_BOT_PUSH_RELAY handed to sandboxes; default `publicUrl`. From a Docker container on this machine that is `http://host.docker.internal:<port>`. */
  relayUrl?: string
  /** `{email}` sign-in with no verification at all. Development only. */
  devSignIn?: boolean
  /** The owner's access code: email sign-in needs it (and turns on without --dev-sign-in). */
  accessCode?: string
  /** At most this many accounts; new ones are refused beyond it. */
  maxAccounts?: number
  apple?: { bundleId: string; jwksUrl?: string }
  /** The host's own APNs sender (the App Store key); null = relay answers 503. */
  apns?: ApnsTransport | null
  /** [push] FCM for Android phones (src/push-fcm.ts): the host's Firebase service account. */
  fcm?: FcmTransport | null
  idleMinutes?: number
  /** How often the idle/wake sweep runs; 0 = only when `sweep()` is called. */
  sweepMs?: number
  /** Sandboxes made ahead and kept suspended, so sign-in hands one over instead of building one (measured on Fly: 1.6 s instead of 20 s). */
  warm?: number
  /** How long POST /host/sandbox waits for a new sandbox before answering `creating`. */
  createWaitMs?: number
  healthTimeoutMs?: number
  /** Prefix for new account/sandbox ids (tests: `test-`). */
  idPrefix?: string
  now?: () => number
  host?: string
  port?: number
  /** The app's browser build to serve at `/` (the bot's `app/`); the page learns this host's URL from a meta tag. */
  appDir?: string
  // [compliance]
  /** Universal links / App Links for /open/*: `<TeamID>.<bundle id>` for iOS, the package and its signing certificate's SHA-256 for Android. */
  links?: { appleAppIds?: string[]; androidPackage?: string; androidCertSha256?: string[] }
  /** Bearer for /host/admin/* (reports). Not the host secret: every sandbox has that one. */
  adminToken?: string
  /** Who runs this host and how to reach them, for the privacy policy and terms. */
  operator?: string
  contact?: string
  /** The AI provider every sandbox sends to, and the moderation service, if any: named in the privacy policy. */
  ai?: AiProvider
  filter?: string | null
  hosting?: string
}

/** [compliance] A report as the operator sees it (GET /host/admin/reports). */
export interface HostReport {
  id: string; at: string; dueBy: string; source: 'sandbox' | 'app'; account?: string; sandbox?: string
  kind: 'reply' | 'interface'; reason: string; note?: string; excerpt?: string; moduleId?: string; moduleTitle?: string; moduleSource?: string; sessionId?: string; rowId?: string
  status: 'open' | 'resolved' | 'dismissed'; action?: 'none' | 'block-interface' | 'suspend-account'; resolvedAt?: string; resolution?: string
}
/** How long the operator has to answer a report; the terms promise it. */
export const REPORT_RESPONSE_HOURS = 24

export interface HostServer { origin: string; close(): Promise<void>; sweep(): Promise<void>; accounts: AccountStore; /** Resolves when the warm pool is full (tests). */ warmed(): Promise<void> }

const HOP = new Set(['host', 'connection', 'upgrade', 'keep-alive', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'x-account', 'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-extensions'])

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

async function readBody(req: IncomingMessage, limit = 256 << 10): Promise<string> {
  let s = ''
  for await (const c of req) { s += c; if (s.length > limit) throw new Error('body too large') }
  return s
}

const sameSecret = (a: string | null | undefined, b: string) => Boolean(a) && a!.length === b.length && timingSafeEqual(Buffer.from(a!), Buffer.from(b))

export async function createHostServer(o: HostOptions): Promise<HostServer> {
  const accounts = await AccountStore.open(o.accountsPath, { idPrefix: o.idPrefix })
  const now = o.now ?? Date.now
  const idleMs = (o.idleMinutes ?? 30) * 60_000
  let publicUrl = (o.publicUrl ?? '').replace(/\/$/, '')
  const log = (s: string) => console.log(`[host] ${s}`)
  if (o.devSignIn) console.warn('[host] --dev-sign-in: POST /host/sign-in {email} creates accounts WITHOUT verifying anything. Development only.')

  /** Open WebSockets per sandbox: a connected phone keeps it awake. */
  const conns = new Map<string, number>()
  /** The same sockets, so a token rotation can cut them. */
  const sockets = new Map<string, Set<WebSocket>>()
  /** One in-flight create/wake per sandbox. */
  const jobs = new Map<string, Promise<void>>()

  // Wrong access codes per client: five in ten minutes and that client waits out the window.
  const misses = new Map<string, number[]>()
  const WINDOW = 10 * 60_000
  const recent = (who: string) => (misses.get(who) ?? []).filter((t) => now() - t < WINDOW)
  const tooManyWrong = (who: string) => recent(who).length >= 5
  const wrong = (who: string) => { misses.set(who, [...recent(who), now()]) }

  // [compliance] Reports, kept next to accounts.json; anonymous ones (a phone paired with its own computer) are limited per address.
  const reportsPath = join(dirname(o.accountsPath), 'reports.json')
  let reports: HostReport[] = []
  try { reports = JSON.parse(await readFile(reportsPath, 'utf8')) } catch {}
  const saveReports = async () => { const tmp = `${reportsPath}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`; await writeFile(tmp, JSON.stringify(reports, null, 2) + '\n', { mode: 0o600 }); await rename(tmp, reportsPath) }
  const anonReports = new Map<string, number[]>()
  const legal = (): LegalInfo => ({ operator: o.operator ?? 'Boop', contact: o.contact ?? '', hostUrl: publicUrl, ai: o.ai, filter: o.filter, hosting: o.hosting })
  const html = (res: ServerResponse, status: number, body: string) => { res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'" }); res.end(body) }
  /** Delete an account: its computer (disk included), its record and tokens, and its reports. */
  const deleteAccount = async (acct: Account) => {
    if (acct.sandbox) { try { await o.provider.remove(acct.sandbox.id) } catch (e) { if (await o.provider.status(acct.sandbox.id) !== 'missing') throw e } }
    await accounts.remove(acct.id)
    const n = reports.length; reports = reports.filter((r) => r.account !== acct.id); if (reports.length !== n) await saveReports()
    log(`account ${acct.id} deleted${acct.sandbox ? ` with sandbox ${acct.sandbox.id}` : ''}`)
  }
  const sameAdmin = (t: string | null) => Boolean(o.adminToken) && sameSecret(t, o.adminToken!)

  // The warm pool: ids of sandboxes built ahead and suspended, persisted next to accounts.json with
  // the image they were made from. After a deploy (a new image) the old ones are removed before the
  // host takes requests, so the next account gets the deployed code, not the previous build.
  const poolPath = join(dirname(o.accountsPath), 'pool.json')
  let pool: string[] = []
  let poolImage: string | undefined
  let poolEnv: string | undefined
  // what a warm sandbox was made with: the image and a hash of its environment (a new model key must reach the next account; values are never stored)
  const envHash = createHash('sha256').update(JSON.stringify(Object.entries(o.sandboxEnv).sort())).digest('hex').slice(0, 16)
  try { const v = JSON.parse(await readFile(poolPath, 'utf8')) as string[] | { image?: string; env?: string; ids?: string[] }; if (Array.isArray(v)) pool = v; else { pool = v.ids ?? []; poolImage = v.image; poolEnv = v.env } } catch {}
  const savePool = async () => { const tmp = `${poolPath}.${process.pid}.${Date.now()}.tmp`; await writeFile(tmp, JSON.stringify({ image: o.image, env: envHash, ids: pool })); await rename(tmp, poolPath) }
  if (pool.length && (poolImage !== o.image || poolEnv !== envHash)) {
    for (const id of pool) { try { await o.provider.remove(id); log(`warm sandbox ${id} was made from ${poolImage !== o.image ? (poolImage ?? 'an earlier image') : 'an earlier environment'}; removed`) } catch (e) { log(`warm pool: removing ${id}: ${(e as Error).message}`) } }
    pool = []; await savePool()
  }
  let warming: Promise<void> | null = null
  const refill = (): Promise<void> => {
    if (warming) return warming
    warming = (async () => {
      try {
        for (let i = 0; i < pool.length; i++) if (await o.provider.status(pool[i]) === 'missing') { pool.splice(i--, 1); await savePool() }
        while (pool.length < (o.warm ?? 0)) {
          const id = `${o.idPrefix ?? ''}pool-${randomBytes(3).toString('hex')}`
          const t0 = Date.now()
          const sb = await o.provider.create(id, { image: o.image, env: sandboxEnv(id) })
          await waitHealthy(sb.origin, { timeoutMs: o.healthTimeoutMs })
          await o.provider.stop(id)
          pool.push(id); await savePool()
          log(`warm sandbox ${id} ready and suspended in ${((Date.now() - t0) / 1000).toFixed(1)}s (${pool.length}/${o.warm})`)
        }
      } catch (e) { log(`warm pool: ${(e as Error).message}`) } finally { warming = null }
    })()
    return warming
  }

  // DEEPSEEK_BOT_PUBLIC_URL: where a browser reaches this sandbox's bot, for OAuth redirects (src/oauth.ts) — stable because a warm sandbox keeps its id.
  const sandboxEnv = (id: string) => ({ ...o.sandboxEnv, DEEPSEEK_BOT_HOST_SECRET: o.hostSecret, DEEPSEEK_BOT_PUSH_RELAY: (o.relayUrl ?? publicUrl).replace(/\/$/, ''), DEEPSEEK_BOT_PUBLIC_URL: `${publicUrl}/s/${id}` })

  // `role: 'host'` marks the host's own pairing: the bot hides it from the person's Devices and refuses its removal by a phone.
  // The phone's pairing is named "phone" until the app names it (PATCH /devices/me) when it first connects.
  const pair = async (origin: string, name: string, role?: 'host') => {
    const r = await fetch(`${origin}/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostSecret: o.hostSecret, name, ...(role ? { role } : {}) }), signal: AbortSignal.timeout(10_000) })
    if (!r.ok) throw new Error(`pairing ${name} failed: HTTP ${r.status}`)
    return (await r.json() as { token: string }).token
  }

  /** Create the account's sandbox: container → healthy → two devices (host, phone). */
  const create = (acct: Account): Promise<void> => {
    // a new account takes a warm sandbox when one is ready; the pool refills behind it
    const claimed = !acct.sandbox && pool.length ? pool.shift()! : null
    if (claimed) { void savePool(); setTimeout(() => { refill().catch(() => {}) }, 0) }
    const id = acct.sandbox?.id ?? claimed ?? acct.id
    const running = jobs.get(id); if (running) return running
    const job = (async () => {
      await accounts.setSandbox(acct.id, { id, state: 'creating', lastSeenAt: new Date(now()).toISOString(), wakeAt: null, ...(acct.sandbox ? { hostToken: acct.sandbox.hostToken, phoneToken: acct.sandbox.phoneToken } : {}) })
      try {
        const t0 = Date.now()
        const st = await o.provider.status(id)
        if (st === 'stopped') await o.provider.start(id) // a warm one, or one that was idle when its account came back
        const sb = st === 'missing' ? await o.provider.create(id, { image: o.image, env: sandboxEnv(id) }) : (await o.provider.get(id))!
        await waitHealthy(sb.origin, { timeoutMs: o.healthTimeoutMs })
        // a sandbox recreated over an existing volume still knows the old devices; pair anew only when we have no tokens
        const hostToken = acct.sandbox?.hostToken ?? await pair(sb.origin, 'host', 'host')
        const phoneToken = acct.sandbox?.phoneToken ?? await pair(sb.origin, 'phone')
        await accounts.patchSandbox(acct.id, { state: 'ready', hostToken, phoneToken, error: undefined, lastSeenAt: new Date(now()).toISOString() })
        log(`sandbox ${id} ready in ${((Date.now() - t0) / 1000).toFixed(1)}s (${o.provider.kind})`)
      } catch (e) {
        await accounts.patchSandbox(acct.id, { state: 'failed', error: (e as Error).message })
        log(`sandbox ${id} failed: ${(e as Error).message}`)
      } finally { jobs.delete(id) }
    })()
    jobs.set(id, job)
    return job
  }

  /** Start a stopped sandbox and wait for health. Shared by the proxy (wake on request) and the sweep. */
  const wake = (acct: Account): Promise<void> => {
    const id = acct.sandbox!.id
    const running = jobs.get(id); if (running) return running
    const job = (async () => {
      try {
        const t0 = Date.now()
        await o.provider.start(id)
        const sb = await o.provider.get(id)
        if (!sb) throw new Error('gone after start')
        await waitHealthy(sb.origin, { timeoutMs: o.healthTimeoutMs })
        await accounts.patchSandbox(acct.id, { lastSeenAt: new Date(now()).toISOString(), wakeAt: null })
        log(`sandbox ${id} woke in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
      } finally { jobs.delete(id) }
    })()
    jobs.set(id, job)
    return job
  }

  /**
   * Replace the account's two sandbox device tokens (host and phone): pair two new devices, save them on the
   * account, then revoke the old two on the bot (the bot says which device each old token is: `current` in
   * GET /devices) and cut the sockets open through the proxy. The person's other devices are left alone.
   * Never returns or logs a token.
   */
  const rotateTokens = async (acct: Account): Promise<{ status: number; body: Record<string, unknown> }> => {
    const sb = acct.sandbox
    if (!sb || sb.state !== 'ready' || jobs.has(sb.id)) return { status: 409, body: { error: `sandbox ${sb ? (jobs.has(sb.id) ? 'busy' : sb.state) : 'none'}` } }
    const st = await o.provider.status(sb.id)
    if (st !== 'running' && st !== 'stopped') return { status: 409, body: { error: `sandbox ${st}` } }
    if (st === 'stopped') await wake(acct)
    const run = (async () => {
      const live = await o.provider.get(sb.id)
      if (!live?.origin) throw new Error('sandbox has no address')
      const current = async (token: string | undefined): Promise<{ id: string; name: string } | null> => {
        if (!token) return null
        const r = await fetch(`${live.origin}/devices`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) })
        if (r.status === 401) return null // already refused: nothing to revoke
        if (!r.ok) throw new Error(`GET /devices: HTTP ${r.status}`)
        return (await r.json() as { id: string; name: string; current?: boolean }[]).find((d) => d.current) ?? null
      }
      const oldHost = await current(sb.hostToken), oldPhone = await current(sb.phoneToken)
      const old = [...new Set([oldHost?.id, oldPhone?.id].filter((x): x is string => Boolean(x)))]
      const hostToken = await pair(live.origin, 'host', 'host')
      const phoneToken = await pair(live.origin, oldPhone?.name || 'phone') // the name the phone gave itself (PATCH /devices/me) carries over
      await accounts.patchSandbox(acct.id, { hostToken, phoneToken, lastSeenAt: new Date(now()).toISOString() })
      for (const id of old) {
        const r = await fetch(`${live.origin}/devices/${encodeURIComponent(id)}`, { method: 'DELETE', headers: { authorization: `Bearer ${hostToken}` }, signal: AbortSignal.timeout(10_000) })
        if (!r.ok) throw new Error(`new tokens saved, but revoking old device ${id} failed: HTTP ${r.status}; revoke it with DELETE /devices/${id}`)
      }
      for (const ws of sockets.get(sb.id) ?? []) ws.close(1008, 'tokens rotated')
      log(`account ${acct.id}: sandbox ${sb.id} tokens rotated; old devices ${old.join(', ') || '(none)'} revoked`)
      return { status: 200, body: { ok: true, account: acct.id, sandboxId: sb.id, revoked: old.length } }
    })()
    jobs.set(sb.id, run.then(() => {}, () => {})) // the sweep leaves it running meanwhile
    try { return await run }
    catch (e) { log(`account ${acct.id}: rotating tokens failed: ${(e as Error).message}`); return { status: 502, body: { error: (e as Error).message } } }
    finally { jobs.delete(sb.id) }
  }

  const describe = async (acct: Account) => {
    const sb = acct.sandbox
    if (!sb) return { state: 'none' as const }
    const base = { origin: `${publicUrl}/s/${sb.id}`, token: sb.phoneToken, sandboxId: sb.id }
    if (sb.state === 'creating') return { state: 'creating' as const, sandboxId: sb.id }
    if (sb.state === 'failed') return { state: 'failed' as const, error: sb.error, sandboxId: sb.id }
    const st = await o.provider.status(sb.id)
    if (st === 'running') return { state: 'ready' as const, ...base }
    if (st === 'stopped') return { state: 'stopped' as const, ...base }
    if (st === 'creating') return { state: 'creating' as const, sandboxId: sb.id }
    return { state: 'missing' as const, sandboxId: sb.id }
  }

  const accountFrom = async (req: IncomingMessage, url: URL): Promise<Account | null> => {
    const fromHeader = req.headers['x-account']
    const cookie = /(?:^|;\s*)account=([A-Za-z0-9_-]+)/.exec(String(req.headers.cookie ?? ''))?.[1]
    const t = (typeof fromHeader === 'string' && fromHeader) || cookie || url.searchParams.get('account') || bearerToken(req.headers.authorization)
    return t ? accounts.lookup(t) : null
  }

  /** The proxy's gate: 401 no token, 403 not the owner, otherwise the account and its (started) sandbox origin. */
  const gate = async (req: IncomingMessage, url: URL): Promise<{ status: number; error?: string; acct?: Account; origin?: string; id?: string }> => {
    const m = /^\/s\/([a-z0-9][a-z0-9-]{2,40})(\/.*)?$/.exec(url.pathname)
    if (!m) return { status: 404, error: 'not found' }
    const id = m[1]
    // Who may reach a sandbox: its account (x-account / cookie / ?account= / bearer), the phone the host
    // paired for that account (its device token as bearer — what the app sends on every request), or a
    // WebSocket upgrade carrying a one-time ticket the bot inside issued (?ticket=; the bot validates it).
    let acct = await accountFrom(req, url)
    let unauth = false
    if (!acct) {
      const bearer = bearerToken(req.headers.authorization)
      const owner = accounts.all().find((a) => a.sandbox?.id === id)
      const phone = owner?.sandbox?.phoneToken
      if (owner && bearer && phone && bearer.length === phone.length && timingSafeEqual(Buffer.from(bearer), Buffer.from(phone))) acct = owner
      else if (owner && req.headers.upgrade && url.searchParams.get('ticket')) acct = owner
      // the OAuth redirect from a service's sign-in page (src/oauth.ts): a browser with no token; the bot inside checks the one-time state
      else if (owner && req.method === 'GET' && m[2] === '/connectors/callback') acct = owner
      // a module the assistant wrote (src/ui.ts), run in a browser or the app's web view, which carry no token: its
      // one-time play page (the bot checks ?ticket=), the page's runtime files (the bot checks the module's own
      // unspent token) and its result (the bot checks the same token, once). These never wake or touch a stopped
      // sandbox: a leaked sandbox id must not be a free wake switch.
      else if (owner && req.method === 'GET' && /^\/ui\/[\w-]+\/play$/.test(m[2] ?? '') && url.searchParams.get('ticket')) { acct = owner; unauth = true }
      else if (owner && req.method === 'GET' && /^\/ui\/[\w-]+\/runtime\/(?:nsh|harden|host)\.[0-9a-f]+\.(?:js|wasm|nshc)$/.test(m[2] ?? '') && url.searchParams.get('token')) { acct = owner; unauth = true }
      else if (owner && req.method === 'GET' && /^\/ui\/[\w-]+\/tiles\/\d+\/\d+\/\d+\.png$/.test(m[2] ?? '') && url.searchParams.get('token')) { acct = owner; unauth = true } // a map's tiles (src/tiles.ts): same token
      else if (owner && req.method === 'POST' && /^\/ui\/[\w-]+\/result$/.test(m[2] ?? '') && bearer) { acct = owner; unauth = true }
    }
    if (!acct) return { status: 401, error: 'account-unauthorized' }
    if (acct.suspendedAt) return { status: 403, error: 'suspended' } // [compliance]
    if (acct.sandbox?.id !== id) return { status: 403, error: 'not your sandbox' }
    if (acct.sandbox.state !== 'ready') return unauth ? { status: 401, error: 'account-unauthorized' } : { status: 503, error: `sandbox ${acct.sandbox.state}` }
    const st = await o.provider.status(id)
    if (st === 'missing') return { status: 404, error: 'sandbox missing' }
    if (st === 'stopped') {
      if (unauth) return { status: 401, error: 'account-unauthorized' }
      try { await wake(acct) } catch (e) { return { status: 502, error: `wake failed: ${(e as Error).message}` } }
    }
    else if (st === 'creating') { await new Promise((r) => setTimeout(r, 1000)) }
    const sb = await o.provider.get(id)
    if (!sb?.origin) return { status: 502, error: 'sandbox has no address' }
    if (!unauth) await accounts.patchSandbox(acct.id, { lastSeenAt: new Date(now()).toISOString() })
    return { status: 200, acct, origin: sb.origin, id }
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://host')
      const path = url.pathname
      if (path.startsWith('/s/')) {
        const g = await gate(req, url)
        if (g.status !== 200) return json(res, g.status, { error: g.error })
        const rest = url.pathname.slice(`/s/${g.id}`.length) || '/'
        return proxyHttp(req, res, new URL(g.origin!), rest + url.search)
      }
      // [compliance] the files that make /open/* links open the app, the public pages, deletion and reports
      if (path === '/.well-known/apple-app-site-association' && req.method === 'GET') {
        const ids = o.links?.appleAppIds ?? []
        if (!ids.length) return json(res, 404, { error: 'not configured' })
        return json(res, 200, { applinks: { details: [{ appIDs: ids, components: [{ '/': '/open/*', comment: 'An interface the assistant built, or the app itself' }] }] } })
      }
      if (path === '/.well-known/assetlinks.json' && req.method === 'GET') {
        const fp = o.links?.androidCertSha256 ?? []
        if (!o.links?.androidPackage || !fp.length) return json(res, 404, { error: 'not configured' })
        return json(res, 200, [{ relation: ['delegate_permission/common.handle_all_urls'], target: { namespace: 'android_app', package_name: o.links.androidPackage, sha256_cert_fingerprints: fp } }])
      }
      const langOf = (): Lang => { const q = url.searchParams.get('lang'); return q ? uiLang(q) : pageLang(req.headers['accept-language']) }
      if (/^\/open\/[a-z0-9][a-z0-9-]{2,40}\/ui\/[\w-]{1,40}$/.test(path) && req.method === 'GET') return html(res, 200, openPage(legal(), langOf()))
      if (path === '/privacy' && req.method === 'GET') return html(res, 200, privacyPage(legal(), langOf()))
      if (path === '/terms' && req.method === 'GET') return html(res, 200, termsPage(legal(), langOf()))
      if (path === '/account/delete') {
        const codeRequired = Boolean(o.accessCode)
        if (req.method === 'GET') return html(res, 200, deletePage(legal(), langOf(), 'form', codeRequired))
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
        const who = req.socket.remoteAddress ?? ''
        if (tooManyWrong(who)) return html(res, 429, deletePage(legal(), langOf(), 'busy', codeRequired))
        const form = new URLSearchParams(await readBody(req))
        if (o.accessCode && !sameSecret(String(form.get('code') ?? '').trim(), o.accessCode)) { wrong(who); return html(res, 403, deletePage(legal(), langOf(), 'wrong', codeRequired)) }
        if (!o.accessCode && !o.devSignIn) return html(res, 403, deletePage(legal(), langOf(), 'wrong', codeRequired))
        const acct = accounts.byEmail(String(form.get('email') ?? ''))
        if (acct) await deleteAccount(acct)
        return html(res, 200, deletePage(legal(), langOf(), 'done', codeRequired)) // the same answer whether the email had an account or not
      }
      if (path === '/host/reports' && req.method === 'POST') {
        let b: Record<string, unknown>
        try { b = JSON.parse(await readBody(req) || '{}') } catch { return json(res, 400, { error: 'bad json' }) }
        if ((b.kind !== 'reply' && b.kind !== 'interface') || !(REPORT_REASONS as readonly string[]).includes(String(b.reason))) return json(res, 400, { error: 'expected {kind: reply|interface, reason}' })
        const fromSandbox = sameSecret(bearerToken(req.headers.authorization), o.hostSecret)
        if (!fromSandbox) {
          const ip = req.socket.remoteAddress ?? ''
          const times = (anonReports.get(ip) ?? []).filter((t) => now() - t < 3600_000)
          if (times.length >= 20) return json(res, 429, { error: 'too many reports; try again later' })
          anonReports.set(ip, [...times, now()])
        }
        const s = (v: unknown, n: number) => (typeof v === 'string' && v.trim() ? v.slice(0, n) : undefined)
        const sandbox = fromSandbox ? s(b.sandbox, 60) : undefined
        const at = new Date(now())
        const r: HostReport = { id: `hr${randomBytes(6).toString('hex')}`, at: at.toISOString(), dueBy: new Date(at.getTime() + REPORT_RESPONSE_HOURS * 3600_000).toISOString(), source: fromSandbox ? 'sandbox' : 'app', sandbox, account: sandbox ? accounts.bySandbox(sandbox)?.id : undefined, kind: b.kind, reason: String(b.reason), note: s(b.note, 1000), excerpt: s(b.excerpt, 4000), moduleId: s(b.moduleId, 40), moduleTitle: fromSandbox ? s(b.moduleTitle, 80) : undefined, moduleSource: fromSandbox ? s(b.moduleSource, 20_000) : undefined, sessionId: s(b.sessionId, 120), rowId: s(b.rowId, 120), status: 'open' }
        for (const k of Object.keys(r) as (keyof HostReport)[]) if (r[k] === undefined) delete r[k]
        reports.push(r); await saveReports()
        log(`report ${r.id} (${r.kind}, ${r.reason}) from ${r.source}${r.account ? ` account ${r.account}` : ''}; answer by ${r.dueBy}`)
        return json(res, 200, { ok: true, id: r.id })
      }
      if (path === '/host/admin/reports' || path.startsWith('/host/admin/reports/')) {
        if (!sameAdmin(bearerToken(req.headers.authorization))) return json(res, 401, { error: 'admin-token' })
        if (path === '/host/admin/reports' && req.method === 'GET') { const st = url.searchParams.get('status'); return json(res, 200, [...reports].reverse().filter((r) => !st || r.status === st)) }
        const rid = path.slice('/host/admin/reports/'.length)
        const r = reports.find((x) => x.id === rid)
        if (!r) return json(res, 404, { error: 'not found' })
        if (req.method !== 'PATCH') return json(res, 405, { error: 'method not allowed' })
        let b: { status?: string; action?: string; note?: string } = {}
        try { b = JSON.parse(await readBody(req) || '{}') } catch { return json(res, 400, { error: 'bad json' }) }
        if (b.status !== undefined && !['open', 'resolved', 'dismissed'].includes(b.status)) return json(res, 400, { error: 'status: open | resolved | dismissed' })
        if (b.action !== undefined && !['none', 'block-interface', 'suspend-account'].includes(b.action)) return json(res, 400, { error: 'action: none | block-interface | suspend-account' })
        const acct = r.account ? accounts.get(r.account) : undefined
        if (b.action === 'block-interface') {
          if (!r.moduleId || !acct?.sandbox) return json(res, 409, { error: 'no interface on a hosted computer to block' })
          if (await o.provider.status(acct.sandbox.id) === 'stopped') await wake(acct)
          const live = await o.provider.get(acct.sandbox.id)
          const br = live?.origin ? await fetch(`${live.origin}/ui/${encodeURIComponent(r.moduleId)}/block`, { method: 'POST', headers: { authorization: `Bearer ${o.hostSecret}` }, signal: AbortSignal.timeout(10_000) }).catch(() => null) : null
          if (!br?.ok) return json(res, 502, { error: 'the computer did not block it' })
        }
        if (b.action === 'suspend-account') { if (!acct) return json(res, 409, { error: 'no account to suspend' }); await accounts.suspend(acct.id) }
        if (b.status) { r.status = b.status as HostReport['status']; if (b.status !== 'open') r.resolvedAt = new Date(now()).toISOString() }
        if (b.action) r.action = b.action as HostReport['action']
        if (typeof b.note === 'string') r.resolution = b.note.slice(0, 1000)
        await saveReports()
        log(`report ${r.id} → ${r.status}${r.action ? ` (${r.action})` : ''}`)
        return json(res, 200, r)
      }
      if (path === '/host/admin/rotate-tokens' && req.method === 'POST') {
        if (!sameAdmin(bearerToken(req.headers.authorization))) return json(res, 401, { error: 'admin-token' })
        let b: { account?: unknown; email?: unknown }
        try { b = JSON.parse(await readBody(req) || '{}') } catch { return json(res, 400, { error: 'bad json' }) }
        let found: Account[]
        if (typeof b.account === 'string' && b.account) found = accounts.all().filter((a) => a.id === b.account)
        else if (typeof b.email === 'string' && b.email.includes('@')) { const e = b.email.trim().toLowerCase(); found = accounts.all().filter((a) => a.email === e) }
        else return json(res, 400, { error: 'send {account} or {email}' })
        if (!found.length) return json(res, 404, { error: 'no such account' })
        if (found.length > 1) return json(res, 409, { error: 'several accounts have this email; pass {account}', accounts: found.map((a) => a.id) })
        const out = await rotateTokens(found[0])
        return json(res, out.status, out.body)
      }
      if (path === '/host/health') return json(res, 200, { ok: true, provider: o.provider.kind, accounts: accounts.all().length })
      if (o.appDir && req.method === 'GET' && !path.startsWith('/host/')) return serveStatic(o.appDir, path, res, `<meta name="deepseek-bot-host" content="${publicUrl.replace(/"/g, '')}">`)
      if (path === '/host/config' && req.method === 'GET') return json(res, 200, { codeRequired: Boolean(o.accessCode), apple: Boolean(o.apple) })
      if (path === '/host/sign-in' && req.method === 'POST') {
        const who = req.socket.remoteAddress ?? ''
        if (tooManyWrong(who)) return json(res, 429, { error: 'too many wrong codes; try again later' })
        let body: { email?: string; apple?: string; code?: string }
        try { body = JSON.parse(await readBody(req) || '{}') } catch { return json(res, 400, { error: 'bad json' }) }
        let acct: Account
        if (typeof body.apple === 'string') {
          if (!o.apple) return json(res, 503, { error: 'this host has no --apple-bundle-id; Sign in with Apple is off' })
          try { const who = await verifyAppleIdentityToken(body.apple, { bundleId: o.apple.bundleId, jwksUrl: o.apple.jwksUrl, now }); acct = await accounts.findOrCreate({ appleSub: who.sub, email: who.email }) }
          catch (e) { return json(res, 401, { error: `apple: ${(e as Error).message}` }) }
        } else if (typeof body.email === 'string' && body.email.includes('@')) {
          if (o.accessCode) {
            if (!sameSecret(typeof body.code === 'string' ? body.code.trim() : undefined, o.accessCode)) { wrong(who); return json(res, 403, { error: 'that access code is not right' }) }
          } else if (!o.devSignIn) return json(res, 403, { error: 'email sign-in is off on this host' })
          const email = body.email.trim().toLowerCase().slice(0, 200)
          if (!accounts.all().some((a) => a.email === email) && o.maxAccounts !== undefined && accounts.all().length >= o.maxAccounts) return json(res, 403, { error: 'this host is full' })
          acct = await accounts.findOrCreate({ email })
          log(`email sign-in ${acct.id}${o.accessCode ? ' (access code)' : ' (unverified email)'}`)
        } else return json(res, 400, { error: 'send {email} (dev) or {apple: identityToken}' })
        if (acct.suspendedAt) return json(res, 403, { error: 'this account is suspended' }) // [compliance]
        return json(res, 200, { accountToken: await accounts.issueToken(acct.id) })
      }
      if (path === '/host/push' && req.method === 'POST') {
        if (!sameSecret(bearerToken(req.headers.authorization), o.hostSecret)) return json(res, 401, { error: 'host-secret' })
        const n = JSON.parse(await readBody(req) || '{}') as { kind?: string; token?: string; title?: string; body?: string; url?: string; tag?: string }
        const apnsOk = n.kind === 'apns' && TOKEN_RE.test(String(n.token ?? '').toLowerCase())
        const fcmOk = n.kind === 'fcm' && FCM_TOKEN_RE.test(String(n.token ?? '')) // [push] Android
        if ((!apnsOk && !fcmOk) || typeof n.title !== 'string' || typeof n.body !== 'string') return json(res, 400, { error: 'expected {kind:"apns"|"fcm", token, title, body}' })
        const via = apnsOk ? o.apns : o.fcm
        if (!via) return json(res, 503, { error: apnsOk ? 'this host has no APNs key' : 'this host has no FCM service account' })
        try { await via.send(apnsOk ? String(n.token).toLowerCase() : String(n.token), { title: n.title, body: n.body, url: n.url, tag: n.tag }); return json(res, 200, { ok: true }) }
        catch (e) { const { statusCode, reason } = e as { statusCode?: number; reason?: string }; return json(res, statusCode && statusCode >= 400 && statusCode < 600 ? statusCode : 502, { error: reason || (e as Error).message }) }
      }
      // [compliance] Delete the account (in-app): the account token, or the phone's own device token for its computer.
      if (path === '/host/account' && req.method === 'DELETE') {
        let acct = await accountFrom(req, url)
        const bearer = bearerToken(req.headers.authorization)
        if (!acct && bearer) acct = accounts.all().find((a) => a.sandbox?.phoneToken && sameSecret(bearer, a.sandbox.phoneToken)) ?? null
        if (!acct) return json(res, 401, { error: 'account-unauthorized' })
        await deleteAccount(acct)
        return json(res, 200, { ok: true })
      }
      if (path.startsWith('/host/')) {
        const acct = await accountFrom(req, url)
        if (!acct) return json(res, 401, { error: 'account-unauthorized' })
        if (path === '/host/me') return json(res, 200, { id: acct.id, email: acct.email ?? null })
        if (path === '/host/sandbox' && req.method === 'GET') return json(res, 200, await describe(acct))
        if (path === '/host/sandbox' && req.method === 'POST') {
          const fresh = accounts.get(acct.id)!
          const d = await describe(fresh)
          if (d.state === 'none' || d.state === 'failed' || d.state === 'missing') {
            const job = create(fresh)
            await Promise.race([job, new Promise((r) => setTimeout(r, o.createWaitMs ?? 20_000))])
          } else if (d.state === 'stopped') {
            await wake(fresh).catch((e) => log(`wake on POST failed: ${(e as Error).message}`))
          } else if (d.state === 'creating' && jobs.has(fresh.sandbox!.id)) {
            await Promise.race([jobs.get(fresh.sandbox!.id)!, new Promise((r) => setTimeout(r, o.createWaitMs ?? 20_000))])
          }
          return json(res, 200, await describe(accounts.get(acct.id)!))
        }
        if (path === '/host/sandbox' && req.method === 'DELETE') {
          if (acct.sandbox) { await o.provider.remove(acct.sandbox.id); await accounts.setSandbox(acct.id, undefined); log(`sandbox ${acct.sandbox.id} removed`) }
          return json(res, 200, { ok: true })
        }
        return json(res, 404, { error: 'not found' })
      }
      json(res, 404, { error: 'not found' })
    } catch (err) {
      console.error('[host]', req.method, req.url, err)
      if (!res.headersSent) json(res, 500, { error: 'internal' }); else res.end()
    }
  })

  // WebSocket: the client's subprotocols go upstream; whatever the bot picks is echoed back.
  server.on('upgrade', async (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://host')
    const refuse = (status: number, text: string) => { socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\n\r\n`); socket.destroy() }
    let g: Awaited<ReturnType<typeof gate>>
    try { g = await gate(req, url) } catch (e) { console.error('[host] upgrade', e); return refuse(500, 'Internal Server Error') }
    if (g.status !== 200) return refuse(g.status, g.status === 401 ? 'Unauthorized' : g.status === 403 ? 'Forbidden' : g.status === 404 ? 'Not Found' : 'Service Unavailable')
    const id = g.id!
    const target = new URL(g.origin!)
    const rest = (url.pathname.slice(`/s/${id}`.length) || '/') + url.search
    const protocols = String(req.headers['sec-websocket-protocol'] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries(req.headers)) if (v !== undefined && !HOP.has(k) && k !== 'sec-websocket-protocol' && k !== 'cookie') headers[k] = Array.isArray(v) ? v.join(', ') : v
    const upstream = new WebSocket(`${target.protocol === 'https:' ? 'wss' : 'ws'}://${target.host}${rest}`, protocols, { headers })
    upstream.once('unexpected-response', (_r, ures) => refuse(ures.statusCode ?? 502, ures.statusMessage ?? 'Bad Gateway'))
    upstream.once('error', () => { if (!socket.destroyed) refuse(502, 'Bad Gateway') })
    upstream.once('open', () => {
      const wss = new WebSocketServer({ noServer: true, handleProtocols: () => upstream.protocol || false })
      wss.handleUpgrade(req, socket, head, (client) => {
        conns.set(id, (conns.get(id) ?? 0) + 1)
        const open = sockets.get(id) ?? new Set<WebSocket>(); open.add(client); sockets.set(id, open)
        const done = () => { open.delete(client); if (!open.size) sockets.delete(id); const n = (conns.get(id) ?? 1) - 1; if (n <= 0) conns.delete(id); else conns.set(id, n); accounts.patchSandbox(g.acct!.id, { lastSeenAt: new Date(now()).toISOString() }).catch(() => {}) }
        client.on('message', (d, bin) => upstream.send(d, { binary: bin }))
        upstream.on('message', (d, bin) => client.send(d, { binary: bin }))
        client.on('close', (c, r) => { upstream.close(normalCode(c), r); done() })
        upstream.on('close', (c, r) => client.close(normalCode(c), r))
        client.on('error', () => upstream.terminate())
        upstream.on('error', () => client.terminate())
      })
    })
  })

  /** Idle stop + scheduled wake, one pass. */
  const sweep = async () => {
    for (const acct of accounts.all()) {
      const sb = acct.sandbox
      if (!sb || sb.state !== 'ready' || jobs.has(sb.id)) continue
      try {
        const st = await o.provider.status(sb.id)
        if (st === 'running' && !(conns.get(sb.id) ?? 0) && now() - Date.parse(sb.lastSeenAt) >= idleMs) {
          const wakeAt = await earliestSchedule(acct).catch(() => null)
          await o.provider.stop(sb.id)
          await accounts.patchSandbox(acct.id, { wakeAt })
          log(`sandbox ${sb.id} idle → stopped${wakeAt ? `, wake at ${wakeAt}` : ''}`)
        } else if (st === 'stopped' && sb.wakeAt && Date.parse(sb.wakeAt) - 60_000 <= now()) {
          log(`sandbox ${sb.id}: schedule due at ${sb.wakeAt}, starting`)
          await wake(acct)
        }
      } catch (e) { log(`sweep ${sb.id}: ${(e as Error).message}`) }
    }
  }

  /** The bot's GET /schedules with the host's own device token → earliest active nextRunAt. */
  const earliestSchedule = async (acct: Account): Promise<string | null> => {
    const sb = acct.sandbox!
    const live = await o.provider.get(sb.id)
    if (!live?.origin || !sb.hostToken) return null
    const r = await fetch(`${live.origin}/schedules`, { headers: { authorization: `Bearer ${sb.hostToken}` }, signal: AbortSignal.timeout(5000) })
    if (!r.ok) return null
    const tasks = await r.json() as { active?: boolean; nextRunAt?: string | null }[]
    const times = tasks.filter((t) => t.active && t.nextRunAt).map((t) => Date.parse(t.nextRunAt!)).filter(Number.isFinite)
    return times.length ? new Date(Math.min(...times)).toISOString() : null
  }

  let timer: NodeJS.Timeout | null = null
  if (o.sweepMs) { timer = setInterval(() => { sweep().catch((e) => console.error('[host] sweep', e)) }, o.sweepMs); timer.unref?.() }
  if (o.warm) refill().catch(() => {})

  server.listen(o.port ?? 0, o.host ?? '127.0.0.1')
  await once(server, 'listening')
  const addr = server.address() as { address: string; port: number; family: string }
  if (!publicUrl) publicUrl = `http://${addr.address}:${addr.port}`
  return {
    warmed: () => warming ?? Promise.resolve(),
    origin: `http://${addr.family === 'IPv6' ? `[${addr.address}]` : addr.address}:${addr.port}`,
    accounts,
    sweep,
    async close() {
      if (timer) clearInterval(timer)
      server.closeAllConnections()
      await new Promise<void>((r) => server.close(() => r()))
    },
  }
}

function normalCode(c: number) { return c === 1005 || c === 1006 || c < 1000 ? 1000 : c }

function proxyHttp(req: IncomingMessage, res: ServerResponse, target: URL, path: string) {
  const headers: Record<string, string | string[]> = {}
  for (const [k, v] of Object.entries(req.headers)) if (v !== undefined && !HOP.has(k)) headers[k] = v
  // the account cookie is the host's; everything else in the cookie header goes through
  if (typeof headers.cookie === 'string') { const rest = headers.cookie.split(';').map((s) => s.trim()).filter((s) => s && !s.startsWith('account=')).join('; '); if (rest) headers.cookie = rest; else delete headers.cookie }
  const up = httpRequest({ protocol: target.protocol, hostname: target.hostname.replace(/^\[|\]$/g, ''), port: target.port, method: req.method, path, headers }, (ur) => {
    res.writeHead(ur.statusCode ?? 502, ur.headers)
    ur.pipe(res)
  })
  up.on('error', () => { if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'sandbox unreachable' })) })
  req.pipe(up)
}
