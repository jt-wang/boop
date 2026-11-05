import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { followThread, type ThreadFrame } from '../src/thread.ts'
import type { Harness, FollowFrame } from '../src/harness.ts'

// A fake harness whose follow() lets the test push frames.
function fakeHarness(sessions: { sessionId: string; running: boolean }[] = []) {
  let push: ((f: FollowFrame) => void) | null = null
  const h = {
    kind: 'fake', events: { on() {}, clientId: 'c' },
    async createSession() { return { sessionId: 's' } }, async listSessions() { return sessions.map((x) => ({ updatedAt: 1, blank: false, ...x })) }, async prompt() {}, async answer() {}, async cancel() { return true }, async rpc() { return {} as never }, async close() {},
    async follow(_id: string, onFrame: (f: FollowFrame) => void) { push = onFrame; return () => { push = null } },
  } as unknown as Harness
  return { h, push: (f: FollowFrame) => push!(f) }
}

test('harness frames become bot thread frames: snapshot, deltas, rows, status', async () => {
  const { h, push } = fakeHarness()
  const out: ThreadFrame[] = []
  await followThread(h, 'main', (f) => out.push(f))
  push({ type: 'snapshot', header: { cwd: '/w' }, records: [{ type: 'event', event: { type: 'user/message', time: 1, data: { id: 'u1', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } } } }], projections: { values: { title: 'Hi' } } })
  push({ type: 'assistant-stream', frame: { type: 'start' } })
  push({ type: 'assistant-stream', frame: { type: 'chunk', chunk: { type: 'text-delta', text: 'Hel' } } })
  push({ type: 'assistant-stream', frame: { type: 'chunk', chunk: { type: 'text-delta', text: 'lo' } } })
  push({ type: 'event', event: { type: 'assistant/message', time: 2, data: { message: { role: 'assistant', content: [{ type: 'text', text: 'Hello' }, { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{"command":"ls"}' }] } } } })
  push({ type: 'event', event: { type: 'turn/end', data: { reason: { kind: 'completed' } } } })
  const types = out.map((f) => f.type)
  assert.equal(types[0], 'snapshot')
  const snap = out[0] as Extract<ThreadFrame, { type: 'snapshot' }>
  assert.equal(snap.title, 'Hi'); assert.equal(snap.rows[0].kind, 'you')
  // the first delta creates the streaming row (sent as a row), the second is a pure delta
  assert.ok(types.includes('delta'), types.join(','))
  const delta = out.find((f) => f.type === 'delta') as Extract<ThreadFrame, { type: 'delta' }>
  assert.equal(delta.text, 'lo')
  // the committed message replaces the streaming row in place (same id, a rows frame): no second snapshot,
  // and a client that merges rows by id ends with one reply (2026-10-27: it got the prefix row and the full one)
  assert.equal(types.filter((t) => t === 'snapshot').length, 1, types.join(','))
  const byId = new Map<string, { kind: string; text?: string }>()
  for (const f of out) {
    if (f.type === 'snapshot' || f.type === 'rows') for (const r of f.rows) byId.set(r.id, { ...r } as { kind: string; text?: string })
    else if (f.type === 'delta') { const r = byId.get(f.rowId); if (r) r.text = (r.text ?? '') + f.text }
  }
  assert.deepEqual([...byId.values()].map((r) => r.kind), ['you', 'them', 'step'])
  assert.equal([...byId.values()][1].text, 'Hello')
  const status = out.filter((f) => f.type === 'status').at(-1) as Extract<ThreadFrame, { type: 'status' }>
  assert.equal(status.running, false)
})

test('frames before the snapshot are ignored and end is reported', async () => {
  const { h, push } = fakeHarness()
  const out: ThreadFrame[] = []
  await followThread(h, 'main', (f) => out.push(f))
  push({ type: 'event', event: { type: 'turn/end', data: {} } })
  assert.equal(out.length, 0)
})

// The owner's turn 7 (2026-10-27, Android, hosted): 39 tool calls and three automatic compactions in ~5 minutes.
// The app showed "做了 20 件事 · 137 秒" and 在线 at the third compaction while the turn went on. Real event order,
// types, seqs and times; texts and arguments replaced (test/fixtures/compaction-turn.json).
type Ev = { type: string; seq: number; time: number; data: Record<string, unknown> }
const turn7 = JSON.parse(readFileSync(new URL('./fixtures/compaction-turn.json', import.meta.url), 'utf8')) as Ev[]
const upTo = (seq: number) => turn7.filter((e) => e.seq <= seq).map((event) => ({ type: 'event', event }))
const statuses = (out: ThreadFrame[]) => out.filter((f) => f.type === 'status' || f.type === 'snapshot').map((f) => (f as { running: boolean }).running)

test('a re-follow during the third compaction (no assistant attempt in flight) still says the turn is working', async () => {
  const { h, push } = fakeHarness()
  const out: ThreadFrame[] = []
  await followThread(h, 'main', (f) => out.push(f), 'zh')
  // what DSH answers a follow with at seq 284 (compaction/start): the records so far, an assistant stream with no active attempt
  push({ type: 'snapshot', header: { cwd: '/w' }, records: upTo(284), projections: { values: { title: '' } }, assistantStream: { revision: 80 } })
  const snap = out[0] as Extract<ThreadFrame, { type: 'snapshot' }>
  assert.equal(snap.running, true, 'the turn has started and not ended')
  assert.ok(snap.statusText, 'and says it is working')
  for (const e of turn7.filter((x) => x.seq > 284)) push({ type: 'event', event: e })
  assert.ok(statuses(out).every(Boolean), `a status said not running: ${JSON.stringify(statuses(out))}`)
})

test('a live follow through all three compactions never reports the turn finished; turn/end does', async () => {
  const { h, push } = fakeHarness()
  const out: ThreadFrame[] = []
  await followThread(h, 'main', (f) => out.push(f), 'zh')
  push({ type: 'snapshot', header: { cwd: '/w' }, records: upTo(167), projections: { values: { title: '' } }, assistantStream: { revision: 40 } })
  for (const e of turn7.filter((x) => x.seq > 167)) push({ type: 'event', event: e })
  const after = statuses(out).slice(1)
  assert.ok(after.length > 0 && after.every(Boolean), JSON.stringify(after))
  push({ type: 'event', event: { type: 'turn/end', seq: 385, time: 0, data: { turn: 7, reason: { kind: 'completed' } } } })
  assert.equal(statuses(out).at(-1), false)
})

test('a re-follow whose page starts mid-turn (turn/start cut off) asks the harness whether the session is running', async () => {
  const { h, push } = fakeHarness([{ sessionId: 'main', running: true }])
  const out: ThreadFrame[] = []
  await followThread(h, 'main', (f) => out.push(f), 'zh')
  push({ type: 'snapshot', header: { cwd: '/w' }, records: upTo(284).filter((r) => r.event.seq > 200), projections: { values: { title: '' } }, assistantStream: { revision: 80 } })
  for (let i = 0; i < 20 && statuses(out).at(-1) !== true; i++) await new Promise((r) => setTimeout(r, 10))
  assert.equal(statuses(out).at(-1), true, JSON.stringify(out.map((f) => f.type)))
})

// A fake harness with several sessions: follow() keeps one pusher per session, backgroundTasks() lists the tasks.
function treeHarness(tasks: { sessionId: string; threadId: string; parentId: string; running: boolean }[]) {
  const pushers = new Map<string, (f: FollowFrame) => void>()
  const h = {
    kind: 'fake', events: { on() {}, clientId: 'c' },
    async createSession() { return { sessionId: 's' } }, async listSessions() { return [] }, async prompt() {}, async answer() {}, async cancel() { return true }, async rpc() { return {} as never }, async close() {},
    async backgroundTasks() { return tasks },
    async follow(id: string, onFrame: (f: FollowFrame) => void) { pushers.set(id, onFrame); return () => { pushers.delete(id) } },
  } as unknown as Harness
  const push = (id: string, f: FollowFrame) => pushers.get(id)!(f)
  return { h, push, pushers, tasks }
}
const tick = () => new Promise((r) => setTimeout(r, 0))
const showCall = (id: string, title: string, time: number) => ({ type: 'event' as const, event: { type: 'assistant/message', time, data: { message: { role: 'assistant', content: [{ type: 'tool-call', id, name: 'mcp__bot__show', arguments: JSON.stringify({ kind: 'choices', title, options: [{ label: 'Odakyu' }, { label: 'JR' }] }) }] } } } })
const said = (text: string, time: number, kind = 'user') => ({ type: 'event', event: { type: 'user/message', time, data: { id: `u${time}`, content: [{ type: 'text', text }], source: { kind } } } })
const replied = (text: string, time: number) => ({ type: 'event', event: { type: 'assistant/message', time, data: { message: { role: 'assistant', content: [{ type: 'text', text }] } } } })
function rowsOf(out: ThreadFrame[]) {
  const byId = new Map<string, Record<string, unknown>>(); let order: string[] = []
  for (const f of out) {
    if (f.type === 'snapshot') { order = f.rows.map((r) => r.id); for (const r of f.rows) byId.set(r.id, { ...r }) }
    if (f.type === 'rows') for (const r of f.rows) { if (!byId.has(r.id)) order.push(r.id); byId.set(r.id, { ...r }) }
  }
  return order.map((id) => byId.get(id)!)
}

// A card a background task made stayed in the task's own session: the conversation only relayed it in words
//. It shows in the conversation that started the task, where it was made.
test('a card a background task makes shows in its conversation, at the time it was made', async () => {
  const { h, push } = treeHarness([{ sessionId: 'task', threadId: 'main', parentId: 'main', running: true }])
  const out: ThreadFrame[] = []
  await followThread(h, 'main', (f) => out.push(f))
  push('main', { type: 'snapshot', header: { cwd: '/w' }, records: [said('compare the ways to Evora', 1), replied('On it, in the background.', 3)] } as FollowFrame)
  await tick()
  push('task', { type: 'snapshot', header: { cwd: '/w' }, records: [showCall('card1', 'Which way?', 2)] } as FollowFrame)
  let rows = rowsOf(out)
  assert.deepEqual(rows.map((r) => r.kind), ['you', 'card', 'them'])
  assert.equal((rows[1].card as { title: string }).title, 'Which way?')
  // the task makes another one later: it arrives live
  push('task', showCall('card2', 'Which day?', 5) as FollowFrame)
  rows = rowsOf(out)
  assert.deepEqual(rows.map((r) => r.id), [rows[0].id, 'card1', rows[2].id, 'card2'])
  // the task's own words and steps stay in the task
  push('task', replied('Odakyu is cheapest.', 6) as FollowFrame)
  assert.equal(rowsOf(out).length, 4)
})

test('a tap on a background task\'s card goes to the conversation and marks the card answered, also on a later follow', async () => {
  const { h, push } = treeHarness([{ sessionId: 'task', threadId: 'main', parentId: 'main', running: false }])
  const out: ThreadFrame[] = []
  await followThread(h, 'main', (f) => out.push(f))
  // the answer is in the conversation before the task's card is known (a fresh follow folds the conversation first)
  push('main', { type: 'snapshot', header: { cwd: '/w' }, records: [said('go', 1), said('⟦bot⟧ card card1\nOdakyu', 4)] } as FollowFrame)
  await tick()
  push('task', { type: 'snapshot', header: { cwd: '/w' }, records: [showCall('card1', 'Which way?', 2)] } as FollowFrame)
  const card = rowsOf(out).find((r) => r.id === 'card1')!
  assert.equal(card.answer, 'Odakyu')
})

test('a task started while following is followed too, and every follow stops with the conversation\'s', async () => {
  const t = treeHarness([])
  const out: ThreadFrame[] = []
  const cancel = await followThread(t.h, 'main', (f) => out.push(f))
  t.push('main', { type: 'snapshot', header: { cwd: '/w' }, records: [said('go', 1)] } as FollowFrame)
  await tick()
  assert.equal(t.pushers.has('task'), false)
  // the hand-off: DSH's subagent_fork call and its result name the task
  t.tasks.push({ sessionId: 'task', threadId: 'main', parentId: 'main', running: true })
  t.push('main', { type: 'event', event: { type: 'assistant/message', time: 2, data: { message: { role: 'assistant', content: [{ type: 'tool-call', id: 'f1', name: 'subagent_fork', arguments: '{"description":"Evora"}' }] } } } } as FollowFrame)
  t.push('main', { type: 'event', event: { type: 'tool/result', time: 3, data: { message: { toolCallId: 'f1', content: [{ type: 'text', text: 'started subagent task' }] } } } } as FollowFrame)
  await tick(); await tick()
  assert.equal(t.pushers.has('task'), true)
  t.push('task', { type: 'snapshot', header: { cwd: '/w' }, records: [showCall('card1', 'Which way?', 4)] } as FollowFrame)
  assert.ok(rowsOf(out).some((r) => r.id === 'card1'))
  cancel()
  assert.equal(t.pushers.size, 0)
})

// A fork starts with a copy of the conversation: the same card ids and times, up to `session/end-seed` (DSH's
// subagent_fork; the iOS pass of 2026-10-30 had the conversation's seven cards in each task). The conversation's
// snapshot is one page of its latest events, so an older card copied into the task must not come back from there.
test('the conversation a task was forked from is not delivered again', async () => {
  const { h, push } = treeHarness([{ sessionId: 'task', threadId: 'main', parentId: 'main', running: true }])
  const out: ThreadFrame[] = []
  await followThread(h, 'main', (f) => out.push(f))
  push('main', { type: 'snapshot', header: { cwd: '/w' }, records: [said('compare', 4)] } as FollowFrame)
  await tick()
  push('task', { type: 'snapshot', header: { cwd: '/w' }, records: [said('pick', 1), showCall('old', 'Cascais or Sintra?', 2), said('compare', 4), { type: 'event', event: { type: 'session/end-seed', time: 5, data: {} } }, showCall('new', 'Which train?', 6)] } as FollowFrame)
  assert.deepEqual(rowsOf(out).filter((r) => r.kind === 'card').map((r) => r.id), ['new'])
})
