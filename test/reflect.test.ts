import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LlmClient } from '../src/llm.ts'
import { Memory } from '../src/memory.ts'
import { Reflector } from '../src/reflect.ts'

// Fake cheap model: answers with whatever the test queued, records prompts.
async function fakeModel() {
  const prompts: { role: string; content: string }[][] = []
  const answers: unknown[] = []
  let inFlight = 0, maxInFlight = 0
  const srv = createServer((req, res) => {
    let s = ''
    req.on('data', (c) => { s += c })
    req.on('end', async () => {
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight)
      prompts.push(JSON.parse(s).messages)
      await new Promise((r) => setTimeout(r, 30))
      inFlight--
      res.writeHead(200, { 'content-type': 'application/json' })
      const a = answers.shift() as { __raw?: string } | undefined
      const content = a && typeof a === 'object' && '__raw' in a ? a.__raw : JSON.stringify(a ?? { user: [], memory: [] })
      res.end(JSON.stringify({ choices: [{ message: { content } }] }))
    })
  })
  srv.listen(0, '127.0.0.1'); await once(srv, 'listening')
  const { port } = srv.address() as { port: number }
  return { llm: new LlmClient({ baseURL: `http://127.0.0.1:${port}/v1`, model: 'cheap' }), prompts, answers, maxInFlight: () => maxInFlight, close: () => new Promise<void>((r) => { srv.closeAllConnections(); srv.close(() => r()) }) }
}

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'reflect-'))
  writeFileSync(join(dir, 'USER.md'), '# USER.md\n\n- 2026-10-20 Lives in Lisbon\n')
  writeFileSync(join(dir, 'MEMORY.md'), '# MEMORY.md\n')
  return dir
}

test('a turn is summarised into USER.md / MEMORY.md facts; known facts are not written twice; activity and the update hook fire once', async () => {
  const m = await fakeModel()
  const ws = workspace()
  const activity: { kind: string; text: string }[] = []
  const updates: unknown[] = []
  try {
    m.answers.push({ user: ['Prefers oat milk in coffee', 'lives in lisbon'], memory: ['Plans to run 10 km by January', ''] })
    const r = new Reflector({ llm: m.llm, memory: new Memory(ws), onActivity: (e) => activity.push(e), onUpdated: (u) => updates.push(u) })
    const out = await r.reflect({ user: 'I take oat milk in my coffee, and I want to be able to run 10 km by January.', assistant: 'Noted. I will plan a 12-week build-up.' })
    assert.deepEqual(out, { user: ['Prefers oat milk in coffee'], memory: ['Plans to run 10 km by January'] })
    const user = readFileSync(join(ws, 'USER.md'), 'utf8'), memory = readFileSync(join(ws, 'MEMORY.md'), 'utf8')
    assert.match(user, /- \d{4}-\d{2}-\d{2} (\[\w+\] )?Prefers oat milk in coffee\n/)
    assert.equal(user.match(/Lives in Lisbon/gi)?.length, 1, 'the known fact was not appended again')
    assert.match(memory, /Plans to run 10 km by January/)
    assert.equal(activity.length, 1); assert.equal(activity[0].kind, 'memory'); assert.match(activity[0].text, /^Updated memory: Prefers oat milk in coffee; Plans to run 10 km by January/)
    assert.equal(updates.length, 1)
    // the prompt carried both sides of the turn and the facts already known
    const sent = m.prompts[0].map((x) => x.content).join('\n')
    assert.match(sent, /oat milk in my coffee/); assert.match(sent, /12-week build-up/); assert.match(sent, /Lives in Lisbon/)
  } finally { await m.close() }
})

test('short turns are skipped without calling the model; nothing new → no activity, no hook', async () => {
  const m = await fakeModel()
  const ws = workspace()
  const activity: unknown[] = [], updates: unknown[] = []
  try {
    const r = new Reflector({ llm: m.llm, memory: new Memory(ws), onActivity: (e) => activity.push(e), onUpdated: (u) => updates.push(u) })
    assert.equal(await r.reflect({ user: 'hi', assistant: 'Hello!' }), null)
    assert.equal(m.prompts.length, 0)
    m.answers.push({ user: ['Lives in Lisbon'], memory: [] })
    const out = await r.reflect({ user: 'Remind me again where I said I live? I keep forgetting to tell people.', assistant: 'You told me you live in Lisbon.' })
    assert.deepEqual(out, { user: [], memory: [] })
    assert.equal(activity.length, 0); assert.equal(updates.length, 0)
  } finally { await m.close() }
})

test('one reflection at a time: a second turn arriving while one runs is dropped, not queued', async () => {
  const m = await fakeModel()
  const ws = workspace()
  try {
    m.answers.push({ user: [], memory: ['A'] }, { user: [], memory: ['B'] })
    const r = new Reflector({ llm: m.llm, memory: new Memory(ws) })
    const turn = { user: 'Please remember that my dentist appointment is on the 3rd of November at 10.', assistant: 'Saved.' }
    const [a, b] = await Promise.all([r.reflect(turn), r.reflect(turn)])
    assert.equal(m.prompts.length, 1)
    assert.ok((a === null) !== (b === null), 'exactly one of the two ran')
    assert.equal(m.maxInFlight(), 1)
  } finally { await m.close() }
})

test('a broken model answer is swallowed: reflect resolves null and the files are untouched', async () => {
  const m = await fakeModel()
  const ws = workspace()
  try {
    m.answers.push({ __raw: 'not json at all' }, { __raw: 'still not json' }) // a broken answer is asked for once more (src/llm.ts)
    const r = new Reflector({ llm: m.llm, memory: new Memory(ws), log: () => {} })
    const before = readFileSync(join(ws, 'USER.md'), 'utf8')
    assert.equal(await r.reflect({ user: 'Something long enough to be worth reflecting on today.', assistant: 'Sure, here is a long answer.' }), null)
    assert.equal(readFileSync(join(ws, 'USER.md'), 'utf8'), before)
  } finally { await m.close() }
})

// --- server hook: when a main-thread turn ends, onTurnEnd gets both sides of the exchange ---
import { createBotServer } from '../src/server.ts'
import { MemoryDeviceStore } from '../src/devices.ts'
import { EventWatcher } from '../src/events.ts'
import { WebSocketServer } from 'ws'

async function fakeDsh(snapshotRecords: unknown[] = []) {
  const srv = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'server-response', rpcId: 'r', result: { ok: true, value: {} } })) })
  const wss = new WebSocketServer({ server: srv, path: '/api/remote.mux' })
  const sockets: import('ws').WebSocket[] = []
  wss.on('connection', (ws) => {
    sockets.push(ws)
    ws.on('message', (m) => {
      const f = JSON.parse(m.toString())
      const send = (v: unknown) => ws.send(JSON.stringify({ type: 'item', streamId: f.streamId, value: v }))
      if (f.type === 'open' && f.endpoint === '$events') send({ type: 'ready', clientId: 'c1', host: { home: '/x' } })
      if (f.type === 'open' && f.endpoint === 'session/follow') send({ type: 'snapshot', header: { id: 'main' }, cursor: 0, records: snapshotRecords, hasMore: false, projections: { values: {} } })
    })
  })
  srv.listen(0, '127.0.0.1'); await once(srv, 'listening')
  const { port } = srv.address() as { port: number }
  const emit = (v: unknown) => { for (const s of sockets) s.send(JSON.stringify({ type: 'item', streamId: 'events', value: v })) }
  const followEvent = (ev: unknown) => { for (const s of sockets) s.send(JSON.stringify({ type: 'item', streamId: '1', value: { type: 'event', event: ev } })) }
  return { origin: `http://127.0.0.1:${port}`, emit, followEvent, close: () => { wss.close(); srv.close() } }
}

const userMsg = (text: string) => ({ type: 'user/message', seq: 8, data: { role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } } })
const assistantMsg = (text: string) => ({ type: 'assistant/message', seq: 9, data: { message: { role: 'assistant', content: [{ type: 'text', text }] } } })

test('onTurnEnd fires once per finished main-thread turn with the user text (from the snapshot or a live event) and the last assistant line; broadcast() reaches phones', async () => {
  const dsh = await fakeDsh([{ type: 'event', event: userMsg('Book me a table for two at 7pm tonight') }])
  const turns: { sessionId: string; user: string; assistant: string }[] = []
  const watcher = new EventWatcher({ origin: dsh.origin, cookie: 'c=1' })
  const settings = { assistantName: 'Nori', mainSessionId: 'main', language: 'auto' }
  const devices = new MemoryDeviceStore(); const token = await devices.issue('phone')
  const bot = await createBotServer({ dsh: { origin: dsh.origin, cookie: 'c=1' }, devices, watcher, host: '127.0.0.1', port: 0, settings: { get: async () => settings, set: async () => settings }, onTurnEnd: (sessionId, t) => { turns.push({ sessionId, ...t }) } })
  watcher.start()
  const { WebSocket } = await import('ws')
  const phone = new WebSocket(`${bot.origin.replace('http', 'ws')}/events`, ['bearer', token])
  const got: string[] = []
  phone.on('message', (m) => got.push(JSON.parse(m.toString()).type))
  await new Promise((r) => phone.on('open', r))
  try {
    await new Promise((r) => setTimeout(r, 150))
    dsh.emit({ type: 'emit', event: 'api-session/status', args: ['main', true] })
    await new Promise((r) => setTimeout(r, 600))
    dsh.followEvent(assistantMsg('Booked the table for 7pm. Confirmation #4821.'))
    dsh.emit({ type: 'emit', event: 'api-session/status', args: ['main', false] })
    for (let i = 0; i < 40 && turns.length === 0; i++) await new Promise((r) => setTimeout(r, 50))
    assert.deepEqual(turns, [{ sessionId: 'main', user: 'Book me a table for two at 7pm tonight', assistant: 'Booked the table for 7pm. Confirmation #4821.' }])
    // second turn: user text arrives live
    dsh.emit({ type: 'emit', event: 'api-session/status', args: ['main', true] })
    await new Promise((r) => setTimeout(r, 200))
    dsh.followEvent(userMsg('Thanks! Also remind me to leave at 6:30'))
    dsh.followEvent(assistantMsg('Will do.'))
    dsh.emit({ type: 'emit', event: 'api-session/status', args: ['main', false] })
    for (let i = 0; i < 40 && turns.length < 2; i++) await new Promise((r) => setTimeout(r, 50))
    assert.equal(turns.length, 2)
    assert.equal(turns[1].user, 'Thanks! Also remind me to leave at 6:30'); assert.equal(turns[1].assistant, 'Will do.')
    bot.broadcast({ type: 'memory-updated', added: 1 })
    for (let i = 0; i < 40 && !got.includes('memory-updated'); i++) await new Promise((r) => setTimeout(r, 50))
    assert.ok(got.includes('memory-updated'))
  } finally { phone.close(); await watcher.stop(); await bot.close(); dsh.close() }
})

// Seen 2026-10-27 on a real bot: after a service connected, the bot prompted the assistant itself ("[Connected …]"),
// the assistant answered, and the reflection saved "Acme Pages is connected" as a decision of the person's.
test('a turn with no words from the person (the bot prompted the assistant) is not reflected', async () => {
  const m = await fakeModel()
  try {
    const memory = new Memory(workspace())
    m.answers.push({ user: [], memory: ['Acme Pages is connected and can be searched'] })
    const r = await new Reflector({ llm: m.llm, memory }).reflect({ user: '', assistant: 'Acme Pages is connected now. Tell me what to look for in it and I will.' })
    assert.equal(r, null)
    assert.equal(m.prompts.length, 0)
    assert.doesNotMatch(await memory.read('memory'), /Acme/)
  } finally { await m.close() }
})

// A reasoning model spends its output budget thinking before it writes the JSON: with room for 600 tokens a long
// turn came back empty ("Unexpected end of JSON input"), 3 of 8 times against group/auto-deepseek-flash
// (2026-10-27, QA pass; 0 of 8 with room for 2400). This fake thinks for 1500 tokens and answers only past them.
test('a long turn on a model that thinks first still comes back as facts', async () => {
  const srv = createServer((req, res) => {
    let s = ''
    req.on('data', (c) => { s += c })
    req.on('end', () => {
      const room = Number(JSON.parse(s).max_tokens ?? Infinity)
      const content = room > 1500 ? JSON.stringify({ user: ['Runs twice a week, about 3 km'], memory: ['Goal: 10 km in three months'] }) : ''
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ finish_reason: room > 1500 ? 'stop' : 'length', message: { content, reasoning_content: 'thinking…' } }] }))
    })
  })
  srv.listen(0, '127.0.0.1'); await once(srv, 'listening')
  const { port } = srv.address() as { port: number }
  const logged: unknown[] = []
  try {
    const r = new Reflector({ llm: new LlmClient({ baseURL: `http://127.0.0.1:${port}/v1`, model: 'thinker' }), memory: new Memory(workspace()), log: (...a: unknown[]) => logged.push(a) })
    const out = await r.reflect({ user: 'Set me a goal: 10 km in three months. I run twice a week, about 3 km.', assistant: 'Goal set. '.repeat(200) })
    assert.deepEqual(out, { user: ['Runs twice a week, about 3 km'], memory: ['Goal: 10 km in three months'] })
    assert.deepEqual(logged, [])
  } finally { srv.closeAllConnections(); srv.close() }
})
