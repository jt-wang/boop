// deepseek-bot's DSH plugin. openHome copies this file into the
// DSH profile and inserts it as a row of the profile patch; it runs inside `dsh web`, so it is plain
// JavaScript with no imports (the profile folder has no node_modules).
//
// When the person writes while the conversation is in the middle of a task, the task moves to a
// background task, the turn ends, and the person's message starts the next turn, which answers it.
// DSH has the background task already: a continuable fork subagent (its own session, reached with
// `send_message`, and a settlement notice that wakes the conversation with its result). Only the model
// can start one, by calling `subagent_fork`, and DeepSeek does not. So at
// the next step boundary after the person's message is queued, this plugin answers that step's model
// call with DSH's own `subagent_fork` call and concludes the turn after it. DSH runs the tool as if the
// model had called it: the same tool call and result ("started subagent <id>") in the conversation, the
// same child, the same notice. The task's prompt is the person's own words from the turn being moved; the
// one text of ours the model reads is the reason after DSH's result, the sentence Claude Code's Bash tool
// gives for a command it moved to the background so a queued message could reach the model.
//
// DSH hooks used (0.2.0-rc.2), each the way a shipped DSH plugin uses it: `agent/pre-step` (the
// archived-session gate in dsh-api-session-controller), `llm/stream` and `tools/execute` (dsh-session-
// checkpoint-policy), `exec.concludeTurn()` (the structured-output tool in dsh-subagent-in-process-driver).
//
// The task goes on where it was. DSH's fork provider seeds a child with completed turns only
// (`completedTurnPrefix`: "it does not see the current in-flight turn"), so a moved task would start over
// (measured 2026-10-29: 15 minutes of research again, no result). For a hand-off the fork provider's
// continuable seed is instead DSH's own `buildForkSeed` (dsh-session, the cut `session/fork` makes inside an
// open turn) at the step boundary where the task was moved: the person's request, every tool call and
// result so far, then DSH's inherited-cut marker and its closers for the open turn.
//
// Only the person stops a background task (Stop, which the bot sends as DSH's subagents/interruptByParent).
// On the real model the conversation answered the person's question and then called `interrupt_agent` on the
// task it had just moved, so the result never came (2026-10-29). A top-level session's tools leave out
// `interrupt_agent` (DSH's per-agent `tools.restrict`, as dsh-subagent applies a child's tool filter).
//
// A background task asks the person before anything hard to undo, like the conversation. DSH pins every
// subagent's approval policy to "never" at creation (dsh-subagent captureDelegatedPolicyOverrides, an
// `approval/policy` event with source "delegation"; a later switch wins). For a thread's own background
// task this plugin appends the switch back to "ask" inside the task's first turn, the event
// dsh-user-approval's setApprovalPolicy writes. Its asks then reach the bot like the thread's own. Only tasks
// this plugin moved get it (their ids from the hand-off's fork); a subagent the model starts itself, and any
// subagent of a task, keep DSH's "never". Known gap: DSH's own context for the task still says approvals are
// "rejected automatically".

//
// A command still running when the person writes moves with the work. DSH's bash
// tool waits on its command's job until the call's timeout and then returns the job's id (dsh-tool-bash, "moved to
// background job"); `job_output` with `wait` waits the same way (ctx.jobs.wait). Measured 2026-11-01: a question sent
// 5 s into `sleep 100` waited 55 s for that, and the background task then got "job bash-1 belongs to another session",
// because a job belongs to the session that started it (dsh-jobs, "The ownership boundary"). So a thread's own wait ends
// as soon as the person's message would move the work, the jobs the moved turn started go with it to the background
// task (it reads and stops them as their owner would), and their completion notices wake the task, not the thread.

export const name = 'deepseek-bot'
export const inject = ['sessionProjections', 'sessions', 'subagents', 'agents', 'jobs', 'llm']
/** dsh-session's module URL; openHome writes it here when it copies this file (the profile has no node_modules). */
const DSH_SESSION = '@deepseek-ai/dsh-session'

/** Logged on DSH's stderr; the bot passes lines starting "deepseek-bot:" to its own log (src/dsh.ts). */
const log = (m) => console.error(`deepseek-bot: ${m}`)

/** Tools that hand work to a subagent or talk to one; a step of only these is not work to move. A thread's own jobs are work: they move with it. */
const DELEGATION = new Set(['subagent', 'subagent_fork', 'send_message', 'interrupt_agent', 'list_agents'])
/** The mark on a prompt the bot itself sends (src/fold.ts INJECT; this file has no imports). */
const INJECT = '⟦bot⟧ '
/** How the bot's prompt starts when a turn the computer's restart cut off goes on (src/fold.ts RESUMED, src/recover.ts). */
const RESUMED = `${INJECT}[The computer restarted]`
/** What a hand-off's result adds after DSH's "started subagent <id>": the facts Claude Code's Bash result gives for a command moved to the background so a queued message reaches the model, said of the subagent that now does the work. */
const MOVED = 'The person wrote while you were working on this, so the work moved to the background: it goes on in that subagent from where you were, it was not interrupted, and its result comes to you when it finishes.'

/** The bot's tools that show the person a card or an interface (src/tools.ts). */
const SHOWN = new Set(['mcp__bot__show', 'mcp__bot__ui'])

/**
 * A background task's result of show or ui. What it shows appears in the person's conversation and a tap answers
 * there (src/thread.ts); the tools' own result ("their answer will arrive as their next message; wait for it", src/tools.ts)
 * is true for the conversation only, and the bot's MCP server is not told which session called.
 */
function whereShown(said) {
  return said
    .replace(/^Shown\./, 'Shown in the person\'s conversation.')
    .replace(' Their answer will arrive as their next message; wait for it.', ' Their answer goes to the conversation, not to you.')
    .replace(/their result arrives as their next message \(.*\)\. Wait for it\.$/, 'their result goes to the conversation, not to you.')
}

/** DSH's tools that start a continuable subagent, in the background unless the call asks to wait. */
const BACKGROUND_STARTS = new Set(['subagent', 'subagent_fork'])
const textOf = (content) => (Array.isArray(content) ? content : []).filter((c) => c && c.type === 'text').map((c) => String(c.text ?? '')).join('')

/** DSH's result for a continuable subagent that started (dsh-tool-subagent: "started subagent <id>"). */
const startedTask = (e) => e.type === 'tool/result' && !e.data?.message?.isError && /^started subagent \S+/.test(textOf(e.data?.message?.content))

/** The current turn's events: everything after its `turn/start`. */
function currentTurn(session) {
  const events = session.snapshotEvents()
  const start = events.findLastIndex((e) => e.type === 'turn/start')
  return start < 0 ? [] : events.slice(start + 1)
}

/** The turn before the current one: its events between the two `turn/start`s. */
function previousTurn(session) {
  const events = session.snapshotEvents()
  const starts = events.flatMap((e, i) => (e.type === 'turn/start' ? [i] : []))
  return starts.length < 2 ? [] : events.slice(starts.at(-2) + 1, starts.at(-1))
}

/** What the person asked in a turn, in their words. */
const askedIn = (turn) => turn.filter((e) => e.type === 'user/message' && e.data?.source?.kind === 'user').map((e) => textOf(e.data.content).trim()).filter(Boolean)

/**
 * What to hand to a background task at this step boundary, or null: a top-level session (not itself a
 * background task), past its first step, whose last step ended in tool calls that were work, with a
 * message from the person waiting for the next turn. The task's prompt is what the person asked in the
 * turn being moved, in their words.
 * @param agent - the Agent proposing a step.
 * @param queued - the session's next-turn inbox (the `inbox` projection).
 * @param step - the step being proposed.
 */
export function handoffFor(agent, queued, step) {
  if (agent.session.header.origin === 'subagent' || step <= 1) return null
  if (!queued.some((m) => m && m.source && m.source.kind === 'user')) return null
  if (!(agent.session.requestHeader()?.tools ?? []).some((t) => t.name === 'subagent_fork')) return null
  const turn = currentTurn(agent.session)
  // A turn that already started a background task has handed its work off; moving it again starts the same task twice
  // (QA 2026-10-30: turn 18 started one for 「顺便也比较一下去埃武拉的。」, sleep-waited, and was moved at 03:44:32).
  if (turn.some(startedTask)) return null
  const last = turn.findLast((e) => e.type === 'assistant/message')
  const calls = (last?.data?.message?.content ?? []).filter((p) => p.type === 'tool-call')
  if (!calls.length || calls.every((c) => DELEGATION.has(c.name))) return null
  let asked = askedIn(turn)
  // a turn going on after a restart (src/recover.ts) is the cut-off turn's work: what the person asked there
  if (asked.length && asked.every((t) => t.startsWith(RESUMED))) asked = askedIn(previousTurn(agent.session))
  if (!asked.length) return null
  // A turn answering one of the bot's own prompts (the opening, a reminder: ⟦bot⟧ …) is housekeeping whose reply belongs
  // in the thread; moved, it came back as a send_message and a settlement notice, and each started a turn of filler
  // (QA 2026-10-30, en: the opening, moved at 03:51:51 while it read USER.md). It finishes, then the message is answered.
  if (asked.some((t) => t.startsWith(INJECT))) return null
  const prompt = asked.join('\n\n')
  const first = prompt.split('\n')[0]
  const waiting = queued.filter((m) => m && m.source && m.source.kind === 'user').map((m) => m.id)
  return { prompt, description: first.length > 32 ? `${first.slice(0, 32)}…` : first, waiting }
}

/** The hand-off's own call ids (`forkCall`). */
const HANDOFF_CALL = /^call_bg_/

/**
 * The conversation's request without the steps a hand-off moved: the tool calls of the moved turn before the fork, and
 * their results. They stay in the session's log and in the task's seed; only the conversation's model stops reading
 * them. With them, it went on with the moved work after answering the person (an A/B of 2026-10-30:
 * 8 to 21 more searches, and twice the person's question waited 280 s and 353 s). DSH's surface replace, which would
 * hide them in the log, hung the next turn when written from this plugin; this only changes what one model call sends.
 * The person's messages and DSH's own context messages in that turn stay.
 * @param messages - one model call's messages (dsh-llm Message: system, developer, user, assistant, tool).
 */
export function withoutMovedSteps(messages) {
  const dropped = new Set(), calls = new Set()
  const toolCalls = (m) => (m.role === 'assistant' ? (m.content ?? []).filter((p) => p.type === 'tool-call') : [])
  const textOf = (m) => (Array.isArray(m.content) ? m.content.map((p) => p.text ?? '').join('') : String(m.content ?? ''))
  messages.forEach((m, i) => {
    const fork = toolCalls(m).find((p) => HANDOFF_CALL.test(String(p.id)))
    if (!fork) return
    // the task this hand-off started, and whether it has reported back to the conversation since
    const started = messages.slice(i + 1).find((x) => x.role === 'tool' && String(x.toolCallId) === String(fork.id))
    const child = /started subagent (\S+)/.exec(started ? textOf(started) : '')?.[1]
    if (!child) return // the task did not start (DSH's cap on live tasks): nothing moved, the turn goes on by itself
    const reported = messages.slice(i + 1).some((x) => x.role === 'user' && textOf(x).includes(child) && /sent a message|finished|failed|stopped|cancel/i.test(textOf(x)))
    const asks = []
    let j = i - 1
    for (; j >= 0; j--) {
      const x = messages[j]
      if (x.role === 'user') { asks.push(j); continue }
      if (x.role !== 'assistant') continue
      const these = toolCalls(x)
      // the turn before: one that ended in words, or one that ended by starting a task
      if (!these.length || these.some((p) => HANDOFF_CALL.test(String(p.id)) || BACKGROUND_STARTS.has(p.name))) break
      dropped.add(j); for (const p of these) calls.add(String(p.id))
    }
    // while the task runs, the ask is its work, not the conversation's (the fork call's prompt still carries it)
    if (!reported) for (const k of asks) dropped.add(k)
  })
  if (!dropped.size) return messages
  return messages.filter((m, i) => !dropped.has(i) && !(m.role === 'tool' && calls.has(String(m.toolCallId))))
}

/** DSH's stream protocol for one assistant message that is a single `subagent_fork` call (dsh-llm StreamChunk; the pi-ai adapter emits the same sequence). */
async function* forkCall(id, h) {
  const args = JSON.stringify({ description: h.description, prompt: h.prompt })
  yield { type: 'block-start', index: 0, blockType: 'tool-call' }
  yield { type: 'tool-call-delta', index: 0, id, name: 'subagent_fork', argumentsDelta: args }
  yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'subagent_fork', arguments: args } }
  yield { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } }
  yield { type: 'finish', reason: { kind: 'tool-calls' } }
}

/**
 * Whether a background task's settlement notice only repeats what the task already told its parent: DSH tells every
 * continuable child to send its result with send_message before it finishes (dsh-subagent withContinuableReturnGuidance)
 * and the notice carries the closing message again. QA 2026-10-30 (en): child 0d437f4b sent at 04:07:43 and settled
 * at 04:07:58; each started a turn, and the second said 「Same numbers as the comparison I already sent — nothing
 * changes」. A repeat is a notice that the task finished (not stopped, failed or cut short) after the parent got a
 * non-empty message from it (DSH's "Agent <id> sent a message: …", dsh-subagent agentMessageSource) since the parent last
 * gave it work (DSH's "started subagent <id>" or "message delivered to agent <id>"). Read from the parent's own log and
 * this claim: a settled child's session need not be live any more (DSH SessionStore.get finds live sessions only).
 * @param notice - a claimed message.
 * @param events - the parent's log.
 * @param claimed - every message this step claims, in order.
 */
export function repeatsResult(notice, events, claimed = []) {
  const source = notice?.source
  const child = source?.senderSessionId
  if (source?.kind !== 'subagent-settled' || !child) return false
  if (!textOf(notice.content).startsWith(`Background subagent ${child} finished `)) return false
  const gave = (e) => e.type === 'tool/result' && !e.data?.message?.isError && new RegExp(`^(started subagent|message delivered to agent) ${child}\\b`).test(textOf(e.data?.message?.content))
  const from = events.findLastIndex(gave)
  if (from < 0) return false
  const said = (m) => m?.source?.kind === 'agent-message' && m.source.senderSessionId === child && textOf(m.content).replace(/^Agent \S+ sent a message: /, '').trim().length > 0
  return events.slice(from + 1).some((e) => e.type === 'user/message' && said(e.data)) || claimed.slice(0, claimed.indexOf(notice)).some(said)
}

/** Whether this session is a thread's own background task still under the "never" policy DSH gave it at creation. */
export function refusesAsks(session, parentHeader) {
  if (session.header.origin !== 'subagent' || !parentHeader || parentHeader.origin === 'subagent') return false
  const policy = session.snapshotEvents().findLast((e) => e.type === 'approval/policy')
  return policy?.data?.policy === 'never' && policy.data.source === 'delegation'
}

/**
 * A seed with nothing waiting in its inbox. Whatever the parent had queued at the cut is the parent's: QA 2026-10-30, a
 * child seeded at seq 357 inherited 「顺便也比较一下去埃武拉的。」 (seq 353, next-turn), answered it in its first turn, and
 * only started its own prompt (which DSH appends after it) in the next one. The removal is DSH's own splice shape for a
 * dropped pending message (dsh-agent-loop Inbox.clear: next-step, then next-turn, `outcome: 'canceled'`), after the seed's
 * closers, in the inherited part of the child's log.
 */
export function withoutWaiting(seed) {
  const inbox = { 'next-turn': [], 'next-step': [] }
  for (const e of seed) if (e.type === 'agent/inbox/spliced' && inbox[e.data?.target]) inbox[e.data.target] = inbox[e.data.target].toSpliced(e.data.start, e.data.removedCount ?? 0, ...(e.data.inserted ?? []))
  const last = seed.at(-1)
  const out = [...seed]
  for (const target of ['next-step', 'next-turn']) {
    if (!inbox[target].length) continue
    out.push({ type: 'agent/inbox/spliced', seq: out.length, time: last?.time, data: { target, start: 0, removedCount: inbox[target].length, inserted: [], outcome: 'canceled' } })
  }
  return out
}

/**
 * Make the fork provider seed a hand-off's child with the moved turn so far. Other forks keep DSH's seed. No fork seed
 * carries the parent's waiting messages: DSH's own (completed turns only) had them too (QA 2026-10-30, en: the model's
 * own `subagent_fork` at 04:04:33 inherited 「Also compare the same for Evora.」 and answered it before its prompt).
 * @param provider - a registered subagent provider.
 * @param cuts - per parent session, the last event seq the child inherits (taken once).
 * @param buildForkSeed - dsh-session's fork-seed builder.
 */
export function carryTurn(provider, cuts, buildForkSeed, moved = new Set()) {
  if (!provider || provider.name !== 'fork' || typeof provider.prepareContinuable !== 'function' || provider.carriesTurn) return
  const own = provider.prepareContinuable.bind(provider)
  provider.prepareContinuable = (request) => {
    const cut = cuts.get(request.parent.session.id)
    if (cut === undefined) return own(request).then((p) => (p?.seed ? { ...p, seed: withoutWaiting(p.seed) } : p))
    cuts.delete(request.parent.session.id)
    if (request.sessionId) moved.add(request.sessionId)
    return Promise.resolve({ seed: withoutWaiting(buildForkSeed(request.parent.session.snapshotEvents(), cut)) })
  }
  provider.carriesTurn = true
}

/**
 * A top-level session (a thread) does not get `interrupt_agent`; a background task keeps its tools. `without` is left
 * out of every agent: `web_search` when the profile row says the provider cannot serve DeepSeek's native search
 *, so the model is never handed a tool that always fails.
 */
export function leaveTasksRunning(agent, without = []) {
  const deny = [...(agent.session.header.origin === 'subagent' ? [] : ['interrupt_agent']), ...without]
  if (!deny.length) return
  try { agent.ctx.tools.restrict({ deny }) } catch (e) { log(`could not leave ${deny.join(', ')} out of ${agent.session.id}: ${e?.message ?? e}`) }
}

/** The jobs a turn started: DSH's bash results "started background job <id>" and "…moved to background job <id>]". */
export function jobsOfTurn(turn) {
  const ids = new Set()
  for (const e of turn) {
    if (e.type !== 'tool/result' || e.data?.message?.isError) continue
    for (const m of textOf(e.data?.message?.content).matchAll(/(?:started|moved to) background job ([\w-]+)/g)) ids.add(m[1])
  }
  return [...ids]
}

/** The job a completion notice is about (dsh-tool-jobs fitCompletionNotice: "background job <id> (…) finished …"), or undefined. */
export const noticeJob = (m) => (m?.source?.kind === 'tool-jobs' ? /^background job ([\w-]+)\b/.exec(textOf(m.content))?.[1] : undefined)

/**
 * Let jobs follow moved work, on DSH's job registry (one per process, dsh-jobs-local). For a job in `handed`, the
 * background task it went to reads, waits on, stops and lists it as its owner (the thread) would; the thread itself gets
 * an error that says where it went. A thread's own wait (the bash tool's foreground wait, `job_output` with `wait`) ends
 * early, with the job still running, once `personWrote(sessionId)` says the person's message would move the work: the
 * bash tool then returns the job's id as on its timeout, and the step ends.
 * @param jobs - ctx.jobs.
 * @param handed - job id → { parent, child } session ids.
 * @param personWrote - whether this session's work would move now.
 * @param cut - gets the id of each job whose wait ended this way.
 */
export function followTheWork(jobs, handed, personWrote, cut = new Set(), pollMs = 250) {
  if (!jobs || jobs.followsTheWork) return
  const own = { read: jobs.read, get: jobs.get, kill: jobs.kill, wait: jobs.wait, remove: jobs.remove, list: jobs.list }
  const as = (id, caller) => {
    const h = handed.get(id)
    if (!h || caller === undefined) return caller
    if (caller === h.child) return h.parent
    if (caller === h.parent) throw new Error(`job ${id} moved with the work to background subagent ${h.child}; its output and its completion go to that subagent`)
    return caller
  }
  jobs.read = (id, caller) => own.read.call(jobs, id, as(id, caller))
  jobs.get = (id, caller) => own.get.call(jobs, id, as(id, caller))
  jobs.kill = (id, caller, reason) => own.kill.call(jobs, id, as(id, caller), reason)
  jobs.remove = (id, caller) => own.remove.call(jobs, id, as(id, caller))
  jobs.list = (caller) => {
    const mine = own.list.call(jobs, caller)
    const taken = [...handed].filter(([, h]) => h.child === caller && caller !== undefined)
    return taken.length ? [...mine, ...taken.flatMap(([id, h]) => own.list.call(jobs, h.parent).filter((j) => j.id === id))] : mine
  }
  jobs.wait = async (id, timeoutMs, caller, signal) => {
    const who = as(id, caller)
    // only a thread's own wait for a call (it carries the call's signal; the bash tool's internal stop-and-collect does not)
    if (signal === undefined || who !== caller || caller === undefined) return own.wait.call(jobs, id, timeoutMs, who, signal)
    const stop = new AbortController()
    const onAbort = () => stop.abort(signal.reason)
    if (signal.aborted) stop.abort(signal.reason); else signal.addEventListener('abort', onAbort, { once: true })
    let timer
    const wrote = new Promise((resolve) => { const tick = () => { if (personWrote(caller)) resolve(null); else timer = setTimeout(tick, pollMs) }; timer = setTimeout(tick, pollMs) })
    // the registry's wait, aborted when cut short: a waiter left behind would mark the settlement `awaited` and DSH would send no completion notice
    const waited = own.wait.call(jobs, id, timeoutMs, caller, stop.signal)
    try {
      const won = await Promise.race([waited.then((view) => ({ view })), wrote])
      if (won) return won.view
      waited.catch(() => {})
      stop.abort()
      cut.add(id)
      log(`the person wrote while ${caller} waited on job ${id}, so the wait ended and the job goes on in the background`)
      return own.get.call(jobs, id, caller)
    } finally { clearTimeout(timer); signal.removeEventListener('abort', onAbort) }
  }
  jobs.followsTheWork = true
}

export function apply(ctx, config) {
  const without = config?.webSearch === false ? ['web_search'] : []
  // Bug #20: a call that asks to leave the sandbox is refused in DSH's own pre-execute gate, before the tool can
  // request an approval. The deny reason is what the model sees and what it can explain; nobody is asked. DSH's
  // auto-review plugin denies the same way (dsh-experimental-auto-review, `tools/pre-execute`, { kind: 'deny', reason }).
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec?.arguments?.sandbox_permissions !== 'danger-full-access') return next()
    return { kind: 'deny', reason: `This computer does not allow tool "${exec.name}" to run outside its sandbox; nobody was asked.` }
  })
  for (const agent of ctx.agents.list()) leaveTasksRunning(agent, without)
  ctx.on('agent/created', ({ agent }) => leaveTasksRunning(agent, without))
  /** Sessions whose next agent-loop model call is the hand-off, with the step boundary it cuts at. */
  const pending = new Map()
  /** Parent sessions whose next fork is a hand-off: the last event its child inherits. */
  const cuts = new Map()
  /** Background tasks this plugin moved (the only ones that get "ask" back). */
  const moved = new Set()
  const asksAgain = (session) => {
    if (!moved.has(session.id)) return
    if (refusesAsks(session, session.header.parentSession ? ctx.sessions.get(session.header.parentSession)?.header : undefined)) session.append('approval/policy', { policy: 'ask' })
  }
  import(DSH_SESSION).then(({ buildForkSeed }) => {
    carryTurn(ctx.subagents.getProvider('fork'), cuts, buildForkSeed, moved)
    ctx.on('subagent/provider-added', (provider) => carryTurn(provider, cuts, buildForkSeed, moved))
  }, (e) => log(`dsh-session not found, a moved task starts over: ${e}`))
  /** Call ids of hand-offs, with their session: their turn ends once the background task has started. */
  const handoffCalls = new Map()
  /** Jobs that moved with a thread's work: job id → { parent, child }. */
  const handed = new Map()
  /** Background tasks the person stopped: the jobs they took are stopped too, and no notice wakes them. */
  const stopped = new Set()
  const workMoves = (sessionId) => {
    const agent = ctx.agents.get(sessionId)
    if (!agent || agent.session.header.origin === 'subagent') return false
    return handoffFor(agent, ctx.sessionProjections.stateOf(agent.session, 'inbox')?.['next-turn'] ?? [], 2) !== null
  }
  /** Jobs whose wait ended because the person wrote: the bash tool's result says so, not that the timeout passed. */
  const cutShort = new Set()
  followTheWork(ctx.jobs, handed, workMoves, cutShort)
  if (ctx.jobs) try { ctx.jobs.events.subscribe({ owners: 'scope' }, (e) => { if (e.type === 'removed') handed.delete(e.job.id) }) } catch (e) { log(`could not follow job removals: ${e?.message ?? e}`) }
  const interrupt = ctx.subagents.interrupt
  if (typeof interrupt === 'function' && !interrupt.stopsTakenJobs) {
    const stopsTakenJobs = function (childSessionId, ...rest) {
      const result = interrupt.call(this ?? ctx.subagents, childSessionId, ...rest)
      for (const [id, h] of handed) if (h.child === childSessionId) {
        stopped.add(childSessionId)
        try { ctx.jobs.kill(id, childSessionId, 'the person stopped the task') } catch (e) { log(`could not stop job ${id} of a stopped task: ${e?.message ?? e}`) }
      }
      return result
    }
    stopsTakenJobs.stopsTakenJobs = true
    ctx.subagents.interrupt = stopsTakenJobs
  }
  /**
   * A notice of a job that moved goes to the task that took it, none to a stopped task. It goes as the thread's message to
   * its task, the way `send_message` sends one (dsh-tool-subagent-control): that wakes a task that already finished its
   * turn, whose agent is no longer live (measured 2026-11-01: the task had settled when its job did).
   */
  const forward = (m, parent) => {
    const id = noticeJob(m), h = handed.get(id)
    if (!h || stopped.has(h.child)) return
    log(`job ${id} finished; its notice goes to background task ${h.child}, which took it`)
    ctx.subagents.sendMessage(parent, h.child, m.content, { signal: new AbortController().signal })
      .catch((e) => log(`could not pass job ${id}'s notice to ${h.child}: ${e?.message ?? e}`))
  }
  /** A turn that ends (completed, cancelled, failed) leaves nothing for the next one. */
  const forget = (sessionId) => {
    pending.delete(sessionId); cuts.delete(sessionId)
    for (const [call, owner] of handoffCalls) if (owner === sessionId) handoffCalls.delete(call)
  }
  ctx.on('agent/status', ({ agent, status }) => { if (status !== 'running') forget(agent.session.id) })
  ctx.on('agent/pre-step', async (payload, next) => {
    asksAgain(payload.agent.session)
    let decision = await next()
    if (decision.kind !== 'enter') return decision
    // A settlement notice that repeats a result the task already sent is not answered again (repeatsResult). Its queueing
    // still ends the task's status in the thread (src/fold.ts). Nothing else claimed: the turn ends before its first step.
    const session = payload.agent.session
    const claimed = payload.messages ?? []
    const events = session.header.origin === 'subagent' || !claimed.length ? [] : session.snapshotEvents()
    const repeats = events.length ? claimed.filter((m) => repeatsResult(m, events, claimed)) : []
    if (repeats.length) log(`a background task's settlement notice repeats the result it already sent, so it starts no turn: ${repeats.map((m) => m.source.senderSessionId).join(', ')}`)
    // a job that moved with the work: its notice is the task's, not the thread's
    const theirs = session.header.origin === 'subagent' ? [] : claimed.filter((m) => handed.get(noticeJob(m))?.parent === session.id)
    for (const m of theirs) forward(m, payload.agent)
    const drop = [...repeats, ...theirs]
    if (drop.length) decision = { ...decision, messages: drop.length === claimed.length && payload.step === 1 ? [] : decision.messages.filter((m) => !drop.includes(m)) }
    const queued = ctx.sessionProjections.stateOf(payload.agent.session, 'inbox')?.['next-turn'] ?? []
    const h = handoffFor(payload.agent, queued, payload.step)
    if (h) pending.set(payload.agent.session.id, { ...h, cut: payload.agent.session.seq - 1 }) // every event so far: the last step and its results are closed
    return decision
  })
  /** Requests this plugin already rewrote and sent through the stream again. */
  const rewritten = new WeakSet()
  ctx.on('llm/stream', (options, next) => {
    // only the agent loop's own call (it carries the session's tools and tool history), not a compaction or title request
    const loopCall = options.sessionId !== undefined && Array.isArray(options.tools) && options.toolHistory !== undefined
    const h = loopCall ? pending.get(options.sessionId) : undefined
    if (!h) {
      if (!loopCall || rewritten.has(options) || !Array.isArray(options.messages) || ctx.sessions.get(options.sessionId)?.header.origin === 'subagent') return next()
      const messages = withoutMovedSteps(options.messages)
      if (messages === options.messages) return next()
      // DSH freezes the request (measured 2026-11-01), so the call goes again as a copy through the whole stream; the
      // copy is marked so this hook passes it on
      const copy = Object.freeze({ ...options, messages })
      rewritten.add(copy)
      return ctx.llm.stream(copy)
    }
    pending.delete(options.sessionId)
    // the person's message must still be waiting: removed or answered meanwhile, the turn goes on as it was
    const session = ctx.sessions.get(options.sessionId)
    const queued = session ? ctx.sessionProjections.stateOf(session, 'inbox')?.['next-turn'] ?? [] : []
    if (!queued.some((m) => h.waiting.includes(m?.id))) return next()
    cuts.set(options.sessionId, h.cut)
    const id = `call_bg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
    handoffCalls.set(id, options.sessionId)
    return forkCall(id, h)
  })
  /** Call ids of hand-offs that started their task: their result says why the task moved. */
  const explained = new Set()
  // The conversation reads a hand-off's call as its own: without a reason it took it for a mistake and offered to
  // cancel the task (QA 2026-10-30, the Porto thread). Claude Code's Bash tool gives the reason in the result of a
  // command it moves for the same cause; these are its facts, said of the subagent (its wording, "it was not interrupted"
  // of a command, read as "you" here: the conversation went on with the moved work itself, QA 2026-10-30). DSH renders a tool's content from its value after
  // tools/execute, so the sentence goes on in tools/post-execute (an accept decision's content, as dsh-tools
  // documents it), after DSH's own line, which src/fold.ts reads.
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const downstream = await next()
    if (downstream.kind !== 'accept' || result.isError) { explained.delete(exec.callId); return downstream }
    const promoted = exec.name === 'bash' ? /\[still running after \d+ms; moved to background job ([\w-]+)\]/.exec(textOf(downstream.content ?? result.content)) : null
    if (promoted && cutShort.delete(promoted[1])) {
      const said = textOf(downstream.content ?? result.content).replace(promoted[0], `[still running when the person wrote; moved to background job ${promoted[1]}]`)
      return { ...downstream, content: [{ type: 'text', text: said }] }
    }
    if (SHOWN.has(exec.name) && exec.agent?.session.header.origin === 'subagent') {
      const said = textOf(downstream.content ?? result.content)
      return said.startsWith('Shown.') ? { ...downstream, content: [{ type: 'text', text: whereShown(said) }] } : downstream
    }
    if (!explained.delete(exec.callId)) return downstream
    return { ...downstream, content: [...(downstream.content ?? result.content), { type: 'text', text: `\n${MOVED}` }] }
  })
  ctx.on('tools/execute', async (exec, next) => {
    if (exec.agent) asksAgain(exec.agent.session) // before a task's first tool runs, even if its first step began before the hand-off returned
    const owner = handoffCalls.get(exec.callId)
    if (owner === undefined) {
      // A thread's turn that starts a background task itself ends with that step, as a hand-off does: QA 2026-10-30,
      // turn 18 started one and then sleep-waited (`sleep 60`, `sleep 110`, `list_agents`) for a result DSH's settlement
      // notice brings anyway, while the person's next message waited. Both tools are continuable in DSH's standard
      // preset (dsh-web-app presets/standard.patch.yml, `backgroundMode: continuable`), so they run in the background
      // unless the call says `run_in_background: false`; DSH carries the mark only on a successful start.
      if (BACKGROUND_STARTS.has(exec.name) && exec.agent && exec.agent.session.header.origin !== 'subagent' && exec.arguments?.run_in_background !== false) exec.concludeTurn()
      return next()
    }
    handoffCalls.delete(exec.callId)
    // Marked before the body runs, as DSH's structured-output tool does; DSH carries it only on a successful
    // result (dsh-tools createSuccessResult), so the turn ends only once the background task has started.
    exec.concludeTurn()
    const result = await next()
    const started = result && !result.isError ? /started subagent (\S+)/.exec(textOf(result.content))?.[1] : undefined
    if (started) {
      moved.add(started); explained.add(exec.callId)
      const session = ctx.sessions.get(owner)
      const running = new Set((ctx.jobs?.list(owner) ?? []).filter((j) => j.status === 'running' || j.status === 'stopping').map((j) => j.id))
      for (const id of session ? jobsOfTurn(currentTurn(session)) : []) if (running.has(id)) { handed.set(id, { parent: owner, child: started }); log(`job ${id} of ${owner} moved with the work to ${started}`) }
    }
    if (result?.isError) { // DSH's limit of live background tasks (maxActiveSubagents, 8), or any other failure: the turn goes on
      cuts.delete(owner)
      log(`a background task could not start for ${owner}, so the turn goes on: ${textOf(result.content).slice(0, 300)}`)
    }
    return result
  })
}
