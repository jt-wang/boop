// A turn the computer's restart cut off goes on after the restart.
//
// A restart during a turn (a deploy, a model switch under the supervisor, a crash, the machine going away) used to
// leave the person with no reply. DSH closes such a turn when it next reads the session: each call it was running
// gets an "interrupted" result that tells the model to check before repeating anything with side effects, and the
// turn ends with reason `interrupted` (dsh-session interruptedTurnClosers; the live loop ends a turn `completed`,
// `blocked`, `max-tokens`, `aborted` or `error`, never `interrupted`). It starts nothing. DeepSeek's dsh-superagent
// prototype starts interrupted work again at start-up with a recovery note (its docs/003-execution.md, "Restart");
// this does the same for each thread whose last turn the restart cut off, once.
import type { Harness, FollowFrame } from './harness.ts'
import { RESUMED } from './fold.ts'

/** What the thread gets to go on: the bot's own message, which the thread does not show (src/fold.ts RESUMED); the steps after it show. */
export const RECOVER = `${RESUMED} The computer restarted while you were working on this, so whatever was still running stopped where it was, commands in the background included. Carry on from there and finish it.`

type Rec = { type: string; event?: { type: string; data?: Record<string, unknown> } }
const textOf = (c: unknown) => Array.isArray(c) ? c.map((p) => (p as { text?: string }).text ?? '').join('') : typeof c === 'string' ? c : ''

/** Whether a session's last turn is one the restart cut off, and not already the going-on after an earlier one. */
export function cutOff(records: Rec[]): boolean {
  const events = records.filter((r) => r.type === 'event' && r.event).map((r) => r.event!)
  const end = events.findLastIndex((e) => e.type === 'turn/end')
  if (end < 0 || (events[end].data?.reason as { kind?: string } | undefined)?.kind !== 'interrupted') return false
  if (events.slice(end + 1).some((e) => e.type === 'turn/start')) return false
  const start = events.slice(0, end).findLastIndex((e) => e.type === 'turn/start')
  const opener = events.slice(0, start < 0 ? end : start).findLast((e) => e.type === 'user/message')
  return !textOf(opener?.data?.content).startsWith(RECOVER)
}

/**
 * Whether the session waits on a background job the restart killed. A job dies with the harness process (dsh-jobs,
 * "What can go wrong"), so DSH's completion notice for it never comes and nothing wakes the session. A job counts once
 * DSH's bash result said it started or moved to the background (dsh-tool-bash), and stops counting when the session
 * heard of its end (DSH's notice, also passed on by a thread, src/dsh-plugin.js), read its end with job_output or
 * job_kill, moved it with the work (the hand-off's call, `call_bg_…`), or already went on after a restart.
 */
export function lostJob(records: Rec[]): boolean {
  const events = records.filter((r) => r.type === 'event' && r.event).map((r) => r.event!)
  const open = new Set<string>()
  const callJob = new Map<string, string>()
  for (const e of events) {
    const d = e.data ?? {}
    if (e.type === 'user/message') {
      const said = textOf(d.content)
      if (said.startsWith(RECOVER)) open.clear()
      for (const m of said.matchAll(/background job ([\w-]+) \(/g)) open.delete(m[1])
    } else if (e.type === 'assistant/message') {
      const parts = ((d.message as { content?: unknown[] } | undefined)?.content ?? []) as { type?: string; id?: string; name?: string; arguments?: { job_id?: unknown } }[]
      for (const p of parts) {
        if (p.type !== 'tool-call') continue
        if (String(p.id ?? '').startsWith('call_bg_')) open.clear() // the hand-off: the turn's jobs went with the work
        if ((p.name === 'job_output' || p.name === 'job_kill') && typeof p.arguments?.job_id === 'string') callJob.set(String(p.id), p.arguments.job_id)
      }
    } else if (e.type === 'tool/result') {
      const message = d.message as { toolCallId?: string; source?: { callId?: string }; isError?: boolean; content?: unknown } | undefined
      const said = textOf(message?.content)
      const job = callJob.get(String(message?.toolCallId ?? message?.source?.callId))
      if (job && /\[status: (completed|killed|failed)\b|had already finished/.test(said)) open.delete(job)
      if (!message?.isError) for (const m of said.matchAll(/(?:started|moved to) background job ([\w-]+)/g)) open.add(m[1])
    }
  }
  return open.size > 0
}

/** The session's records as a fresh follow's snapshot gives them, or null when none came in time. */
async function snapshotOf(harness: Harness, sessionId: string, parentSessionId?: string, ms = 10_000): Promise<Rec[] | null> {
  let cancel: (() => void) | undefined
  try {
    return await new Promise<Rec[] | null>((resolve) => {
      const t = setTimeout(() => resolve(null), ms)
      harness.follow(sessionId, (f: FollowFrame) => { if (f.type === 'snapshot') { clearTimeout(t); resolve((f as { records?: Rec[] }).records ?? []) } }, () => { clearTimeout(t); resolve(null) }, parentSessionId)
        .then((c) => { cancel = c }, () => { clearTimeout(t); resolve(null) })
    })
  } finally { cancel?.() }
}

/** At start-up: each thread, then each background task, whose last turn the restart cut off goes on. Returns the sessions it went on with. */
export async function recoverInterrupted(harness: Harness, log: (m: string) => void = (m) => console.log(m)): Promise<string[]> {
  const went: string[] = []
  let sessions: Awaited<ReturnType<Harness['listSessions']>>
  try { sessions = await harness.listSessions() } catch (e) { log(`[bot] could not list threads to go on after a restart: ${(e as Error).message}`); return went }
  for (const s of sessions) {
    // not `blank`: after a stop by SIGTERM DSH lists the cut-off thread as blank (measured 2026-11-01)
    if (s.running) continue
    const records = await snapshotOf(harness, s.sessionId)
    if (!records || !(cutOff(records) || lostJob(records))) continue
    try { await harness.prompt(s.sessionId, RECOVER); went.push(s.sessionId); log(`[bot] the restart cut off a turn of ${s.sessionId}; it goes on`) } catch (e) { log(`[bot] could not go on with ${s.sessionId} after a restart: ${(e as Error).message}`) }
  }
  // a background task's result reaches its thread when its turn ends, as before the restart
  if (!harness.promptTask || !harness.backgroundTasks) return went
  const tasks = await harness.backgroundTasks().catch((e) => { log(`[bot] could not list background tasks to go on after a restart: ${(e as Error).message}`); return [] })
  for (const t of tasks) {
    if (t.running || !t.parentId) continue
    const records = await snapshotOf(harness, t.sessionId, t.parentId)
    if (!records || !(cutOff(records) || lostJob(records))) continue
    try { await harness.promptTask(t.parentId, t.sessionId, RECOVER); went.push(t.sessionId); log(`[bot] the restart cut off background task ${t.sessionId}; it goes on`) } catch (e) { log(`[bot] could not go on with background task ${t.sessionId} after a restart: ${(e as Error).message}`) }
  }
  return went
}
