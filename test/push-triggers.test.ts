// Which events reach the phone as a notification, what they say, and where a tap lands
//. Fake dsh: $events carries approvals, questions and session status;
// session/follow replays the assistant's last message. The bot's PushService records
// every payload instead of sending it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocketServer, WebSocket } from 'ws'
import { createBotServer, type BotServer, type Settings } from '../src/server.ts'
import { MemoryDeviceStore } from '../src/devices.ts'
import { PushService, type Notification } from '../src/push.ts'
import { EventWatcher } from '../src/events.ts'

async function fakeDsh() {
  // session/list answers with every thread an ask came from (the bot finds an ask's thread by the listed headers)
  const threads = new Set<string>()
  const srv = createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); const value = req.url === '/api/session/list' ? { items: [...threads].map((sessionId) => ({ sessionId, updatedAt: 1, running: false, blank: false })) } : {}; res.end(JSON.stringify({ type: 'server-response', rpcId: 'r', result: { ok: true, value } })) })
  const wss = new WebSocketServer({ server: srv, path: '/api/remote.mux' })
  const sockets: WebSocket[] = []
  /** session id → the follow stream ids open for it */
  const follows = new Map<string, { ws: WebSocket; streamId: string }[]>()
  wss.on('connection', (ws) => {
    sockets.push(ws)
    ws.on('message', (m) => {
      const f = JSON.parse(m.toString())
      const send = (v: unknown) => ws.send(JSON.stringify({ type: 'item', streamId: f.streamId, value: v }))
      if (f.type === 'open' && f.endpoint === '$events') send({ type: 'ready', clientId: 'c1', host: { home: '/x' } })
      if (f.type === 'open' && f.endpoint === 'session/follow') {
        const sid = String(f.payload.args.request.address.sessionId)
        send({ type: 'snapshot', header: { id: sid }, cursor: 0, records: [], hasMore: false, projections: { values: {} } })
        follows.set(sid, [...(follows.get(sid) ?? []), { ws, streamId: f.streamId }])
      }
    })
  })
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
  const port = (srv.address() as { port: number }).port
  const emit = (v: unknown) => { for (const s of sockets) s.send(JSON.stringify({ type: 'item', streamId: 'events', value: v })) }
  const say = (sid: string, text: string) => { for (const f of follows.get(sid) ?? []) f.ws.send(JSON.stringify({ type: 'item', streamId: f.streamId, value: { type: 'event', event: { type: 'assistant/message', seq: 5, data: { message: { role: 'assistant', content: [{ type: 'text', text }] } } } } })) }
  return { origin: `http://127.0.0.1:${port}`, emit, say, follows, thread: (id: string) => threads.add(id), close: () => { wss.close(); srv.close() } }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const until = async (ok: () => boolean, ms = 3000) => { const end = Date.now() + ms; while (!ok() && Date.now() < end) await wait(20) }

async function setup(o: { settings?: Partial<Settings>; heartbeatMs?: number } = {}) {
  const dsh = await fakeDsh()
  const dir = mkdtempSync(join(tmpdir(), 'push-triggers-')); mkdirSync(join(dir, 'ws'))
  const pushed: Notification[] = []
  const push = await PushService.open(join(dir, 'push.json'), { sender: async (_s, p) => { pushed.push(JSON.parse(p)) } })
  await push.subscribe('d1', { endpoint: 'https://push.example/1', keys: { p256dh: 'a', auth: 'b' } })
  const devices = new MemoryDeviceStore(); const token = await devices.issue('phone')
  const watcher = new EventWatcher({ origin: dsh.origin, cookie: 'c=1' })
  let settings: Settings = { assistantName: 'Nori', mainSessionId: 'main', language: 'auto', ...o.settings }
  const bot: BotServer = await createBotServer({ dsh: { origin: dsh.origin, cookie: 'c=1' }, devices, push, watcher, workspace: join(dir, 'ws'), host: '127.0.0.1', port: 0, settings: { get: async () => settings, set: async (p) => (settings = { ...settings, ...p }) }, ...(o.heartbeatMs ? { heartbeatMs: o.heartbeatMs } : {}) })
  watcher.start()
  await wait(150)
  /** A phone with the app open: /events, following `sessionId` when given. */
  const phone = async (sessionId?: string, wsOpts: { autoPong?: boolean } = {}) => {
    const ws = new WebSocket(`${bot.origin.replace('http', 'ws')}/events`, ['bearer', token], wsOpts)
    await new Promise((r) => ws.on('open', r))
    if (sessionId) ws.send(JSON.stringify({ type: 'follow', sessionId }))
    await wait(100)
    return ws
  }
  const approval = (eventId: string, sessionId: string, request: Record<string, unknown>) => dsh.thread(sessionId) && dsh.emit({ type: 'waterfall', event: 'approval/request', eventId, agentId: sessionId, request })
  const question = (eventId: string, sessionId: string, request: Record<string, unknown>) => dsh.thread(sessionId) && dsh.emit({ type: 'waterfall', event: 'user-questions/request', eventId, agentId: sessionId, request })
  /** One turn in `sid`: running, the assistant's last line, idle. */
  const turn = async (sid: string, text: string) => {
    dsh.emit({ type: 'emit', event: 'api-session/status', args: [sid, true] })
    await until(() => (dsh.follows.get(sid) ?? []).length > 0); await wait(100)
    dsh.say(sid, text)
    await wait(50)
    dsh.emit({ type: 'emit', event: 'api-session/status', args: [sid, false] })
    await wait(600)
  }
  return { dsh, bot, push, pushed, phone, approval, question, turn, close: async () => { await watcher.stop(); await bot.close(); dsh.close() } }
}

test('an approval with the app closed: one push in the person’s language, the card’s own words, a link to the card', async () => {
  const s = await setup({ settings: { person: { locale: 'zh-CN' } } })
  try {
    s.approval('ev-1', 'main', { toolName: 'bash', reason: 'escalate sandbox to workspace-write: write ~/notes', displayReason: { zh: '要写入笔记文件夹，需要 workspace-write 权限', en: 'Needs workspace-write permissions to write the notes folder' } })
    await until(() => s.pushed.length > 0)
    await wait(100)
    assert.equal(s.pushed.length, 1)
    const n = s.pushed[0]
    assert.equal(n.title, 'Nori需要你点头')
    assert.equal(n.body, '要写入笔记文件夹，需要 workspace-write 权限')
    assert.equal(n.url, '/threads/main/asks/ev-1')
    assert.equal(n.tag, 'approval:ev-1')
  } finally { await s.close() }
})

test('an approval without words of its own says what it wants to do, never the tool’s name', async () => {
  const s = await setup()
  try {
    s.approval('ev-2', 'main', { toolName: 'bash' })
    await until(() => s.pushed.length > 0)
    assert.equal(s.pushed[0].title, 'Nori needs a yes')
    assert.doesNotMatch(s.pushed[0].body, /bash/)
    assert.ok(s.pushed[0].body.length > 0)
  } finally { await s.close() }
})

test('a question links to its card in its thread', async () => {
  const s = await setup()
  try {
    s.question('q-1', 'side-1', { questions: [{ id: 'a', prompt: 'Window or aisle?' }] })
    await until(() => s.pushed.length > 0)
    assert.deepEqual(s.pushed[0], { title: 'Nori has a question', body: 'Window or aisle?', url: '/threads/side-1/asks/q-1', tag: 'question:q-1' })
  } finally { await s.close() }
})

test('the app open in the foreground on that thread gets no push; open on another thread it does', async () => {
  const s = await setup()
  try {
    const p = await s.phone('main')
    s.approval('ev-3', 'main', { toolName: 'bash', reason: 'delete build/' })
    await wait(300)
    assert.equal(s.pushed.length, 0, 'the card is on the screen')
    s.question('q-2', 'side-1', { questions: [{ id: 'a', prompt: 'Which file?' }] })
    await until(() => s.pushed.length > 0)
    assert.equal(s.pushed.length, 1)
    assert.equal(s.pushed[0].url, '/threads/side-1/asks/q-2')
    await s.turn('main', 'All set.')
    assert.equal(s.pushed.length, 1, 'no "done" for the thread on the screen')
    p.close()
  } finally { await s.close() }
})

// Through TailPocket the phone's end of the socket is a loopback port that stays open when the computer is gone: it asks.
test('a phone that asks whether the socket is alive gets an answer', async () => {
  const s = await setup()
  try {
    const p = await s.phone('main')
    const got: string[] = []
    p.on('message', (raw: Buffer) => { got.push(JSON.parse(raw.toString()).type) })
    p.send(JSON.stringify({ type: 'ping' }))
    await wait(100)
    assert.ok(got.includes('pong'), JSON.stringify(got))
    p.close()
  } finally { await s.close() }
})

test('an app in the background (still connected) gets the turn’s last line, linked to its thread', async () => {
  const s = await setup()
  try {
    const p = await s.phone('main')
    p.send(JSON.stringify({ type: 'presence', state: 'background' }))
    await wait(100)
    await s.turn('main', 'Booked the table for **7pm**.\n\nConfirmation #4821.')
    await until(() => s.pushed.length > 0)
    assert.equal(s.pushed.length, 1)
    assert.deepEqual(s.pushed[0], { title: 'Nori is done', body: 'Booked the table for 7pm. Confirmation #4821.', url: '/threads/main', tag: 'turn:main' })
    // back in the foreground: nothing for the next turn
    p.send(JSON.stringify({ type: 'presence', state: 'foreground' }))
    await wait(100)
    await s.turn('main', 'Anything else?')
    assert.equal(s.pushed.length, 1)
    p.close()
  } finally { await s.close() }
})

test('a side thread that finishes while the app is closed pushes once, linked to that thread', async () => {
  const s = await setup()
  try {
    await s.turn('side-7', 'The report is in Files: report.pdf')
    await until(() => s.pushed.length > 0)
    assert.equal(s.pushed.length, 1)
    assert.equal(s.pushed[0].url, '/threads/side-7')
    assert.equal(s.pushed[0].tag, 'turn:side-7')
    assert.match(s.pushed[0].body, /report\.pdf/)
  } finally { await s.close() }
})

test('the bot’s own pushes (reminder, notify, brief) skip a foreground app and land on the main thread', async () => {
  const s = await setup()
  try {
    await s.bot.notify({ title: 'Water', body: 'x', tag: 'schedule:t1' }, { sessionId: 'main' })
    await until(() => s.pushed.length > 0)
    assert.equal(s.pushed[0].url, '/threads/main')
    const p = await s.phone('side-1')
    await s.bot.notify({ title: 'Morning ideas', body: 'y', tag: 'brief', url: '/discover' })
    await wait(200)
    assert.equal(s.pushed.length, 1, 'the app is open: no brief')
    await s.bot.notify({ title: 'Water', body: 'x', tag: 'schedule:t2' }, { sessionId: 'main' })
    await until(() => s.pushed.length > 1)
    assert.equal(s.pushed.length, 2, 'open on another thread: the reminder still comes')
    p.close()
  } finally { await s.close() }
})

test('a reminder’s push stands for its turn: the answer that follows does not push again', async () => {
  const s = await setup()
  try {
    await s.bot.notify({ title: 'Water', body: 'It’s time.', tag: 'schedule:t1' }, { sessionId: 'main', turn: true })
    await until(() => s.pushed.length > 0)
    await s.turn('main', 'Time for a glass of water.')
    assert.equal(s.pushed.length, 1)
    await s.turn('main', 'Next one.')
    assert.equal(s.pushed.length, 2, 'the turn after it pushes as usual')
  } finally { await s.close() }
})

test('a phone that stops answering pings (a suspended app) is dropped and counts as closed', async () => {
  const s = await setup({ heartbeatMs: 150 })
  try {
    const p = await s.phone('main', { autoPong: false })
    let closed = false
    p.on('close', () => { closed = true })
    await until(() => closed, 2000)
    assert.ok(closed, 'the bot closed a socket that never answered')
    await s.turn('main', 'Done with the draft.')
    await until(() => s.pushed.length > 0)
    assert.equal(s.pushed.length, 1)
  } finally { await s.close() }
})
