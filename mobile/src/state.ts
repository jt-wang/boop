// App-wide signals. Components read them inside JSX bindings so only the
// bound text or style updates.
//
// The thread speaks bot's own protocol (src/thread.ts): the /events socket
// carries asks and, after `{type:'follow', sessionId}`, the ThreadFrames
//   snapshot — all rows + running + statusText + title
//   rows     — rows added or replaced, by id
//   delta    — text appended to one row
//   status   — running + statusText
//   end      — the follow ended; with `error` the thread shows a notice and follows again
import { effect, platform, signal, Storage, host } from 'nsh'
import { Bot, loadSession, saveSession, setChosenLanguage, type Session } from './api.ts'
import { forgetPocket, openTunnel, restorePocket, viaPocket } from './pocket.ts'
import { watchSocket, type SocketWatch } from './liveness.ts'
import { isLang, labelSeparator, listSeparator } from './locale.ts'
import { ALL as STRINGS, detectLang, type Lang } from './i18n.ts' // [agent:ui] the merged table, so str() resolves every module's keys
import { toolWord, type Row } from './fold.ts'
import { afterConnect as nativeAfterConnect, appState } from './native.ts' // [agent:ios]
import { loadPrefs } from './prefs.ts'

export interface Me { device: { id: string; name: string }; assistant: { name: string }; mainSessionId: string | null; connected: boolean; /** absent on a bot older than the Computer section of Settings */ computer?: { name: string; version: string } }
/** [compliance] Who messages go to and whether the person agreed (src/compliance.ts on the bot); absent on a bot older than the consent gate. */
export interface Me { ai?: { model: string; company: string; policyUrl: string | null; filter: string | null; consent: { at: string } | null }; age?: 'adult' | 'minor' | null }
export type Ask =
  | { kind: 'approval'; eventId: string; sessionId: string; request: { toolName?: string; reason?: string; displayReason?: Record<string, string> }; at: number }
  | { kind: 'question'; eventId: string; sessionId: string; request: { questions?: { id: string; prompt?: string; question?: string; text?: string; title?: string; detail?: string; options?: (string | { label?: string; value?: string; name?: string; description?: string })[]; multiSelect?: boolean; multiple?: boolean; allowCustom?: boolean }[] }; at: number }
/** One entry of GET /threads. */
export interface ThreadSummary { sessionId: string; title?: string; updatedAt: number; running: boolean; blank: boolean }
export type ThreadFrame =
  | { type: 'snapshot'; sessionId: string; rows: Row[]; running: boolean; statusText: string; title: string }
  | { type: 'rows'; sessionId: string; rows: Row[] }
  | { type: 'delta'; sessionId: string; rowId: string; text: string }
  | { type: 'status'; sessionId: string; running: boolean; statusText?: string }
  | { type: 'end'; sessionId: string; error?: { code: string; message: string } }

export const lang = signal<Lang>('en')
export const t = <K extends keyof typeof STRINGS.en>(k: K): (typeof STRINGS.en)[K] => STRINGS[lang()][k]
export const str = (k: keyof typeof STRINGS.en) => String(STRINGS[lang()][k])
/** Parts of one line of detail ("20 KB, 2h"), in the person's language: no middle dots. */
export const joined = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(listSeparator(lang()))
/** `label: value`, with the full-width colon in Chinese. */
export const labeled = (label: string, value: string) => `${label}${labelSeparator(lang())}${value}`

export const session = signal<Session | null>(null)
export const me = signal<Me | null>(null)
export const connection = signal<'online' | 'offline' | 'reconnecting'>('offline')
export const asks = signal<Ask[]>([])
export const rows = signal<Row[]>([])            // oldest first
export const statusText = signal('')
export const running = signal(false)
export const title = signal('')
export const sessionId = signal<string | null>(null)
export const toast = signal('')
/** Ids of cards whose answer is on its way to the bot (buttons stay disabled meanwhile). */
export const answering = signal<Set<string>>(new Set())
/** The person just spoke and the assistant has not started answering: 👀 under their bubble. */
export const awaiting = signal(false)

let bot: Bot | null = null
export const api = () => { if (!bot) throw new Error('not connected'); return bot }

const thread = { rows: [] as Row[], running: false, statusText: '', title: '' }
function publish() { rows.set([...thread.rows]); statusText.set(thread.statusText); running.set(thread.running); title.set(thread.title); saveThread() }

/**
 * The bot answered with the followed thread's snapshot. Until then an empty thread is not known to be empty: the
 * chat shows the rows this phone kept from last time (`thread:<id>` in Storage), or nothing, never the empty state
 * with its starters (the owner's app showed them for seconds before the history came, 2026-10-27).
 */
export const threadLoaded = signal(false)
const CACHED_ROWS = 80
const cacheKey = (id: string) => `thread:${id}`
let cacheTimer: ReturnType<typeof setTimeout> | undefined
/** Keeps the last rows the bot sent for the next launch; only what the bot confirmed (not the phone's unsent words). */
function saveThread() {
  const id = sessionId(); if (!id || !threadLoaded()) return
  const kept = thread.rows.filter((r) => !outbox.includes(r)).slice(-CACHED_ROWS).map((r) => (r.kind === 'step' ? { ...r, output: r.output?.slice(0, 400) } : r.kind === 'them' && r.streaming ? { ...r, streaming: false } : r))
  if (cacheTimer) clearTimeout(cacheTimer)
  cacheTimer = setTimeout(() => { Storage.setItem(cacheKey(id), JSON.stringify(kept)).catch(() => {}) }, 400)
}
async function cachedRows(id: string): Promise<Row[]> {
  try { const v = JSON.parse((await Storage.getItem(cacheKey(id))) ?? '[]'); return Array.isArray(v) ? (v as Row[]) : [] } catch { return [] }
}
let pending = false
/** Publishes at most once a frame while text streams in. */
function schedule() { if (pending) return; pending = true; setTimeout(() => { pending = false; publish() }, 16) }

let eventsWs: WebSocket | null = null
let followId: string | null = null
let stopped = false

/** A request or a socket started while the network was down can wait for minutes without failing (Android, QA
 * 2026-10-28 #15: still "Not connected" 20 s after the network came back). Give up after this and try again. */
const CONNECT_TIMEOUT_MS = 8000
const within = <T,>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<T>((_, no) => setTimeout(() => no(new Error('timeout')), ms))])

export async function boot() {
  await loadPrefs()
  const saved = await Storage.getItem('lang')
  if (isLang(saved)) { lang.set(saved); setChosenLanguage(saved) } else lang.set(detectLang())
  const s = await loadSession()
  if (!s) return
  // the port of the last tunnel means nothing now; a phone that lost its link pairs again
  if (await restorePocket()) {
    try { s.origin = await openTunnel() } catch (e) { if ((e as { code?: string }).code === 'not-paired') { await disconnect(); return } }
  }
  await connect(s)
}

/** The person chose a language in the app: it is their language from now on, for the bot's notifications and the assistant's replies too. */
export async function setLang(l: Lang) {
  lang.set(l); setChosenLanguage(l)
  await Storage.setItem('lang', l)
  bot?.sendContext().catch(() => {})
}

/** What this phone calls itself on the computer: the platform's name (Devices lists it). */
export function deviceName() { try { const p = (globalThis as { navigator?: { userAgent?: string } }).navigator?.userAgent ?? ''; return /iPad/.test(p) ? 'iPad' : platform.os === 'ios' || /iPhone/.test(p) ? 'iPhone' : platform.os === 'android' || /Android/.test(p) ? 'Android' : 'Phone' } catch { return 'Phone' } }

/** The name a host gives the phone's pairing before it knows the phone (src/host/server.ts). */
const HOST_PHONE_NAME = 'phone'

/** The host that made the paired computer (the hosted flow), else null: a computer the person paired by hand. */
export const hostedBy = signal<string | null>(null)

/** `via`: how this pairing happened (the hosted flow names its host, the connect screen null); a saved session keeps what it had. */
export async function connect(s: Session, via?: { hostedBy: string | null }) {
  if (via) { hostedBy.set(via.hostedBy); if (via.hostedBy) await Storage.setItem('hostedBy', via.hostedBy); else await Storage.removeItem('hostedBy') }
  else hostedBy.set(await Storage.getItem('hostedBy'))
  // bot before session: resources keyed on session() fetch synchronously when it changes. [main]
  bot = new Bot(s); stopped = false; session.set(s); await saveSession(s)
  // the last known assistant draws the app at once (no naming screen, no blank) while /me answers
  if (!via) { try { const c = await Storage.getItem('me'); if (c && !me()) me.set(JSON.parse(c) as Me) } catch {} }
  // and the last known thread, while the bot is asked for it
  const known = me()?.mainSessionId; if (!via && known && me()?.assistant.name) await follow(known)
  // opened without a network: the request fails, and nothing else would ask again (QA 2026-10-28 #15, 85 s after the
  // network came back it still said 「未连接」); keep asking, a little slower each time, while this pairing stands
  for (let wait = 1500; ; wait = Math.min(wait * 2, 15000)) {
    try { putMe(await within(bot.get<Me>('/me'), CONNECT_TIMEOUT_MS)); break } catch (e) {
      if ((e as Error).message === 'unpaired') { await disconnect(); return }
      const mine: Bot | null = bot
      await reopenTunnel()
      await new Promise((r) => setTimeout(r, wait))
      if (stopped || bot !== mine) return
    }
  }
  // the phone tells the bot what it knows (time zone, language) so the assistant never asks for it
  bot.sendContext().catch(() => {})
  // a host pairs the phone before it knows which phone it is: the phone names itself when it first connects, as pairing
  // by code names it (and once more on a launch while it is still the host's "phone", for a phone paired before this)
  if (hostedBy() && (via || me()!.device.name === HOST_PHONE_NAME)) bot.send('PATCH', '/devices/me', { name: deviceName() }).catch(() => {})
  nativeAfterConnect(bot, (me() as { pushPublicKey?: string | null } | null)?.pushPublicKey).catch(() => {}) // [agent:ios] notifications via the native shell, when there is one
  if (me()!.assistant.name && aiReady()) await openMain()
}

/** Sets `me` and keeps a copy for the next launch. */
function putMe(m: Me) { me.set(m); Storage.setItem('me', JSON.stringify(m)).catch(() => {}) }

export async function disconnect() {
  stopped = true
  if (viaPocket()) await forgetPocket()
  followId = null; mainOpened = false; wantedThread = null; eventsWs?.close(); eventsWs = null
  const kept = sessionId(); if (kept) await Storage.removeItem(cacheKey(kept)).catch(() => {}); sessionId.set(null); threadLoaded.set(false); thread.rows = []
  bot = null; await saveSession(null); await Storage.removeItem('hostedBy'); hostedBy.set(null); session.set(null); me.set(null); await Storage.removeItem('me'); rows.set([]); asks.set([]); connection.set('offline')
}

export async function setAssistantName(name: string) {
  await api().send('PUT', '/settings', { assistantName: name })
  const m = me(); if (m) putMe({ ...m, assistant: { name } })
  if (!sessionId()) await openMain()
}

/** [push] A thread a tapped notification asked for before the main one was opened: opening the app lands there instead. */
let wantedThread: string | null = null
/** openMain ran for this pairing: what the app shows from now on is the person's (or a notification's) choice. */
let mainOpened = false
/** [push] Show this thread (a tapped notification): now, and still when the main thread opens later at launch. */
export async function openThread(id: string) {
  if (!mainOpened) wantedThread = id
  if (followId || mainOpened) await follow(id)
}

/** The main thread: created once by the bot (POST /sessions/main), found in GET /threads, then followed. */
async function openMain() {
  const m = me()!
  let id = m.mainSessionId
  if (!id) { const r = await api().send<{ sessionId: string }>('POST', '/sessions/main'); id = r.sessionId; putMe({ ...m, mainSessionId: id }) }
  const list = await api().get<ThreadSummary[]>('/threads').catch(() => [] as ThreadSummary[])
  const target = wantedThread ?? id; wantedThread = null; mainOpened = true
  const shown = list.find((x) => x.sessionId === target)
  connectEvents()
  await follow(target)
  if (shown) { thread.title = shown.title ?? ''; thread.running = shown.running; if (shown.running) thread.statusText = str('working'); publish() }
}

/** Follow one thread: the socket answers with a snapshot, then rows, deltas and status. */
export async function follow(id: string) {
  if (id !== sessionId()) {
    // another thread: what this phone kept of it shows at once; the snapshot replaces it
    outbox.length = 0; threadLoaded.set(false)
    thread.rows = await cachedRows(id); thread.running = false; thread.statusText = ''; thread.title = ''
    sessionId.set(id)
  } // the same thread again (pull to refresh, reconnect): its rows stay until the snapshot
  followId = id; publish()
  sendFollow()
}

/** [push] Tell the bot whether a person can see the app: it pushes only while no one can (src/server.ts presence). */
function sendPresence() {
  if (!eventsWs || eventsWs.readyState !== 1) return
  eventsWs.send(JSON.stringify({ type: 'presence', state: appState() }))
}
effect(() => { appState(); sendPresence() })

function sendFollow() {
  if (!followId || !eventsWs || eventsWs.readyState !== 1) return
  eventsWs.send(JSON.stringify({ type: 'follow', sessionId: followId, lang: lang() }))
}

/** One ThreadFrame into the thread. Exported for tests, which play the socket. */
export function apply(f: ThreadFrame) {
  if (f.sessionId !== sessionId()) return
  switch (f.type) {
    case 'snapshot':
      threadLoaded.set(true)
      settle(f.rows, false)
      thread.rows = [...f.rows, ...outbox]; thread.running = f.running || outbox.length > 0; thread.statusText = f.statusText || (thread.running ? str('working') : ''); thread.title = f.title
      if (!outbox.length) awaiting.set(false)
      break
    case 'rows':
      settle(f.rows, true)
      for (const r of f.rows) { const i = thread.rows.findIndex((x) => x.id === r.id); if (i >= 0) thread.rows[i] = r; else thread.rows.push(r) }
      if (f.rows.some((r) => r.kind !== 'you')) awaiting.set(false) // it started answering
      break
    case 'delta': {
      const r = thread.rows.find((x) => x.id === f.rowId)
      if (r && 'text' in r) r.text += f.text
      awaiting.set(false)
      schedule(); return
    }
    case 'status':
      thread.running = f.running
      thread.statusText = typeof f.statusText === 'string' ? f.statusText : f.running ? thread.statusText || str('working') : ''
      break
    case 'end':
      if (f.error) {
        awaiting.set(false)
        const last = thread.rows[thread.rows.length - 1]
        if (!(last?.kind === 'notice' && last.text === f.error.message)) thread.rows.push({ kind: 'notice', id: `n${Date.now().toString(36)}-${thread.rows.length}`, text: f.error.message, at: Date.now() })
        thread.running = false; thread.statusText = ''
        if (!stopped) setTimeout(sendFollow, 3000)
      }
      break
  }
  publish()
}

/** What a tool does, in words, to sit inside a sentence ("running a command", "执行命令"). */
export const toolPhrase = (name: string, l: Lang) => { const w = toolWord(name, l); return w.charAt(0).toLowerCase() + w.slice(1) }

/** One /events message. Tests hand messages in the same way (`app.host.send('event', m)`), as the socket cannot be stubbed headless. */
export function handleEvent(m: { type: string; asks?: Ask[]; ask?: Ask; eventId?: string; sessionId?: string; running?: boolean; toolName?: string; connected?: boolean; me?: Me; user?: number; memory?: number }) {
  if (m.type === 'hello') { asks.set(m.asks ?? []); connection.set(m.connected ? 'online' : 'reconnecting') }
  else if (m.type === 'ask' && m.ask) asks.set([...asks().filter((a) => a.eventId !== m.ask!.eventId), m.ask])
  else if ((m.type === 'ask-cancelled' || m.type === 'ask-answered') && m.eventId) asks.set(asks().filter((a) => a.eventId !== m.eventId))
  else if (m.type === 'snapshot' || m.type === 'rows' || m.type === 'delta' || m.type === 'status' || m.type === 'end') apply(m as unknown as ThreadFrame)
  else if (m.type === 'auto-approved' && m.sessionId === sessionId()) { thread.rows.push({ kind: 'notice', id: `n${Date.now()}`, text: t('autoApproved')(toolPhrase(m.toolName ?? '', lang())), at: Date.now() }); publish() }
  else if (m.type === 'reset') { asks.set([]); connection.set('reconnecting') }
  else if (m.type === 'memory-updating') reflecting.set(true) // [agent:ui] reflection after a turn; the status line shows it
  else if (m.type === 'memory-updated') { reflecting.set(false); const n = (Number(m.user) || 0) + (Number(m.memory) || 0); if (n > 0) { memoryNoted.set(n); setTimeout(() => { if (memoryNoted() === n) memoryNoted.set(0) }, 4000) } } // [agent:ui] the status line says how many things it remembered, for 4 s
  else if (m.type === 'connector') connectorChanged.set(connectorChanged() + 1) // [agent:connectors] a service was connected (the browser came back)
  // the name (or another setting) changed on the bot, e.g. "call yourself Momo" in the chat: read /me again
  else if (m.type === 'me-updated' || m.type === 'settings') refreshMe().catch(() => {})
}

// [compliance] The first-run questions before anything reaches the model: the age, then the AI provider.
export const needsAge = () => Boolean(me()?.ai) && !me()?.age
export const underAge = () => me()?.age === 'minor'
export const needsConsent = () => Boolean(me()?.ai) && !me()?.ai?.consent
/** Nothing in the way of the model: the bot's gate (src/compliance.ts) would let a message through. */
export const aiReady = () => !needsAge() && !underAge() && !needsConsent()
/** PUT /consent {age?, ai?}; the answer is the bot's state, merged into `me`. Agreeing opens the thread when it can. */
export async function setConsent(body: { age?: 'adult' | 'minor'; ai?: boolean }) {
  const state = await api().send<{ ai: NonNullable<Me['ai']>; age: Me['age'] }>('PUT', '/consent', body)
  const cur = me(); if (cur) putMe({ ...cur, ai: state.ai, age: state.age })
  if (aiReady() && me()?.assistant.name && !sessionId()) await openMain()
}

/** GET /me again; the header, the avatar's letter and Settings read `me`. */
export async function refreshMe() {
  if (!bot) return
  const next = await bot.get<Me>('/me')
  const cur = me()
  putMe(cur ? { ...cur, ...next, mainSessionId: next.mainSessionId ?? cur.mainSessionId } : next)
}

const REOPEN_EVERY_MS = 20_000
const SOCKET_CHECK_MS = 10_000
let lastReopen = 0
/** Through TailPocket, a request that fails may mean the tunnel itself is gone (a suspended app, a new network): open it again. */
async function reopenTunnel() {
  if (!viaPocket() || !bot) return
  // with the computer off or no network every try fails, and each opening starts a node on this phone: not every few seconds
  const now = Date.now(); if (now - lastReopen < REOPEN_EVERY_MS) return
  lastReopen = now
  const mine = bot
  let origin: string
  try { origin = await openTunnel() } catch (e) { if ((e as { code?: string }).code === 'not-paired') await disconnect(); return }
  if (bot !== mine || stopped) return
  mine.s = { ...mine.s, origin }
  session.set(mine.s); await saveSession(mine.s)
}

function connectEvents() {
  if (eventsWs || stopped || !bot) return // a reconnect timer may fire after unpairing
  within(api().ticket(), CONNECT_TIMEOUT_MS).then((ticket) => {
    if (eventsWs || stopped) return
    const ws = new WebSocket(api().wsUrl('/events', ticket))
    eventsWs = ws
    setTimeout(() => { if (eventsWs === ws && ws.readyState === 0) { try { ws.close() } catch {} eventsWs = null; if (!stopped) setTimeout(connectEvents, 500) } }, CONNECT_TIMEOUT_MS)
    let watch: SocketWatch | null = null
    ws.onopen = () => {
      connection.set('online'); sendFollow(); if (appState() === 'background') sendPresence()
      if (viaPocket()) watch = watchSocket({ every: SOCKET_CHECK_MS, may: () => appState() !== 'background', ping: () => { try { ws.send(JSON.stringify({ type: 'ping' })) } catch {} }, dead: () => {
        if (eventsWs !== ws) return
        eventsWs = null; connection.set('reconnecting'); try { ws.close() } catch {}
        lastReopen = 0 // the tunnel is the likely cause: open it again now
        reopenTunnel().catch(() => {}).finally(() => { if (!stopped) connectEvents() })
      } })
    }
    ws.onmessage = (e) => { try { const m = JSON.parse(String(e.data)); if (m.type === 'pong') watch?.answered(); else handleEvent(m) } catch {} }
    ws.onclose = () => { watch?.stop(); if (eventsWs === ws) { eventsWs = null; connection.set('reconnecting') } else if (!eventsWs && connection() === 'online') connection.set('reconnecting'); if (!stopped) setTimeout(connectEvents, 1500) }
    ws.onerror = () => {}
  }).catch((e) => {
    // the token was revoked or rotated while the app was open: signed out, as a refused /me at launch
    if ((e as Error).message === 'unpaired') { disconnect().catch(() => {}); return }
    reopenTunnel().catch(() => {}).finally(() => { if (!stopped) setTimeout(connectEvents, 3000) })
  })
}

export async function send(text: string) {
  const id = sessionId(); if (!text.trim()) return
  if (!id) throw new Error('no thread yet') // the computer has not answered: the caller keeps the words and says so
  // The person's words show at once; the bot's own `you` row with the same text takes this one's place.
  const local: Row = { kind: 'you', id: `local-${Date.now().toString(36)}-${thread.rows.length}`, text: text.trim(), at: Date.now() }
  outbox.push(local); thread.rows.push(local)
  thread.running = true; thread.statusText = str('working'); awaiting.set(true); publish()
  try { await api().prompt(id, text.trim()) } catch (e) { dropLocal(local.id); awaiting.set(false); throw e }
}

/** Rows the phone drew for messages the bot has not echoed yet. */
const outbox: Row[] = []
/** The bot's row id → the local row it replaced, so the thread keeps one key for the bubble (no second entrance). */
const settledAs = new Map<string, string>()
export const rowKey = (id: string) => settledAs.get(id) ?? id
function dropLocal(id: string) {
  const i = outbox.findIndex((r) => r.id === id); if (i >= 0) outbox.splice(i, 1)
  thread.rows = thread.rows.filter((r) => r.id !== id)
}
/** A `you` row from the bot settles the oldest local row with the same text: it is replaced in place (rows frame) or dropped (snapshot, which carries its own). */
function settle(incoming: Row[], inPlace: boolean) {
  for (const r of incoming) {
    if (r.kind !== 'you') continue
    const i = outbox.findIndex((l) => l.kind === 'you' && l.text === r.text.trim()); if (i < 0) continue
    const [l] = outbox.splice(i, 1)
    settledAs.set(r.id, l.id)
    const at = thread.rows.findIndex((x) => x.id === l.id)
    if (at >= 0) { if (inPlace && !thread.rows.some((x) => x.id === r.id)) thread.rows[at] = r; else thread.rows.splice(at, 1) }
  }
}

/**
 * The person tapped a card: `text` is what they would have typed (cards.tsx
 * `answerText`); the bot marks the card answered and the next `rows` frame
 * shows it. Offline: a toast, nothing queued. True when it went out.
 */
export async function answerCard(cardId: string, text: string): Promise<boolean> {
  const id = sessionId(); if (!id || !text.trim()) return false
  if (connection() !== 'online') { showToast(str('notConnected')); return false }
  answering.update((s) => new Set(s).add(cardId))
  try { await api().prompt(id, text, cardId); thread.running = true; thread.statusText = str('working'); awaiting.set(true); publish(); return true }
  catch { showToast(str('failed')); return false }
  finally { answering.update((s) => { const n = new Set(s); n.delete(cardId); return n }) }
}

export async function answerApproval(ask: Ask, outcome: 'allowed-once' | 'rejected', remember?: 'task' | 'always') {
  asks.set(asks().filter((a) => a.eventId !== ask.eventId))
  try { await api().send('POST', `/approvals/${encodeURIComponent(ask.eventId)}`, { outcome, remember }) } catch { toast.set(str('failed')) }
}
export async function answerQuestion(ask: Ask, answers: { id: string; selected: string[]; custom?: string }[]) {
  asks.set(asks().filter((a) => a.eventId !== ask.eventId))
  try { await api().send('POST', `/questions/${encodeURIComponent(ask.eventId)}`, { answers }) } catch { toast.set(str('failed')) }
}

/** Android 13 (API 33) and later confirm every copy themselves; a toast of ours on top says it twice (QA 2026-10-28 #5). */
export function systemShowsCopy(os: string, version: string) { return os === 'android' && Number(version) >= 33 }
/** After a copy: our toast, unless the system already says so. */
export function copiedToast(msg: string) { let sys = false; try { sys = systemShowsCopy(platform.os, platform.version) } catch {} if (!sys) showToast(msg) }
export function showToast(msg: string) { toast.set(msg); setTimeout(() => { if (toast() === msg) toast.set('') }, 2400) }

// [agent:ui] ---------------------------------------------------------------
// Thread notices, a guarded send, and the frame seam the embedding app uses.
// `nsh test` plays the host (`app.host.send`), because its network stubs have
// no WebSocket: `thread` takes ThreadFrames exactly as the socket does, `asks`
// replaces the pending cards.

/** How many things the reflection after the last turn remembered; the status line says so for 4 s. */
export const memoryNoted = signal(0)
/** The bot is updating memory after a turn (`memory-updating` → `memory-updated` on /events). */
export const reflecting = signal(false)
/** [agent:connectors] Bumped when the bot says a service was connected (`connector` on /events); connectors.tsx refetches. */
export const connectorChanged = signal(0)

/** A grey one-liner in the thread (after a card was answered, for example). */
export function addNotice(text: string) {
  thread.rows.push({ kind: 'notice', id: `n${Date.now().toString(36)}-${thread.rows.length}`, text, at: Date.now() }); publish()
}

/** Applies ThreadFrames as the socket handler does. */
export function ingest(frames: unknown[]) { for (const f of frames) apply(f as ThreadFrame) }

/** Sends, or puts the thread back to idle and says why; true when it went out. */
export async function trySend(text: string): Promise<boolean> {
  try { await send(text); return true } catch (e) {
    if (/HTTP 403/.test(String((e as Error).message))) refreshMe().catch(() => {}) // [compliance] consent withdrawn elsewhere: the consent screen comes back
    thread.running = false; thread.statusText = ''; publish(); showToast(str('failed')); return false
  }
}

try {
  host.on('thread', (frames) => ingest(Array.isArray(frames) ? frames : [frames]))
  host.on('asks', (list) => asks.set(Array.isArray(list) ? (list as Ask[]) : []))
  host.on('event', (m) => { if (m && typeof m === 'object' && typeof (m as { type?: unknown }).type === 'string') handleEvent(m as unknown as Parameters<typeof handleEvent>[0]) })
} catch {}
