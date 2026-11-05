// Usage transparency: how much the assistant has consumed, from the harness's
// own per-session token projections. No prices here (they differ per
// provider); the app shows tokens and lets the person judge.
import type { Harness } from './harness.ts'

export interface SessionUsage { sessionId: string; title?: string; updatedAt: number; inputTokens: number; cachedTokens: number; outputTokens: number; turns: number }
export interface UsageSummary { today: { inputTokens: number; cachedTokens: number; outputTokens: number; sessions: number }; sessions: SessionUsage[] }

interface ListItem { sessionId: string; updatedAt: number; origin?: string; parentSessionId?: string; projections?: { values?: { title?: string | null; tokenUsage?: { uncachedInputTokens?: number; outputTokens?: number; cacheReadTokens?: number }; sessionStats?: { turns?: number } } } }

/** Summarize the harness's session list; `now` and `dayStart` are injectable for tests. */
export function summarize(items: ListItem[], dayStart: number): UsageSummary {
  // A background task (origin "subagent", src/harness.ts) is part of its thread: its tokens
  // count on the thread's row, the top-level ancestor by the header chain. Its own title is the task's instruction,
  // or for a fork the thread's first prompt, and its turns are not the person's. A thread that is gone keeps an
  // untitled row of its own.
  const byId = new Map(items.map((s) => [s.sessionId, s]))
  const threadOf = (s: ListItem) => { let cur = s; for (let i = 0; i < 16 && cur.origin === 'subagent' && cur.parentSessionId; i++) cur = byId.get(cur.parentSessionId) ?? { sessionId: cur.parentSessionId, updatedAt: 0 }; return cur.sessionId }
  const rows = new Map<string, SessionUsage>()
  for (const s of items) if (s.origin !== 'subagent') {
    const v = s.projections?.values
    rows.set(s.sessionId, { sessionId: s.sessionId, title: v?.title ?? undefined, updatedAt: s.updatedAt, inputTokens: v?.tokenUsage?.uncachedInputTokens ?? 0, cachedTokens: v?.tokenUsage?.cacheReadTokens ?? 0, outputTokens: v?.tokenUsage?.outputTokens ?? 0, turns: v?.sessionStats?.turns ?? 0 })
  }
  for (const s of items) if (s.origin === 'subagent') {
    const id = threadOf(s)
    const row = rows.get(id) ?? { sessionId: id, title: undefined, updatedAt: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, turns: 0 }
    const t = s.projections?.values?.tokenUsage
    row.inputTokens += t?.uncachedInputTokens ?? 0; row.cachedTokens += t?.cacheReadTokens ?? 0; row.outputTokens += t?.outputTokens ?? 0
    row.updatedAt = Math.max(row.updatedAt, s.updatedAt)
    rows.set(id, row)
  }
  const sessions = [...rows.values()].sort((a, b) => b.updatedAt - a.updatedAt)
  const todays = sessions.filter((s) => s.updatedAt >= dayStart)
  const sum = (k: 'inputTokens' | 'cachedTokens' | 'outputTokens') => todays.reduce((n, s) => n + s[k], 0)
  return { today: { inputTokens: sum('inputTokens'), cachedTokens: sum('cachedTokens'), outputTokens: sum('outputTokens'), sessions: todays.length }, sessions }
}

export async function usage(harness: Pick<Harness, 'rpc'>, timeZone?: string): Promise<UsageSummary> {
  const v = await harness.rpc<{ items: ListItem[] }>('session/list', { _request: {} })
  return summarize(v.items, startOfToday(Date.now(), timeZone))
}

export function startOfToday(now: number, timeZone?: string): number {
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: timeZone || undefined, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(now)).map((p) => [p.type, p.value]))
    const wall = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute))
    const offset = wall - Math.floor(now / 60_000) * 60_000
    return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)) - offset
  } catch { const d = new Date(now); d.setHours(0, 0, 0, 0); return d.getTime() }
}
