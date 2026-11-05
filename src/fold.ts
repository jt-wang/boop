// Folds DeepSeek Harness session frames into bot's own thread rows — the
// translation layer that keeps clients harness-agnostic (src/thread.ts serves
// the result). Pure. Shapes measured against DSH 0.2.0-rc.2 on 2026-10-26
// (scratchpad/shapes.json) and DSH Mobile's PROTOCOL.md.
import { SERVER_WORDS, type Lang } from './locales/index.ts'
import { CardSchema, parseCardAnswer, parseModuleAnswer, type Card } from './cards.ts'

export type Row =
  | { kind: 'you'; id: string; text: string; at: number }
  | { kind: 'them'; id: string; text: string; at: number; streaming?: boolean }
  | { kind: 'step'; id: string; name: string; description?: string; command?: string; output?: string; at: number }
  | { kind: 'notice'; id: string; text: string; at: number }
  | { kind: 'card'; id: string; card: Card; answer?: string; at: number }
  /** Second layer (src/ui.ts): an interface the assistant wrote, signed as a package the phone opens in a sheet. `id` is the tool call's; `moduleId` names the package. */
  | { kind: 'module'; id: string; moduleId: string; title: string; url: string; answer?: string; at: number }
  /** A file the assistant handed over with `present`: an image shows in the thread, anything else is a card that opens (GET /library/file?path=). */
  | { kind: 'file'; id: string; path: string; name: string; description?: string; image: boolean; at: number; /** An image the harness keeps in its attachment store (a browser screenshot): fetched by this id (GET /library/attachment), not by path. */ attachment?: string; /** A file the turn wrote (`new`) or changed (`edited`) with a file tool, carded when the turn ends; absent for a presented file. */ change?: 'new' | 'edited' }

export interface ThreadState {
  rows: Row[]            // oldest first
  streamingId: string | null
  statusText: string     // what the assistant is doing right now
  running: boolean
  title: string
  cwd: string | null
  /** The current turn answers a bot-injected prompt (opening, reminder): its steps are housekeeping, not shown. */
  quiet?: boolean
  /** Titles of `ui` calls still building, by tool call id: the module row takes its title when the result names the package. */
  moduleTitles?: Record<string, string>
  /** File-tool calls of this turn still waiting for their result, by tool call id: the workspace file each writes. */
  writes?: Record<string, { path: string; change: 'new' | 'edited' }>
  /** Workspace files this turn wrote or changed, in first-seen order: one card each when the turn ends. */
  produced?: { path: string; change: 'new' | 'edited'; at: number }[]
  /** Where this turn's rows start, so a file it presented is not carded twice. */
  turnFrom?: number
  /** Background tasks still running, by their session id: what each is doing. */
  background?: Record<string, string>
  /** The person's answers by `card:<id>` / `module:<id>`, for a card a background task made, which joins the rows later (src/thread.ts). */
  answers?: Record<string, string>
}

const IMAGE = /\.(png|jpe?g|gif|webp|svg|heic|bmp)$/i
/** Notes and scripts: what the assistant writes on its way. Presented, they are a card only when asked for (askedFor). */
const WORKING = /\.(md|markdown|txt|py|js|mjs|ts|sh|json|ya?ml|toml|html?|css)$/i
/** The person's words this turn name the file or ask for a file (a document, a report). Not its bare stem: "Plan a trip"
 *  is no request for plan.py. */
function askedFor(s: ThreadState, name: string): boolean {
  const you = s.rows.slice(s.turnFrom ?? 0).filter((r) => r.kind === 'you') as { text: string }[]
  const said = (you.length ? you : s.rows.filter((r) => r.kind === 'you').slice(-1) as { text: string }[]).map((r) => r.text.toLowerCase()).join('\n')
  return said.includes(name.toLowerCase()) || /\b(files?|documents?|reports?|markdown|md|txt)\b|文件|文档|报告/.test(said)
}

export const emptyThread = (): ThreadState => ({ rows: [], streamingId: null, statusText: '', running: false, title: '', cwd: null })

const HIDDEN_TOOLS = new Set(['ask_user_question'])
/** DSH's tools that start a background task (a continuable subagent); the result names it: "started subagent <id>". */
const TASK_TOOLS = new Set(['subagent', 'subagent_fork'])
/** While the conversation is idle and a background task runs, the thread still says it is working, and on what. */
function backgroundStatus(s: ThreadState, lang: Lang) {
  const doing = Object.values(s.background ?? {})
  if (s.running || !doing.length) return
  s.running = true
  s.statusText = SERVER_WORDS[lang].status.background(doing[0])
}
/** A background task ended (its settlement notice): the thread stops saying it works on it. */
function taskEnded(s: ThreadState, id: string | undefined, lang: Lang) {
  if (!id || s.background?.[id] === undefined) return false
  delete s.background[id]
  if (!Object.keys(s.background).length && s.statusText.startsWith(SERVER_WORDS[lang].status.backgroundPrefix)) s.statusText = SERVER_WORDS[lang].status.working
  return true
}
const SHOW_TOOLS = new Set(['mcp__bot__show', 'show'])
const UI_TOOLS = new Set(['mcp__bot__ui', 'ui'])
export const INJECT = '\u27e6bot\u27e7 '
/** How the bot's prompt starts when a turn the computer's restart cut off goes on (src/recover.ts): its steps are the person's task. */
export const RESUMED = `${INJECT}[The computer restarted]`
let seq = 0
const uid = () => `r${Date.now().toString(36)}${(seq++).toString(36)}`

export const textOf = (content: unknown): string =>
  (Array.isArray(content) ? content : []).filter((c) => c && c.type === 'text').map((c) => String(c.text ?? '')).join('')

/** Human words for tool names; `description` from the tool arguments wins when present. */
/**
 * A failed turn, said for the person. The raw message
 * stays in the session file and the bot's log for whoever runs the bot.
 */
export function humanError(raw: string, lang: Lang): string {
  const m = raw.toLowerCase()
  const w = SERVER_WORDS[lang].errors
  if (/no api key|api[_ ]key.*(missing|not set)|credential/.test(m)) return w.noKey
  if (/\b401\b|\b403\b|authentication|unauthori[sz]ed|invalid api key/.test(m)) return w.keyRefused
  if (/\b402\b|insufficient|quota|balance/.test(m)) return w.noCredit
  if (/\b429\b|rate limit|too many requests|busy|overloaded|\b503\b/.test(m)) return w.busy
  return w.generic
}

/** A service id as a name: `acme-pages` → `Acme Pages`, `notion` → `Notion`. */
export const serviceName = (id: string) => id.split('-').filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ')

export function toolWord(name: string, lang: Lang): string {
  const w = SERVER_WORDS[lang]
  if (w.tools[name]) return w.tools[name]
  // a connected service (mcp__<service>__<tool>): which service, never the tool's own English name
  const svc = /^mcp__([a-z0-9-]+)__/i.exec(name)?.[1]
  if (svc && svc !== 'bot' && svc !== 'browser') return w.toolUsing(serviceName(svc))
  return w.toolFallback
}

function stepFrom(callId: string, name: string, args: string | undefined, at: number): Row {
  let parsed: Record<string, unknown> = {}
  try { parsed = JSON.parse(args || '{}') } catch {}
  const desc = typeof parsed.description === 'string' ? parsed.description : undefined
  const cmd = [parsed.command, parsed.path, parsed.query, parsed.url, parsed.fact, parsed.name].find((v) => typeof v === 'string') as string | undefined
  return { kind: 'step', id: callId, name, description: desc, command: cmd, at }
}

/**
 * The file a first-party file tool changes, from its arguments: DSH's own web client takes produced files from the
 * same calls (dsh-client-ui-deliverables `mutationPath`, DSH 0.2.0-rc.2): `write` with content, a real `edit`, and
 * `str_replace_editor`'s create / str_replace / insert. Reads and malformed calls change nothing. `new` when the call
 * makes the file (`write` says which in its result: "Created file" or "Updated file").
 */
export function mutationOf(name: string, argsRaw: string | undefined): { path: string; change: 'new' | 'edited' } | null {
  let a: Record<string, unknown>
  try { a = JSON.parse(argsRaw || '') } catch { return null }
  if (!a || typeof a !== 'object' || Array.isArray(a)) return null
  const p = (v: unknown) => (typeof v === 'string' && v.trim() ? v : null)
  if (name === 'write') { const path = typeof a.content === 'string' ? p(a.file_path) : null; return path ? { path, change: 'edited' } : null }
  if (name === 'edit') {
    const ok = typeof a.old_string === 'string' && a.old_string.length > 0 && typeof a.new_string === 'string' && a.old_string !== a.new_string
    const path = ok ? p(a.file_path) : null; return path ? { path, change: 'edited' } : null
  }
  if (name === 'str_replace_editor') {
    const path = p(a.path); if (!path) return null
    if (a.command === 'create' && typeof a.file_text === 'string') return { path, change: 'new' }
    if (a.command === 'str_replace' && typeof a.old_str === 'string' && a.old_str.length > 0) return { path, change: 'edited' }
    if (a.command === 'insert' && typeof a.insert_line === 'number' && typeof a.new_str === 'string') return { path, change: 'edited' }
  }
  return null
}

const MEMORY_FILES = new Set(['SOUL.md', 'USER.md', 'MEMORY.md'])
/**
 * A file the person may be shown: inside the session's working folder (the assistant's workspace), not a memory
 * file at its root, nothing hidden on the way (src/library.ts serves the same set). Scratch files elsewhere (/tmp)
 * are the assistant's own business. Returns the absolute path, or null.
 */
export function workspaceFile(path: string, cwd: string | null): string | null {
  if (!cwd) return null
  const root = cwd.replace(/\/+$/, '')
  const parts: string[] = []
  for (const seg of (path.startsWith('/') ? path : `${root}/${path}`).split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') { parts.pop(); continue }
    parts.push(seg)
  }
  const abs = `/${parts.join('/')}`
  if (!abs.startsWith(`${root}/`)) return null
  const rel = abs.slice(root.length + 1).split('/')
  if (rel.some((seg) => seg.startsWith('.'))) return null
  if (rel.length === 1 && MEMORY_FILES.has(rel[0])) return null
  return abs
}

/**
 * The images in a tool result, as rows: DSH stores an MCP image block (Playwright MCP's `browser_take_screenshot`)
 * in its attachment store and the result carries `{ type: 'image', attachment: { attachmentId, mediaType, name? } }`
 *. `path` is the file the tool's text names: the browser's link (`[Screenshot of viewport](<path>)`,
 * absolute: src/browser.ts runs it with --file-paths absolute) or `read_image`'s `<path>` against the session folder,
 * so a reply or a `present` of that same file does not draw it twice; the app fetches the bytes by `attachment`.
 */
function imagesOf(callId: string, content: unknown, at: number, cwd: string | null): Row[] {
  const parts = Array.isArray(content) ? content as { type?: string; text?: unknown; attachment?: { attachmentId?: unknown; mediaType?: unknown; name?: unknown } }[] : []
  const text = textOf(parts)
  const read = /^<path>([^<\n]+)<\/path>/.exec(text)?.[1]
  const linked = read ? (read.startsWith('/') || !cwd ? read : `${cwd.replace(/\/+$/, '')}/${read.replace(/^\.\//, '')}`) : /\]\(([^)\s]+\.(?:png|jpe?g|webp|gif))\)/i.exec(text)?.[1]
  const rows: Row[] = []
  for (const p of parts) {
    const a = p?.type === 'image' ? p.attachment : undefined
    if (!a || typeof a.attachmentId !== 'string' || (typeof a.mediaType === 'string' && !a.mediaType.startsWith('image/'))) continue
    const named = typeof a.name === 'string' && a.name.trim() ? a.name.trim() : undefined
    const path = rows.length === 0 && linked ? linked : named ?? ''
    rows.push({ kind: 'file', id: `${callId}:img${rows.length}`, path, name: named ?? (path.split('/').pop() || 'screenshot.png'), image: true, attachment: a.attachmentId, at })
  }
  return rows
}

/**
 * What the thread does with every event type the harness writes. A type missing here is reported
 * (the bot logs it), never dropped in silence: on 2026-10-27 `deliverables/presented` fell through
 * and the owner's charts never showed. test/fixtures/harness-event-types.json holds the types the
 * harness wrote in real sessions; test/fold.test.ts fails when one of them has no entry.
 */
export const EVENT_COVERAGE: Record<string, 'shown' | 'ignored'> = {
  'user/message': 'shown', 'assistant/message': 'shown', 'tool/result': 'shown', 'deliverables/presented': 'shown',
  'session/title': 'shown', 'turn/start': 'shown', 'turn/end': 'shown',
  'llm/retry': 'shown', 'compaction/start': 'shown', // the status line says why it is taking long
  'llm/retry-started': 'ignored', 'compaction/end': 'ignored', 'compaction/prune': 'ignored', 'compaction/summary': 'ignored', // covered by the two above and turn/end
  'tool/call': 'ignored', // the step row comes from the assistant message's tool part; the result fills it
  'approval/asked': 'ignored', 'approval/decided': 'ignored', 'approval/policy': 'ignored', // approvals reach the app through the bot's own ask channel (src/events.ts)
  'assistant/attempt': 'ignored', 'step/start': 'ignored', 'step/end': 'ignored', // model-attempt bookkeeping; text arrives as assistant/message
  'developer/message': 'ignored', 'system/message': 'ignored', 'request/context': 'ignored', 'request/header': 'ignored', // what the harness tells the model, not the person
  'agent/inbox/spliced': 'ignored', // a steered message already shown as the person's own row; a queued settlement notice ends its background task's status
  'session': 'ignored', 'session/end-seed': 'ignored', 'session/title-llm-request': 'ignored', 'permission/preset': 'ignored', 'sandbox/mode': 'ignored',
  'workspace/changes': 'ignored', // carries only the turn number (the summary stays in DSH's memory and is gone after a restart); the turn's file cards come from its file-tool calls instead
}

/** One log line for DSH's `llm/retry`: why the model call failed, so the hosted logs say it. Keys in the message are masked. */
export function retryLog(d: { provider?: string; retry?: number; maxRetries?: number; delayMs?: number; failure?: { code?: string; status?: number; message?: string } }): string {
  const f = d.failure ?? {}
  const message = String(f.message ?? '').replace(/\b(sk-|Bearer\s+)[A-Za-z0-9._-]+/g, '$1…').replace(/\s+/g, ' ').slice(0, 160)
  const of = d.maxRetries ? `/${d.maxRetries}` : ''
  return `[bot] model retry ${d.retry ?? '?'}${of} in ${d.delayMs ?? '?'} ms (${d.provider ?? '?'}): ${[f.status, f.code, message].filter((x) => x !== undefined && x !== '').join(' ')}`
}

/** Apply one durable session event. Returns true when the thread changed. */
export function foldEvent(s: ThreadState, ev: { type: string; time?: number; data?: Record<string, unknown> }, lang: Lang = 'en', onUnknown?: (type: string) => void, hashOf?: (path: string) => string | undefined): boolean {
  const d = ev.data ?? {}
  const at = ev.time ?? Date.now()
  switch (ev.type) {
    case 'user/message': {
      const source = d.source as { kind?: string; senderSessionId?: string } | undefined
      if (source?.kind === 'subagent-settled') return taskEnded(s, source.senderSessionId, lang) // a background task ended; its result comes as the next reply
      if (source?.kind !== 'user') return false
      const text = textOf(d.content)
      const mod = parseModuleAnswer(text)
      if (mod) { // a module the assistant built posted its result: mark the row answered and show the words
        const row = s.rows.find((r) => r.kind === 'module' && r.moduleId === mod.moduleId) as Extract<Row, { kind: 'module' }> | undefined
        if (row) row.answer = mod.text
        ;(s.answers ??= {})[`module:${mod.moduleId}`] = mod.text
        s.quiet = false
        s.rows.push({ kind: 'you', id: String(d.id ?? uid()), text: mod.text, at })
        return true
      }
      const ans = parseCardAnswer(text)
      if (ans) { // the person tapped a card: mark it answered and show their words
        const card = s.rows.find((r) => r.kind === 'card' && r.id === ans.cardId) as Extract<Row, { kind: 'card' }> | undefined
        if (card) card.answer = ans.text
        ;(s.answers ??= {})[`card:${ans.cardId}`] = ans.text
        s.quiet = false
        s.rows.push({ kind: 'you', id: String(d.id ?? uid()), text: ans.text, at })
        return true
      }
      if (text.startsWith(INJECT)) { s.quiet = !text.startsWith(RESUMED); return false } // bot-injected (reminder, opening prompt): the reply is what matters, not the steps; a task going on after a restart shows its steps
      s.quiet = false
      s.rows.push({ kind: 'you', id: String(d.id ?? uid()), text, at })
      return true
    }
    case 'assistant/message': {
      const message = d.message as { content?: unknown[] } | undefined
      const text = textOf(message?.content)
      // the committed text takes the streaming row's place and id: clients update one row (a `rows` frame)
      // instead of dropping it and getting a whole-thread snapshot; a client that merges by id sees one reply
      const streamed = s.streamingId ? s.rows.findIndex((r) => r.id === s.streamingId) : -1
      if (streamed >= 0 && text.trim()) s.rows[streamed] = { kind: 'them', id: s.streamingId!, text, at }
      else {
        if (streamed >= 0) s.rows.splice(streamed, 1)
        if (text.trim()) s.rows.push({ kind: 'them', id: uid(), text, at })
      }
      s.streamingId = null
      for (const part of (message?.content ?? []) as { type: string; id?: string; name?: string; arguments?: string }[]) {
        if (part.type !== 'tool-call' || !part.name || HIDDEN_TOOLS.has(part.name)) continue
        const id = part.id ?? uid()
        if (SHOW_TOOLS.has(part.name)) {
          let parsed: unknown = null; try { parsed = JSON.parse(part.arguments || '{}') } catch {}
          const card = CardSchema.safeParse(parsed)
          if (card.success) { s.rows.push({ kind: 'card', id, card: card.data, at }); continue }
        }
        if (UI_TOOLS.has(part.name)) { // the module row appears when the result names the package (it may fail to compile first)
          let parsed: { title?: unknown } = {}; try { parsed = JSON.parse(part.arguments || '{}') } catch {}
          ;(s.moduleTitles ??= {})[id] = typeof parsed.title === 'string' ? parsed.title : ''
        }
        const m = mutationOf(part.name, part.arguments)
        const abs = m ? workspaceFile(m.path, s.cwd) : null
        if (m && abs) (s.writes ??= {})[id] = { path: abs, change: m.change }
        const step = stepFrom(id, part.name, part.arguments, at) as Extract<Row, { kind: 'step' }>
        if (TASK_TOOLS.has(part.name) && step.description) step.description = `${toolWord(part.name, lang)}${SERVER_WORDS[lang].status.stepSep}${step.description}`
        if (!s.quiet) s.rows.push(step)
        s.statusText = (step.description || toolWord(part.name, lang)) + '…' // what it is doing, in its own words
      }
      return true
    }
    case 'tool/result': {
      const message = d.message as { toolCallId?: string; source?: { callId?: string }; content?: unknown } | undefined
      const id = message?.toolCallId ?? message?.source?.callId
      const step = [...s.rows].reverse().find((r) => r.kind === 'step' && r.id === id) as Extract<Row, { kind: 'step' }> | undefined
      const built = id !== undefined && s.moduleTitles?.[id] !== undefined ? /\bmodule=([\w-]+)/.exec(textOf(message?.content)) : null
      if (built) { // `ui` published the package: the step (if shown) becomes the module row
        const row: Row = { kind: 'module', id: String(id), moduleId: built[1], title: s.moduleTitles![id!] || 'Interface', url: `/ui/${built[1]}.nshpkg`, at }
        delete s.moduleTitles![id!]
        const i = s.rows.findIndex((r) => r.kind === 'step' && r.id === id)
        if (i >= 0) s.rows[i] = row; else s.rows.push(row)
        s.statusText = SERVER_WORDS[lang].status.readingResults
        return true
      }
      const w = id !== undefined ? s.writes?.[id] : undefined
      if (w) { // a file tool finished: its file gets a card when the turn ends, unless the call failed
        delete s.writes![id!]
        if ((message as { isError?: boolean }).isError !== true) {
          const created = w.change === 'new' || /\bCreated file\b/.test(textOf(message?.content))
          const seen = (s.produced ??= []).find((f) => f.path === w.path)
          if (!seen) s.produced.push({ path: w.path, change: created ? 'new' : 'edited', at })
        }
      }
      if (step) {
        step.output = textOf(message?.content).slice(0, 4000)
        const started = TASK_TOOLS.has(step.name) ? /^started subagent (\S+)/.exec(step.output)?.[1] : undefined
        if (started) (s.background ??= {})[started] = step.description?.replace(/^[^：:]*[：:]\s*/, '') || toolWord(step.name, lang)
      } else if (s.rows.some((r) => (r.kind === 'card' || r.kind === 'module') && r.id === id)) return false // a card's "Shown." is noise
      s.statusText = SERVER_WORDS[lang].status.readingResults
      const shots = imagesOf(String(id ?? uid()), message?.content, at, s.cwd) // shown in a quiet turn too (a reminder's screenshot is what it was for)
      if (shots.length) { // a screenshot the browser took: shown right after its step
        const i = step ? s.rows.indexOf(step) : -1
        if (i >= 0) s.rows.splice(i + 1, 0, ...shots); else s.rows.push(...shots)
      }
      return Boolean(step) || shots.length > 0
    }
    // `present` (DSH's dsh-tool-present): { turn, callId, files: [{ path, description? }] }, paths against the session cwd
    case 'deliverables/presented': {
      const files = Array.isArray(d.files) ? d.files as { path?: unknown; description?: unknown }[] : []
      let added = false
      files.forEach((f, i) => {
        if (typeof f?.path !== 'string' || !f.path.trim()) return
        const path = f.path.startsWith('/') || !s.cwd ? f.path : `${s.cwd.replace(/\/+$/, '')}/${f.path.replace(/^\.\//, '')}`
        const name = path.split('/').pop() || path
        if (WORKING.test(name) && !askedFor(s, name)) return // a note or script the person did not ask for: the Library has it
        const row: Row = { kind: 'file', id: `${String(d.callId ?? uid())}:${i}`, path, name, ...(typeof f.description === 'string' && f.description.trim() ? { description: f.description.trim() } : {}), image: IMAGE.test(name), at }
        // the assistant's own look at this image this turn (`read_image`, a browser screenshot) gives way to the file it
        // hands over: one image in the thread, the one that opens (QA 2026-10-28 #8)
        // in its place and under its id, so a phone that already drew the look replaces it.
        // Only the same file: a file of the same name elsewhere is another image (an older one in the workspace hid the
        // browser's new screenshot), or the same bytes under another name: the attachment
        // id is the image's sha256, and the assistant copied the saved screenshot before presenting it. `hashOf` reads the file (src/thread.ts); without it, the path alone decides.
        const since = s.rows.map((r) => r.kind).lastIndexOf('you') + 1
        const looks = (match: (r: Extract<Row, { kind: 'file' }>) => boolean) => s.rows.findIndex((r, j) => j >= since && r.kind === 'file' && Boolean(r.attachment) && match(r))
        let same = (r: Extract<Row, { kind: 'file' }>) => r.path === path
        let looked = row.image ? looks(same) : -1
        if (looked < 0 && row.image && hashOf) { const h = hashOf(path); if (h) { same = (r) => r.attachment === `sha256:${h}`; looked = looks(same) } }
        if (looked >= 0) {
          s.rows[looked] = { ...row, id: s.rows[looked].id }
          // a later look at the same file (it redrew the image and looked again) goes too
          for (let j; (j = looks(same)) >= 0;) s.rows.splice(j, 1)
        } else s.rows.push(row)
        added = true
      })
      return added
    }
    case 'session/title': s.title = String(d.title ?? ''); return false
    // The turn is the unit of "working": tool runs and compactions (no assistant attempt in flight) are inside it.
    case 'agent/inbox/spliced': { // a settlement notice the bot's DSH plugin drops is never a user/message (src/dsh-plugin.js); queued, the task has ended
      let changed = false
      for (const m of (d.inserted ?? []) as { source?: { kind?: string; senderSessionId?: string } }[]) if (m?.source?.kind === 'subagent-settled') changed = taskEnded(s, m.source.senderSessionId, lang) || changed
      return changed
    }
    case 'turn/start': s.running = true; s.turnFrom = s.rows.length; s.writes = {}; s.produced = []; if (!s.statusText) s.statusText = SERVER_WORDS[lang].status.working; return true
    case 'turn/end': {
      if (s.streamingId) { const r = s.rows.find((x) => x.id === s.streamingId) as Extract<Row, { kind: 'them' }> | undefined; if (r) r.streaming = false; s.streamingId = null }
      s.statusText = ''; s.running = false
      backgroundStatus(s, lang)
      const reason = d.reason as { kind?: string; error?: { message?: string } } | undefined
      if (reason?.kind === 'error') s.rows.push({ kind: 'notice', id: uid(), text: humanError(reason.error?.message ?? '', lang), at })
      // a file the person named and this turn wrote or changed, one card each after the reply; a
      // presented one has its card already; the rest are in the Library
      const turn = s.rows.slice(s.turnFrom ?? 0)
      const presented = new Set(turn.filter((r) => r.kind === 'file').map((r) => (r as { path: string }).path))
      const asked = turn.filter((r) => r.kind === 'you').map((r) => (r as { text: string }).text.toLowerCase()).join('\n')
      for (const f of s.produced ?? []) {
        if (presented.has(f.path) || !asked.includes((f.path.split('/').pop() || f.path).toLowerCase())) continue
        s.rows.push({ kind: 'file', id: `changed:${d.turn ?? ''}:${f.path}`, path: f.path, name: f.path.split('/').pop() || f.path, image: false, change: f.change, at: f.at })
      }
      s.produced = []; s.writes = {}
      return true
    }
    case 'llm/retry': {
      if (!s.running) return false
      s.statusText = SERVER_WORDS[lang].status.modelBusy
      return true
    }
    case 'compaction/start': {
      if (!s.running) return false
      s.statusText = SERVER_WORDS[lang].status.tidying
      return true
    }
    default:
      if (!(ev.type in EVENT_COVERAGE)) onUnknown?.(ev.type)
      return false
  }
}

/** Apply one live assistant-stream frame (never logged, never replayed). */
export function foldStream(s: ThreadState, frame: { type: string; chunk?: { type: string; text?: string; name?: string } ; outcome?: { kind: string } }, lang: Lang = 'en'): boolean {
  if (frame.type === 'start') { s.running = true; s.statusText = SERVER_WORDS[lang].status.working; return true }
  if (frame.type === 'end') { if (frame.outcome?.kind === 'abandoned' && s.streamingId) { s.rows = s.rows.filter((r) => r.id !== s.streamingId); s.streamingId = null; return true } return false }
  const c = frame.chunk
  if (!c) return false
  if (c.type === 'text-delta') {
    if (!s.streamingId) { s.streamingId = uid(); s.rows.push({ kind: 'them', id: s.streamingId, text: '', at: Date.now(), streaming: true }) }
    const r = s.rows.find((x) => x.id === s.streamingId) as Extract<Row, { kind: 'them' }>
    r.text += c.text ?? ''
    return true
  }
  if (c.type === 'reasoning-delta') { s.statusText = SERVER_WORDS[lang].status.thinking; return true }
  if (c.type === 'tool-call-delta' && c.name && !HIDDEN_TOOLS.has(c.name)) { s.statusText = toolWord(c.name, lang) + '…'; return true }
  return false
}

/** Fold a follow snapshot: records (durable events) plus an in-flight attempt. */
export function foldSnapshot(s: ThreadState, snap: { header?: { cwd?: string }; records?: { type: string; event?: { type: string; time?: number; data?: Record<string, unknown> } }[]; projections?: { values?: { title?: string | null } }; assistantStream?: { activeAttempt?: unknown } }, lang: Lang = 'en', hashOf?: (path: string) => string | undefined) {
  s.rows = []; s.streamingId = null; s.running = false; s.statusText = ''; s.writes = {}; s.produced = []; s.turnFrom = 0
  s.cwd = snap.header?.cwd ?? s.cwd
  // running = a turn/start with no turn/end yet (a re-follow during a tool run or a compaction has no active attempt)
  for (const r of snap.records ?? []) if (r.type === 'event' && r.event) foldEvent(s, r.event, lang, undefined, hashOf)
  s.title = snap.projections?.values?.title ?? s.title
  if (snap.assistantStream?.activeAttempt) s.running = true
  if (s.running && !s.statusText) s.statusText = SERVER_WORDS[lang].status.working
  if (!s.running) s.statusText = ''
}
