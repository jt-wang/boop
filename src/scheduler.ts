// Reminders and recurring checks, owned by bot so they fire even when the
// harness build has no schedule service. A due task is handed to `onDue`
// (main.ts prompts the main thread with it and pushes the result).
import { JsonList } from './store.ts'

export type When =
  | { kind: 'once'; at: string }                       // ISO instant
  | { kind: 'every'; seconds: number }                 // fixed rate from creation / last run
  | { kind: 'daily'; time: string; timeZone: string }  // "HH:MM" local to timeZone
  | { kind: 'weekly'; time: string; timeZone: string; weekdays: number[] } // ISO 1..7

export interface Task {
  id: string
  name: string
  instruction: string
  when: When
  createdAt: string
  nextRunAt: string | null
  lastRunAt?: string
  active: boolean
}

export interface SchedulerOptions { now?: () => number; tickMs?: number; onDue: (task: Task) => Promise<void> }

export class Scheduler {
  private timer: NodeJS.Timeout | null = null
  private readonly now: () => number
  private readonly store: JsonList<Task>
  private readonly opts: SchedulerOptions
  private constructor(store: JsonList<Task>, opts: SchedulerOptions) { this.store = store; this.opts = opts; this.now = opts.now ?? Date.now }

  static async open(path: string, opts: SchedulerOptions) { return new Scheduler(await JsonList.open<Task>(path), opts) }

  list(): Task[] { return this.store.all() }

  async create(input: { name: string; instruction: string; when: When }): Promise<Task> {
    const next = nextRun(input.when, this.now(), undefined)
    if (!next) throw new Error('that time is in the past')
    return this.store.insert({ name: input.name.slice(0, 80), instruction: input.instruction.slice(0, 2000), when: input.when, createdAt: new Date(this.now()).toISOString(), nextRunAt: new Date(next).toISOString(), active: true })
  }

  async update(id: string, patch: { name?: string; instruction?: string; when?: When; active?: boolean }): Promise<Task | undefined> {
    const t = this.store.get(id); if (!t) return undefined
    const when = patch.when ?? t.when
    const nextRunAt = patch.when || patch.active ? new Date(nextRun(when, this.now(), undefined) ?? this.now()).toISOString() : t.nextRunAt
    return this.store.update(id, { ...patch, when, nextRunAt })
  }

  remove(id: string) { return this.store.remove(id) }

  /** Fire everything due; returns the tasks that ran. */
  async tick(): Promise<Task[]> {
    const ran: Task[] = []
    for (const t of this.store.all()) {
      if (!t.active || !t.nextRunAt || Date.parse(t.nextRunAt) > this.now()) continue
      const next = t.when.kind === 'once' ? null : nextRun(t.when, this.now(), Date.parse(t.nextRunAt))
      await this.store.update(t.id, { lastRunAt: new Date(this.now()).toISOString(), nextRunAt: next ? new Date(next).toISOString() : null, active: next !== null })
      try { await this.opts.onDue(t) } catch (e) { console.error('[bot] scheduled task failed', t.name, e) }
      ran.push(t)
    }
    return ran
  }

  start() { if (!this.timer) this.timer = setInterval(() => { this.tick().catch((e) => console.error('[bot] scheduler', e)) }, this.opts.tickMs ?? 15_000); this.timer.unref?.() }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null }
}

/** Next run strictly after `now` (ms); `previous` anchors fixed-rate tasks. */
export function nextRun(when: When, now: number, previous: number | undefined): number | null {
  switch (when.kind) {
    case 'once': { const at = Date.parse(when.at); return Number.isFinite(at) && at > now ? at : null }
    case 'every': { const base = previous ?? now; let next = base + when.seconds * 1000; while (next <= now) next += when.seconds * 1000; return next }
    case 'daily': return nextLocal(when.time, when.timeZone, now, [1, 2, 3, 4, 5, 6, 7])
    case 'weekly': return nextLocal(when.time, when.timeZone, now, when.weekdays)
  }
}

function nextLocal(time: string, timeZone: string, now: number, weekdays: number[]): number | null {
  const [hh, mm] = time.split(':').map(Number)
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null
  for (let dayOffset = 0; dayOffset < 8; dayOffset++) {
    const candidate = zonedInstant(now + dayOffset * 86_400_000, timeZone, hh, mm)
    if (candidate === null) return null
    const weekday = isoWeekday(candidate, timeZone)
    if (candidate > now && weekdays.includes(weekday)) return candidate
  }
  return null
}

/** The instant at local hh:mm on the local calendar day containing `ms` in `timeZone`. */
function zonedInstant(ms: number, timeZone: string, hh: number, mm: number): number | null {
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms)).map((p) => [p.type, p.value]))
    const localAsUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), hh, mm)
    // offset = local wall-clock minus the real instant, measured at ms
    const wallAtMs = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute))
    const offset = wallAtMs - Math.floor(ms / 60_000) * 60_000
    return localAsUtc - offset
  } catch { return null }
}

function isoWeekday(ms: number, timeZone: string): number {
  const name = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(new Date(ms))
  return ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(name) + 1
}
