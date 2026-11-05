// The seam between bot and the agent harness. Everything bot needs from a
// harness is on this interface; `DshHarness` is the first implementation
// (DeepSeek Harness's `dsh web`). Someone swapping in another harness
// implements this and leaves the rest of bot alone.
import { randomUUID } from 'node:crypto'
import { rpc, Mux, sessionAddress, type DshTarget } from './dshclient.ts'
import { EventWatcher, type BotEvent } from './events.ts'

export type HarnessEvent = BotEvent

export interface FollowFrame { type: 'snapshot' | 'event' | 'assistant-stream' | string; [k: string]: unknown }

export interface Harness {
  /** Human-readable name for logs and the app's About line. */
  readonly kind: string
  /** Create a session (thread) in the given working directory. */
  createSession(cwd?: string): Promise<{ sessionId: string }>
  listSessions(): Promise<{ sessionId: string; updatedAt: number; running: boolean; blank: boolean; title?: string }[]>
  /** Background tasks: sessions the harness runs for a thread, with the thread they belong to. */
  backgroundTasks?(): Promise<{ sessionId: string; threadId: string; parentId: string; running: boolean }[]>
  /** The thread a session belongs to, by its header chain: itself for a thread, the top-level ancestor for a background task; null when that cannot be told. */
  threadOf?(sessionId: string): Promise<string | null>
  /** Queue a user message; resolves when the harness has accepted it. */
  prompt(sessionId: string, text: string, opts?: { timeZone?: string }): Promise<void>
  /** Queue a message for a background task, as its parent's person would (DSH subagents/prompt). */
  promptTask?(parentSessionId: string, childSessionId: string, text: string): Promise<void>
  /** Follow a session: one snapshot, then durable events and live stream frames. Returns a canceller. */
  follow(sessionId: string, onFrame: (f: FollowFrame) => void, onEnd?: (err?: { code: string; message: string }) => void, parentSessionId?: string): Promise<() => void>
  /** Answer a pending approval or question the harness raised. */
  answer(eventId: string, outcome: unknown): Promise<void>
  /** Stop the running turn of a session, when the harness supports it. */
  cancel(sessionId: string): Promise<boolean>
  /** Host-level events: approvals, questions, cancellations, session status. */
  readonly events: { on(event: 'event', fn: (e: HarnessEvent) => void): unknown; clientId: string | null }
  /** Raw gateway call for clients that speak the harness's own protocol (the apps proxy through bot). */
  rpc<T = unknown>(method: string, args: Record<string, unknown>): Promise<T>
  close(): Promise<void>
}

export class DshHarness implements Harness {
  readonly kind = 'deepseek-harness'
  readonly target: DshTarget
  readonly events: EventWatcher
  private mux: Mux | null = null
  constructor(target: DshTarget, watcher: EventWatcher) { this.target = target; this.events = watcher }

  rpc<T = unknown>(method: string, args: Record<string, unknown>) { return rpc<T>(this.target, method, args) }

  async createSession(cwd?: string) { return this.rpc<{ sessionId: string }>('session/create', { request: cwd ? { cwd } : {} }) }

  // A background task (a subagent of a thread, src/dsh-plugin.js) is part of its thread, never a thread of its own.
  private async sessionItems() {
    return (await this.rpc<{ items: { sessionId: string; updatedAt: number; running: boolean; blank: boolean; origin?: string; parentSessionId?: string; projections?: { values?: { title?: string | null } } }[] }>('session/list', { _request: {} })).items
  }
  async listSessions() {
    return (await this.sessionItems()).filter((s) => s.origin !== 'subagent').map((s) => ({ sessionId: s.sessionId, updatedAt: s.updatedAt, running: s.running, blank: s.blank, title: s.projections?.values?.title ?? undefined }))
  }
  // The header chain as DSH lists it (session/list reads stored headers: origin, parentSessionId). An unlisted
  // session, a broken chain, or a failed list is no thread.
  async threadOf(sessionId: string) {
    let items: Awaited<ReturnType<DshHarness['sessionItems']>>
    try { items = await this.sessionItems() } catch { return null }
    const byId = new Map(items.map((s) => [s.sessionId, s]))
    let cur = byId.get(sessionId)
    for (let i = 0; cur && i < 16; i++) {
      if (cur.origin !== 'subagent') return cur.sessionId
      cur = cur.parentSessionId ? byId.get(cur.parentSessionId) : undefined
    }
    return null
  }

  // A subagent's thread is its top-level ancestor (a task's own subagents belong to the same thread).
  async backgroundTasks() {
    const items = await this.sessionItems()
    const byId = new Map(items.map((s) => [s.sessionId, s]))
    const threadOf = (s: { sessionId: string; origin?: string; parentSessionId?: string }) => { let cur = s; for (let i = 0; i < 16 && cur.origin === 'subagent' && cur.parentSessionId; i++) cur = byId.get(cur.parentSessionId) ?? { sessionId: cur.parentSessionId }; return cur.sessionId }
    return items.filter((s) => s.origin === 'subagent').map((s) => ({ sessionId: s.sessionId, threadId: threadOf(s), parentId: s.parentSessionId ?? '', running: s.running }))
  }

  // Queue: a message sent while the assistant is working waits for the next turn, and DSH's own web client
  // queues by default too. It does not wait for the task: at the next step boundary the bot's DSH plugin
  // moves the task to a background task and ends the turn, so the
  // message is answered in the next turn while the task goes on. Steer (until 2026-10-29) put it inside the
  // running turn, where the model answered it and dropped the task. On an idle session a
  // queued message starts a turn at once.
  async prompt(sessionId: string, text: string, opts: { timeZone?: string } = {}) {
    await this.rpc('session/prompt', { request: { requestId: randomUUID(), sessionId, mode: 'queue', content: [{ type: 'text', text }], ...(opts.timeZone ? { clientTimeZone: opts.timeZone } : {}) } })
  }

  // DSH's own client prompts a subagent this way (dsh-subagent prompt: a durable parent address, delivery queue); it
  // resumes a task whose session is not live (its "cold resume").
  async promptTask(parentSessionId: string, childSessionId: string, text: string) {
    await this.rpc('subagents/prompt', { request: { requestId: randomUUID(), parentSessionId, childSessionId, mode: 'continuable', delivery: 'queue', content: [{ type: 'text', text }] } })
  }

  // A background task is followed through its parent: DSH refuses a subagent's own address ("subagent Sessions require
  // their durable parent address", dsh-api-session-controller validateAddress).
  async follow(sessionId: string, onFrame: (f: FollowFrame) => void, onEnd: (err?: { code: string; message: string }) => void = () => {}, parentSessionId?: string) {
    if (!this.mux) { const m = new Mux(this.target); m.ws.on('close', () => { if (this.mux === m) this.mux = null }); this.mux = m }
    const address = parentSessionId ? { kind: 'subagent', parentSessionId, childSessionId: sessionId, mode: 'unknown' } : sessionAddress(sessionId)
    const stream = await this.mux.open('session/follow', { request: { address, assistantStream: true, maxMessages: 200 } })
    ;(async () => { try { for await (const item of stream) onFrame(item as FollowFrame); onEnd() } catch (e) { onEnd({ code: (e as { code?: string }).code ?? 'error', message: (e as Error).message }) } })()
    return () => stream.cancel()
  }

  async answer(eventId: string, outcome: unknown) {
    const clientId = this.events.clientId
    if (!clientId) throw new Error('not connected to the harness')
    await this.rpc('$events/result', { clientId, eventId, outcome })
  }

  // Stop stops the thread's background tasks too: DSH's own interrupt, as its client's
  // stop button on a subagent (dsh-subagent subagents/interruptByParent; the task's settlement notice follows).
  // A task that ended its turn may still hold a command that moved with it (src/dsh-plugin.js followTheWork), so
  // every task of the thread gets the interrupt: DSH takes one for a task with no running turn as a no-op, and the
  // plugin stops the commands it took.
  async cancel(sessionId: string) {
    const tasks = (await this.backgroundTasks().catch(() => [])).filter((t) => t.parentId === sessionId) // a task's own subagents stop with it
    for (const t of tasks) await this.rpc('subagents/interruptByParent', { childSessionId: t.sessionId, parentSessionId: sessionId, mode: 'continuable' }).catch((e) => console.error('[bot] stopping a background task failed', e))
    try { await this.rpc('session/cancel', { request: { sessionId } }); return true } catch (e) { if ((e as { code?: string }).code === 'http-404') return tasks.length > 0; throw e }
  }

  async close() { this.mux?.close(); this.mux = null; await this.events.stop() }
}
