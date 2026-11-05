// Connectors: outside services the person plugs into the assistant. Each one is
// an MCP server that DSH mounts through `@deepseek-ai/dsh-mcp-client`; the
// model then sees `mcp__<id>__<tool>`.
//
// Two kinds:
//   - One-tap services (`auth: 'oauth'`): Notion, Linear, Atlassian, GitHub,
//     Slack, Gmail, Google Calendar, Google Drive — remote MCP servers the person
//     connects by signing in once (src/oauth.ts). Their tokens live in
//     <home>/connector-secrets.json (0600); the profile row points DSH at the
//     bot's loopback proxy (src/connector-proxy.ts), never at the token.
//   - Advanced: a folder on this computer, the notes graph, or any MCP server by
//     command or address. Keys travel as env var *names*, rendered as
//     `!!js process.env.NAME` so DSH reads the value when it starts. DSH drops
//     ambient vars whose names look like credentials before launching a stdio
//     child (mcp-client README, "Environment scrubbing"), so the explicit
//     pass-through is also the only way a token reaches such a server.
//
// What is stored (~/.deepseek-bot/connectors.json) never holds a secret.
//
// Changes apply live: `onChange` lets the bot rewrite the profile patch, and a
// running `dsh web` reloads it (HMR watches the patch: measured 2026-10-27,
// a row appended at runtime was connected 2.1 s later, a removed row dropped
// 2.1 s later; with `hmr` disabled neither happened). `restartNeeded` stays
// for profiles without HMR.
import type { Lang } from './locales/index.ts'
import { readFile, stat } from 'node:fs/promises'
import { dirname, join, isAbsolute } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { writeAtomic } from './atomic.ts'

/** The address a loopback request came in on: a browser on this computer, or a phone through TailPocket at its own port. */
export function requestOrigin(o: { peer: string; host?: string; forwarded?: boolean }): string | undefined {
  if (o.forwarded || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(o.peer)) return undefined
  return o.host && /^127\.0\.0\.1:\d{1,5}$/.test(o.host) ? `http://${o.host}` : undefined
}

export type Transport = 'stdio' | 'streamable-http'

export interface Connector {
  /** Also the MCP serverName: `[A-Za-z0-9_-]{1,32}`. */
  id: string
  name: string
  /** Catalog preset id, or `custom`. */
  preset: string
  transport: Transport
  command?: string
  args?: string[]
  url?: string
  /** Env var NAME whose value is sent as `Authorization: Bearer …` (streamable-http). */
  bearerEnv?: string
  /** Env var NAMES forwarded to the server by reference. */
  envNames?: string[]
  /** Literal, non-secret env a preset sets at add time (a file path). */
  env?: Record<string, string>
  /** `oauth`: the person signed in (src/oauth.ts); the bearer comes from the proxy, not from env. */
  auth?: 'oauth'
  enabled: boolean
  addedAt: string
}

export interface Preset {
  id: string
  name: string
  description: string
  transport: Transport
  command?: string
  args?: string[]
  url?: string
  bearerEnv?: string
  /** Env vars the person must set on the computer (names only). */
  envNames: string[]
  /** One line: what to do on the computer before it works. */
  hint: string
  /** The preset needs one folder path from the person. */
  needsPath?: boolean
  /** Not a server: the app shows a form, the API needs `custom: true`. */
  custom?: boolean
  /** One tap: a remote MCP server the person signs in to (OAuth 2.1, src/oauth.ts). */
  auth?: 'oauth'
  /** The service registers no clients itself: the host sets `<clientEnv>_CLIENT_ID` and `<clientEnv>_CLIENT_SECRET`; without them the tile says not available. */
  clientEnv?: string
  /** OAuth scopes to ask for, when the service wants them named. */
  scope?: string
}

// One-tap services (checked 2026-10-27, docs/connectors.md): the URL is the
// service's own remote MCP server. Notion, Linear and Atlassian advertise
// dynamic client registration, so any bot can connect out of the box. GitHub,
// Slack and Google register no clients: the host that runs the bot creates an
// OAuth app there once and sets `<clientEnv>_CLIENT_ID` / `_CLIENT_SECRET`.
// Google's servers are a developer preview; Gmail scopes need Google's app
// verification before strangers can sign in. Scopes below are the documented
// REST scopes; whether Google's MCP servers accept narrower ones is unverified.
const ONE_TAP: Preset[] = [
  { id: 'notion', name: 'Notion', description: 'Search, read and write your pages and databases.', transport: 'streamable-http', url: 'https://mcp.notion.com/mcp', auth: 'oauth', envNames: [], hint: '' },
  { id: 'linear', name: 'Linear', description: 'Issues, projects and cycles.', transport: 'streamable-http', url: 'https://mcp.linear.app/mcp', auth: 'oauth', envNames: [], hint: '' },
  { id: 'atlassian', name: 'Jira and Confluence', description: 'Issues, boards and wiki pages in your Atlassian sites.', transport: 'streamable-http', url: 'https://mcp.atlassian.com/v2/mcp', auth: 'oauth', envNames: [], hint: '' },
  { id: 'github', name: 'GitHub', description: 'Issues, pull requests and code in your repositories.', transport: 'streamable-http', url: 'https://api.githubcopilot.com/mcp/', auth: 'oauth', clientEnv: 'DEEPSEEK_BOT_OAUTH_GITHUB', envNames: [], hint: '' },
  { id: 'slack', name: 'Slack', description: 'Read channels, search, and send messages as you.', transport: 'streamable-http', url: 'https://mcp.slack.com/mcp', auth: 'oauth', clientEnv: 'DEEPSEEK_BOT_OAUTH_SLACK', envNames: [], hint: '' },
  { id: 'gmail', name: 'Gmail', description: 'Read, search and draft your email.', transport: 'streamable-http', url: 'https://gmailmcp.googleapis.com/mcp/v1', auth: 'oauth', clientEnv: 'DEEPSEEK_BOT_OAUTH_GOOGLE', scope: 'https://www.googleapis.com/auth/gmail.modify', envNames: [], hint: '' },
  { id: 'google-calendar', name: 'Google Calendar', description: 'See, create and change events.', transport: 'streamable-http', url: 'https://calendarmcp.googleapis.com/mcp/v1', auth: 'oauth', clientEnv: 'DEEPSEEK_BOT_OAUTH_GOOGLE', scope: 'https://www.googleapis.com/auth/calendar', envNames: [], hint: '' },
  { id: 'google-drive', name: 'Google Drive', description: 'Find and read your files and documents.', transport: 'streamable-http', url: 'https://drivemcp.googleapis.com/mcp/v1', auth: 'oauth', clientEnv: 'DEEPSEEK_BOT_OAUTH_GOOGLE', scope: 'https://www.googleapis.com/auth/drive', envNames: [], hint: '' },
]

// Advanced. Versions checked with `npm view <pkg> time --json` on 2026-10-27;
// each is the newest release at least two weeks old on that date.
const ADVANCED: Preset[] = [
  { id: 'filesystem', name: 'Files on this computer', description: 'Read and change files in one folder you pick.', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem@1.0.0'], envNames: [], needsPath: true, hint: 'Pick one folder. The assistant can only see files inside it.' },
  { id: 'memory', name: 'Notes graph', description: 'A small knowledge graph the assistant keeps on this computer.', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory@1.0.0'], envNames: [], hint: 'Nothing to set. The notes live in the deepseek-bot folder.' },
  { id: 'custom', name: 'Custom MCP server', description: 'Any MCP server: a command on this computer, or an address.', transport: 'stdio', envNames: [], custom: true, hint: 'Keys stay on the computer: give the env var name, set the value there.' },
]

/**
 * More one-tap services a host offers: `DEEPSEEK_BOT_ONE_TAP_EXTRA` is a JSON list of
 * `{ id, name, url, description? }`, each a remote MCP server that signs people in with OAuth
 * (discovery + dynamic registration, like Notion). A team wiki, an internal tracker, or the fake
 * service the end-to-end test runs. Entries with a bad id, a taken id, or a plain-http address
 * off this machine are dropped.
 */
export function extraOneTap(env: NodeJS.ProcessEnv = process.env): Preset[] {
  let list: unknown
  try { list = JSON.parse(env.DEEPSEEK_BOT_ONE_TAP_EXTRA ?? '[]') } catch { return [] }
  if (!Array.isArray(list)) return []
  const taken = new Set([...ONE_TAP, ...ADVANCED].map((p) => p.id))
  const out: Preset[] = []
  for (const e of list as Record<string, unknown>[]) {
    const id = typeof e?.id === 'string' ? e.id : ''
    const name = typeof e?.name === 'string' ? e.name.trim().slice(0, 40) : ''
    if (!/^[a-z0-9-]{1,32}$/.test(id) || taken.has(id) || !name) continue
    let u: URL
    try { u = new URL(String(e.url ?? '')) } catch { continue }
    const loopback = u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]'
    if (!(u.protocol === 'https:' || (u.protocol === 'http:' && loopback))) continue
    taken.add(id)
    out.push({ id, name, description: typeof e.description === 'string' && e.description.trim() ? e.description.trim().slice(0, 120) : `Use ${name} from the assistant.`, transport: 'streamable-http', url: u.href, auth: 'oauth', envNames: [], hint: '' })
  }
  return out
}

export const CATALOG: Preset[] = [...ONE_TAP, ...extraOneTap(), ...ADVANCED]

const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/
const SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/

export type AddInput = {
  preset?: string
  /** Set by src/oauth.ts after the person signed in; the app never sends it. */
  oauth?: boolean
  path?: string
  custom?: boolean
  name?: string
  transport?: string
  command?: string
  args?: unknown
  url?: string
  bearerEnv?: string
  envNames?: unknown
  [k: string]: unknown
}

export class ConnectorError extends Error { readonly status = 400 }
const bad = (m: string) => new ConnectorError(m)

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'server'

export class Connectors {
  private rows: Connector[] = []
  private readonly path: string
  private applied: string | null = null
  readonly catalog: Preset[]
  /** Called after every change that was persisted (add, enable/disable, remove); the bot rewrites the profile patch. */
  onChange?: () => Promise<void> | void
  /** Whether a one-tap connector has a token on file (set by src/oauth.ts). */
  hasToken: (id: string) => boolean = () => false
  private constructor(path: string, catalog: Preset[]) { this.path = path; this.catalog = catalog }

  static async open(path: string, o: { catalog?: Preset[] } = {}) {
    const s = new Connectors(path, o.catalog ?? CATALOG)
    try { s.rows = JSON.parse(await readFile(path, 'utf8')) } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
    return s
  }

  list(): Connector[] { return this.rows.map((r) => ({ ...r })) }
  get(id: string): Connector | undefined { const r = this.rows.find((x) => x.id === id); return r && { ...r } }
  enabled(): Connector[] { return this.list().filter((r) => r.enabled && (r.auth !== 'oauth' || this.hasToken(r.id))) }
  /** A one-tap connector that is enabled and signed in. */
  connected(id: string) { const r = this.rows.find((x) => x.id === id); return Boolean(r && r.enabled && (r.auth !== 'oauth' || this.hasToken(r.id))) }

  private started: Set<string> | null = null
  /** Remember what the harness was started with, so `restartNeeded` can compare. */
  markApplied() { this.applied = this.signature() }
  /** The env names the harness got when it started; a live reload cannot add one (its env is fixed then). */
  markStarted() { this.started = new Set(connectorEnvNames(this.enabled())) }
  restartNeeded() {
    if (this.applied !== null && this.applied !== this.signature()) return true
    return this.started !== null && connectorEnvNames(this.enabled()).some((n) => !this.started!.has(n))
  }
  private signature() { return JSON.stringify(this.enabled().map(({ addedAt: _a, name: _n, ...r }) => r)) }

  async add(input: AddInput): Promise<Connector> {
    if (input.env !== undefined || input.headers !== undefined) throw bad('env values are not accepted here; give env var names (envNames / bearerEnv) and set the values on the computer')
    const draft = input.preset !== undefined && input.custom !== true ? this.fromPreset(input) : this.fromCustom(input)
    await this.check(draft)
    const row: Connector = { ...draft, id: draft.auth === 'oauth' ? draft.id : this.freeId(draft.id), enabled: true, addedAt: new Date().toISOString() }
    if (this.rows.some((r) => r.id === row.id)) throw bad(`${row.id} is already connected`)
    this.rows.push(row); await this.persist(); await this.onChange?.(); return { ...row }
  }

  async setEnabled(id: string, enabled: boolean) {
    const r = this.rows.find((x) => x.id === id); if (!r) return undefined
    r.enabled = Boolean(enabled); await this.persist(); await this.onChange?.(); return { ...r }
  }

  async remove(id: string) {
    const n = this.rows.length; this.rows = this.rows.filter((x) => x.id !== id)
    if (this.rows.length !== n) { await this.persist(); await this.onChange?.() }
    return this.rows.length !== n
  }

  private fromPreset(input: AddInput): Omit<Connector, 'enabled' | 'addedAt'> {
    const p = this.catalog.find((x) => x.id === input.preset)
    if (!p) throw bad(`unknown preset "${input.preset}"`)
    if (p.custom) throw bad('a custom server needs custom: true, a name, and a command or url')
    if (p.auth === 'oauth') {
      if (input.oauth !== true) throw bad(`${p.name} is connected by signing in: tap Connect in the app`)
      return { id: p.id, name: p.name, preset: p.id, transport: 'streamable-http', url: p.url, auth: 'oauth', envNames: [] }
    }
    const args = [...(p.args ?? [])]
    if (p.needsPath) {
      if (typeof input.path !== 'string' || !input.path.trim()) throw bad('this preset needs a folder path')
      if (!isAbsolute(input.path)) throw bad('the folder path must be absolute')
      args.push(input.path)
    }
    const env = p.id === 'memory' ? { MEMORY_FILE_PATH: join(dirname(this.path), 'connectors', 'memory.jsonl') } : undefined
    return { id: p.id, name: p.name, preset: p.id, transport: p.transport, command: p.command, args: p.command ? args : undefined, url: p.url, bearerEnv: p.bearerEnv, envNames: [...p.envNames], ...(env ? { env } : {}) }
  }

  private fromCustom(input: AddInput): Omit<Connector, 'enabled' | 'addedAt'> {
    if (input.custom !== true) throw bad('a custom server needs custom: true (the app asks you to confirm)')
    const name = String(input.name ?? '').trim().slice(0, 40)
    if (!name) throw bad('a name is needed')
    const transport = input.transport
    if (transport !== 'stdio' && transport !== 'streamable-http') throw bad('transport must be stdio or streamable-http')
    const envNames = input.envNames === undefined ? [] : input.envNames
    if (!Array.isArray(envNames) || envNames.some((e) => typeof e !== 'string' || !ENV_NAME.test(e))) throw bad('each env var name must look like MY_TOKEN')
    const bearerEnv = input.bearerEnv === undefined || input.bearerEnv === '' ? undefined : String(input.bearerEnv)
    if (bearerEnv !== undefined && !ENV_NAME.test(bearerEnv)) throw bad('bearerEnv must be an env var name like MY_TOKEN')
    const base = { id: slug(name), name, preset: 'custom', transport, envNames: envNames as string[] }
    if (transport === 'stdio') {
      const command = String(input.command ?? '').trim()
      if (!command) throw bad('a command is needed')
      const args = input.args === undefined ? [] : input.args
      if (!Array.isArray(args) || args.length > 32 || args.some((a) => typeof a !== 'string' || a.length > 500)) throw bad('args must be a list of strings')
      return { ...base, command, args: args as string[] }
    }
    let url: URL
    try { url = new URL(String(input.url ?? '')) } catch { throw bad('a valid url is needed') }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw bad('url must start with http:// or https://')
    return { ...base, url: url.href, bearerEnv, envNames: bearerEnv && !envNames.includes(bearerEnv) ? [...(envNames as string[]), bearerEnv] : envNames as string[] }
  }

  private async check(d: Omit<Connector, 'enabled' | 'addedAt'>) {
    if (!SERVER_NAME.test(d.id)) throw bad('name must give letters, digits, - or _')
    const p = this.catalog.find((x) => x.id === d.preset)
    if (p?.needsPath) {
      const dir = d.args![d.args!.length - 1]
      const s = await stat(dir).catch(() => null)
      if (!s?.isDirectory()) throw bad('that folder does not exist on the computer')
    }
  }

  private freeId(base: string) {
    if (!this.rows.some((r) => r.id === base)) return base
    for (let i = 2; ; i++) { const id = `${base}-${i}`.slice(0, 32); if (!this.rows.some((r) => r.id === id)) return id }
  }

  private async persist() {
    await writeAtomic(this.path, () => JSON.stringify(this.rows, null, 2) + '\n')
  }
}

/** Which env vars are set on this computer — booleans only, never the values. */
export function envPresence(names: string[], env: NodeJS.ProcessEnv = process.env): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  for (const n of names) out[n] = Boolean(env[n])
  return out
}

/**
 * The env names enabled connectors read from the harness's env (their `!!js process.env.X` rows). The harness
 * starts with an allow-listed env (src/dsh.ts harnessEnv), so these are added to it by name. The bot's own
 * secrets (DEEPSEEK_BOT_*: host secret, OAuth clients, model key) never go in, whatever a row names.
 */
export function connectorEnvNames(connectors: Connector[]): string[] {
  const out = new Set<string>()
  for (const c of connectors) {
    if (!c.enabled || c.auth === 'oauth') continue
    for (const n of [...(c.envNames ?? []), ...(c.bearerEnv ? [c.bearerEnv] : [])]) if (ENV_NAME.test(n) && !n.startsWith('DEEPSEEK_BOT_')) out.add(n)
  }
  return [...out]
}

export const missingEnv = (c: Connector, env: NodeJS.ProcessEnv = process.env) => (c.envNames ?? []).filter((n) => !env[n])

// YAML: strings go out as JSON (a JSON string is a valid YAML double-quoted
// scalar), so paths with spaces or quotes cannot break the row. Env var names
// are regex-checked above, so the `!!js` expressions only ever contain a name.
const q = (s: string) => JSON.stringify(s)
const ref = (name: string) => `!!js "process.env.${name} ?? ''"`

/**
 * One `insert` row per enabled connector, appended to the profile patch by openHome. `env` is only read to
 * assert nothing leaks. One-tap connectors need `proxy` (src/connector-proxy.ts): their row points DSH at
 * the bot's loopback proxy with this process's secret, never at the service token; without a proxy they get no row.
 */
export function connectorRowsYaml(connectors: Connector[], _env: NodeJS.ProcessEnv = process.env, proxy?: { url: string; secret: string }): string {
  const rows = connectors.filter((c) => c.enabled && (c.auth !== 'oauth' || proxy))
  if (rows.length === 0) return ''
  let y = `# Connectors (src/connectors.ts): MCP servers the person added in the app. Secrets by env var name only; signed-in services go through the bot's proxy.\n- insert:\n`
  for (const c of rows) {
    y += `    - id: connector-${c.id}\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: ${c.id}\n        transport: ${c.transport}\n`
    if (c.auth === 'oauth') {
      y += `        url: ${q(`${proxy!.url}/${c.id}`)}\n        headers:\n          authorization: Bearer ${proxy!.secret}\n`
    } else if (c.transport === 'stdio') {
      y += `        command: ${q(c.command ?? '')}\n        args: ${JSON.stringify(c.args ?? [])}\n`
      const literal = Object.entries(c.env ?? {})
      const names = (c.envNames ?? []).filter((n) => ENV_NAME.test(n))
      if (literal.length || names.length) {
        y += `        env:\n`
        for (const [k, v] of literal) if (ENV_NAME.test(k)) y += `          ${k}: ${q(v)}\n`
        for (const n of names) y += `          ${n}: ${ref(n)}\n`
      }
    } else {
      y += `        url: ${q(c.url ?? '')}\n`
      if (c.bearerEnv && ENV_NAME.test(c.bearerEnv)) y += `        headers:\n          Authorization: !!js "\`Bearer \${process.env.${c.bearerEnv} ?? ''}\`"\n`
    }
    y += `        failOnStartupError: false\n`
  }
  return y
}

// ---- HTTP: GET/POST /connectors, PATCH/DELETE /connectors/:id ----

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}
async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let s = ''
  for await (const c of req) { s += c; if (s.length > 64 * 1024) throw bad('body too large') }
  if (!s.trim()) return {}
  try { const v = JSON.parse(s); return v && typeof v === 'object' && !Array.isArray(v) ? v : {} } catch { throw bad('body must be JSON') }
}

/** The flow a one-tap connector goes through (src/oauth.ts); the route handler needs only this much of it. */
export interface ConnectorAuthLike {
  available(presetId: string): boolean
  start(presetId: string, o?: { local?: boolean }): Promise<{ url: string; state: string }>
  callback(q: { state?: string; code?: string; error?: string; error_description?: string }): Promise<{ ok: true; name: string } | { ok: false; error: string; name?: string }>
  disconnect(id: string): Promise<boolean>
}

/** `GET /connectors/callback` is the one connector route a browser reaches without a device token (the service redirects there). */
export const isConnectorCallback = (method: string | undefined, path: string) => method === 'GET' && path === '/connectors/callback'

/**
 * Handles the connector routes; the caller has already checked the device (except the callback, which
 * carries a one-time state instead). Returns false when the path is not ours.
 */
export async function handleConnectorsRoute(req: IncomingMessage, res: ServerResponse, store: Connectors, env: NodeJS.ProcessEnv = process.env, auth?: ConnectorAuthLike, appLang?: () => Promise<Lang | undefined>): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://bot')
  const path = url.pathname
  const one = /^\/connectors\/([^/]+)$/.exec(path)
  const connect = /^\/connectors\/([^/]+)\/connect$/.exec(path)
  if (path !== '/connectors' && !one && !connect) return false
  try {
    if (isConnectorCallback(req.method, path)) {
      if (!auth) return send(res, 404, { error: 'not found' }), true
      const { callbackPage, pageLang } = await import('./oauth.ts')
      const r = await auth.callback({ state: url.searchParams.get('state') ?? undefined, code: url.searchParams.get('code') ?? undefined, error: url.searchParams.get('error') ?? undefined, error_description: url.searchParams.get('error_description') ?? undefined })
      res.writeHead(r.ok ? 200 : 400, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' })
      // the app's language: a phone's browser can keep another one (Chrome kept zh on an English phone, 2026-10-30)
      res.end(callbackPage(r, (await appLang?.().catch(() => undefined)) ?? pageLang(String(req.headers['accept-language'] ?? ''))))
      return true
    }
    if (connect && req.method === 'POST') {
      if (!auth) return send(res, 404, { error: 'not found' }), true
      // From this computer (loopback socket, not relayed): its browser can come back over loopback.
      const peer = req.socket.remoteAddress ?? ''
      const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer) && !req.headers['x-forwarded-for'] && !req.headers.forwarded
      const r = await auth.start(decodeURIComponent(connect[1]), { local, origin: requestOrigin({ peer, host: req.headers.host, forwarded: Boolean(req.headers['x-forwarded-for'] || req.headers.forwarded) }) })
      return send(res, 200, { url: r.url }), true
    }
    if (path === '/connectors' && req.method === 'GET') {
      const list = store.list()
      const names = [...new Set([...store.catalog.flatMap((p) => p.envNames), ...list.flatMap((c) => c.envNames ?? [])])]
      const catalog = store.catalog.map((p) => ({ ...p, available: p.auth === 'oauth' ? Boolean(auth?.available(p.id)) : true }))
      return send(res, 200, { connectors: list.map((c) => ({ ...c, missingEnv: missingEnv(c, env), connected: store.connected(c.id) })), catalog, env: envPresence(names, env), restartNeeded: store.restartNeeded() }), true
    }
    if (path === '/connectors' && req.method === 'POST') { const c = await store.add(await body(req) as AddInput); return send(res, 200, { ...c, missingEnv: missingEnv(c, env), connected: store.connected(c.id) }), true }
    if (one && req.method === 'PATCH') {
      const b = await body(req)
      const c = await store.setEnabled(decodeURIComponent(one[1]), Boolean(b.enabled))
      return c ? send(res, 200, { ...c, missingEnv: missingEnv(c, env), connected: store.connected(c.id) }) : send(res, 404, { error: 'not found' }), true
    }
    if (one && req.method === 'DELETE') {
      const id = decodeURIComponent(one[1])
      const ok = store.get(id)?.auth === 'oauth' && auth ? await auth.disconnect(id) : await store.remove(id)
      return send(res, 200, { ok }), true
    }
    return send(res, 404, { error: 'not found' }), true
  } catch (e) {
    if (e instanceof ConnectorError) return send(res, 400, { error: e.message }), true
    throw e
  }
}
