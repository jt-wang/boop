// Try it: the app on made-up data, for someone with no computer yet. A Bot that answers from
// this file: nothing goes over the network, and state.ts keeps nothing of it in Storage.
import { Bot, type Session } from './api.ts'
import { TRY_STRINGS, type TryWords } from './i18n-try.ts'
import type { Lang } from './locale.ts'

/** Not an address anything can reach: a fetch that slipped through fails instead of going out. */
export const SAMPLE_ORIGIN = 'sample://boop'
export const SAMPLE_THREAD = 'sample-main'
const DAY = 86_400_000

type Frame = { type: string; sessionId: string; [k: string]: unknown }
type Item = { id: string; [k: string]: unknown }

export class SampleBot extends Bot {
  private readonly w: TryWords
  private readonly at = Date.now()
  private timers: ReturnType<typeof setTimeout>[] = []
  private n = 0
  private sideChats = 0
  private readonly lists: Record<string, Item[]>
  name: string

  constructor(private readonly language: Lang, name: string, private readonly emit: (f: Frame) => void) {
    super({ origin: SAMPLE_ORIGIN, token: 'sample' } as Session)
    this.w = TRY_STRINGS[language]
    this.name = name
    const iso = (d: number) => new Date(this.at + d).toISOString()
    this.lists = {
      goals: [{ id: 'g1', title: this.w.sampleGoal, plan: [this.w.sampleGoalStep1, this.w.sampleGoalStep2], notes: [], status: 'active' }],
      schedules: [{ id: 't1', name: this.w.sampleTask, instruction: this.w.sampleTaskDo, when: { kind: 'daily', time: '08:00' }, nextRunAt: iso(DAY), active: true }],
      ideas: [{ id: 'i1', title: this.w.sampleIdea, body: this.w.sampleIdeaBody, action: this.w.sampleIdeaDo, createdAt: iso(0), dismissed: false }],
      memory: [{ id: 'm1', file: 'user', kind: 'preference', text: this.w.sampleMemory, date: iso(-DAY).slice(0, 10) }],
    }
  }

  me() { return { device: { id: 'sample-phone', name: 'iPhone' }, assistant: { name: this.name }, mainSessionId: SAMPLE_THREAD, connected: true, computer: { name: this.w.sampleComputer, version: '' } } }

  /** What the socket would answer to a follow. */
  snapshot(id: string): Frame {
    const rows = id !== SAMPLE_THREAD ? [] : [
      { kind: 'notice', id: 'sample-notice', text: this.w.sampleNotice, at: this.at - 4 },
      { kind: 'you', id: 'sample-y1', text: this.w.sampleYou1, at: this.at - 3 },
      { kind: 'them', id: 'sample-t1', text: this.w.sampleThem1, at: this.at - 2 },
      { kind: 'you', id: 'sample-y2', text: this.w.sampleYou2, at: this.at - 1 },
      { kind: 'them', id: 'sample-t2', text: this.w.sampleThem2, at: this.at },
    ]
    return { type: 'snapshot', sessionId: id, rows, running: false, statusText: '', title: '' }
  }

  /** The one card the sample opens with. */
  asks() { return [{ kind: 'approval' as const, eventId: 'sample-ask', sessionId: SAMPLE_THREAD, request: { toolName: 'bash', reason: this.w.sampleAsk, displayReason: { [this.language]: this.w.sampleAsk } }, at: this.at }] }

  private later(ms: number, fn: () => void) { this.timers.push(setTimeout(fn, ms)) }
  private reply(sessionId: string, text: string) {
    const id = `sample-${++this.n}`
    this.later(900, () => {
      this.emit({ type: 'rows', sessionId, rows: [{ kind: 'them', id, text, at: Date.now() }] })
      this.emit({ type: 'status', sessionId, running: false })
    })
  }

  override async get<T>(path: string): Promise<T> {
    const p = path.split('?')[0]
    const at = this.at
    const answers: Record<string, unknown> = {
      '/me': this.me(),
      '/threads': [{ sessionId: SAMPLE_THREAD, title: '', updatedAt: at, running: false, blank: false }],
      '/library': [{ path: 'lisbon.md', size: this.w.sampleFile.length, mtime: at, kind: 'text' }],
      '/library/file': { kind: 'text', mime: 'text/markdown', size: this.w.sampleFile.length, text: this.w.sampleFile },
      '/activity': [{ id: 'a1', at: new Date(at).toISOString(), kind: 'schedule', text: this.w.sampleActivity }],
      '/devices': [{ id: 'sample-phone', name: 'iPhone', createdAt: new Date(at).toISOString(), revokedAt: null, current: true }],
      '/usage': { today: { inputTokens: 0, cachedTokens: 0, outputTokens: 0, sessions: 0 }, sessions: [] },
      '/connectors': { connectors: [], catalog: [], env: {}, restartNeeded: false },
      '/ui': [],
    }
    const list = this.lists[p.slice(1)]
    return (list ?? answers[p] ?? []) as T
  }

  override async text(path: string): Promise<string> { return path === '/export' ? this.w.sampleMemory : '' }

  override async send<T>(method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T> {
    const [, kind, id, action] = path.split('?')[0].split('/').map(decodeURIComponent)
    const list = this.lists[kind]
    if (kind === 'approvals') { this.reply(SAMPLE_THREAD, this.w.sampleApproved); this.emit({ type: 'status', sessionId: SAMPLE_THREAD, running: true }) }
    else if (kind === 'settings' && typeof (body as { assistantName?: unknown })?.assistantName === 'string') this.name = (body as { assistantName: string }).assistantName
    else if (kind === 'ideas' && id === 'refresh') return list as T
    else if (list && id && (method === 'DELETE' || action === 'dismiss')) this.lists[kind] = list.filter((x) => x.id !== id)
    else if (list && id && method === 'PATCH') this.lists[kind] = list.map((x) => (x.id === id ? { ...x, ...(body as object) } : x))
    return { ok: true, forwarded: false, error: kind === 'connectors' ? 'sample' : undefined } as T
  }

  override async rpc<T = unknown>(method: string): Promise<T> {
    return (method === 'session/create' ? { sessionId: `sample-side-${++this.sideChats}` } : {}) as T
  }

  override async prompt(sessionId: string, text: string) {
    this.emit({ type: 'rows', sessionId, rows: [{ kind: 'you', id: `sample-${++this.n}`, text, at: Date.now() }] })
    this.reply(sessionId, this.w.sampleReply)
    return { ok: true }
  }

  override async cancel(path: string) {
    for (const t of this.timers) clearTimeout(t)
    this.timers = []
    this.emit({ type: 'status', sessionId: decodeURIComponent(path.split('/')[2] ?? ''), running: false })
    return 200
  }

  override async sendContext() {}
  override async ticket() { return '' }
}
