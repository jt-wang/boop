// The bot's DSH plugin (src/dsh-plugin.js) against a stand-in for the hooks DSH gives it: the waterfalls
// agent/pre-step, llm/stream and tools/execute, and the agent/status event. The real thing runs in
// test/steer.e2e.test.ts; these pin the state rules the security review asked for (SECREVIEW.md).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildForkSeed } from '@deepseek-ai/dsh-session'
import { apply, carryTurn, followTheWork, jobsOfTurn, noticeJob } from '../src/dsh-plugin.js'

type Ev = { type: string; seq: number; data?: Record<string, unknown> }
function session(id: string, header: Record<string, unknown> = {}, events: Omit<Ev, 'seq'>[] = []) {
  const log: Ev[] = events.map((e, seq) => ({ ...e, seq }))
  return {
    id, header: { id, ...header }, get seq() { return log.length },
    snapshotEvents: () => [...log],
    requestHeader: () => ({ tools: [{ name: 'subagent_fork' }, { name: 'bash' }] }),
    append(type: string, data: Record<string, unknown>) { log.push({ type, data, seq: log.length }) },
    log,
  }
}
const person = (text: string) => ({ id: `m-${text}`, source: { kind: 'user' }, content: [{ type: 'text', text }] })
/** A thread mid-task: the person asked, the model ran a command, its result is in. */
const midTask = () => session('session-t', {}, [
  { type: 'turn/start', data: { turn: 1 } },
  { type: 'user/message', data: person('TASK') },
  { type: 'assistant/message', data: { message: { content: [{ type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}' }] } } },
  { type: 'tool/result', data: {} },
])

function host(opts: { restrict?: (f: { deny: string[] }) => void; config?: Record<string, unknown> } = {}) {
  const handlers = new Map<string, ((p: never, next: () => unknown) => unknown)[]>()
  const inboxes = new Map<string, unknown[]>()
  const sessions = new Map<string, ReturnType<typeof session>>()
  const ctx = {
    on(name: string, fn: (p: never, next: () => unknown) => unknown) { if (!handlers.has(name)) handlers.set(name, []); handlers.get(name)!.push(fn) },
    agents: { list: () => [] },
    subagents: { getProvider: () => undefined },
    sessionProjections: { stateOf: (s: { id: string }, key: string) => (key === 'inbox' ? { 'next-turn': inboxes.get(s.id) ?? [], 'next-step': [] } : undefined) },
    sessions: { get: (id: string) => sessions.get(id) },
  }
  apply(ctx, opts.config)
  const waterfall = (name: string, payload: unknown, last: () => unknown) => {
    const hs = handlers.get(name) ?? []
    const run = (i: number): unknown => (i < hs.length ? hs[i](payload as never, () => run(i + 1)) : last())
    return run(0)
  }
  /** A waterfall over two arguments (DSH's tools/post-execute: exec, result, next). */
  const waterfall2 = (name: string, a: unknown, b: unknown, last: () => unknown) => {
    const hs = handlers.get(name) ?? []
    const run = (i: number): unknown => (i < hs.length ? (hs[i] as unknown as (a: unknown, b: unknown, n: () => unknown) => unknown)(a, b, () => run(i + 1)) : last())
    return run(0)
  }
  const emit = (name: string, payload: unknown) => { for (const h of handlers.get(name) ?? []) h(payload as never, () => undefined) }
  const agent = (s: ReturnType<typeof session>) => { sessions.set(s.id, s); return { id: s.id, session: s, ctx: { tools: { restrict: opts.restrict ?? (() => {}) } } } }
  const preStep = (a: ReturnType<typeof agent>, step: number) => waterfall('agent/pre-step', { agent: a, messages: [], turn: 1, step }, () => Promise.resolve({ kind: 'enter', messages: [] }))
  const stream = async (s: { id: string }) => {
    const out = waterfall('llm/stream', { sessionId: s.id, tools: [], toolHistory: [] }, () => 'MODEL') as AsyncIterable<{ type: string; name?: string; argumentsDelta?: string }> | string
    if (typeof out === 'string') return out
    const chunks = []; for await (const c of out) chunks.push(c); return chunks
  }
  return { handlers, inboxes, agent, preStep, stream, waterfall, waterfall2, emit }
}
const forked = (out: unknown) => Array.isArray(out) && out.some((c: { name?: string }) => c.name === 'subagent_fork')

test('a message queued mid-task: the next model call is a subagent_fork with the person\'s words', async () => {
  const h = host(); const s = midTask(); const a = h.agent(s)
  h.inboxes.set(s.id, [person('WHAT-TIME')])
  await h.preStep(a, 2)
  const out = await h.stream(s)
  assert.ok(forked(out), JSON.stringify(out))
  assert.match(JSON.stringify(out), /TASK/)
})

test('a turn that ends (cancelled, or idle) between the step boundary and the model call does not fork in the next turn', async () => {
  const h = host(); const s = midTask(); const a = h.agent(s)
  h.inboxes.set(s.id, [person('WHAT-TIME')])
  await h.preStep(a, 2)
  h.emit('agent/status', { agent: a, status: 'idle' })
  assert.equal(await h.stream(s), 'MODEL')
})

test('no hand-off once the queued message is gone (removed or already answered)', async () => {
  const h = host(); const s = midTask(); const a = h.agent(s)
  h.inboxes.set(s.id, [person('WHAT-TIME')])
  await h.preStep(a, 2)
  h.inboxes.set(s.id, [])
  assert.equal(await h.stream(s), 'MODEL')
})

test('a failed restriction of interrupt_agent is logged, not swallowed', () => {
  const errors: string[] = []
  const orig = console.error; console.error = (m: unknown) => { errors.push(String(m)) }
  try {
    const h = host({ restrict: () => { throw new Error('unknown tool') } })
    h.emit('agent/created', { agent: h.agent(session('session-x')) })
  } finally { console.error = orig }
  assert.ok(errors.some((e) => /interrupt_agent/.test(e) && /unknown tool/.test(e)), JSON.stringify(errors))
})

test('a hand-off whose fork fails (DSH\'s limit of live background tasks) keeps the turn and logs why', async () => {
  const h = host(); const s = midTask(); const a = h.agent(s)
  h.inboxes.set(s.id, [person('WHAT-TIME')])
  await h.preStep(a, 2)
  const out = await h.stream(s) as { type: string; id?: string }[]
  const callId = out.find((c) => c.type === 'tool-call-delta')!.id!
  const errors: string[] = []
  const orig = console.error; console.error = (m: unknown) => { errors.push(String(m)) }
  try {
    // concludeTurn() is marked before the body runs; DSH carries it only on a successful result (dsh-tools
    // createSuccessResult), so an error result keeps the turn going (test/steer.e2e.test.ts measures it)
    const exec = { callId, agent: a, concludeTurn() {} }
    const result = await h.waterfall('tools/execute', exec, () => Promise.resolve({ isError: true, content: [{ type: 'text', text: 'Error: subagent delivery unavailable: ACTIVATION_LIMIT_REACHED' }] })) as { isError: boolean }
    assert.equal(result.isError, true, 'the tool result is DSH\'s own')
  } finally { console.error = orig }
  assert.ok(errors.some((e) => /could not start/.test(e) && /ACTIVATION_LIMIT_REACHED/.test(e)), JSON.stringify(errors))
})

// Bug #20: a call that asks to leave the sandbox is denied in DSH's own pre-execute gate, before any approval is
// requested. The reason is the model's whole view of it: this computer said no, and nobody was asked.
const DENIED = 'This computer does not allow tool "bash" to run outside its sandbox; nobody was asked.'

test('a danger-full-access escalation is denied before any approval, and nobody is asked', async () => {
  const h = host(); const a = h.agent(midTask())
  const exec = { name: 'bash', arguments: { command: 'touch /tmp/x', sandbox_permissions: 'danger-full-access', justification: 'TEST-ESCALATION' }, agent: a }
  const result = await h.waterfall('tools/pre-execute', exec, () => Promise.resolve({ kind: 'allow' }))
  assert.deepEqual(result, { kind: 'deny', reason: DENIED })
})

test('other calls are untouched: ordinary calls and workspace-write escalations still reach the approval path', async () => {
  const h = host(); const a = h.agent(midTask())
  for (const [name, args] of [
    ['bash', { command: 'ls' }],
    ['bash', { command: 'echo x', sandbox_permissions: 'workspace-write', justification: 'TEST-ESCALATION' }],
    ['write', { path: 'notes.md', content: 'x', sandbox_permissions: 'workspace-write', justification: 'TEST-ESCALATION' }],
  ] as const) {
    const result = await h.waterfall('tools/pre-execute', { name, arguments: args, agent: a }, () => Promise.resolve({ kind: 'allow' }))
    assert.deepEqual(result, { kind: 'allow' }, `${name} ${JSON.stringify(args)}`)
  }
})

// Approvals (SECREVIEW.md item 1): only a background task this plugin moved gets "ask" back; DSH's "never" stays on others.
const pinned = (id: string, parent: string) => session(id, { origin: 'subagent', parentSession: parent }, [{ type: 'approval/policy', data: { policy: 'never', source: 'delegation' } }])
const policyOf = (s: ReturnType<typeof session>) => s.log.findLast((e) => e.type === 'approval/policy')?.data?.policy
async function handOff(h: ReturnType<typeof host>, thread: ReturnType<typeof session>, childId: string) {
  const a = h.agent(thread)
  h.inboxes.set(thread.id, [person('WHAT-TIME')])
  await h.preStep(a, 2)
  const out = await h.stream(thread) as { type: string; id?: string }[]
  const callId = out.find((c) => c.type === 'tool-call-delta')!.id!
  await h.waterfall('tools/execute', { callId, agent: a, concludeTurn() {} }, () => Promise.resolve({ isError: false, content: [{ type: 'text', text: `started subagent ${childId}` }] }))
}

test('a background task the plugin moved asks again: its "never" becomes "ask" in its first step', async () => {
  const h = host(); const t = midTask()
  await handOff(h, t, 'task-1')
  const child = pinned('task-1', t.id)
  await h.preStep(h.agent(child), 1)
  assert.equal(policyOf(child), 'ask')
})

test('a subagent the model started itself keeps DSH\'s "never"', async () => {
  const h = host(); const t = midTask(); h.agent(t)
  const child = pinned('model-child', t.id)
  await h.preStep(h.agent(child), 1)
  assert.equal(policyOf(child), 'never')
})

test('a background task\'s own subagent keeps "never"', async () => {
  const h = host(); const t = midTask()
  await handOff(h, t, 'task-1')
  h.agent(pinned('task-1', t.id))
  const nested = pinned('nested', 'task-1')
  await h.preStep(h.agent(nested), 1)
  assert.equal(policyOf(nested), 'never')
})

// With a provider that does not serve DeepSeek's native search, web_search always failed. The
// profile row says so (src/home.ts) and every agent, a thread or a background task, goes without it.
test('webSearch: false leaves web_search out of every agent; a thread still loses interrupt_agent', () => {
  const denied: string[][] = []
  const h = host({ config: { webSearch: false }, restrict: (f) => { denied.push(f.deny) } })
  h.emit('agent/created', { agent: h.agent(session('session-top')) })
  h.emit('agent/created', { agent: h.agent(session('session-task', { origin: 'subagent' })) })
  assert.deepEqual(denied, [['interrupt_agent', 'web_search'], ['web_search']])
  const plain: string[][] = []
  const h2 = host({ restrict: (f) => { plain.push(f.deny) } })
  h2.emit('agent/created', { agent: h2.agent(session('session-top')) })
  h2.emit('agent/created', { agent: h2.agent(session('session-task', { origin: 'subagent' })) })
  assert.deepEqual(plain, [['interrupt_agent']])
})

// QA 2026-10-30 (iOS, zh): turn 17 was moved at 03:39:14 with its fork seed cut at seq 357, and seq 353 had put the
// person's next message (「顺便也比较一下去埃武拉的。」) into the conversation's next-turn inbox. The child inherited that
// inbox: its first turn answered the message the conversation also answered, and its own prompt waited behind it
// (DSH appended the prompt at index 1). The child starts with only its prompt; what waits is the conversation's.
test('a hand-off child does not inherit the messages waiting for the conversation\'s next turn', async () => {
  const waiting = person('EVORA-TOO')
  const parent = session('session-t', {}, [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'step/start', data: { turn: 1, step: 1 } },
    { type: 'user/message', data: person('TASK') },
    { type: 'assistant/message', data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'web_search', arguments: '{}' }] } } },
    { type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name: 'web_search', arguments: '{}' } },
    { type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, inserted: [waiting] } },
    { type: 'tool/result', data: { turn: 1, step: 1, message: { role: 'tool', source: { kind: 'tool', callId: 'c1' }, toolCallId: 'c1', content: [{ type: 'text', text: 'RESULTS' }] } } },
    { type: 'step/end', data: { turn: 1, step: 1 } },
  ])
  const provider = { name: 'fork', prepareContinuable: (_r: unknown) => Promise.resolve({}) }
  carryTurn(provider, new Map([[parent.id, parent.seq - 1]]), buildForkSeed)
  const { seed } = await provider.prepareContinuable({ parent: { session: parent }, sessionId: 'child' }) as { seed: Ev[] }
  assert.deepEqual(seed.map((e) => e.seq), seed.map((_, i) => i), 'the seed stays contiguous from seq 0')
  // DSH's inbox projection (dsh-agent-loop inboxProjectionDefinition): each splice is toSpliced(start, removedCount ?? 0, ...inserted)
  const inbox: Record<string, unknown[]> = { 'next-turn': [], 'next-step': [] }
  for (const e of seed) if (e.type === 'agent/inbox/spliced') { const d = e.data as { target: string; start: number; removedCount?: number; inserted: unknown[] }; inbox[d.target] = inbox[d.target].toSpliced(d.start, d.removedCount ?? 0, ...d.inserted) }
  assert.deepEqual(inbox, { 'next-turn': [], 'next-step': [] }, 'nothing waits in the child: its first turn is its own prompt')
  assert.ok(seed.some((e) => e.type === 'tool/result'), 'the steps done so far are still carried')
  assert.equal(parent.log.filter((e) => e.type === 'agent/inbox/spliced').length, 1, 'the conversation keeps its waiting message')
})

// QA 2026-10-30 (iOS, en): DSH's own fork seed (completed turns only) has the same gap. The model's own `subagent_fork`
// at 04:04:33 seeded 9aacc281 through seq 355, where seq 345 had queued 「Also compare the same for Evora.」; the child
// answered that first and only started its own prompt at 04:08:09.
test('a fork the model starts itself does not inherit the conversation\'s waiting messages either', async () => {
  const inherited: Ev[] = [
    { type: 'turn/start', seq: 0, data: { turn: 1 } },
    { type: 'agent/inbox/spliced', seq: 1, data: { target: 'next-turn', start: 0, inserted: [person('EVORA-TOO')] } },
    { type: 'turn/end', seq: 2, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  const provider = { name: 'fork', prepareContinuable: (_r: unknown) => Promise.resolve({ seed: inherited }) }
  carryTurn(provider, new Map(), buildForkSeed)
  const { seed } = await provider.prepareContinuable({ parent: { session: session('session-t') }, sessionId: 'child' }) as { seed: Ev[] }
  assert.deepEqual(seed.slice(0, 3), inherited, 'DSH\'s seed is kept')
  assert.deepEqual(seed.slice(3).map((e) => [e.type, e.seq, e.data]), [['agent/inbox/spliced', 3, { target: 'next-turn', start: 0, removedCount: 1, inserted: [], outcome: 'canceled' }]])
  const empty = { name: 'fork', prepareContinuable: (_r: unknown) => Promise.resolve({}) }
  carryTurn(empty, new Map(), buildForkSeed)
  assert.deepEqual(await empty.prepareContinuable({ parent: { session: session('session-t') } }), {}, 'no seed (no completed turn yet) stays no seed')
})

// QA 2026-10-30 (iOS, en): the opening (the bot's own first-open prompt, ⟦bot⟧ …) was still reading USER.md when the
// person wrote 「Hi. From now on your name is Momo.」 at 03:51:49, so it was moved to a background task. Its greeting then
// came back as a send_message and a settlement notice, and each started a turn that posted filler between the person's
// question and its answer (「I'm Momo now — and ready when you are…」, 「I'm just waiting on your answer…」).
test('a turn answering one of the bot\'s own prompts is not moved; the person\'s message comes right after it', async () => {
  const h = host()
  const s = session('session-t', {}, [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'user/message', data: person('⟦bot⟧ This is the first time the person opens the app.') },
    { type: 'assistant/message', data: { message: { content: [{ type: 'tool-call', id: 'c1', name: 'read', arguments: '{}' }] } } },
    { type: 'tool/result', data: {} },
  ])
  const a = h.agent(s)
  h.inboxes.set(s.id, [person('Hi. From now on your name is Momo.')])
  await h.preStep(a, 2)
  assert.equal(await h.stream(s), 'MODEL')
})

// QA 2026-10-30: turn 18 started a background task itself (`subagent`, "started subagent 28d2813b…") and then only
// waited (bash `sleep 60`/`sleep 110`, `list_agents`). When 「现在里斯本几点？一句话。」 came in at 03:44:32 the plugin
// moved that waiting turn as well: a third task for the Evora request it had already started.
const startedTask = () => session('session-t', {}, [
  { type: 'turn/start', data: { turn: 1 } },
  { type: 'user/message', data: person('EVORA-TOO') },
  { type: 'assistant/message', data: { message: { content: [{ type: 'tool-call', id: 'c1', name: 'subagent', arguments: '{}' }] } } },
  { type: 'tool/result', data: { message: { content: [{ type: 'text', text: 'started subagent child-1' }] } } },
  { type: 'assistant/message', data: { message: { content: [{ type: 'tool-call', id: 'c2', name: 'bash', arguments: '{"command":"sleep 110"}' }] } } },
  { type: 'tool/result', data: {} },
])
test('a turn that already started a background task is not moved again', async () => {
  const h = host(); const s = startedTask(); const a = h.agent(s)
  h.inboxes.set(s.id, [person('WHAT-TIME')])
  await h.preStep(a, 3)
  assert.equal(await h.stream(s), 'MODEL')
})

// The same turn sleep-waited for minutes for a result DSH's settlement notice brings anyway. A thread's turn that starts
// a background task ends with that step, as a hand-off does; the result comes back in a turn of its own.
test('a thread\'s turn that starts a background task ends after that step; a foreground run or a task\'s own subagent does not', async () => {
  const h = host()
  const run = async (s: ReturnType<typeof session>, name: string, args: Record<string, unknown>) => {
    let concluded = false
    await h.waterfall('tools/execute', { callId: `c-${name}`, name, arguments: args, agent: h.agent(s), concludeTurn() { concluded = true } }, () => Promise.resolve({ isError: false, content: [{ type: 'text', text: 'started subagent child-1' }] }))
    return concluded
  }
  assert.equal(await run(midTask(), 'subagent', { description: 'x', prompt: 'x' }), true, 'subagent')
  assert.equal(await run(midTask(), 'subagent_fork', { description: 'x', prompt: 'x' }), true, 'subagent_fork')
  assert.equal(await run(midTask(), 'subagent', { description: 'x', prompt: 'x', run_in_background: false }), false, 'a foreground run returns its result in the turn')
  assert.equal(await run(session('task-1', { origin: 'subagent', parentSession: 'session-t' }), 'subagent', { description: 'x', prompt: 'x' }), false, 'a background task\'s own subagent')
  assert.equal(await run(midTask(), 'bash', { command: 'ls' }), false, 'other tools')
})

// QA 2026-10-30 (iOS, en): DSH tells a continuable child to send its result with send_message before it finishes
// (dsh-subagent withContinuableReturnGuidance), and the settlement notice repeats it as the closing message. Child
// 0d437f4b did both (send_message at 04:07:43, settled 04:07:58), and each started a turn of the conversation: turn 21
// relayed the result, turn 22 said 「Same numbers as the comparison I already sent — nothing changes」.
const settled = (child: string, how = 'finished and will do no further work unless you send it more.') => ({ id: `n-${child}`, role: 'user', source: { kind: 'subagent-settled', form: 'notice', senderSessionId: child }, content: [{ type: 'text', text: `Background subagent ${child} ${how}` }, { type: 'text', text: 'Its closing message:' }, { type: 'text', text: 'RESULT' }] })
/** DSH's message from a child to its parent (dsh-subagent agentMessageSource). */
const sent = (child: string, text: string) => ({ id: `s-${child}`, role: 'user', source: { kind: 'agent-message', form: 'relay', senderSessionId: child }, content: [{ type: 'text', text: `Agent ${child} sent a message: ` }, { type: 'text', text }] })
const gave = (text: string) => [
  { type: 'assistant/message', data: { message: { content: [{ type: 'tool-call', id: `g-${text}`, name: 'subagent_fork', arguments: '{}' }] } } },
  { type: 'tool/result', data: { message: { source: { kind: 'tool', callId: `g-${text}` }, toolCallId: `g-${text}`, isError: false, content: [{ type: 'text', text }] } } },
]
/** The conversation's log: it started `child`, then got these messages and results. */
const thread = (child: string, after: Omit<Ev, 'seq'>[]) => session('session-t', {}, [
  { type: 'turn/start', data: { turn: 1 } }, { type: 'user/message', data: person('TASK') }, ...gave(`started subagent ${child}`), { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ...after,
])
const said = (m: unknown) => [{ type: 'turn/start', data: { turn: 2 } }, { type: 'user/message', data: m as Record<string, unknown> }, { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } }]
const claim = async (h: ReturnType<typeof host>, t: ReturnType<typeof session>, claimed: unknown[], step = 1) =>
  (await h.waterfall('agent/pre-step', { agent: h.agent(t), messages: claimed, turn: 3, step }, () => Promise.resolve({ kind: 'enter', messages: [...claimed, { id: 'runtime-context' }] })) as { messages: { id: string }[] }).messages.map((m) => m.id)

test('a settlement notice whose result the task already sent is not a turn of its own', async () => {
  const h = host()
  const result = 'Lisbon → Sintra, three ways: …'
  assert.deepEqual(await claim(h, thread('task-1', said(sent('task-1', result))), [settled('task-1')]), [], 'nothing to answer: the turn ends before its first step')
  assert.deepEqual(await claim(h, thread('task-1', said(sent('task-1', result))), [settled('task-1'), person('WHAT-TIME')]), ['m-WHAT-TIME', 'runtime-context'], 'with something else to answer, only the notice goes')
  assert.deepEqual(await claim(h, thread('task-1', said(sent('task-1', result))), [settled('task-1')], 3), ['runtime-context'], 'mid-turn too')
  assert.deepEqual(await claim(h, thread('task-1', []), [sent('task-1', result), settled('task-1')]), ['s-task-1', 'runtime-context'], 'the message and the notice in one claim: the message is answered once')
})

test('a settlement notice still comes when the task sent nothing, sent it before it was given more, sent it empty, or did not finish', async () => {
  const h = host()
  assert.deepEqual(await claim(h, thread('task-1', []), [settled('task-1')]), ['n-task-1', 'runtime-context'], 'nothing sent: the notice is the result')
  assert.deepEqual(await claim(h, thread('task-1', said(sent('task-1', '  '))), [settled('task-1')]), ['n-task-1', 'runtime-context'], 'an empty message')
  assert.deepEqual(await claim(h, thread('task-1', said(sent('task-2', 'OTHER'))), [settled('task-1')]), ['n-task-1', 'runtime-context'], 'another task\'s message')
  assert.deepEqual(await claim(h, thread('task-1', [...said(sent('task-1', 'FIRST')), ...gave('message delivered to agent task-1')]), [settled('task-1')]), ['n-task-1', 'runtime-context'], 'the conversation gave it more after its message')
  assert.deepEqual(await claim(h, thread('task-1', said(sent('task-1', 'PARTIAL'))), [settled('task-1', 'was stopped before it finished.')]), ['n-task-1', 'runtime-context'], 'a stop or a failure is news')
  assert.deepEqual(await claim(h, session('session-t'), [settled('task-1')]), ['n-task-1', 'runtime-context'], 'a task this thread never started')
})

// QA 2026-10-30 (Porto thread): the conversation read the hand-off as a call it made by mistake and offered to cancel
// the task. Claude Code's Bash tool says why in the result of a command it moved for the same reason ("Command was
// moved to the background (ID: …) so that a message that arrived while it was running can reach you; it was not
// interrupted."); the hand-off's result says the same, after DSH's own line, which src/fold.ts reads.
test('a hand-off\'s result says the task was moved so the person\'s message could reach the conversation; a fork the model makes keeps DSH\'s', async () => {
  const h = host(); const t = midTask(); const a = h.agent(t)
  h.inboxes.set(t.id, [person('WHAT-TIME')])
  await h.preStep(a, 2)
  const out = await h.stream(t) as { type: string; id?: string }[]
  const callId = out.find((c) => c.type === 'tool-call-delta')!.id!
  const dsh = () => Promise.resolve({ isError: false, content: [{ type: 'text', text: 'started subagent task-1' }] })
  // DSH runs tools/execute, renders the content from the tool's value, then tools/post-execute (dsh-tools)
  const post = async (exec: object) => { const r = await h.waterfall('tools/execute', exec, dsh) as { content: unknown[] }; return h.waterfall2('tools/post-execute', exec, r, () => Promise.resolve({ kind: 'accept' })) as Promise<{ kind: string; content?: { text: string }[] }> }
  const moved = await post({ callId, agent: a, concludeTurn() {} })
  const text = (moved.content ?? []).map((c) => c.text).join('')
  assert.match(text, /^started subagent task-1\n/)
  assert.match(text, /the work moved to the background: it goes on in that subagent from where you were/)
  const own = await post({ callId: 'c-own', name: 'subagent_fork', arguments: {}, agent: a, concludeTurn() {} })
  assert.deepEqual(own, { kind: 'accept' }, 'a fork the model makes keeps DSH\'s result')
})

// A card or interface a background task shows appears in the person's conversation, and a tap answers there
// (src/thread.ts); the bot's tools say "their answer will arrive as their next message; wait for it", which is true
// only for the conversation. A task's result says where the answer goes; the conversation's stays as it is.
test('a background task\'s show and ui results say the answer goes to the conversation; the conversation\'s stay', async () => {
  const h = host(); const t = midTask(); const thread = h.agent(t)
  const task = h.agent(session('task-1', { origin: 'subagent', parentSession: t.id }))
  const run = async (agent: unknown, name: string, said: string) => {
    const exec = { callId: `c-${name}`, name, arguments: {}, agent, concludeTurn() {} }
    const r = await h.waterfall('tools/execute', exec, () => Promise.resolve({ isError: false, content: [{ type: 'text', text: said }] })) as { content: unknown[] }
    return h.waterfall2('tools/post-execute', exec, r, () => Promise.resolve({ kind: 'accept' })) as Promise<{ kind: string; content?: { text: string }[] }>
  }
  const card = await run(task, 'mcp__bot__show', 'Shown. Their answer will arrive as their next message; wait for it.')
  assert.equal(card.content?.map((c) => c.text).join(''), 'Shown in the person\'s conversation. Their answer goes to the conversation, not to you.')
  const ui = await run(task, 'mcp__bot__ui', 'Shown. module=m1 — it opens on their phone when they tap it; their result arrives as their next message (a line starting with "⟦bot⟧ module" above it is the marker, ignore it). Wait for it.')
  assert.equal(ui.content?.map((c) => c.text).join(''), 'Shown in the person\'s conversation. module=m1 — it opens on their phone when they tap it; their result goes to the conversation, not to you.')
  const plain = await run(task, 'mcp__bot__show', 'Shown.')
  assert.equal(plain.content?.map((c) => c.text).join(''), 'Shown in the person\'s conversation.')
  assert.deepEqual(await run(thread, 'mcp__bot__show', 'Shown. Their answer will arrive as their next message; wait for it.'), { kind: 'accept' })
})


// A command still running when the person writes moves with the work (src/dsh-plugin.js followTheWork).
function registry() {
  const jobs = new Map([['bash-1', { id: 'bash-1', owner: 'thread', status: 'running' }], ['bash-2', { id: 'bash-2', owner: 'other', status: 'running' }]])
  const expect = (id: string, caller?: string) => { const j = jobs.get(id)!; if (j.owner !== caller) throw new Error(`job ${id} belongs to another session`); return j }
  return {
    jobs,
    read(id: string, caller?: string) { return { job: expect(id, caller), chunks: [] } },
    get(id: string, caller?: string) { return { ...expect(id, caller) } },
    kill(id: string, caller?: string) { expect(id, caller).status = 'killed'; return 'requested' },
    remove(id: string, caller?: string) { expect(id, caller) },
    list(caller?: string) { return [...jobs.values()].filter((j) => j.owner === caller) },
    wait(id: string, ms: number, caller?: string, signal?: AbortSignal) {
      expect(id, caller)
      return new Promise((resolve, reject) => { const t = setTimeout(() => resolve({ ...jobs.get(id) }), ms); signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('wait aborted')) }) })
    },
  }
}

test('a job that moved with the work is the task\'s: it reads, stops and lists it; the thread is told where it went', () => {
  const r = registry(), handed = new Map([['bash-1', { parent: 'thread', child: 'task' }]])
  followTheWork(r, handed, () => false)
  assert.equal(r.read('bash-1', 'task').job.id, 'bash-1')
  assert.deepEqual(r.list('task').map((j: { id: string }) => j.id), ['bash-1'])
  assert.throws(() => r.read('bash-1', 'thread'), /moved with the work to background subagent task/)
  assert.throws(() => r.read('bash-2', 'task'), /belongs to another session/, 'only the job it took')
  r.kill('bash-1', 'task')
  assert.equal(r.jobs.get('bash-1')!.status, 'killed')
})

test('a thread\'s wait on its job ends once the person\'s message would move the work, and the job keeps running', async () => {
  const r = registry(), cut = new Set<string>()
  let wrote = false
  followTheWork(r, new Map(), (id: string) => id === 'thread' && wrote, cut, 10)
  const started = Date.now()
  const waiting = r.wait('bash-1', 60_000, 'thread', new AbortController().signal)
  setTimeout(() => { wrote = true }, 50)
  const view = await waiting as { status: string }
  assert.equal(view.status, 'running')
  assert.ok(Date.now() - started < 2000, 'it did not wait for the timeout')
  assert.ok(cut.has('bash-1'))
  // a wait without the call's signal (the bash tool collecting a job it stopped) is left as it is
  wrote = true
  const t = Date.now(); await r.wait('bash-1', 100, 'thread'); assert.ok(Date.now() - t >= 90)
})

test('the jobs a turn started, and the job a completion notice is about', () => {
  const result = (text: string, isError = false) => ({ type: 'tool/result', data: { message: { isError, content: [{ type: 'text', text }] } } })
  assert.deepEqual(jobsOfTurn([result('started background job bash-3'), result('out\n[still running after 60000ms; moved to background job bash-4]\nThe command keeps running'), result('started background job bash-9', true)]), ['bash-3', 'bash-4'])
  assert.equal(noticeJob({ source: { kind: 'tool-jobs' }, content: [{ type: 'text', text: 'background job bash-4 (bash: sleep 9) finished [status: completed]. Read its output with job_output.' }] }), 'bash-4')
  assert.equal(noticeJob({ source: { kind: 'user' }, content: [{ type: 'text', text: 'background job bash-4 finished' }] }), undefined)
})

// A message sent while a turn goes on after a restart moves the work like any other: the going-on turn opens with the
// bot's own prompt (src/recover.ts), and the work is what the person asked in the turn the restart cut off.
test('a message sent while a turn goes on after a restart moves the work, with the person\'s words from the cut-off turn', async () => {
  const { handoffFor } = await import('../src/dsh-plugin.js')
  const { RECOVER } = await import('../src/recover.ts')
  const ev = (type: string, data: Record<string, unknown> = {}) => ({ type, data })
  const said = (text: string) => ev('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text }] })
  const events = [
    ev('turn/start'), said('compare three routes'), ev('assistant/message', { message: { content: [{ type: 'tool-call', name: 'bash' }] } }), ev('turn/end', { reason: { kind: 'interrupted' } }),
    ev('turn/start'), said(RECOVER), ev('assistant/message', { message: { content: [{ type: 'tool-call', name: 'bash' }] } }),
  ]
  const agent = { session: { header: { origin: 'user' }, requestHeader: () => ({ tools: [{ name: 'subagent_fork' }] }), snapshotEvents: () => events } }
  const h = handoffFor(agent, [{ id: 'm1', source: { kind: 'user' } }], 3)
  assert.equal(h?.prompt, 'compare three routes')
})

test('the conversation\'s request leaves out the steps a hand-off moved, keeping the hand-off and everything else', async () => {
  const { withoutMovedSteps } = await import('../src/dsh-plugin.js')
  const user = (id: string) => ({ id, role: 'user', content: [{ type: 'text', text: id }] })
  const said = (id: string) => ({ id, role: 'assistant', content: [{ type: 'text', text: id }] })
  const call = (id: string, callId: string, name: string) => ({ id, role: 'assistant', content: [{ type: 'tool-call', id: callId, name, arguments: {} }] })
  const result = (id: string, callId: string) => ({ id, role: 'tool', toolCallId: callId, content: [{ type: 'text', text: id }] })
  const messages = [
    { id: 'sys', role: 'system', content: [] }, user('hi'), said('hello'),
    user('fork it'), call('a0', 'c0', 'subagent'), result('r0', 'c0'), // a turn that started a task itself
    user('compare routes'), call('a1', 'c1', 'web_search'), result('r1', 'c1'), user('runtime context'), call('a2', 'c2', 'bash'), result('r2', 'c2'),
    call('a3', 'call_bg_x', 'subagent_fork'), { ...result('r3', 'call_bg_x'), content: [{ type: 'text', text: 'started subagent t-1' }] }, user('is it raining?'),
  ]
  assert.deepEqual(withoutMovedSteps(messages).map((m: { id: string }) => m.id), ['sys', 'hi', 'hello', 'fork it', 'a0', 'r0', 'a3', 'r3', 'is it raining?'])
  const plain = [user('a'), call('b', 'c', 'bash'), result('d', 'c')]
  assert.equal(withoutMovedSteps(plain), plain, 'nothing moved: the same request')
  // a hand-off DSH refused (no more live tasks): the turn goes on by itself, so it keeps its ask and its steps
  const refused = [user('compare'), call('b', 'c', 'bash'), result('d', 'c'), call('e', 'call_bg_y', 'subagent_fork'), { ...result('f', 'call_bg_y'), content: [{ type: 'text', text: 'Error: too many active subagents' }] }]
  assert.equal(withoutMovedSteps(refused), refused, 'a refused hand-off moved nothing')
})

// Ramen with the real model, 2026-11-01: with only the steps hidden, 1 run in 3 still answered the moved ask itself
// before the new question (13 searches, the answer 171 s late), because the ask stood in its history unanswered.
// While the task has not reported back, the ask goes too; the fork call's prompt still carries it.
test('withoutMovedSteps: while the moved task runs, its ask is out of the conversation\'s request too; back once it reports', async () => {
  const { withoutMovedSteps } = await import('../src/dsh-plugin.js')
  const user = (id: string, text = id) => ({ id, role: 'user', content: [{ type: 'text', text }] })
  const call = (id: string, callId: string, name: string) => ({ id, role: 'assistant', content: [{ type: 'tool-call', id: callId, name, arguments: {} }] })
  const result = (id: string, callId: string, text = id) => ({ id, role: 'tool', toolCallId: callId, content: [{ type: 'text', text }] })
  const said = (id: string) => ({ id, role: 'assistant', content: [{ type: 'text', text: id }] })
  const moved = [
    user('hi'), said('hello'),
    user('compare ramen'), user('runtime context'), call('a1', 'c1', 'web_search'), result('r1', 'c1'),
    call('a2', 'call_bg_x', 'subagent_fork'), result('r2', 'call_bg_x', 'started subagent child-7 (continuable)'), user('is it raining?'),
  ]
  assert.deepEqual(withoutMovedSteps(moved).map((m: { id: string }) => m.id), ['hi', 'hello', 'a2', 'r2', 'is it raining?'])
  const reported = [...moved, said('no rain'), user('n', 'Agent child-7 sent a message: the table')]
  assert.deepEqual(withoutMovedSteps(reported).map((m: { id: string }) => m.id), ['hi', 'hello', 'compare ramen', 'runtime context', 'a2', 'r2', 'is it raining?', 'no rain', 'n'])
})
