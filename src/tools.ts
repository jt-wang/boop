// The assistant's own tools, served to DSH over MCP (streamable HTTP) on a
// loopback-only port: remember / forget, reminders, goals, notify. DSH mounts
// it through `@deepseek-ai/dsh-mcp-client`, so the model sees them as
// `mcp__bot__remember` etc. and the usual approval flow applies.
import { createServer } from 'node:http'
import { once } from 'node:events'
import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import { CardSchema, answerable } from './cards.ts'
import { McpServer } from '@modelcontextprotocol/server'
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node'
import type { Memory } from './memory.ts'
import type { Scheduler, When } from './scheduler.ts'
import type { Goals } from './goals.ts'
import type { Ui } from './ui.ts'
import { line, uiLang, type Line, type LineKey } from './lang.ts'
import { INTL_LOCALE } from './locales/index.ts'

export interface ToolsOptions {
  memory: Memory
  scheduler: Scheduler
  goals: Goals
  /** Send a push to the person's phones. */
  notify: (n: { title: string; body: string }) => Promise<void>
  /** Called with a short description whenever a tool changed something the app shows. */
  onActivity?: (entry: { kind: string; text: string; line?: Line }) => void
  /** Generative UI, second layer (src/ui.ts): the `ui` tool compiles and signs a module the assistant wrote. */
  ui?: Ui
  /** Inside the image: install the assistant's browser (scripts/install-browser.sh, run by the bot because the agent's shell cannot install system packages). */
  installBrowser?: () => Promise<string>
  /** Give the assistant a new name: the same settings store PUT /settings uses (rewrites AGENTS.md), then tell the apps. */
  rename?: (name: string) => Promise<void>
  /** The person's language (src/lang.ts personLanguage), for the activity lines the tools write. */
  language?: () => Promise<string>
  /** The time zone of where the person said they live: it replaces the phone's (src/main.ts, the person's settings). */
  setHomeZone?: (zone: string) => Promise<void>
}

const realZone = (z: string) => { try { new Intl.DateTimeFormat('en-US', { timeZone: z }); return z !== 'UTC' && z.includes('/') } catch { return false } }

export interface ToolsServer { url: string; secret: string; close(): Promise<void> }

const when = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('once'), at: z.string().describe('ISO 8601 instant, e.g. 2026-10-27T09:00:00-04:00') }),
  z.object({ kind: z.literal('every'), seconds: z.number().int().min(60) }),
  z.object({ kind: z.literal('daily'), time: z.string().regex(/^\d{2}:\d{2}$/), timeZone: z.string() }),
  z.object({ kind: z.literal('weekly'), time: z.string().regex(/^\d{2}:\d{2}$/), timeZone: z.string(), weekdays: z.array(z.number().int().min(1).max(7)).min(1) }),
])

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] })

export function buildMcpServer(o: ToolsOptions) {
  const server = new McpServer({ name: 'deepseek-bot', version: '0.1.0' })
  const act = (kind: string, t: string) => o.onActivity?.({ kind, text: t })
  /** A templated activity line, in the person's language now and again later (src/lang.ts activityView). */
  const actLine = async (kind: string, key: LineKey, ...args: unknown[]) => o.onActivity?.({ kind, ...line(uiLang((await o.language?.()) || 'en'), key, ...(args as never[])) })

  server.registerTool('remember', {
    title: 'Remember',
    description: 'Save one fact for later. `kind`: preference (how they like things), fact (who they are: name, family, work, where they live), decision (something they decided or agreed), project (something ongoing you are tracking for them, with its next step), person (someone they mention). One short sentence per call, in the person\'s language, the way they would say it: no codes (time-zone ids like America/New_York, locale tags like en-US, ids, file names). The phone already tells you their time zone and language: do not save those. When the fact is where they live, pass that place\'s IANA time zone as `timeZone` (Europe/Lisbon for Lisbon): it becomes their time zone for every time and reminder.',
    inputSchema: z.object({ fact: z.string().min(2).max(300), kind: z.enum(['preference', 'fact', 'decision', 'project', 'person']).default('decision'), file: z.enum(['user', 'memory']).optional(), timeZone: z.string().max(64).optional() }),
  }, async ({ fact, kind, file, timeZone }) => {
    if (timeZone !== undefined && !realZone(timeZone)) return { ...text(`"${timeZone}" is not a time zone; pass an IANA zone like Europe/Lisbon, or leave it out. Nothing was saved.`), isError: true }
    const target = file ?? (kind === 'preference' || kind === 'fact' ? 'user' : 'memory')
    if (timeZone) await o.setHomeZone?.(timeZone)
    const added = await o.memory.remember(target, fact, kind)
    if (added) await actLine('memory', 'remembered', fact)
    return text(added ? `Saved (${kind}).` : 'Already known; nothing changed.')
  })

  if (o.rename) {
    const rename = o.rename
    server.registerTool('set_my_name', {
      title: 'Change my name',
      description: 'Change your own name — the one the person sees at the top of the app and in notifications. Call it as soon as the person gives you a new name ("call yourself Nori"). It takes effect at once on every phone; nothing else is needed. Never look for or edit configuration files to rename yourself.',
      inputSchema: z.object({ name: z.string().max(40) }),
    }, async ({ name }) => {
      const n = name.replace(/\s+/g, ' ').trim()
      if (!n) return { ...text('The name is empty; nothing changed.'), isError: true }
      await rename(n)
      await actLine('name', 'renamed', n)
      return text(`Your name is now ${n}. The app shows it already.`)
    })
  }

  server.registerTool('forget', {
    title: 'Forget',
    description: 'Delete remembered facts that contain the given words, from both USER.md and MEMORY.md. Tell the person what was removed.',
    inputSchema: z.object({ query: z.string().min(2).max(100) }),
  }, async ({ query }) => {
    const removed = await o.memory.forget(query)
    if (removed.length) await actLine('memory', 'forgot', removed.length, query)
    return text(removed.length ? `Removed:\n${removed.map((r) => `- ${r}`).join('\n')}` : 'Nothing matched.')
  })

  server.registerTool('schedule_create', {
    title: 'Create a reminder or recurring task',
    description: 'Create a reminder or a recurring check. When it is due, the instruction is sent to you as a new message in the main thread and the person gets a notification. Confirm the exact time and time zone with the person first. Use `once` for a single time, `every` for a fixed interval, `daily`/`weekly` for wall-clock times in an IANA time zone.',
    inputSchema: z.object({ name: z.string().min(1).max(80), instruction: z.string().min(1).max(2000), when }),
  }, async ({ name, instruction, when: w }) => {
    const t = await o.scheduler.create({ name, instruction, when: w as When })
    const tz = (w as { timeZone?: string }).timeZone
    const locale = INTL_LOCALE[uiLang((await o.language?.()) || 'en')]
    const when_ = t.nextRunAt ? new Date(t.nextRunAt).toLocaleString(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz }) : '—'
    await actLine('schedule', 'scheduled', name, when_)
    return text(`Created ${t.id}: "${t.name}", next run ${t.nextRunAt}.`)
  })

  server.registerTool('schedule_list', { title: 'List reminders', description: 'List active and inactive reminders with their ids and next run times.', inputSchema: z.object({}) }, async () => {
    const tasks = o.scheduler.list()
    return text(tasks.length ? tasks.map((t) => `${t.id} ${t.active ? 'active' : 'inactive'} "${t.name}" next=${t.nextRunAt ?? '—'} when=${JSON.stringify(t.when)}`).join('\n') : 'No reminders.')
  })

  server.registerTool('schedule_update', {
    title: 'Change a reminder',
    description: 'Change a reminder\'s name, instruction, timing, or pause/resume it. Keeps its id.',
    inputSchema: z.object({ id: z.string(), name: z.string().max(80).optional(), instruction: z.string().max(2000).optional(), when: when.optional(), active: z.boolean().optional() }),
  }, async ({ id, ...patch }) => {
    const t = await o.scheduler.update(id, patch as { name?: string; instruction?: string; when?: When; active?: boolean })
    if (!t) return text(`No reminder ${id}.`)
    await actLine('schedule', 'scheduleUpdated', t.name, t.nextRunAt ?? '—')
    return text(`Updated ${t.id}: "${t.name}", next run ${t.nextRunAt ?? '—'}, ${t.active ? 'active' : 'inactive'}.`)
  })

  server.registerTool('schedule_delete', { title: 'Delete a reminder', description: 'Delete a reminder by id.', inputSchema: z.object({ id: z.string() }) }, async ({ id }) => {
    const ok = await o.scheduler.remove(id)
    if (ok) await actLine('schedule', 'scheduleDeleted')
    return text(ok ? 'Deleted.' : `No reminder ${id}.`)
  })

  server.registerTool('goal_set', {
    title: 'Set a goal',
    description: 'Record something the person wants over days or weeks, with a short plan (3–7 steps). You track progress with goal_update.',
    inputSchema: z.object({ title: z.string().min(1).max(120), plan: z.array(z.string().max(200)).max(20).default([]) }),
  }, async ({ title, plan }) => { const g = await o.goals.set(title, plan); await actLine('goal', 'goalNew', title); return text(`Goal ${g.id} created.`) })

  server.registerTool('goal_update', {
    title: 'Update a goal',
    description: 'Add a progress note, change the plan or title, or mark the goal done/paused.',
    inputSchema: z.object({ id: z.string(), note: z.string().max(500).optional(), plan: z.array(z.string().max(200)).max(20).optional(), title: z.string().max(120).optional(), status: z.enum(['active', 'done', 'paused']).optional() }),
  }, async ({ id, ...patch }) => { const g = await o.goals.update(id, patch); if (!g) return text(`No goal ${id}.`); await actLine('goal', 'goalUpdated', g.title, patch.note ?? patch.status ?? ''); return text(`Goal "${g.title}" updated (${g.status}).`) })

  server.registerTool('goal_list', { title: 'List goals', description: 'List goals with ids, status, plan and latest notes.', inputSchema: z.object({}) }, async () => {
    const gs = o.goals.list()
    return text(gs.length ? gs.map((g) => `${g.id} [${g.status}] ${g.title}\n  plan: ${g.plan.join(' → ') || '—'}\n  latest: ${g.notes.at(-1)?.text ?? '—'}`).join('\n') : 'No goals.')
  })

  server.registerTool('notify', {
    title: 'Notify the person',
    description: 'Send a short notification to the person\'s phone right now. Use it when something they asked you to watch has happened, or a background task finished and they are not in the app. One line.',
    inputSchema: z.object({ title: z.string().min(1).max(60), body: z.string().max(200).default('') }),
  }, async ({ title, body }) => { await o.notify({ title, body }); act('notify', `${title} — ${body}`); return text('Sent.') })

  if (o.installBrowser) server.registerTool('install_browser', {
    title: 'Install your browser',
    description: 'Install your own browser on this computer when the browser tools are missing (a few minutes). A call waits for the install, up to about 4 minutes; if it is still going after that it says so, and calling again waits for the same install (never run apt yourself). When it says Installed, the browser tools are there; carry on with what you were doing.',
    inputSchema: z.object({}),
  }, async () => text(await o.installBrowser!()))

  server.registerTool('show', {
    title: 'Show a card',
    description: 'Show the person a native card in the thread instead of describing it in prose: choices (tap one), form (fields they fill), confirm (yes/no), table (with pick: true a comparison they answer by tapping a row), progress (a plan or steps), summary (amounts, totals, results). For choices/form/confirm/table-with-pick their answer arrives as their next message. Keep text short; the card is the message.',
    inputSchema: CardSchema,
  }, async (card) => { act('show', card.title); return text(answerable(card) ? 'Shown. Their answer will arrive as their next message; wait for it.' : 'Shown.') })

  server.registerTool('ui', {
    title: 'Build an interface',
    description: 'Show the person an interface you write yourself. It runs inside the thread, as tall as what it draws (full screen is one tap away), so it can be whatever shows the answer best: a plan as a timeline, a calculator, a checklist they tick, a quiz, a tracker, a chart drawn with Views or a Canvas, a map. `source` is a complete NSH TSX module (App.tsx: `import { host, mount, signal, Text, View } from \'nsh\'`, Tailwind classes, `mount(App)`); no network except the bot. A map: `import { MapView } from \'./map\'`, then `<MapView places={[{ name, lat, lng }, …]} route height={220} />` draws the places numbered in order on OpenStreetMap (`route`: a line through them in that order; `selected`: an index drawn larger). It gets `{ origin, moduleId, token }` from `await host.call(\'launch.params\')` and sends its result once with `fetch(`${origin}/ui/${moduleId}/result`, { method: \'POST\', headers: { authorization: `Bearer ${token}`, \'content-type\': \'application/json\' }, body: JSON.stringify({ value, text }) })`, then `host.call(\'ui.close\')`. The result arrives as their next message. Compile errors come back to you: fix the source and call `ui` again.',
    inputSchema: z.object({ title: z.string().min(1).max(80).describe('What the interface is, in a few words; shown above it in the thread'), source: z.string().min(40).max(40_000).describe('The whole App.tsx'), permissions: z.array(z.enum(['openUrl', 'clipboard', 'picker'])).max(3).optional().describe('Only if the interface needs it: openUrl (open https links in the browser), clipboard (copy or paste), picker (let them choose photos). The person is asked to allow each one when they open it; without them the interface still opens, so handle a refusal.') }),
  }, async ({ title, source, permissions }) => {
    if (!o.ui?.available) return text('The ui tool is not available on this computer (the nsh CLI is not installed); use show instead.')
    const r = await o.ui.create({ title, source, permissions })
    if (!r.ok) return text(`Compile errors — fix the source and call ui again:\n${r.errors.slice(0, 6000)}`)
    await actLine('ui', 'built', title)
    return text(`Shown. module=${r.module.id} — it opens on their phone when they tap it; their result arrives as their next message (a line starting with "⟦bot⟧ module" above it is the marker, ignore it). Wait for it.`)
  })

  return server
}

/** Serve the MCP tools on 127.0.0.1 with a per-process bearer secret. */
export async function startToolsServer(o: ToolsOptions, port = 0): Promise<ToolsServer> {
  const secret = randomBytes(24).toString('base64url')
  const mcp = buildMcpServer(o)
  const http = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${secret}`) { res.writeHead(401); return res.end() }
    if (new URL(req.url ?? '/', 'http://x').pathname !== '/mcp') { res.writeHead(404); return res.end() }
    try {
      const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined })
      await mcp.connect(transport)
      await transport.handleRequest(req, res)
    } catch (e) { console.error('[bot] mcp request failed', e); if (!res.headersSent) res.writeHead(500); res.end() }
  })
  http.listen(port, '127.0.0.1')
  await once(http, 'listening')
  const { port: p } = http.address() as { port: number }
  return { url: `http://127.0.0.1:${p}/mcp`, secret, close: () => new Promise((r) => { http.closeAllConnections(); http.close(() => r()) }) }
}
