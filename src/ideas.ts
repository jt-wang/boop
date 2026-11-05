// Ideas: three concrete suggestions the assistant brings to the person, made
// by a cheap model from what it knows (USER.md, MEMORY.md, goals, upcoming
// reminders, recent activity). Refreshed on demand, once a day on its own,
// when what it knows changes, and — when the person opted in — pushed as one "morning brief" per day.
// Each idea carries the message the person can send with one tap.
import { createHash } from 'node:crypto'
import type { LlmClient } from './llm.ts'
import { JsonList } from './store.ts'
import { languageName, line, uiLang, type Line } from './lang.ts'

export interface Idea {
  id: string
  title: string
  body: string
  /** A message the person can send to the assistant as-is. */
  action: string
  createdAt: string
  dismissed: boolean
}

export interface IdeasContext {
  user: string
  memory: string
  goals: unknown[]
  schedules: unknown[]
  activity: { at: string; kind: string; text: string }[]
}

export interface IdeasSettings { assistantName: string; language?: string; morningBrief?: boolean; briefHour?: number; timeZone?: string }

export interface IdeasOptions {
  llm: LlmClient
  context: () => Promise<IdeasContext>
  settings: () => Promise<IdeasSettings>
  notify?: (n: { title: string; body: string; url?: string; tag?: string }) => Promise<void>
  onActivity?: (e: { kind: string; text: string; line?: Line }) => void
  now?: () => number
  /** How often `start()` looks at the clock. Default 60 s. */
  tickMs?: number
  /** Minimum gap between two automatic refreshes. Default 24 h. */
  dailyMs?: number
  /** Minimum gap between a refresh and one because goals, memory or reminders changed. Default 10 min. */
  changedMs?: number
  log?: (...a: unknown[]) => void
}

interface State { id: 'state'; lastRunAt: string | null; lastBriefOn: string | null; lastContext?: string }

/** What the ideas stand on, without recent activity (it moves with every turn). */
const fingerprint = (c: IdeasContext) => createHash('sha1').update(JSON.stringify([c.user, c.memory, c.goals, c.schedules])).digest('hex')

const SYSTEM = `You are the proactive side of a personal assistant. From the notes below, propose exactly 3 concrete things the assistant could do for the person right now, each one tap away.
Return JSON: {"ideas":[{"title":"…","body":"…","action":"…"}]}
- title: at most 40 characters, a verb phrase ("Book the dentist").
- body: one or two sentences on why now, grounded in the notes (a goal with no progress, an upcoming reminder, something they said they wanted).
- action: the exact message the person would send to the assistant to make it happen, written in the first person ("Find me a dentist slot next Tuesday morning"). The assistant will receive it verbatim.
Write in the language the first line names. Never invent facts that are not in the notes; when the notes are thin, propose ways to get to know them (ask about their week, set up a first reminder). No duplicates of what was already done in the recent activity.
- The person never sees how notes are kept: never mention files, notes, profiles, templates or memory as things; speak of what you know about them. Never propose asking for their time zone or language: their phone already tells the assistant.`

/** A notes file's facts alone: its heading and its unfilled placeholder are how it is kept, not what is known. */
const facts = (text: string) => text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && !/^\(.*\)$/.test(l)).join('\n')

export class Ideas {
  private readonly store: JsonList<Idea>
  private readonly state: JsonList<State>
  private readonly o: IdeasOptions
  private readonly now: () => number
  private timer: NodeJS.Timeout | null = null
  private refreshing: Promise<Idea[]> | null = null
  private constructor(store: JsonList<Idea>, state: JsonList<State>, o: IdeasOptions) { this.store = store; this.state = state; this.o = o; this.now = o.now ?? Date.now }

  static async open(path: string, o: IdeasOptions) {
    const store = await JsonList.open<Idea>(path)
    const state = await JsonList.open<State>(path.replace(/\.json$/, '') + '-state.json')
    if (!state.get('state')) await state.insert({ id: 'state', lastRunAt: null, lastBriefOn: null })
    return new Ideas(store, state, o)
  }

  /** Ideas the person has not dismissed: newest batch first, in the model's order within a batch. */
  list(): Idea[] { return this.store.all().filter((i) => !i.dismissed).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)) }

  /** Ask the model for 3 fresh ideas; they replace the undismissed ones. Concurrent calls share one run. */
  refresh(): Promise<Idea[]> {
    if (!this.refreshing) this.refreshing = this.generate().finally(() => { this.refreshing = null })
    return this.refreshing
  }

  async dismiss(id: string): Promise<boolean> {
    const i = this.store.get(id)
    if (!i) return false
    await this.store.update(id, { dismissed: true } as Partial<Idea>)
    return true
  }

  /** The daily clock: refresh once a day; push the morning brief when it is time and the person opted in. */
  async tick(): Promise<{ refreshed: boolean; briefed: boolean }> {
    const st = this.state.get('state')!
    const s = await this.o.settings()
    const tz = s.timeZone || systemTimeZone()
    const { date, hour } = localParts(this.now(), tz)
    const briefDue = Boolean(s.morningBrief) && hour >= (s.briefHour ?? 8) && st.lastBriefOn !== date
    const since = st.lastRunAt ? this.now() - Date.parse(st.lastRunAt) : Infinity
    const changed = Boolean(st.lastContext) && since >= (this.o.changedMs ?? 600_000) && fingerprint(await this.o.context()) !== st.lastContext
    const refreshDue = since >= (this.o.dailyMs ?? 86_400_000) || changed
    if (!briefDue && !refreshDue) return { refreshed: false, briefed: false }
    let ideas: Idea[]
    try { ideas = await this.refresh() } catch (e) { (this.o.log ?? console.error)('[bot] ideas refresh failed', (e as Error).message); return { refreshed: false, briefed: false } }
    let briefed = false
    if (briefDue && ideas[0] && this.o.notify) {
      await this.o.notify({ title: s.assistantName || 'Assistant', body: ideas[0].title, url: '/', tag: 'brief' })
      await this.state.update('state', { lastBriefOn: date })
      this.o.onActivity?.({ kind: 'notify', ...line(uiLang(s.language && s.language !== 'auto' ? s.language : 'en'), 'brief', ideas[0].title) })
      briefed = true
    }
    return { refreshed: true, briefed }
  }

  start() { if (!this.timer) { this.timer = setInterval(() => { this.tick().catch((e) => console.error('[bot] ideas', e)) }, this.o.tickMs ?? 60_000); this.timer.unref?.() } }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null }

  private async generate(): Promise<Idea[]> {
    const [ctx, s] = await Promise.all([this.o.context(), this.o.settings()])
    const tz = s.timeZone || systemTimeZone()
    const nowText = new Intl.DateTimeFormat('en-US', { timeZone: tz, dateStyle: 'full', timeStyle: 'short' }).format(new Date(this.now()))
    const lang = s.language && s.language !== 'auto' ? s.language : ''
    const prompt = [
      lang ? `Write every title, body and action in ${languageName(lang)}.` : 'Write in the language the person uses in their notes.',
      `Assistant name: ${s.assistantName || '(unnamed)'}. Now: ${nowText} (${tz}).`,
      `## About the person\n${facts(ctx.user) || '(nothing yet)'}`,
      `## Things to keep in mind\n${facts(ctx.memory) || '(nothing yet)'}`,
      `## Goals\n${ctx.goals.length ? JSON.stringify(ctx.goals).slice(0, 4000) : '(none)'}`,
      `## Upcoming reminders\n${ctx.schedules.length ? JSON.stringify(ctx.schedules).slice(0, 2000) : '(none)'}`,
      `## Recent activity (newest first)\n${ctx.activity.length ? ctx.activity.slice(0, 10).map((a) => `- ${a.at} [${a.kind}] ${a.text}`).join('\n') : '(none)'}`,
    ].join('\n\n')
    const raw = await this.o.llm.json<{ ideas?: unknown }>([{ role: 'system', content: SYSTEM }, { role: 'user', content: prompt }], { maxTokens: 900, temperature: 0.7 })
    const items = (Array.isArray(raw?.ideas) ? raw.ideas : [])
      .map((x) => x as Record<string, unknown>)
      .map((x) => ({ title: str(x.title, 60), body: str(x.body, 400), action: str(x.action, 1000) }))
      .filter((x) => x.title && x.action)
      .slice(0, 3)
    if (!items.length) throw new Error('model returned no usable ideas')
    for (const old of this.store.all()) if (!old.dismissed) await this.store.remove(old.id)
    const createdAt = new Date(this.now()).toISOString()
    const out: Idea[] = []
    for (const it of items) out.push(await this.store.insert({ ...it, createdAt, dismissed: false }))
    await this.state.update('state', { lastRunAt: createdAt, lastContext: fingerprint(ctx) })
    this.o.onActivity?.({ kind: 'ideas', ...line(uiLang(lang || 'en'), 'ideas', out.map((i) => i.title)) })
    return out
  }
}

function str(v: unknown, max: number) { return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '' }

export function systemTimeZone() { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' } catch { return 'UTC' } }

/** Local calendar date (YYYY-MM-DD) and hour (0–23) of `ms` in `timeZone`; falls back to UTC on a bad zone. */
export function localParts(ms: number, timeZone: string): { date: string; hour: number } {
  let parts: Record<string, string>
  try {
    parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms)).map((p) => [p.type, p.value]))
  } catch {
    parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms)).map((p) => [p.type, p.value]))
  }
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) % 24 }
}
