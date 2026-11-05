// One-tap connectors: OAuth 2.1 for remote MCP servers (Notion, Linear,
// Atlassian, GitHub, Slack, Google Workspace), the way Claude and ChatGPT
// connect them (docs/connectors.md has the evidence, read 2026-10-27).
//
//   app  POST /connectors/<preset>/connect  → the bot discovers the service's
//        authorization server (RFC 9728 → RFC 8414), gets a client id (one the
//        host registered, or dynamic registration RFC 7591), and answers with
//        the authorization URL (PKCE S256, a random state, resource = the MCP URL).
//   phone opens it in the system browser; the person signs in and taps Allow.
//   service redirects to <public origin>/connectors/callback?code&state → the
//        bot exchanges the code, keeps the tokens in <home>/connector-secrets.json
//        (0600), enables the connector, and the profile patch gets a row that
//        points DSH at the bot's loopback proxy (src/connector-proxy.ts), which
//        adds the bearer and refreshes it. Tokens never reach the patch, the
//        app, a log, or the model.
import { uiLang } from './lang.ts'
import { HTML_LANG, SERVER_WORDS, type Lang } from './locales/index.ts'
import { readFile } from 'node:fs/promises'
import { createHash, randomBytes } from 'node:crypto'
import { CATALOG, ConnectorError, type Connector, type Connectors, type Preset } from './connectors.ts'
import { writeAtomic } from './atomic.ts'

export interface AuthServerMeta {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  registration_endpoint?: string
  code_challenge_methods_supported?: string[]
  scopes_supported?: string[]
  token_endpoint_auth_methods_supported?: string[]
}
export interface OAuthClient { clientId: string; clientSecret?: string }
export interface TokenSet { accessToken: string; refreshToken?: string; /** ms since epoch */ expiresAt?: number; scope?: string; tokenType?: string }
export interface StoredConnection { resource: string; meta: AuthServerMeta; client: OAuthClient; token: TokenSet }

const CLIENT_NAME = 'Boop'
const bad = (m: string) => new ConnectorError(m)

/** RFC 8707 canonical resource URI: lowercase scheme and host, no fragment. */
export function canonicalResource(mcpUrl: string): string {
  const u = new URL(mcpUrl); u.hash = ''
  return `${u.protocol.toLowerCase()}//${u.host.toLowerCase()}${u.pathname}${u.search}`
}

async function getJson(url: string, f: typeof fetch): Promise<Record<string, unknown> | null> {
  try {
    const r = await f(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) })
    if (!r.ok) return null
    const v = await r.json(); return v && typeof v === 'object' ? v as Record<string, unknown> : null
  } catch { return null }
}

/**
 * Where to sign in for an MCP server: protected-resource metadata (path-suffixed first, GitHub
 * serves that form; then the origin's, Notion's form; then the 401 challenge), and the
 * authorization server's metadata (path-inserted RFC 8414, then plain, then OpenID discovery).
 */
export async function discover(mcpUrl: string, f: typeof fetch = fetch): Promise<AuthServerMeta> {
  const u = new URL(mcpUrl)
  const path = u.pathname.replace(/\/$/, '')
  let as: string | undefined
  for (const url of [`${u.origin}/.well-known/oauth-protected-resource${path}`, `${u.origin}/.well-known/oauth-protected-resource`]) {
    const prm = await getJson(url, f)
    const list = prm?.authorization_servers
    if (Array.isArray(list) && typeof list[0] === 'string') { as = list[0]; break }
  }
  if (!as) {
    try {
      const r = await f(mcpUrl, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{"jsonrpc":"2.0","id":0,"method":"ping"}', signal: AbortSignal.timeout(15_000) })
      const m = /resource_metadata="([^"]+)"/.exec(r.headers.get('www-authenticate') ?? '')
      if (m) { const prm = await getJson(m[1], f); const list = prm?.authorization_servers; if (Array.isArray(list) && typeof list[0] === 'string') as = list[0] }
    } catch {}
  }
  as ??= u.origin
  const a = new URL(as)
  const asPath = a.pathname.replace(/\/$/, '')
  const candidates = [...(asPath ? [`${a.origin}/.well-known/oauth-authorization-server${asPath}`] : []), `${a.origin}${asPath}/.well-known/oauth-authorization-server`, `${a.origin}${asPath}/.well-known/openid-configuration`]
  for (const url of candidates) {
    const m = await getJson(url, f)
    if (m && typeof m.authorization_endpoint === 'string' && typeof m.token_endpoint === 'string') return { issuer: String(m.issuer ?? as), ...m } as AuthServerMeta
  }
  throw bad(`could not find where to sign in for ${u.host}`)
}

export function makePkce() {
  const verifier = randomBytes(32).toString('base64url')
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
}

/** RFC 7591: register this bot as a public client (PKCE, no secret) for one redirect URI. */
export async function registerClient(meta: AuthServerMeta, redirectUri: string, f: typeof fetch = fetch): Promise<OAuthClient> {
  if (!meta.registration_endpoint) throw bad('this service does not register new clients; it needs a client the host registered')
  const r = await f(meta.registration_endpoint, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ client_name: CLIENT_NAME, redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }), signal: AbortSignal.timeout(20_000) })
  const v = await r.json().catch(() => ({})) as { client_id?: string; client_secret?: string; error?: string; error_description?: string }
  if (!r.ok || !v.client_id) throw Object.assign(bad(`the service refused to register this app (${v.error_description ?? v.error ?? r.status})`), { redirectRefused: v.error === 'invalid_redirect_uri' })
  return { clientId: v.client_id, ...(v.client_secret ? { clientSecret: v.client_secret } : {}) }
}

export function authorizationUrl(meta: AuthServerMeta, p: { clientId: string; redirectUri: string; state: string; challenge: string; resource: string; scope?: string }): string {
  const u = new URL(meta.authorization_endpoint)
  u.searchParams.set('response_type', 'code'); u.searchParams.set('client_id', p.clientId); u.searchParams.set('redirect_uri', p.redirectUri)
  u.searchParams.set('state', p.state); u.searchParams.set('code_challenge', p.challenge); u.searchParams.set('code_challenge_method', 'S256')
  u.searchParams.set('resource', p.resource)
  if (p.scope) u.searchParams.set('scope', p.scope)
  // Google: a refresh token comes only with these two
  if (/google/.test(u.host)) { u.searchParams.set('access_type', 'offline'); u.searchParams.set('prompt', 'consent') }
  return u.href
}

async function tokenRequest(meta: AuthServerMeta, client: OAuthClient, form: Record<string, string>, f: typeof fetch): Promise<TokenSet> {
  const body = new URLSearchParams({ ...form, client_id: client.clientId, ...(client.clientSecret ? { client_secret: client.clientSecret } : {}) })
  const r = await f(meta.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body, signal: AbortSignal.timeout(20_000) })
  const v = await r.json().catch(() => ({})) as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; token_type?: string; error?: string; error_description?: string }
  if (!r.ok || !v.access_token) throw bad(`the service did not hand over access (${v.error_description ?? v.error ?? r.status})`)
  return { accessToken: v.access_token, refreshToken: v.refresh_token, expiresAt: typeof v.expires_in === 'number' ? Date.now() + v.expires_in * 1000 : undefined, scope: v.scope, tokenType: v.token_type }
}

export const exchangeCode = (meta: AuthServerMeta, p: { client: OAuthClient; code: string; redirectUri: string; verifier: string; resource: string }, f: typeof fetch = fetch) =>
  tokenRequest(meta, p.client, { grant_type: 'authorization_code', code: p.code, redirect_uri: p.redirectUri, code_verifier: p.verifier, resource: p.resource }, f)

export const refreshToken = (meta: AuthServerMeta, p: { client: OAuthClient; refreshToken: string; resource: string }, f: typeof fetch = fetch) =>
  tokenRequest(meta, p.client, { grant_type: 'refresh_token', refresh_token: p.refreshToken, resource: p.resource }, f)

// ---- storage: <home>/connector-secrets.json, 0600 ----

interface SecretsFile { clients: Record<string, OAuthClient>; connections: Record<string, StoredConnection> }

/** Tokens and registered clients. Read at start, written atomically, mode 0600; never echoed. */
export class ConnectorSecrets {
  private data: SecretsFile = { clients: {}, connections: {} }
  private readonly path: string
  private constructor(path: string) { this.path = path }
  static async open(path: string) {
    const s = new ConnectorSecrets(path)
    try { const v = JSON.parse(await readFile(path, 'utf8')); s.data = { clients: v.clients ?? {}, connections: v.connections ?? {} } } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
    return s
  }
  get(id: string): StoredConnection | undefined { return this.data.connections[id] }
  has(id: string) { return Boolean(this.data.connections[id]) }
  async set(id: string, c: StoredConnection) { this.data.connections[id] = c; await this.persist() }
  async remove(id: string) { const had = Boolean(this.data.connections[id]); delete this.data.connections[id]; if (had) await this.persist(); return had }
  /** A client registered through DCR, by issuer + redirect URI (a new public URL needs a new registration). */
  client(key: string): OAuthClient | undefined { return this.data.clients[key] }
  async setClient(key: string, c: OAuthClient) { this.data.clients[key] = c; await this.persist() }
  private async persist() {
    await writeAtomic(this.path, () => JSON.stringify(this.data, null, 2) + '\n')
  }
}

// ---- the flow ----

interface Pending { preset: Preset; meta: AuthServerMeta; client: OAuthClient; verifier: string; redirectUri: string; resource: string; at: number }

export interface ConnectorAuthOptions {
  store: Connectors
  secrets: ConnectorSecrets
  /** The address the person's browser can reach the bot at (hosted: `<host>/s/<id>`); read when a flow starts. */
  publicOrigin: () => string
  /**
   * `http://127.0.0.1:<port>`: where a browser on this computer reaches the bot. Notion and Linear
   * take a plain-http redirect only on loopback (measured 2026-10-27, docs/connectors.md), so a
   * bot on the LAN without https signs in through loopback when the person connects from here.
   */
  loopbackOrigin?: () => string
  catalog?: Preset[]
  env?: NodeJS.ProcessEnv
  fetch?: typeof fetch
  /** After the callback stored the token and enabled the connector. */
  onConnected?: (c: Connector) => void
  /** How long an authorization URL stays valid. */
  ttlMs?: number
}

export class ConnectorAuth {
  private readonly pending = new Map<string, Pending>()
  private readonly o: ConnectorAuthOptions
  private readonly f: typeof fetch
  constructor(o: ConnectorAuthOptions) { this.o = o; this.f = o.fetch ?? fetch; o.store.hasToken = (id) => o.secrets.has(id) }
  private get catalog() { return this.o.catalog ?? CATALOG }
  private get env() { return this.o.env ?? process.env }
  preset(id: string) { return this.catalog.find((p) => p.id === id && p.auth === 'oauth') }

  /** A pre-registered client from the environment (the host set `<clientEnv>_CLIENT_ID` and `_CLIENT_SECRET`), or none. */
  hostClient(p: Preset): OAuthClient | undefined {
    if (!p.clientEnv) return undefined
    const id = this.env[`${p.clientEnv}_CLIENT_ID`]
    return id ? { clientId: id, clientSecret: this.env[`${p.clientEnv}_CLIENT_SECRET`] || undefined } : undefined
  }
  /** One tap works here: the service registers clients itself, or the host registered one. */
  available(presetId: string): boolean {
    const p = this.preset(presetId)
    return Boolean(p && (!p.clientEnv || this.hostClient(p)))
  }

  /** Step 1: the URL the phone opens in the system browser. `local`: the request came from this computer, so its browser can come back over loopback. */
  async start(presetId: string, o: { local?: boolean; origin?: string } = {}): Promise<{ url: string; state: string }> {
    const p = this.preset(presetId)
    if (!p?.url) throw bad(`unknown service "${presetId}"`)
    if (!this.available(presetId)) throw bad(`${p.name} is not available on this computer yet`)
    const origin = this.o.publicOrigin().replace(/\/$/, '')
    if (!/^https?:\/\//.test(origin)) throw bad('the bot does not know its own address yet')
    // An https address is always the one (a hosted bot, a tunnel). Over plain http, a browser on this
    // computer comes back over loopback, which every service takes; a phone gets the LAN address,
    // which some services refuse at registration.
    const loopback = this.o.loopbackOrigin?.().replace(/\/$/, '')
    const origins = origin.startsWith('https://') ? [origin] : o.origin ? [o.origin] : !loopback || loopback === origin ? [origin] : o.local ? [loopback, origin] : [origin]
    const resource = canonicalResource(p.url)
    const meta = await discover(p.url, this.f)
    let client = this.hostClient(p)
    let redirectUri = `${origins[0]}/connectors/callback`
    if (!client) {
      for (const from of origins) {
        redirectUri = `${from}/connectors/callback`
        const key = `${meta.issuer}|${redirectUri}`
        client = this.o.secrets.client(key)
        if (client) break
        try { client = await registerClient(meta, redirectUri, this.f); await this.o.secrets.setClient(key, client); break }
        catch (e) { if (!(e as { redirectRefused?: boolean }).redirectRefused) throw e }
      }
      if (!client) throw bad(`${p.name} only connects over a secure address. Open Connectors on the computer the assistant runs on and connect it there.`)
    }
    const { verifier, challenge } = makePkce()
    const state = randomBytes(24).toString('base64url')
    for (const [k, v] of this.pending) if (Date.now() - v.at > (this.o.ttlMs ?? 10 * 60_000)) this.pending.delete(k)
    if (this.pending.size >= 32) this.pending.delete(this.pending.keys().next().value!)
    this.pending.set(state, { preset: p, meta, client, verifier, redirectUri, resource, at: Date.now() })
    return { url: authorizationUrl(meta, { clientId: client.clientId, redirectUri, state, challenge, resource, scope: p.scope }), state }
  }

  /** Step 2: the browser came back. Exchanges the code, stores the token, enables the connector. */
  async callback(q: { state?: string; code?: string; error?: string; error_description?: string }): Promise<{ ok: true; connector: Connector; name: string } | { ok: false; error: string; name?: string }> {
    const pend = q.state ? this.pending.get(q.state) : undefined
    if (pend) this.pending.delete(q.state!)
    if (!pend || Date.now() - pend.at > (this.o.ttlMs ?? 10 * 60_000)) return { ok: false, error: 'This sign-in link is no longer valid.' }
    const name = pend.preset.name
    if (q.error || !q.code) return { ok: false, name, error: q.error_description || (q.error === 'access_denied' ? 'You did not allow it.' : `The service did not allow it (${q.error ?? 'no code'}).`) }
    let token: TokenSet
    try { token = await exchangeCode(pend.meta, { client: pend.client, code: q.code, redirectUri: pend.redirectUri, verifier: pend.verifier, resource: pend.resource }, this.f) }
    catch (e) { return { ok: false, name, error: (e as Error).message } }
    await this.o.secrets.set(pend.preset.id, { resource: pend.resource, meta: pend.meta, client: pend.client, token })
    const existing = this.o.store.get(pend.preset.id)
    const connector = existing ? (await this.o.store.setEnabled(existing.id, true))! : await this.o.store.add({ preset: pend.preset.id, oauth: true })
    this.o.onConnected?.(connector)
    return { ok: true, connector, name }
  }

  /** One tap: the token is deleted and the connector removed. */
  async disconnect(id: string): Promise<boolean> {
    const hadToken = await this.o.secrets.remove(id)
    const hadRow = await this.o.store.remove(id)
    return hadToken || hadRow
  }

  /** A live access token for the proxy; refreshed when it is about to expire or `force`d after a 401. */
  async accessToken(id: string, force = false): Promise<string | null> {
    const c = this.o.secrets.get(id)
    if (!c) return null
    const stale = c.token.expiresAt !== undefined && c.token.expiresAt - 60_000 < Date.now()
    if (!force && !stale) return c.token.accessToken
    if (!c.token.refreshToken) return force ? null : c.token.accessToken
    try {
      const fresh = await refreshToken(c.meta, { client: c.client, refreshToken: c.token.refreshToken, resource: c.resource }, this.f)
      const token: TokenSet = { ...fresh, refreshToken: fresh.refreshToken ?? c.token.refreshToken }
      await this.o.secrets.set(id, { ...c, token })
      return token.accessToken
    } catch { return force ? null : c.token.accessToken }
  }
}

/** The page's language from the browser's Accept-Language: the phone's browser says the phone's language. */
export function pageLang(acceptLanguage: string | undefined): Lang {
  return uiLang((acceptLanguage ?? '').split(/[,;]/)[0]?.trim() ?? '')
}

/** The page the browser shows after the callback; no secret, no address, black on white, in the phone's language. */
export function callbackPage(r: { ok: boolean; name?: string; error?: string }, lang: Lang = 'en'): string {
  const w = SERVER_WORDS[lang].oauth
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!))
  const name = esc(r.name ?? w.service)
  const title = r.ok ? w.connected(name) : w.notConnected
  // outside English the bot's English reason is left out: the one thing to do is enough
  const body = r.ok ? w.goBack : lang === 'en' ? `${esc(r.error ?? '')} ${w.tryAgain}` : w.tryAgain
return `<!doctype html><html lang="${HTML_LANG[lang]}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><style>html{background:#fff;color:#0f1115;font:17px/1.4 -apple-system,system-ui,sans-serif}@media(prefers-color-scheme:dark){html{background:#151517;color:#f9fafb}}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}main{max-width:360px;text-align:center}h1{font-size:22px;margin:0 0 8px}p{margin:0;opacity:.7}</style></head><body><main><h1>${title}</h1><p>${body}</p></main></body></html>`
}
