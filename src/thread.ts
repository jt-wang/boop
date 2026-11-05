// bot's own thread protocol. Clients speak this, never the harness's wire
// format. A ThreadFollower turns harness frames into:
//   { type: 'snapshot', sessionId, rows, running, statusText, title }
//   { type: 'rows', sessionId, rows }                 — rows added or replaced (by id)
//   { type: 'delta', sessionId, rowId, text }         — streaming text for one row
//   { type: 'status', sessionId, running, statusText }
//   { type: 'end', sessionId, error? }
import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import type { Harness, FollowFrame } from './harness.ts'
import { SERVER_WORDS, type Lang } from './locales/index.ts'
import { emptyThread, foldEvent, foldSnapshot, foldStream, retryLog, type Row, type ThreadState } from './fold.ts'

// A harness event the thread has no decision for: say it once in the bot's log (src/fold.ts EVENT_COVERAGE).
const unknownSeen = new Set<string>()
const reportUnknown = (type: string) => { if (!unknownSeen.has(type)) { unknownSeen.add(type); console.warn(`[bot] harness event "${type}" is not handled by the thread view (src/fold.ts EVENT_COVERAGE)`) } }

/** The sha256 of a file the assistant presented, to tell whether it is an image it already showed (src/fold.ts). A
 * regular file only, not through a symlink, and not a huge one: the path comes from the assistant. */
export function fileSha256(path: string, max = 32 * 1024 * 1024): string | undefined {
  let fd: number | undefined
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const st = fstatSync(fd)
    if (!st.isFile() || st.size > max) return undefined
    return createHash('sha256').update(readFileSync(fd)).digest('hex')
  } catch { return undefined } finally { if (fd !== undefined) closeSync(fd) }
}

export type ThreadFrame =
  | { type: 'snapshot'; sessionId: string; rows: Row[]; running: boolean; statusText: string; title: string }
  | { type: 'rows'; sessionId: string; rows: Row[] }
  | { type: 'delta'; sessionId: string; rowId: string; text: string }
  | { type: 'status'; sessionId: string; running: boolean; statusText: string }
  | { type: 'end'; sessionId: string; error?: { code: string; message: string } }

export interface ThreadSummary { sessionId: string; title?: string; updatedAt: number; running: boolean; blank: boolean }

/** What a background task made for the person shows in its conversation; its words and steps stay in the task, and its result comes back through the conversation. */
const DELIVERED = new Set<Row['kind']>(['card', 'module', 'file'])
const answerKey = (r: Row) => r.kind === 'card' ? `card:${r.id}` : r.kind === 'module' ? `module:${r.moduleId}` : ''

/** Follow one session and emit ThreadFrames; `cancel()` stops it. */
export async function followThread(harness: Harness, sessionId: string, emit: (f: ThreadFrame) => void, lang: Lang = 'en'): Promise<() => void> {
  const s: ThreadState = emptyThread()
  let seen = false
  let closed = false
  // The conversation's background tasks (and theirs), each folded on its own; their cards, interfaces and files join
  // the conversation's rows at the time they were made. A tap on one goes to the conversation like any other.
  // A forked task starts with a copy of the conversation (same ids and times) up to `session/end-seed`: only what
  // comes after is the task's own.
  type Task = { state: ThreadState; since: number; cancel?: () => void }
  const tasks = new Map<string, Task>()
  const seedEnd = (t: Task, ev?: { type: string; time?: number }) => { if (ev?.type === 'session/end-seed') t.since = Math.max(t.since, ev.time ?? 0) }
  const deliver = () => {
    let inserted = false
    const changed: Row[] = []
    for (const [taskId, t] of tasks) for (const r of t.state.rows) {
      if (!DELIVERED.has(r.kind) || r.at <= t.since) continue
      // a file the task's turn changed is named by its turn number, which the conversation's turns share
      const id = r.id.startsWith('changed:') ? `changed:${taskId}:${r.id.slice('changed:'.length)}` : r.id
      const i = s.rows.findIndex((x) => x.id === id)
      const answer = (i >= 0 ? (s.rows[i] as { answer?: string }).answer : undefined) ?? s.answers?.[answerKey(r)]
      const row = { ...r, id, ...(answer !== undefined ? { answer } : {}) } as Row
      if (i >= 0) { if (JSON.stringify(s.rows[i]) !== JSON.stringify(row)) { s.rows[i] = row; changed.push(row) } continue }
      const found = s.rows.findIndex((x) => x.at > r.at)
      const at = found < 0 ? s.rows.length : found
      s.rows.splice(at, 0, row)
      if (s.turnFrom !== undefined && at < s.turnFrom) s.turnFrom++ // the turn's own rows still start where they did
      inserted = true
    }
    if (inserted) emit({ type: 'snapshot', sessionId, rows: [...s.rows], running: s.running, statusText: s.statusText, title: s.title })
    else if (changed.length) emit({ type: 'rows', sessionId, rows: changed })
  }
  const followTasks = async () => {
    const list = await harness.backgroundTasks?.().catch(() => []) ?? []
    for (const t of list) {
      if (closed || t.threadId !== sessionId || t.sessionId === sessionId || tasks.has(t.sessionId)) continue
      const task: Task = { state: emptyThread(), since: 0 }
      tasks.set(t.sessionId, task)
      let taskSeen = false
      const cancelTask = await harness.follow(t.sessionId, (f: FollowFrame) => {
        if (f.type === 'snapshot') {
          const snap = f as Parameters<typeof foldSnapshot>[1]
          for (const r of snap.records ?? []) seedEnd(task, r.event)
          foldSnapshot(task.state, snap, lang, fileSha256); taskSeen = true
        } else if (taskSeen && f.type === 'event' && f.event) {
          const ev = f.event as { type: string; time?: number; data?: Record<string, unknown> }
          seedEnd(task, ev); foldEvent(task.state, ev, lang, undefined, fileSha256)
        } else return
        if (seen) deliver()
      }, () => {}, t.parentId).catch(() => () => {})
      if (closed) cancelTask(); else task.cancel = cancelTask
    }
  }
  const taskStarted = () => Object.keys(s.background ?? {}).some((id) => !tasks.has(id))
  const rowsChanged = (before: ThreadState, changedIds: Set<string>) => {
    const rows = s.rows.filter((r) => changedIds.has(r.id))
    if (rows.length) emit({ type: 'rows', sessionId, rows })
    if (before.running !== s.running || before.statusText !== s.statusText) emit({ type: 'status', sessionId, running: s.running, statusText: s.statusText })
  }
  const snapshotOf = (st: ThreadState) => ({ running: st.running, statusText: st.statusText })
  const cancel = await harness.follow(sessionId, (f: FollowFrame) => {
    if (f.type === 'snapshot') {
      foldSnapshot(s, f as Parameters<typeof foldSnapshot>[1], lang, fileSha256); seen = true
      emit({ type: 'snapshot', sessionId, rows: [...s.rows], running: s.running, statusText: s.statusText, title: s.title })
      deliver(); followTasks().catch(() => {})
      // a long turn's turn/start can fall outside the snapshot's page: the harness's own session status decides
      if (!s.running) harness.listSessions().then((l) => {
        if (s.running || !l.find((x) => x.sessionId === sessionId)?.running) return
        s.running = true; s.statusText = SERVER_WORDS[lang].status.working
        emit({ type: 'status', sessionId, running: true, statusText: s.statusText })
      }).catch(() => {})
      return
    }
    if (!seen) return
    const before = snapshotOf(s)
    const idsBefore = new Map(s.rows.map((r) => [r.id, JSON.stringify(r)]))
    if (f.type === 'event' && f.event) {
      if ((f.event as { type: string }).type === 'llm/retry') console.log(retryLog((f.event as { data?: Parameters<typeof retryLog>[0] }).data ?? {}))
      foldEvent(s, f.event as { type: string; time?: number; data?: Record<string, unknown> }, lang, reportUnknown, fileSha256)
      if (taskStarted() || (f.event as { type: string }).type.startsWith('subagent/')) followTasks().catch(() => {})
    } else if (f.type === 'assistant-stream' && f.frame) {
      const frame = f.frame as { type: string; chunk?: { type: string; text?: string; name?: string }; outcome?: { kind: string } }
      const streamingBefore = s.streamingId
      foldStream(s, frame, lang)
      // text deltas go out as deltas, not whole rows
      if (frame.type === 'chunk' && frame.chunk?.type === 'text-delta' && s.streamingId && s.streamingId === streamingBefore) {
        emit({ type: 'delta', sessionId, rowId: s.streamingId, text: frame.chunk.text ?? '' })
        if (before.statusText !== s.statusText || before.running !== s.running) emit({ type: 'status', sessionId, running: s.running, statusText: s.statusText })
        return
      }
    } else return
    const changed = new Set<string>()
    for (const r of s.rows) if (idsBefore.get(r.id) !== JSON.stringify(r)) changed.add(r.id)
    const removed = [...idsBefore.keys()].filter((id) => !s.rows.some((r) => r.id === id))
    if (removed.length) emit({ type: 'snapshot', sessionId, rows: [...s.rows], running: s.running, statusText: s.statusText, title: s.title })
    else rowsChanged(before as ThreadState, changed)
  }, (err) => emit({ type: 'end', sessionId, error: err }))
  return () => { closed = true; cancel(); for (const t of tasks.values()) t.cancel?.() }
}

export async function listThreads(harness: Harness): Promise<ThreadSummary[]> {
  return (await harness.listSessions()).map((s) => ({ sessionId: s.sessionId, title: s.title, updatedAt: s.updatedAt, running: s.running, blank: s.blank }))
}
