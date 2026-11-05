// The thin bot service: device auth in front, dsh web behind.
//   /api/*             → forwarded to dsh with its cookie (device token stripped)
//   /api/remote.mux    → WebSocket bridged to dsh's mux
//   /pair, /me, /push/*, /approvals*, /questions/*, /files/*  → bot's own
//   everything else    → the PWA in app/
// /events (WebSocket) frames from bot to the apps, besides the thread frames (src/thread.ts):
//   hello, ask, ask-cancelled, ask-answered, auto-approved, status, reset, connector, memory-updating, memory-updated,
//   { type: 'me-updated', assistant: { name } } — the assistant's name changed (the person renamed it in Settings or
//   told it a new name in chat); apps refresh GET /me.
import { computerInfo } from './computer.ts'
import { tilePath, type Tiles } from './tiles.ts'
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chown, readFile, readdir, writeFile, stat, mkdir, realpath, open as openFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join, extname, normalize, relative, isAbsolute } from 'node:path'
import { WebSocketServer, WebSocket } from 'ws'
import { bearerToken, type Device, type DeviceStore } from './devices.ts'
import type { Pairing } from './pairing.ts'
import type { Notification, PushService } from './push.ts'
import { approvalBody, askUrl, oneLine, threadUrl } from './push-text.ts'
import { FCM_TOKEN_RE } from './push-fcm.ts'
import type { EventWatcher, BotEvent } from './events.ts'
import { DshHarness, type Harness } from './harness.ts'
import { cardAnswerPrompt } from './cards.ts'
import { moduleAnswerPrompt, resultText, type Ui } from './ui.ts' // [agent:genui]
import { followThread, listThreads } from './thread.ts'
import { EventWatcher as Watcher } from './events.ts'
import { languageName, personLanguage, uiLang, wordsFor, writtenLanguage } from './lang.ts'
import { HTML_LANG, SERVER_WORDS, type Lang } from './locales/index.ts'
import { handleConnectorsRoute, isConnectorCallback, type ConnectorAuthLike, type Connectors } from './connectors.ts' // [agent:connectors]
import { pageLang } from './oauth.ts'
import { personZone } from './clock.ts'
import type { Guard } from './guard.ts'
import { DshRpcError, rpc } from './dshclient.ts'
import { isPermission, type Compliance } from './compliance.ts' // [compliance]
import { ReplyFilter } from './moderation.ts' // [compliance]

export interface BotOptions {
  /** Where the harness's own HTTP/WS API lives, for the apps that speak it through bot (DSH today). */
  dsh: { origin: string; cookie: string }
  /** The harness seam; defaults to DeepSeek Harness over `dsh`. */
  harness?: Harness
  devices: DeviceStore
  pairing?: Pairing
  push?: PushService
  watcher?: EventWatcher
  /** Directory holding SOUL.md / USER.md / MEMORY.md. */
  workspace?: string
  /** When set, new project folders belong to the unprivileged harness cell user. */
  workspaceUid?: number
  appDir?: string
  host?: string
  port?: number
  assistantName?: string
  /** Persisted settings the phone can read and change. */
  settings?: { get(): Promise<Settings>; set(patch: Partial<Settings>): Promise<Settings> }
  /** Bring your own key from the app (src/modelswitch.ts); absent = the model is fixed by whoever runs the bot. */
  model?: { describe(): { provider: string; model: string; baseURL?: string; hasKey: boolean }; set(c: { provider: string; model: string; baseURL?: string; apiKey?: string }): Promise<{ restarting: true } | { restartNeeded: true }> }
  scheduler?: { list(): unknown[]; remove(id: string): Promise<boolean>; update(id: string, patch: Record<string, unknown>): Promise<unknown> }
  goals?: { list(): unknown[]; update(id: string, patch: Record<string, unknown>): Promise<unknown>; remove(id: string): Promise<boolean> }
  activity?: () => unknown[]
  // [main] structured memory for the app; the files stay the storage
  memory?: { items(): Promise<unknown[]>; forgetById(id: string): Promise<string | null>; update?(id: string, patch: { text?: string; kind?: never }): Promise<unknown | null> }
  /** The bot home directory, for export/import. */
  home?: string
  /** Map tiles for the interfaces the assistant writes (src/tiles.ts): GET /ui/:id/tiles/:z/:x/:y.png?token=<the module's>. */
  tiles?: Tiles
  // [agent:library] The Library (src/library.ts): files the assistant made, for GET/DELETE /library*.
  library?: { list(): Promise<unknown[]>; read(path: string): Promise<{ kind: string; mime: string; bytes: Buffer; size: number; truncated: boolean } | null>; remove(path: string): Promise<boolean> }
  // [agent:proactive] Ideas (src/ideas.ts) for GET /ideas, POST /ideas/refresh, POST /ideas/:id/dismiss; and the turn-end hook the memory reflection (src/reflect.ts) listens to.
  ideas?: { list(): unknown[]; refresh(): Promise<unknown[]>; dismiss(id: string): Promise<boolean> }
  /** Fired once when a main-thread turn ends, with the person's message and the assistant's last line. */
  onTurnEnd?: (sessionId: string, turn: { user: string; assistant: string }) => void
  /** [agent:connectors] the connectors store (src/connectors.ts) behind GET/POST /connectors, PATCH/DELETE /connectors/:id. */
  connectors?: Connectors
  /** [agent:connectors] one-tap sign-in (src/oauth.ts): POST /connectors/:preset/connect, GET /connectors/callback (no device: the state is the proof). */
  connectorAuth?: ConnectorAuthLike
  /** A device was removed; its answer goes out first, since this may close the connection it came on (src/pocket.ts). */
  onDeviceRevoked?: (id: string) => void | Promise<void> | undefined
  /** [host] DEEPSEEK_BOT_HOST_SECRET: lets the host that runs this bot pair a device with POST /pair {hostSecret, name}, no code needed. */
  hostSecret?: string
  /** [agent:genui] Modules the assistant wrote (src/ui.ts): GET /ui/:id.nshpkg|/bundle.js|/bundle.nshc|/source|/meta (device), POST /ui/:id/result (module token). */
  ui?: Ui
  /** [guard] server-side outbound policy: what the app may make this bot call, and whether it may change the model. */
  guard?: Guard
  /** [compliance] The AI-provider consent gate, reports and interface links. Absent: no gate (tests that predate it). */
  compliance?: Compliance
  /** [push] How often each phone's /events socket is pinged; one that has not answered the last ping is dropped (a suspended or killed app). Default 30 s. */
  heartbeatMs?: number
}

export interface Settings { assistantName: string; mainSessionId: string | null; language: string; person?: PersonContext; /** The language of what the person writes (src/lang.ts writtenLanguage), when their phone has not said. */ spokenLanguage?: string }
/** What the phone already knows about the person. Sent by the app on every connect (PUT /me/context); never asked for. */
export interface PersonContext { timeZone?: string; locale?: string; name?: string; deviceName?: string; /** The zone is the phone's 'UTC' and nothing better was known: a guess (NSH on Android has no zone, 2026-10-27). */ timeZoneGuessed?: boolean }

/**
 * At start: a remembered main thread the harness no longer has (config restored on another computer, the
 * harness's sessions wiped) would put "session/not-found" in the thread. Forget it, so the app asks for a new one
 * (POST /sessions/main). When the harness cannot list its sessions, the id is trusted. True when it was forgotten.
 */
export async function forgetGoneMainSession(harness: Pick<Harness, 'listSessions'>, settings: { get(): Promise<Settings>; set(p: Partial<Settings>): Promise<Settings> }): Promise<boolean> {
  const st = await settings.get()
  if (!st.mainSessionId) return false
  const known = await harness.listSessions().then((l) => l.some((x) => x.sessionId === st.mainSessionId)).catch(() => true)
  if (known) return false
  console.log(`[bot] main thread ${st.mainSessionId} is gone from the harness; the app will start a new one`)
  await settings.set({ mainSessionId: null })
  return true
}
// [agent:proactive] morning brief: opt-in, local hour (0–23), IANA zone ('' = this machine's zone)
export interface Settings { morningBrief?: boolean; briefHour?: number; timeZone?: string }
/** How often it speaks first: never, only when clearly worth it (default), or whenever it has something. */
export interface Settings { proactivity?: 'off' | 'low' | 'high' }
/** [compliance] The person agreed to send their messages to this provider (`provider` = compliance.ts AiProvider.key), and the age they declared. */
export interface Settings { aiConsent?: { provider: string; at: string } | null; age?: 'adult' | 'minor' | null }

export interface BotServer { origin: string; close(): Promise<void>; pending(): PendingAsk[] }
// [agent:proactive] send one message to every connected phone, e.g. { type: 'memory-updated' }
export interface BotServer { broadcast(msg: unknown): void }
/**
 * [push] A notification from the bot itself (a reminder, the assistant's `notify`, the morning brief). Skipped while
 * the app is open in the foreground on `sessionId` (on any thread when none is given); the tap lands on that thread
 * unless `n.url` says otherwise. `turn`: it stands for the turn it starts, so that turn's end does not push again.
 */
export interface BotServer { notify(n: Notification, o?: { sessionId?: string; turn?: boolean }): Promise<void> }

export type PendingAsk =
  | { kind: 'approval'; eventId: string; sessionId: string; request: Record<string, unknown>; at: number }
  | { kind: 'question'; eventId: string; sessionId: string; request: Record<string, unknown>; at: number }

// `origin`/`referer` are dropped: dsh's browser-trust fence only admits its own
// loopback authority (403 otherwise, measured 2026-10-26); the device token is the auth here.
const HOP = new Set(['authorization', 'cookie', 'host', 'origin', 'referer', 'connection', 'upgrade', 'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-extensions'])
const MEMORY_FILES = new Set(['SOUL.md', 'USER.md', 'MEMORY.md'])
/** Prefix on user-role messages that bot injects (reminders, the opening prompt); apps hide them. */
export const INJECT = '\u27e6bot\u27e7 '
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.wasm': 'application/wasm', '.nshc': 'application/octet-stream', '.woff2': 'font/woff2', '.ttf': 'font/ttf' }

function forwardHeaders(req: IncomingMessage, cookie: string) {
  const h: Record<string, string | string[]> = {}
  for (const [k, v] of Object.entries(req.headers)) if (v !== undefined && !HOP.has(k)) h[k] = v
  h.cookie = cookie
  return h
}

/** Resolve a path and keep it under the workspace; a symlink out of the workspace is refused. */
async function insideWorkspace(workspace: string | undefined, p: string): Promise<string | null> {
  if (!workspace) return null
  const ws = await realpath(workspace).catch(() => null)
  const real = await realpath(p).catch(() => null)
  if (!ws || !real) return null
  const rel = relative(ws, real)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)) ? real : null
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

/** The memory files sit directly in the workspace; O_NOFOLLOW keeps a planted symlink from reading or writing a bot file. */
async function readNoFollow(p: string): Promise<string> {
  try {
    const fh = await openFile(p, constants.O_RDONLY | constants.O_NOFOLLOW)
    try { return await fh.readFile({ encoding: 'utf8' }) } finally { await fh.close() }
  } catch { return '' }
}

async function writeNoFollow(p: string, body: string): Promise<boolean> {
  try {
    const fh = await openFile(p, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600)
    try { await fh.writeFile(body, 'utf8'); return true } finally { await fh.close() }
  } catch { return false }
}

async function readBody(req: IncomingMessage, limit = 1 << 20): Promise<string> {
  let s = ''
  for await (const c of req) { s += c; if (s.length > limit) throw new Error('body too large') }
  return s
}

export async function createBotServer(opts: BotOptions): Promise<BotServer> {
  const dsh = new URL(opts.dsh.origin)
  const ownHarness = !opts.harness
  const harness: Harness = opts.harness ?? new DshHarness(opts.dsh, opts.watcher ?? new Watcher({ origin: opts.dsh.origin, cookie: opts.dsh.cookie }))
  const pending = new Map<string, PendingAsk>()
  const phones = new Set<WebSocket>()
  // [push] What each open app is doing: in the foreground or not, which thread it follows, whether it answered the last ping.
  // An app tells the bot when it goes to the background ({type:'presence'}); one that stops answering pings is dropped.
  const presence = new Map<WebSocket, { foreground: boolean; sessionId: string | null; alive: boolean }>()
  /** An app is open on this thread (or, with no thread, open at all). A foreground app that follows no thread yet counts for every thread. */
  const watching = (sessionId?: string) => [...presence.values()].some((p) => p.foreground && (!sessionId || !p.sessionId || p.sessionId === sessionId))
  /** Threads whose current turn already had its push (a reminder): the turn's end stays quiet. */
  const pushedTurn = new Set<string>()
  /** True when it went out. */
  const notifyAbout = async (n: Notification, sessionId?: string) => {
    if (!opts.push || watching(sessionId)) return false
    await opts.push.notify({ ...n, url: n.url ?? (sessionId ? threadUrl(sessionId) : '/') })
    return true
  }
  const appDir = opts.appDir ?? join(process.cwd(), 'app')
  /** One-time addresses of module play pages (POST /ui/:id/play), two minutes each. */
  const playTickets = new Map<string, { moduleId: string; expires: number }>()

  // Browsers cannot set headers on a WebSocket upgrade, so the PWA sends the
  // device token as the second subprotocol: new WebSocket(url, ['bearer', token]).
  // Native clients whose WebSocket refuses that (NSH, measured 2026-10-26) take a
  // one-time ticket from POST /ws-ticket and open the socket with ?ticket=….
  const tickets = new Map<string, { deviceId: string; expires: number }>()
  const auth = async (req: IncomingMessage): Promise<Device | null> => {
    const t = bearerToken(req.headers.authorization) ?? subprotocolToken(req.headers['sec-websocket-protocol'])
    if (t) return opts.devices.lookup(t)
    const ticket = new URL(req.url ?? '/', 'http://bot').searchParams.get('ticket')
    if (ticket && req.headers.upgrade) {
      const row = tickets.get(ticket); tickets.delete(ticket)
      if (row && row.expires > Date.now()) return (await opts.devices.list()).find((d) => d.id === row.deviceId && !d.revokedAt) ?? null
    }
    return null
  }

  // Standing approvals: "allow for this task" (tool + session) and "always allow" (tool).
  const rules: { toolName: string; sessionId?: string }[] = []
  const ruleFor = (ask: { sessionId: string; request: Record<string, unknown> }) =>
    rules.find((r) => r.toolName === ask.request.toolName && (!r.sessionId || r.sessionId === ask.sessionId))

  // Watcher → pending asks + pushes.
  const onEvent = async (e: BotEvent) => {
    // The assistant's commands always run inside the sandbox. A request to run one
    // without it (DSH asks "escalate sandbox to danger-full-access: …") is refused
    // here, before any card or rule, the way Codex never grants full access to a
    // sandboxed agent. The tool tells the model the refusal is final.
    // A background task asks in the thread it belongs to, found by its header chain; the answer
    // still goes to its own event. An ask that belongs to no thread is refused: no card or push under a hidden session.
    if (e.type === 'approval' || e.type === 'question') {
      const threadId = harness.threadOf ? await harness.threadOf(e.sessionId) : e.sessionId
      if (!threadId) {
        console.log(`[bot] refused an ask from ${e.sessionId}: it belongs to no thread`)
        await harness.answer(e.eventId, e.type === 'approval'
          ? { kind: 'result', value: 'rejected' }
          : { kind: 'rejected', error: { name: 'UserQuestionError', code: 'cancelled', message: 'the user closed this request' } })
        return
      }
      e = { ...e, sessionId: threadId }
    }
    if (e.type === 'approval' && /^escalate sandbox to danger-full-access\b/.test(String(e.request.reason ?? ''))) {
      await harness.answer(e.eventId, { kind: 'result', value: 'rejected' })
      console.log(`[bot] refused leaving the sandbox (${e.sessionId})`)
      return
    }
    // A standing rule never answers a request to widen a sandbox, in a background task or a top-level thread: that one goes to the phone.
    const widening = e.type === 'approval' && /^escalate sandbox to /.test(String(e.request.reason ?? ''))
    if (e.type === 'approval' && opts.watcher?.clientId && ruleFor(e) && !widening) {
      await harness.answer(e.eventId, { kind: 'result', value: 'allowed-once' })
      broadcast({ type: 'auto-approved', eventId: e.eventId, sessionId: e.sessionId, toolName: e.request.toolName })
      return
    }
    if (e.type === 'approval' || e.type === 'question') {
      pending.set(e.eventId, { kind: e.type, eventId: e.eventId, sessionId: e.sessionId, request: e.request, at: Date.now() })
      broadcast({ type: 'ask', ask: pending.get(e.eventId) })
      const st = await opts.settings?.get()
      const l = uiLang(personLanguage(st ?? {}))
      const w = wordsFor(st ?? {}), who = st?.assistantName || opts.assistantName || w.assistant
      await notifyAbout(e.type === 'approval'
        ? { title: w.needsYes(who), body: approvalBody(e.request, l), url: askUrl(e.sessionId, e.eventId), tag: `approval:${e.eventId}` }
        : { title: w.hasQuestion(who), body: oneLine(firstQuestion(e.request), 120) || w.openToAnswer, url: askUrl(e.sessionId, e.eventId), tag: `question:${e.eventId}` }, e.sessionId)
    } else if (e.type === 'cancel') {
      if (pending.delete(e.eventId)) broadcast({ type: 'ask-cancelled', eventId: e.eventId })
    } else if (e.type === 'status') {
      // A thread is working while its own turn or one of its background tasks runs. A task's
      // own turn is not a thread's: its result reaches the person as the thread's next reply, and that one is pushed.
      const tasks = (await harness.backgroundTasks?.().catch(() => [])) ?? []
      const task = tasks.find((t) => t.sessionId === e.sessionId)
      const threadId = task?.threadId ?? e.sessionId
      const own = task ? Boolean((await harness.listSessions().catch(() => [])).find((x) => x.sessionId === threadId)?.running) : e.running
      broadcast({ type: 'status', sessionId: threadId, running: own || tasks.some((t) => t.threadId === threadId && t.running && !(task && t.sessionId === e.sessionId && !e.running)) })
      if (!task) await onStatus(e.sessionId, e.running).catch((err) => console.error('[bot] turn follow', err))
    } else if (e.type === 'disconnected') {
      pending.clear(); broadcast({ type: 'reset' })
    }
  }
  opts.watcher?.on('event', (e) => { onEvent(e).catch((err) => console.error('[bot] event handling failed', err)) })

  // bot's own follow of each running thread: the last assistant line of a turn becomes
  // a push when no app is open on that thread at turn end. The main thread's follow stays open.
  const follows = new Map<string, { sessionId: string; cancel(): void; lastText: string }>()
  const textOf = (c: unknown) => (Array.isArray(c) ? c : []).filter((x: { type: string }) => x.type === 'text').map((x: { text: string }) => x.text).join('')
  // [agent:proactive] the person's message of the current turn, per session (shape: event user/message, data.content[], measured 2026-10-27 in scratchpad/shapes.json)
  const turnUser = new Map<string, string>()
  const noteUser = (sessionId: string, ev: { type?: string; data?: { content?: unknown } } | undefined) => { if (ev?.type === 'user/message') { const t = textOf(ev.data?.content); if (t.trim() && !t.startsWith(INJECT)) turnUser.set(sessionId, t) } }
  const ensureFollow = async (sessionId: string) => {
    if (follows.has(sessionId)) return
    const f = { sessionId, cancel: () => {}, lastText: '' }
    follows.set(sessionId, f)
    f.cancel = await harness.follow(sessionId, (v) => {
      const e = v as { type: string; event?: { type: string; data?: { message?: { content?: unknown } } } }
      if (e.type === 'event' && e.event?.type === 'assistant/message') { const t = textOf(e.event.data?.message?.content); if (t.trim()) f.lastText = t }
      // [agent:proactive] remember the person's side of the turn: live events, and the snapshot's records when the follow opens mid-turn
      if (e.type === 'event') noteUser(sessionId, e.event)
      else if (e.type === 'snapshot') for (const r of ((v as { records?: { event?: { type?: string; data?: { content?: unknown } } }[] }).records ?? [])) noteUser(sessionId, r.event)
    })
  }
  const onStatus = async (sessionId: string, running: boolean) => {
    const main = (await opts.settings?.get())?.mainSessionId
    const isMain = Boolean(main) && sessionId === main
    if (running) { await ensureFollow(sessionId); return }
    const follow = follows.get(sessionId)
    if (!follow) return
    // The idle emit and the turn's last message travel on different sockets; let the follow settle first.
    await new Promise((r) => setTimeout(r, 300))
    const text = follow.lastText
    follow.lastText = ''
    if (!isMain) { follow.cancel(); follows.delete(sessionId) }
    const quiet = pushedTurn.delete(sessionId)
    if (!isMain) {
      if (text && !quiet) await turnDone(sessionId, text)
      return
    }
    // [agent:proactive] one hook per finished turn (memory reflection); the person's text is consumed here
    const userText = turnUser.get(sessionId) ?? ''
    turnUser.delete(sessionId)
    if (opts.onTurnEnd && (text || userText)) { try { opts.onTurnEnd(sessionId, { user: userText, assistant: text }) } catch (e) { console.error('[bot] onTurnEnd', e) } }
    if (text && !quiet) await turnDone(sessionId, text)
  }
  /** A turn ended: its last line, unless an app is open on that thread. Repeated "done" for one thread collapse into one notification. */
  const turnDone = async (sessionId: string, text: string) => {
    const st = await opts.settings?.get()
    const w = wordsFor(st ?? {})
    await notifyAbout({ title: w.done(st?.assistantName || opts.assistantName || w.assistant), body: oneLine(text, 160), url: threadUrl(sessionId), tag: `turn:${sessionId}` }, sessionId) // a title a screen reader can tell from "has a question"
  }

  const broadcast = (msg: unknown) => { const s = JSON.stringify(msg); for (const p of phones) if (p.readyState === WebSocket.OPEN) p.send(s) }

  const answer = async (eventId: string, outcome: unknown) => {
    const ask = pending.get(eventId)
    if (!ask) return { status: 404, body: { error: 'no such pending request' } }
    if (!harness.events.clientId) return { status: 503, body: { error: 'not connected to the assistant' } }
    await harness.answer(eventId, outcome)
    pending.delete(eventId)
    broadcast({ type: 'ask-answered', eventId })
    return { status: 200, body: { ok: true } }
  }

  // [compliance] Nothing goes to the model until the person (18 or older) agreed to the provider: 403 {error: 'ai-consent' | 'age'}.
  const refused = async (res: ServerResponse): Promise<boolean> => {
    const why = await opts.compliance?.gate()
    if (!why) return false
    json(res, 403, { error: why })
    return true
  }
  // [compliance] the content filter between the assistant's replies and the phone (src/moderation.ts)
  const replyFilter = opts.compliance?.moderator ? new ReplyFilter(opts.compliance.moderator) : null
  const sameHostSecret = (t: string | null) => Boolean(opts.hostSecret && t && t.length === opts.hostSecret.length && timingSafeEqual(Buffer.from(t), Buffer.from(opts.hostSecret)))
  const debug = process.env.DEEPSEEK_BOT_DEBUG === '1'
  const server = createServer(async (req, res) => {
    if (debug) res.on('finish', () => console.log(`[bot] ${req.method} ${req.url} → ${res.statusCode}`))
    try {
      const url = new URL(req.url ?? '/', 'http://bot')
      const path = url.pathname
      if (path.startsWith('/api/')) {
        if (!(await auth(req))) return json(res, 401, { error: 'device-unauthorized' })
        if (/^\/api\/session\/(prompt|steer)\b/.test(path) && await refused(res)) return // [compliance]
        return proxyHttp(req, res, dsh, forwardHeaders(req, opts.dsh.cookie))
      }
      if (path === '/pair' && req.method === 'POST') {
        const { code, name, hostSecret, role } = JSON.parse(await readBody(req) || '{}') as { code?: string; name?: string; hostSecret?: string; role?: string }
        // [host] the host pairs on the account's behalf with the shared secret it started this bot with; no code involved.
        // `role: 'host'` is the host's own pairing (hidden from the person's Devices, not theirs to remove); without it, the phone's.
        if (typeof hostSecret === 'string') {
          const ok = Boolean(opts.hostSecret) && hostSecret.length === opts.hostSecret!.length && timingSafeEqual(Buffer.from(hostSecret), Buffer.from(opts.hostSecret!))
          return ok ? json(res, 200, { token: await opts.devices.issue(String(name ?? 'host').slice(0, 64) || 'host', role === 'host' ? { role: 'host' } : {}) }) : json(res, 403, { error: 'wrong or expired code' })
        }
        if (!opts.pairing) return json(res, 404, { error: 'pairing disabled' })
        const token = await opts.pairing.claim(String(code ?? ''), String(name ?? 'phone'))
        return token ? json(res, 200, { token }) : json(res, 403, { error: 'wrong or expired code' })
      }
      // [compliance] the privacy policy and terms, also from a computer the person runs (the app links here when it knows no host)
      if ((path === '/privacy' || path === '/terms') && req.method === 'GET' && opts.compliance) {
        const { privacyPage, termsPage } = await import('./legal.ts')
        const q = url.searchParams.get('lang'); const lang = q ? uiLang(q) : pageLang(String(req.headers['accept-language'] ?? ''))
        const info = { operator: process.env.DEEPSEEK_BOT_OPERATOR || 'Boop', contact: process.env.DEEPSEEK_BOT_CONTACT || '', hostUrl: '', ai: opts.compliance.provider(), filter: opts.compliance.moderator?.name ?? null }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        return res.end(path === '/privacy' ? privacyPage(info, lang) : termsPage(info, lang))
      }
      if (path === '/push/vapid') return json(res, 200, { publicKey: opts.push?.publicKey ?? null })
      if (path === '/health') return json(res, 200, { ok: true, dsh: Boolean(opts.watcher?.clientId) })
      // [agent:connectors] GET/POST /connectors, PATCH/DELETE /connectors/:id — paired device required.
      if (opts.connectors && (path === '/connectors' || path.startsWith('/connectors/'))) {
        if (!isConnectorCallback(req.method, path) && !(await auth(req))) return json(res, 401, { error: 'device-unauthorized' })
        if (await handleConnectorsRoute(req, res, opts.connectors, process.env, opts.connectorAuth, async () => { const st = await opts.settings?.get(); return st ? uiLang(personLanguage(st)) : undefined })) return
      }

      // An image the harness keeps in its attachment store, in the shape of
      // GET /library/file?format=json, so the app fetches it as it fetches a presented image. 404: no such image;
      // 502: the harness did not answer (the app tries again).
      if (path === '/library/attachment' && req.method === 'GET') {
        if (!(await auth(req))) return json(res, 401, { error: 'device-unauthorized' })
        const sessionId = url.searchParams.get('session') ?? '', attachmentId = url.searchParams.get('id') ?? ''
        if (!sessionId || !attachmentId) return json(res, 400, { error: 'session and id are required' })
        let got: { attachment?: { mediaType?: string; bytes?: number }; data?: string }
        try { got = await rpc(opts.dsh, 'session/attachment', { request: { sessionId, attachmentId } }) }
        catch (e) { return e instanceof DshRpcError && !e.code.startsWith('http-') ? json(res, 404, { error: 'not found' }) : json(res, 502, { error: 'the assistant did not answer' }) }
        const mime = got.attachment?.mediaType ?? 'application/octet-stream'
        if (typeof got.data !== 'string') return json(res, 404, { error: 'not found' })
        return json(res, 200, { path: '', kind: mime.startsWith('image/') ? 'image' : 'binary', mime, size: got.attachment?.bytes ?? Buffer.from(got.data, 'base64').length, truncated: false, base64: got.data })
      }

      // [agent:library] The Library: GET /library (list), GET /library/file?path= (text or bytes; &format=json → {kind,mime,size,text|base64}), DELETE /library/file?path=.
      if (opts.library && (path === '/library' || path === '/library/file')) {
        if (!(await auth(req))) return json(res, 401, { error: 'device-unauthorized' })
        if (path === '/library' && req.method === 'GET') return json(res, 200, await opts.library.list())
        const filePath = url.searchParams.get('path') ?? ''
        if (!filePath) return json(res, 400, { error: 'path is required' })
        if (req.method === 'DELETE') return (await opts.library.remove(filePath)) ? json(res, 200, { ok: true }) : json(res, 404, { error: 'not found' })
        if (req.method === 'GET') {
          const file = await opts.library.read(filePath)
          if (!file) return json(res, 404, { error: 'not found' })
          if (url.searchParams.get('format') === 'json') {
            const body: Record<string, unknown> = { path: filePath, kind: file.kind, mime: file.mime, size: file.size, truncated: file.truncated }
            if (file.kind === 'text') body.text = file.bytes.toString('utf8'); else body.base64 = file.bytes.toString('base64')
            return json(res, 200, body)
          }
          res.writeHead(200, { 'content-type': file.mime, 'content-length': file.bytes.length, 'cache-control': 'no-store', 'x-truncated': file.truncated ? '1' : '0' })
          return res.end(file.bytes)
        }
        return json(res, 405, { error: 'method not allowed' })
      }

      // [agent:proactive] Ideas: GET /ideas (undismissed, newest first), POST /ideas/refresh (ask the model now, returns the fresh list), POST /ideas/:id/dismiss — paired device required.
      if (opts.ideas && (path === '/ideas' || path.startsWith('/ideas/'))) {
        if (!(await auth(req))) return json(res, 401, { error: 'device-unauthorized' })
        if (path === '/ideas' && req.method === 'GET') return json(res, 200, opts.ideas.list())
        if (path === '/ideas/refresh' && req.method === 'POST') {
          if (await refused(res)) return // [compliance]
          try { return json(res, 200, await opts.ideas.refresh()) } catch (e) { console.error('[bot] ideas refresh', (e as Error).message); return json(res, 502, { error: 'the model did not answer' }) }
        }
        const dismiss = /^\/ideas\/([^/]+)\/dismiss$/.exec(path)
        if (dismiss && req.method === 'POST') return (await opts.ideas.dismiss(decodeURIComponent(dismiss[1]))) ? json(res, 200, { ok: true }) : json(res, 404, { error: 'not found' })
        return json(res, 404, { error: 'not found' })
      }

      // [agent:genui] The play page's runtime files. The page has the module's token; the host cannot check it, so the
      // page fetches them through the module's own (not spent) token. That keeps the public files off a tenant path
      // that any valid sandbox id could read.
      const runtime = opts.ui && /^\/ui\/([\w-]+)\/runtime\/((?:nsh|harden|host)\.[0-9a-f]+\.(?:js|wasm|nshc))$/.exec(path)
      if (runtime) {
        if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
        if (!opts.ui!.verify(runtime[1], url.searchParams.get('token'))) return json(res, 401, { error: 'module-unauthorized' })
        return serveStatic(appDir, `/${runtime[2]}`, res)
      }

      // A map's tiles (src/tiles.ts). A module's canvas can send no header, so its token is in the address, as above.
      const tile = opts.ui && opts.tiles && /^\/ui\/([\w-]+)(\/tiles\/.+)$/.exec(path)
      if (tile && req.method === 'GET') {
        if (!opts.ui!.verify(tile[1], url.searchParams.get('token'))) return json(res, 401, { error: 'module-unauthorized' })
        const t = tilePath(tile[2])
        const png = t && await opts.tiles!.get(t)
        if (!png) return json(res, 404, { error: 'no tile' })
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=604800' })
        return res.end(png)
      }

      // [agent:genui] A module the assistant built. The package, its bundle (browser), source ("show its work") and meta
      // (the one-time result token) need the device; the result needs the module's own token, once. ?session= on the
      // package download binds the module to the thread it was opened from; without it the result goes to the main thread.
      // [compliance] The person's interfaces: GET /ui (newest first, with a link that opens each in the app), PATCH /ui/:id
      // {hidden?, grants?} (hide one; allow what it asked for), and POST /ui/:id/block for the host after a report (host secret).
      if (opts.ui && path === '/ui' && req.method === 'GET') {
        if (!(await auth(req))) return json(res, 401, { error: 'device-unauthorized' })
        return json(res, 200, opts.ui.list().sort((a, b) => b.at - a.at).map((m) => ({ id: m.id, title: m.title, at: m.at, answered: Boolean(m.spent), hidden: Boolean(m.hidden), blocked: Boolean(m.blocked), permissions: m.permissions ?? [], grants: m.grants ?? [], link: opts.compliance?.link(m.id) ?? null })))
      }
      const uiOne = opts.ui && /^\/ui\/([\w-]+)(\/block)?$/.exec(path)
      if (uiOne && opts.ui) {
        const [, id, block] = uiOne
        if (block) {
          if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
          if (!sameHostSecret(bearerToken(req.headers.authorization))) return json(res, 401, { error: 'host-secret' })
          return (await opts.ui.block(id)) ? json(res, 200, { ok: true }) : json(res, 404, { error: 'not found' })
        }
        if (!(await auth(req))) return json(res, 401, { error: 'device-unauthorized' })
        if (req.method !== 'PATCH') return json(res, 405, { error: 'method not allowed' })
        const m = opts.ui.module(id)
        if (!m) return json(res, 404, { error: 'not found' })
        let body: { hidden?: unknown; grants?: unknown } = {}
        try { body = JSON.parse(await readBody(req) || '{}') } catch { return json(res, 400, { error: 'bad json' }) }
        if (body.grants !== undefined) {
          if (!Array.isArray(body.grants) || !body.grants.every(isPermission) || !(await opts.ui.setGrants(id, body.grants))) return json(res, 400, { error: 'it did not ask for that' })
        }
        if (typeof body.hidden === 'boolean' && !(await opts.ui.setHidden(id, body.hidden))) return json(res, 403, { error: 'blocked' })
        const n = opts.ui.module(id)!
        return json(res, 200, { id, hidden: Boolean(n.hidden), blocked: Boolean(n.blocked), permissions: n.permissions ?? [], grants: n.grants ?? [] })
      }

      const um = opts.ui && /^\/ui\/([\w-]+)(\.nshpkg|\/bundle\.js|\/bundle\.nshc|\/source|\/meta|\/result|\/play)$/.exec(path)
      if (um) {
        const [, id, what] = um
        // The play page, for a phone app with no native shell to run a package (the Android APK): the device asks for a
        // one-time address (POST); the page at it (GET, by the ticket alone) runs the bundle in the phone's browser with
        // the module's own result token and never the device's.
        if (what === '/play' && req.method === 'GET') {
          const ticket = url.searchParams.get('ticket') ?? ''
          const t = playTickets.get(ticket)
          playTickets.delete(ticket)
          if (!t || t.moduleId !== id || t.expires < Date.now()) return json(res, 401, { error: 'ticket' })
          const m = opts.ui!.module(id)
          if (m?.hidden) return json(res, 410, { error: 'hidden' }) // [compliance]
          const bundle = m && await readFile(opts.ui!.bundlePath(id, 'bundle.nshc')).catch(() => null)
          if (!m || !bundle) return json(res, 404, { error: 'not found' })
          const page = await playPage(appDir, { title: m.title, token: m.token, moduleId: id, bundle, lang: pageLang(String(req.headers['accept-language'] ?? '')) })
          if (!page) return json(res, 404, { error: 'no browser build' })
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' })
          return res.end(page)
        }
        if (what === '/result') {
          if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
          if (await refused(res)) return // [compliance] the result becomes the person's message to the model
          const spent = await opts.ui!.spend(id, bearerToken(req.headers.authorization))
          if (spent.status !== 200) return json(res, spent.status, { error: spent.status === 401 ? 'module-unauthorized' : 'already answered' })
          let body: { value?: unknown; text?: unknown } = {}
          try { body = JSON.parse(await readBody(req) || '{}') } catch { return json(res, 400, { error: 'bad json' }) }
          const sessionId = spent.module.sessionId ?? (await opts.settings?.get())?.mainSessionId
          if (!sessionId) return json(res, 409, { error: 'no thread to answer in' })
          await harness.prompt(sessionId, moduleAnswerPrompt(id, resultText(body)), { timeZone: personZone((await opts.settings?.get()) ?? {}) ?? undefined })
          broadcast({ type: 'module-answered', moduleId: id })
          return json(res, 200, { ok: true })
        }
        if (!(await auth(req))) return json(res, 401, { error: 'device-unauthorized' })
        const m = opts.ui!.module(id)
        if (!m) return json(res, 404, { error: 'not found' })
        if (m.hidden && what !== '/source') return json(res, 410, { error: 'hidden' }) // [compliance] hidden or blocked: it no longer opens
        if (what === '/meta') return json(res, 200, { id: m.id, title: m.title, token: m.token, at: m.at, answered: Boolean(m.spent), permissions: m.permissions ?? [], grants: m.grants ?? [] })
        if (what === '/play') {
          if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
          let body: { session?: unknown } = {}
          try { body = JSON.parse(await readBody(req) || '{}') } catch {}
          if (typeof body.session === 'string' && /^[\w-]{1,80}$/.test(body.session)) await opts.ui!.bind(id, body.session)
          for (const [k, v] of playTickets) if (v.expires < Date.now()) playTickets.delete(k)
          const ticket = randomBytes(24).toString('base64url')
          playTickets.set(ticket, { moduleId: id, expires: Date.now() + 2 * 60_000 })
          return json(res, 200, { url: `/ui/${id}/play?ticket=${ticket}` })
        }
        const file = what === '.nshpkg' ? opts.ui!.packagePath(id) : what === '/source' ? opts.ui!.sourcePath(id) : opts.ui!.bundlePath(id, what === '/bundle.js' ? 'bundle.js' : 'bundle.nshc')
        if (what === '.nshpkg') { const sid = url.searchParams.get('session'); if (sid) await opts.ui!.bind(id, sid) }
        const bytes = await readFile(file).catch(() => null)
        if (!bytes) return json(res, 404, { error: 'not found' })
        res.writeHead(200, { 'content-type': what === '/source' ? 'text/plain; charset=utf-8' : what === '/bundle.js' ? 'text/javascript; charset=utf-8' : 'application/octet-stream', 'content-length': bytes.length, 'cache-control': 'no-store' })
        return res.end(bytes)
      }

      // Everything below needs a paired device.
      const needsDevice = path === '/consent' || path === '/reports' || path === '/threads' || path.startsWith('/threads/') || path === '/export' || path === '/import' || path === '/usage' || path === '/memory' || path.startsWith('/memory/') || path === '/me' || path === '/me/context' || path === '/settings' || path === '/model' || path === '/asks' || path === '/sessions/main' || path === '/ws-ticket' || path === '/schedules' || path.startsWith('/schedules/') || path === '/goals' || path.startsWith('/goals/') || path === '/activity' || path.startsWith('/push/') || path.startsWith('/approvals') || path.startsWith('/questions/') || path.startsWith('/files/') || path === '/devices' || path.startsWith('/devices/')
      if (needsDevice) {
        const device = await auth(req)
        if (!device) return json(res, 401, { error: 'device-unauthorized' })
        if (path === '/me') {
          const st = await opts.settings?.get()
          // [agent:genui] uiRootPublicKey: the phone trusts modules signed under this root (null: the ui tool is off on this computer)
          return json(res, 200, { device: { id: device.id, name: device.name }, computer: computerInfo(), assistant: { name: st?.assistantName ?? opts.assistantName ?? '' }, mainSessionId: st?.mainSessionId ?? null, connected: Boolean(opts.watcher?.clientId), pushPublicKey: opts.push?.publicKey ?? null, uiRootPublicKey: opts.ui?.rootPublicKey || null, ...(opts.compliance ? await opts.compliance.state() : {}) })
        }
        // [compliance] PUT /consent {age?: 'adult'|'minor', ai?: boolean}: the declared age and the agreement to send messages to the AI provider (or its withdrawal)
        if (path === '/consent' && req.method === 'PUT' && opts.compliance) {
          let body: Record<string, unknown> = {}
          try { body = JSON.parse(await readBody(req) || '{}') } catch { return json(res, 400, { error: 'bad json' }) }
          try { return json(res, 200, await opts.compliance.setConsent(body)) } catch (e) { return json(res, 400, { error: (e as Error).message }) }
        }
        // [compliance] POST /reports: a reply or an interface the person reports; GET /reports: what they reported
        if (path === '/reports' && opts.compliance) {
          if (req.method === 'GET') return json(res, 200, opts.compliance.reports())
          if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
          let body: Record<string, unknown> = {}
          try { body = JSON.parse(await readBody(req) || '{}') } catch { return json(res, 400, { error: 'bad json' }) }
          const mod = typeof body.moduleId === 'string' ? opts.ui?.module(body.moduleId) : undefined
          if (body.kind === 'interface' && !mod) return json(res, 404, { error: 'no such interface' })
          try {
            const extra = mod ? { moduleTitle: mod.title, moduleSource: await readFile(opts.ui!.sourcePath(mod.id), 'utf8').catch(() => undefined) } : {}
            const r = await opts.compliance.report(body, extra)
            if (mod && body.hide === true) await opts.ui!.setHidden(mod.id, true)
            return json(res, 200, { ok: true, id: r.report.id, forwarded: r.forwarded })
          } catch (e) { return json(res, 400, { error: (e as Error).message }) }
        }
        if (path === '/me/context' && req.method === 'PUT' && opts.settings) {
          const b = JSON.parse(await readBody(req) || '{}') as Record<string, unknown>
          const prevSettings = await opts.settings.get()
          const prev = prevSettings.person ?? {}
          const person: PersonContext = { ...prev }
          if (typeof b.timeZone === 'string' && validTimeZone(b.timeZone)) {
            if (!isUtc(b.timeZone)) { person.timeZone = b.timeZone; delete person.timeZoneGuessed }
            else {
              // 'UTC' from a phone usually means it could not tell: keep a zone the person stated, or one known before
              const stated = opts.workspace ? statedTimeZone(await readNoFollow(join(opts.workspace, 'USER.md'))) : null
              const known = stated ?? realZone(prev.timeZone) ?? realZone(prevSettings.timeZone)
              if (known) { person.timeZone = known; delete person.timeZoneGuessed } else { person.timeZone = b.timeZone; person.timeZoneGuessed = true }
            }
          }
          if (typeof b.locale === 'string' && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(b.locale)) person.locale = b.locale
          if (typeof b.name === 'string' && b.name.trim() && b.name.trim().length <= 60) person.name = b.name.trim()
          if (typeof b.deviceName === 'string' && b.deviceName.trim() && b.deviceName.trim().length <= 60) person.deviceName = b.deviceName.trim()
          const patch: Partial<Settings> = { person }
          // the phone's zone is the person's zone unless they set one by hand; a guess is not
          if (person.timeZone && !person.timeZoneGuessed && !prevSettings.timeZone) patch.timeZone = person.timeZone
          await opts.settings.set(patch)
          return json(res, 200, { ok: true })
        }
        if (path === '/settings' && req.method === 'PUT' && opts.settings) {
          const patch = JSON.parse(await readBody(req) || '{}') as Partial<Settings>
          const allowed: Partial<Settings> = {}
          if (typeof patch.assistantName === 'string') allowed.assistantName = patch.assistantName.trim().slice(0, 40)
          if (typeof patch.mainSessionId === 'string') allowed.mainSessionId = patch.mainSessionId
          if (typeof patch.language === 'string') allowed.language = patch.language.slice(0, 10)
          // [agent:proactive] morning brief fields
          if (typeof patch.morningBrief === 'boolean') allowed.morningBrief = patch.morningBrief
          if (typeof patch.briefHour === 'number' && Number.isInteger(patch.briefHour) && patch.briefHour >= 0 && patch.briefHour <= 23) allowed.briefHour = patch.briefHour
          if (typeof patch.timeZone === 'string' && (patch.timeZone === '' || validTimeZone(patch.timeZone))) allowed.timeZone = patch.timeZone
          if (patch.proactivity === 'off' || patch.proactivity === 'low' || patch.proactivity === 'high') allowed.proactivity = patch.proactivity
          const saved = await opts.settings.set(allowed)
          if (allowed.assistantName !== undefined) broadcast({ type: 'me-updated', assistant: { name: saved.assistantName } })
          return json(res, 200, saved)
        }
        // Bring your own key: the app never reads a key back, only whether one is on file.
        if (path === '/model' && req.method === 'GET') return json(res, 200, opts.model ? opts.model.describe() : { fixed: true })
        if (path === '/model' && req.method === 'PUT') {
          const can = opts.guard?.canChangeModel()
          if (can && !can.ok) return json(res, can.status, { error: can.error })
          if (!opts.model) return json(res, 403, { error: 'the model is fixed by whoever runs this bot' })
          const body = JSON.parse(await readBody(req) || '{}') as { provider?: string; model?: string; baseURL?: string; apiKey?: string }
          if (opts.guard && body.provider !== 'deepseek-official' && typeof body.baseURL === 'string') {
            try { await opts.guard.checkModelBaseURL(body.baseURL) } catch (e) { return json(res, 400, { error: (e as Error).message }) }
          }
          try { return json(res, 200, await opts.model.set({ provider: String(body.provider ?? ''), model: String(body.model ?? ''), baseURL: typeof body.baseURL === 'string' ? body.baseURL : undefined, apiKey: typeof body.apiKey === 'string' ? body.apiKey : undefined })) }
          catch (e) { return json(res, 400, { error: (e as Error).message }) }
        }
        if (path === '/ws-ticket' && req.method === 'POST') {
          const ticket = randomBytes(24).toString('base64url')
          tickets.set(ticket, { deviceId: device.id, expires: Date.now() + 60_000 })
          for (const [k, v] of tickets) if (v.expires < Date.now()) tickets.delete(k)
          return json(res, 200, { ticket, expiresIn: 60 })
        }
        if (path === '/push/subscribe' && req.method === 'POST') {
          const sub = JSON.parse(await readBody(req) || '{}') as { endpoint?: string; keys?: { p256dh: string; auth: string } }
          // [agent:ios] The iOS app registers its APNs token as { kind: 'apns', token }.
          const native = sub as unknown as { kind?: string; token?: string }
          if (native.kind === 'apns') {
            if (!/^[0-9a-f]{16,512}$/i.test(String(native.token ?? ''))) return json(res, 400, { error: 'apns token must be hex' })
            await opts.push?.subscribeApns(device.id, String(native.token))
            return json(res, 200, { ok: true })
          }
          // [push] The Android app registers its FCM token as { kind: 'fcm', token }.
          if (native.kind === 'fcm') {
            if (!FCM_TOKEN_RE.test(String(native.token ?? ''))) return json(res, 400, { error: 'fcm token has unexpected characters' })
            await opts.push?.subscribeFcm(device.id, String(native.token))
            return json(res, 200, { ok: true })
          }
          if (!sub.endpoint || !sub.keys) return json(res, 400, { error: 'subscription missing endpoint/keys' })
          if (opts.guard) { try { await opts.guard.checkPushEndpoint(sub.endpoint) } catch (e) { return json(res, 400, { error: (e as Error).message }) } }
          await opts.push?.subscribe(device.id, { endpoint: sub.endpoint, keys: sub.keys })
          return json(res, 200, { ok: true })
        }
        // [agent:ios] Notifications off for this phone: forget its web and APNs subscriptions.
        if (path === '/push/unsubscribe' && req.method === 'POST') { await opts.push?.unsubscribeDevice(device.id); return json(res, 200, { ok: true }) }
        // [main] bot's own thread API (harness-agnostic; the apps use this, not the harness wire)
        // the main thread's harness title was made from the hidden opening prompt (English, about onboarding): the apps label it themselves
        const mainId = (await opts.settings?.get())?.mainSessionId
        if (path === '/threads' && req.method === 'GET') return json(res, 200, (await listThreads(harness)).map((t) => (t.sessionId === mainId ? { ...t, title: undefined } : t)))
        if (path === '/threads' && req.method === 'POST') {
          // A side chat may be a project: {project: "name"} → <workspace>/projects/<name> (created), or {cwd: "/abs/dir"}.
          const body = JSON.parse(await readBody(req) || '{}') as { project?: string; cwd?: string }
          let cwd = opts.workspace
          if (typeof body.project === 'string' && /^[\w.-]{1,64}$/.test(body.project) && opts.workspace) {
            cwd = join(opts.workspace, 'projects', body.project)
            await mkdir(cwd, { recursive: true })
            if (opts.workspaceUid !== undefined) await chown(cwd, opts.workspaceUid, opts.workspaceUid).catch(() => {})
            if (opts.guard?.policy.hosted) {
              const real = await insideWorkspace(opts.workspace, cwd)
              if (!real) return json(res, 400, { error: 'project folder must be inside the workspace' })
              cwd = real
            }
          }
          else if (typeof body.cwd === 'string' && body.cwd.startsWith('/')) {
            if (opts.guard?.policy.hosted) {
              const real = await insideWorkspace(opts.workspace, body.cwd)
              if (!real) return json(res, 400, { error: 'cwd must be inside the workspace' })
              cwd = real
            } else cwd = body.cwd
          }
          return json(res, 200, { ...(await harness.createSession(cwd)), cwd })
        }
        const tm = /^\/threads\/([^/]+)\/messages$/.exec(path)
        if (tm && req.method === 'POST') {
          if (await refused(res)) return // [compliance]
          const body = JSON.parse(await readBody(req) || '{}') as { text?: string; timeZone?: string; cardId?: string }
          if (!body.text?.trim()) return json(res, 400, { error: 'text is required' })
          // a tap on a card: the person's words, preceded by a marker line the fold uses to mark the card answered
          const card = typeof body.cardId === 'string' && /^[\w-]+$/.test(body.cardId)
          const text = card ? cardAnswerPrompt(body.cardId!, body.text) : body.text
          // what they write tells their language (a card's label was written by the assistant, so it does not)
          const spoken = card ? null : writtenLanguage(body.text)
          if (spoken && opts.settings && (await opts.settings.get()).spokenLanguage !== spoken) await opts.settings.set({ spokenLanguage: spoken })
          // a phone that cannot tell its zone sends 'UTC': the assistant gets the zone the bot knows instead
          let timeZone = body.timeZone
          if (timeZone && isUtc(timeZone)) { const st = await opts.settings?.get(); timeZone = realZone(st?.person?.timeZone) ?? realZone(st?.timeZone) ?? timeZone }
          await harness.prompt(decodeURIComponent(tm[1]), text, { timeZone })
          return json(res, 200, { ok: true })
        }
        if (path === '/memory' && req.method === 'GET' && opts.memory) return json(res, 200, await opts.memory.items())
        // [main] export / import of everything it knows
        if (path === '/export' && req.method === 'GET' && opts.home) { const { exportBundle } = await import('./portability.ts'); const b = await exportBundle(opts.home, (await opts.settings?.get())?.assistantName); res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-disposition': `attachment; filename="deepseek-bot-memory-${new Date().toISOString().slice(0, 10)}.json"` }); return res.end(JSON.stringify(b, null, 2)) }
        if (path === '/import' && req.method === 'POST' && opts.home) { const { importBundle } = await import('./portability.ts'); try { return json(res, 200, await importBundle(opts.home, JSON.parse(await readBody(req, 16 << 20)))) } catch (e) { return json(res, 400, { error: (e as Error).message }) } }
        // [main] usage transparency
        if (path === '/usage' && req.method === 'GET') { const { usage } = await import('./usage.ts'); const u = await usage(harness, (await opts.settings?.get())?.timeZone || undefined); return json(res, 200, { ...u, sessions: u.sessions.map((x) => (x.sessionId === mainId ? { ...x, title: undefined } : x)) }) }
        const mem = /^\/memory\/([^/]+)$/.exec(path)
        // [memory] the person corrects one item in the app: { text?, kind? } → the updated item
        if (mem && req.method === 'PATCH' && opts.memory?.update) {
          const body = JSON.parse(await readBody(req) || '{}') as { text?: unknown; kind?: unknown }
          if ((body.text !== undefined && typeof body.text !== 'string') || (body.kind !== undefined && typeof body.kind !== 'string')) return json(res, 400, { error: 'text and kind are strings' })
          try { const it = await opts.memory.update(decodeURIComponent(mem[1]), { text: body.text as string | undefined, kind: body.kind as never }); return it ? json(res, 200, it) : json(res, 404, { error: 'not found' }) } catch (e) { return json(res, 400, { error: (e as Error).message }) }
        }
        if (mem && req.method === 'DELETE' && opts.memory) { const removed = await opts.memory.forgetById(decodeURIComponent(mem[1])); return json(res, removed ? 200 : 404, { removed }) }
        if (path === '/schedules' && req.method === 'GET') return json(res, 200, opts.scheduler?.list() ?? [])
        if (path === '/goals' && req.method === 'GET') return json(res, 200, opts.goals?.list() ?? [])
        if (path === '/activity' && req.method === 'GET') return json(res, 200, opts.activity?.() ?? [])
        const sched = /^\/schedules\/([^/]+)$/.exec(path)
        if (sched && opts.scheduler) {
          if (req.method === 'DELETE') return json(res, 200, { ok: await opts.scheduler.remove(sched[1]) })
          if (req.method === 'PATCH') return json(res, 200, (await opts.scheduler.update(sched[1], JSON.parse(await readBody(req) || '{}'))) ?? { error: 'not found' })
        }
        const goal = /^\/goals\/([^/]+)$/.exec(path)
        if (goal && opts.goals) {
          if (req.method === 'DELETE') return json(res, 200, { ok: await opts.goals.remove(goal[1]) })
          if (req.method === 'PATCH') return json(res, 200, (await opts.goals.update(goal[1], JSON.parse(await readBody(req) || '{}'))) ?? { error: 'not found' })
        }
        if (path === '/sessions/main' && req.method === 'POST' && opts.settings) {
          if (await refused(res)) return // [compliance] the opening turn goes to the model
          const st = await opts.settings.get()
          // A remembered main thread the harness no longer has (config restored elsewhere, sessions wiped) would
          // otherwise put "session/not-found" in the thread; make a new one instead. If the list itself fails, trust the id.
          if (st.mainSessionId) {
            const known = await harness.listSessions().then((l) => l.some((x) => x.sessionId === st.mainSessionId)).catch(() => true)
            if (known) return json(res, 200, { sessionId: st.mainSessionId })
            console.log(`[bot] main thread ${st.mainSessionId} is gone from the harness; starting a new one`)
          }
          const created = await harness.createSession(opts.workspace)
          await opts.settings.set({ mainSessionId: created.sessionId })
          // The assistant speaks first. Injected prompts carry INJECT so apps hide them.
          const name = st.assistantName || 'the assistant'
          const known = st.person?.locale || st.spokenLanguage || (st.language && st.language !== 'auto' ? st.language : undefined)
          harness.prompt(created.sessionId, openingPrompt(name, st.person, known), { timeZone: personZone(st) ?? undefined }).catch((e) => console.error('[bot] opening prompt failed', e))
          return json(res, 200, { sessionId: created.sessionId })
        }
        if (path === '/approvals' && req.method === 'GET') return json(res, 200, [...pending.values()].filter((a) => a.kind === 'approval'))
        if (path === '/asks' && req.method === 'GET') return json(res, 200, [...pending.values()])
        const m = /^\/(approvals|questions)\/([^/]+)$/.exec(path)
        if (m && req.method === 'POST') {
          const body = JSON.parse(await readBody(req) || '{}') as { outcome?: string; answers?: unknown; cancel?: boolean; remember?: 'task' | 'always' }
          const ask = pending.get(decodeURIComponent(m[2]))
          if (ask && m[1] === 'approvals' && body.outcome !== 'rejected' && body.remember && typeof ask.request.toolName === 'string') {
            rules.push({ toolName: ask.request.toolName, sessionId: body.remember === 'task' ? ask.sessionId : undefined })
          }
          let outcome: unknown
          if (body.cancel) outcome = { kind: 'rejected', error: { name: 'UserQuestionError', code: 'cancelled', message: 'the user closed this request' } }
          else if (m[1] === 'approvals') outcome = { kind: 'result', value: body.outcome === 'rejected' ? 'rejected' : 'allowed-once' }
          else outcome = { kind: 'result', value: { answers: body.answers ?? [] } }
          const r = await answer(decodeURIComponent(m[2]), outcome)
          return json(res, r.status, r.body)
        }
        const f = /^\/files\/([^/]+)$/.exec(path)
        if (f && opts.workspace) {
          const name = decodeURIComponent(f[1])
          if (!MEMORY_FILES.has(name)) return json(res, 404, { error: 'not a memory file' })
          const p = join(opts.workspace, name)
          if (req.method === 'PUT') return (await writeNoFollow(p, await readBody(req))) ? json(res, 200, { ok: true }) : json(res, 400, { error: 'not writable' })
          res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'no-store' })
          return res.end(await readNoFollow(p))
        }
        // [host] the host's own pairing is infrastructure: the person never sees it, and only the host may revoke it (rotating
        // its tokens); removing it would cut the host off. A pairing from before `role` was kept is known by the host's name for it.
        const isHostPairing = (x: Device) => x.role === 'host' || (Boolean(opts.hostSecret) && !x.role && x.name === 'host')
        if (path === '/devices' && req.method === 'GET') return json(res, 200, (await opts.devices.list()).filter((x) => isHostPairing(device) || !isHostPairing(x)).map((x) => ({ id: x.id, name: x.name, createdAt: x.createdAt, revokedAt: x.revokedAt ?? null, current: x.id === device.id })))
        // PATCH /devices/me {name}: the calling device names itself (a phone the host paired, which the host could only call "phone")
        if (path === '/devices/me' && req.method === 'PATCH') {
          let body: { name?: unknown } = {}
          try { body = JSON.parse(await readBody(req) || '{}') } catch { return json(res, 400, { error: 'bad json' }) }
          const name = typeof body.name === 'string' ? body.name.trim().slice(0, 64) : ''
          if (!name) return json(res, 400, { error: 'name required' })
          await opts.devices.rename(device.id, name)
          return json(res, 200, { ok: true })
        }
        const d = /^\/devices\/([^/]+)$/.exec(path)
        if (d && req.method === 'DELETE') {
          const target = (await opts.devices.list()).find((x) => x.id === d[1])
          if (target && isHostPairing(target) && !isHostPairing(device)) return json(res, 403, { error: 'the host\'s own pairing' })
          await opts.devices.revoke(d[1]); await opts.push?.unsubscribeDevice(d[1]); json(res, 200, { ok: true }); res.once('finish', () => { Promise.resolve(opts.onDeviceRevoked?.(d[1])).catch(() => {}) }); return
        }
        return json(res, 404, { error: 'not found' })
      }
      // [agent:browser] Stop a running task: POST /sessions/:id/cancel → harness.cancel
      // (DSH `session/cancel`, wire `{request:{sessionId}}`, measured in dsh-api-session-controller
      // typert.host.js 0.2.0-rc.2). 404 when the harness has no cancel or no such session.
      const cancelMatch = /^\/sessions\/([^/]+)\/cancel$/.exec(path)
      if (cancelMatch && req.method === 'POST') {
        if (!(await auth(req))) return json(res, 401, { error: 'device-unauthorized' })
        try {
          const ok = await harness.cancel(decodeURIComponent(cancelMatch[1]))
          return json(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'stop not supported' })
        } catch (e) {
          if ((e as { code?: string }).code === 'session/not-found') return json(res, 404, { error: 'no such session' })
          throw e
        }
      }
      return serveStatic(appDir, path, res)
    } catch (err) {
      console.error('[bot]', req.method, req.url, err)
      if (!res.headersSent) json(res, 500, { error: 'internal' })
      else res.end()
    }
  })

  const wss = new WebSocketServer({ noServer: true, handleProtocols: (p) => (p.has('bearer') ? 'bearer' : false) })
  // [push] The heartbeat `ws` documents: ping every phone; one that did not answer the previous ping is gone (an app the
  // system suspended keeps its socket open on this side), so it no longer counts as open and the next event pushes.
  const heartbeat = setInterval(() => {
    for (const [ws, p] of presence) {
      if (!p.alive) { presence.delete(ws); phones.delete(ws); ws.terminate(); continue }
      p.alive = false
      try { ws.ping() } catch {}
    }
  }, opts.heartbeatMs ?? 30_000)
  heartbeat.unref()
  server.on('upgrade', async (req, socket, head) => {
    const device = await auth(req).catch((e) => { console.error('[bot] upgrade auth failed', e); return null })
    if (debug) console.log(`[bot] UPGRADE ${req.url} → ${device ? 'ok' : '401'}`)
    if (!device) { socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); socket.destroy(); return }
    const wsPath = new URL(req.url ?? '/', 'http://bot').pathname
    if (wsPath === '/events') {
      wss.handleUpgrade(req, socket, head, (ws) => {
        phones.add(ws)
        presence.set(ws, { foreground: true, sessionId: null, alive: true })
        ws.on('pong', () => { const p = presence.get(ws); if (p) p.alive = true })
        ws.send(JSON.stringify({ type: 'hello', asks: [...pending.values()], connected: Boolean(opts.watcher?.clientId) }))
        // [main] thread protocol: {type:'follow', sessionId, lang?} / {type:'unfollow'} → ThreadFrames on this socket
        let cancelThread: (() => void) | null = null
        ws.on('message', async (data) => {
          let m: { type?: string; sessionId?: string; lang?: string; state?: string }
          try { m = JSON.parse(data.toString()) } catch { return }
          const here = presence.get(ws)
          if (here) here.alive = true
          // [push] {type:'presence', state:'foreground'|'background'}: the app tells the bot whether a person can see it
          if (m.type === 'ping') { ws.send(JSON.stringify({ type: 'pong' })); return }
          if (m.type === 'presence' && here) { here.foreground = m.state !== 'background'; return }
          if (m.type === 'follow' && typeof m.sessionId === 'string') {
            if (here) here.sessionId = m.sessionId
            cancelThread?.(); cancelThread = null
            try { const send = (f: unknown) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(f)) }; cancelThread = await followThread(harness, m.sessionId, (f) => { if (replyFilter) replyFilter.pass(f as never, send); else send(f) }, uiLang(typeof m.lang === 'string' ? m.lang : 'en')) }
            catch (e) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'end', sessionId: m.sessionId, error: { code: 'follow-failed', message: (e as Error).message } })) }
          } else if (m.type === 'unfollow') { if (here) here.sessionId = null; cancelThread?.(); cancelThread = null }
        })
        ws.on('close', () => { phones.delete(ws); presence.delete(ws); cancelThread?.(); cancelThread = null })
      })
      return
    }
    if (wsPath !== '/api/remote.mux') { socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); socket.destroy(); return }
    const upstream = new WebSocket(`${dsh.protocol === 'https:' ? 'wss' : 'ws'}://${dsh.host}/api/remote.mux`, { headers: { cookie: opts.dsh.cookie } })
    upstream.once('error', () => { socket.write('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n'); socket.destroy() })
    upstream.once('open', () => {
      wss.handleUpgrade(req, socket, head, (client) => {
        client.on('message', (d, bin) => upstream.send(d, { binary: bin }))
        upstream.on('message', (d, bin) => client.send(d, { binary: bin }))
        client.on('close', (c, r) => upstream.close(normalCode(c), r))
        upstream.on('close', (c, r) => client.close(normalCode(c), r))
        client.on('error', () => upstream.terminate())
        upstream.on('error', () => client.terminate())
      })
    })
  })

  server.listen(opts.port ?? 0, opts.host ?? '127.0.0.1')
  await once(server, 'listening')
  const addr = server.address() as { address: string; port: number; family: string }
  return {
    origin: `http://${addr.family === 'IPv6' ? `[${addr.address}]` : addr.address}:${addr.port}`,
    pending: () => [...pending.values()],
    broadcast, // [agent:proactive]
    async notify(n, o = {}) { // [push]
      if (await notifyAbout(n, o.sessionId) && o.turn && o.sessionId) pushedTurn.add(o.sessionId)
    },
    async close() {
      clearInterval(heartbeat)
      for (const f of follows.values()) f.cancel()
      follows.clear()
      if (ownHarness) await harness.close().catch(() => {})
      for (const c of wss.clients) c.terminate()
      wss.close()
      server.closeAllConnections()
      await new Promise<void>((r) => server.close(() => r()))
    },
  }
}

function subprotocolToken(header: string | string[] | undefined): string | null {
  const parts = String(header ?? '').split(',').map((s) => s.trim())
  const i = parts.indexOf('bearer')
  return i >= 0 && parts[i + 1] ? bearerToken(`Bearer ${parts[i + 1]}`) : null
}

function firstQuestion(request: Record<string, unknown>) {
  const qs = request.questions as { prompt?: string; question?: string; text?: string }[] | undefined
  const q = qs?.[0]
  return String(q?.prompt ?? q?.question ?? q?.text ?? '').slice(0, 120)
}

function normalCode(c: number) { return c === 1005 || c === 1006 || c < 1000 ? 1000 : c }

// [agent:proactive]
/**
 * The assistant speaks first. It opens with what it already knows from the phone and asks
 * nothing the phone has answered: not the language, not the time zone or city, not the name when sign-in gave one.
 */
export function openingPrompt(name: string, person: PersonContext = {}, language?: string): string {
  const known: string[] = []
  if (person.name) known.push(`their name is ${person.name}`)
  if (person.timeZone && !person.timeZoneGuessed) known.push(`their phone's time zone is ${person.timeZone} (so that is where they live; the local time there is ${localTime(person.timeZone)})`)
  if (person.locale) known.push(`their phone's language is ${person.locale}`)
  const facts = (known.length ? `You already know from their phone: ${known.join('; ')}. Use it; do not ask about any of it. ` : '') + (person.timeZoneGuessed ? 'Their time zone is not known (their phone could not tell); do not ask about it now and do not save it. ' : '')
  const tag = person.locale || language
  const lang = tag ? `Write in ${languageName(tag)}. ` : 'In their language if you can tell, otherwise English. '
  const greet = person.name ? `Greet them by name. ` : ''
  return `${INJECT}This is the first time the person opens the app. You are ${name}. ${facts}${lang}${greet}Introduce yourself in two short sentences (what you can do for them day to day). Save nothing in this turn: the phone tells you all of this again every time, and they have not told you anything yet. Then ask one thing only: what is one thing they have been putting off — you can take it.`
}
function localTime(tz: string) { try { return new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date()) } catch { return 'unknown' } }
/** 'UTC' as a phone without a zone reports it. */
export function isUtc(tz: string) { return /^(Etc\/)?(UTC|UCT|GMT|Universal|Zulu|Greenwich)([+-]?0)?$/i.test(tz) }
const realZone = (tz?: string | null) => (tz && validTimeZone(tz) && !isUtc(tz) ? tz : null)
/** The newest IANA zone named in USER.md ("Lives in Lisbon (Europe/Lisbon)"), when the person stated one. */
export function statedTimeZone(md: string): string | null {
  for (const z of (md.match(/\b[A-Z][A-Za-z_]+\/[A-Za-z_]+(?:\/[A-Za-z_]+)?\b/g) ?? []).reverse()) if (realZone(z)) return z
  return null
}
function validTimeZone(tz: string) { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true } catch { return false } }

function proxyHttp(req: IncomingMessage, res: ServerResponse, dsh: URL, headers: Record<string, string | string[]>) {
  const up = httpRequest({ protocol: dsh.protocol, hostname: dsh.hostname, port: dsh.port, method: req.method, path: req.url, headers }, (ur) => {
    res.writeHead(ur.statusCode ?? 502, ur.headers)
    ur.pipe(res)
  })
  up.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end() })
  req.pipe(up)
}

/**
 * A module's play page: the browser build's own runtime (the digested nsh/harden/host files in `appDir`) runs the
 * module's bundle, inline, through web/host.js's player, with the module's result token. Null without a browser build.
 */
export async function playPage(appDir: string, m: { title: string; token: string; moduleId: string; bundle: Buffer; lang: Lang }): Promise<string | null> {
  const names = await readdir(appDir).catch(() => [] as string[])
  const find = (re: RegExp) => names.find((n) => re.test(n))
  const js = find(/^nsh\.[0-9a-f]+\.js$/), wasm = find(/^nsh\.[0-9a-f]+\.wasm$/), harden = find(/^harden\.[0-9a-f]+\.nshc$/), host = find(/^host\.[0-9a-f]+\.js$/)
  if (!js || !wasm || !harden || !host) return null
  const esc = (x: string) => x.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!))
  const words = SERVER_WORDS[m.lang].play
  const args = { bundleUrl: `data:application/octet-stream;base64,${m.bundle.toString('base64')}`, auth: 'page', token: m.token, title: m.title, moduleId: m.moduleId }
  return `<!doctype html><html lang="${HTML_LANG[m.lang]}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><meta name="referrer" content="no-referrer"><title>${esc(m.title)}</title>
<style>html,body{margin:0;height:100%;background:Canvas;color:CanvasText;color-scheme:light dark;font:17px/1.4 -apple-system,system-ui,sans-serif}main{display:flex;min-height:100%;align-items:center;justify-content:center;padding:24px;box-sizing:border-box;text-align:center;opacity:.7}html[data-app] .ui-sheet>div:first-child{display:none!important}html[data-app] .ui-sheet{color-scheme:inherit!important}</style></head>
<body><main id="after">${esc(words.opening)}</main><script type="module">
// inside the app's sheet (?app=1, mobile/src/cards.tsx): the app draws the title and Done
const q = new URLSearchParams(location.search)
if (q.has('app')) document.documentElement.dataset.app = ''
// the app's light or dark (?scheme=): Android's web view reports light to the page whatever the phone is set to
const scheme = q.get('scheme')
if (scheme === 'dark' || scheme === 'light') {
  document.documentElement.style.colorScheme = scheme
  const own = window.matchMedia.bind(window)
  window.matchMedia = (m) => { const r = own(m); if (!/prefers-color-scheme/.test(m)) return r; const on = new RegExp('prefers-color-scheme:\\\\s*' + scheme).test(m); return { matches: on, media: m, onchange: null, dispatchEvent() { return false }, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} } }
}
// The page is at <computer>/ui/<id>/play, and <computer> is the bot itself or <host>/s/<sandbox>: the runtime files
// and the module's result go to that computer, never to the root of the host in front of it. The runtime files carry
// the module's (unspent) token so a valid sandbox id alone is not enough to fetch them.
const base = new URL('../../', location.href)
const runtime = (f) => new URL('ui/' + encodeURIComponent(${JSON.stringify(m.moduleId)}) + '/runtime/' + f + '?token=' + encodeURIComponent(${JSON.stringify(m.token)}), base).href
const { openModule } = await import(runtime(${JSON.stringify(host)}))
const args = ${JSON.stringify(args).replace(/</g, '\\u003c')}
const after = document.getElementById('after')
let opened = false
const watch = new MutationObserver(() => {
  const done = document.querySelector('[data-testid="ui-done"]'); if (done && done.textContent !== ${JSON.stringify(words.done)}) { done.textContent = ${JSON.stringify(words.done)}; done.style.color = 'CanvasText' }
  if (document.querySelector('.ui-sheet')) opened = true
  else { after.textContent = ${JSON.stringify(words.back)}; if (opened) { opened = false; window.nsh?.postMessage?.('closed') } } // inside the app's web view: the app closes it
})
watch.observe(document.body, { childList: true, subtree: true, characterData: true })
const at = (f) => new URL(f, base).href
openModule({ ...args, origin: base.href.replace(/\\/$/, '') }, { js: at(${JSON.stringify(js)}), wasm: at(${JSON.stringify(wasm)}), harden: at(${JSON.stringify(harden)}) }).catch(() => { after.textContent = ${JSON.stringify(words.failed)}; window.nsh?.postMessage?.('failed') })
</script></body></html>`
}

/** Serves the app's browser build from `appDir`; `inject` goes into index.html's <head> (the host adds its URL). */
export async function serveStatic(appDir: string, path: string, res: ServerResponse, inject = '') {
  let rel = normalize(decodeURIComponent(path)).replace(/^(\.\.[/\\])+/, '')
  if (rel === '/' || rel === '') rel = '/index.html'
  const file = join(appDir, rel)
  if (!file.startsWith(appDir)) { res.writeHead(404); return res.end() }
  try {
    const s = await stat(file)
    if (!s.isFile()) throw new Error('dir')
    // Files named by their content digest (the NSH web build: nsh.<digest>.wasm, app.<digest>.nshc, icons/…) never change: cache them for a year.
    const digested = /\.[0-9a-f]{10}\.[a-z0-9]+$/.test(rel)
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': rel === '/sw.js' || rel === '/index.html' || rel === '/manifest.webmanifest' ? 'no-cache' : digested ? 'public, max-age=31536000, immutable' : 'public, max-age=300' })
    const bytes = await readFile(file)
    res.end(rel === '/index.html' && inject ? bytes.toString('utf8').replace('<head>', `<head>${inject}`) : bytes)
  } catch {
    // SPA fallback for /pair etc.
    if (!extname(rel)) { res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-cache' }); return res.end((await readFile(join(appDir, 'index.html'), 'utf8').catch(() => '')).replace('<head>', `<head>${inject}`)) }
    res.writeHead(404); res.end()
  }
}
