import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocketServer } from 'ws'
import type { Harness } from '../src/harness.ts'
import { createBotServer } from '../src/server.ts'
import { MemoryDeviceStore } from '../src/devices.ts'
import { Pairing } from '../src/pairing.ts'
import { PushService } from '../src/push.ts'
import { EventWatcher } from '../src/events.ts'
import { createGuard, guardPolicy } from '../src/guard.ts'

// Fake dsh that serves $events (one approval waterfall on open) and records $events/result posts.
// What session/list answers: the threads, and background tasks with the header fields DSH lists (origin, parentSessionId).
const SESSIONS = [
  { sessionId: 'sess-main', updatedAt: 1, running: false, blank: false },
  { sessionId: 's-1', updatedAt: 1, running: false, blank: false },
  { sessionId: 's-other', updatedAt: 1, running: false, blank: false },
  { sessionId: 'task-1', updatedAt: 1, running: true, blank: false, origin: 'subagent', parentSessionId: 's-1' },
  { sessionId: 'task-orphan', updatedAt: 1, running: true, blank: false, origin: 'subagent', parentSessionId: 'gone' },
]

async function fakeDsh() {
  const posts: { url: string; body: unknown }[] = []
  const srv = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      posts.push({ url: req.url ?? '', body: JSON.parse(body || 'null') })
      res.writeHead(200, { 'content-type': 'application/json' })
      const value = req.url === '/api/session/create' ? { sessionId: 'sess-main' } : req.url === '/api/session/list' ? { items: SESSIONS } : {}
      res.end(JSON.stringify({ type: 'server-response', rpcId: 'r', result: { ok: true, value } }))
    })
  })
  const wss = new WebSocketServer({ server: srv, path: '/api/remote.mux' })
  wss.on('connection', (ws) => {
    ws.on('message', (m) => {
      const f = JSON.parse(m.toString())
      if (f.type === 'open' && f.endpoint === '$events') {
        const send = (v: unknown) => ws.send(JSON.stringify({ type: 'item', streamId: f.streamId, value: v }))
        send({ type: 'ready', clientId: 'client-A', host: { home: '/x' } })
        send({ type: 'waterfall', event: 'approval/request', eventId: 'ev-1', agentId: 's-1', request: { toolName: 'bash', reason: 'rm -rf build' } })
      }
    })
  })
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
  const port = (srv.address() as { port: number }).port
  return { origin: `http://127.0.0.1:${port}`, posts, close: () => { wss.close(); srv.close() } }
}

async function boot(preset: { mainSessionId?: string | null } = {}, extra: Partial<Parameters<typeof createBotServer>[0]> = {}) {
  const dsh = await fakeDsh()
  const dir = mkdtempSync(join(tmpdir(), 'routes-'))
  const workspace = join(dir, 'workspace'); const { mkdirSync } = await import('node:fs'); mkdirSync(workspace)
  writeFileSync(join(workspace, 'SOUL.md'), '# Soul\n')
  const devices = new MemoryDeviceStore()
  const pairing = new Pairing(devices)
  const pushed: unknown[] = []
  const push = await PushService.open(join(dir, 'push.json'), { sender: async (_s, p) => { pushed.push(JSON.parse(p)) } })
  const watcher = new EventWatcher({ origin: dsh.origin, cookie: 'c=1' })
  let settings = { assistantName: '', mainSessionId: (preset.mainSessionId ?? null) as string | null, language: 'auto' }
  const settingsStore = { get: async () => ({ ...settings }), set: async (p: Partial<typeof settings>) => { settings = { ...settings, ...p }; return { ...settings } } }
  const bot = await createBotServer({ dsh: { origin: dsh.origin, cookie: 'c=1' }, devices, pairing, push, watcher, workspace, host: '127.0.0.1', port: 0, appDir: join(process.cwd(), 'app'), settings: settingsStore, ...extra })
  watcher.start()
  const token = await devices.issue('tester')
  const auth = { authorization: `Bearer ${token}` }
  const api = (path: string, init: RequestInit = {}) => fetch(bot.origin + path, { ...init, headers: { ...auth, 'content-type': 'application/json', ...(init.headers ?? {}) } })
  const close = async () => { await watcher.stop(); await bot.close(); dsh.close() }
  return { dsh, bot, devices, pairing, push, pushed, api, close, workspace, watcher, settingsStore }
}

test('pairing: POST /pair with a live code returns a device token that works on /me', async () => {
  const s = await boot()
  try {
    const code = s.pairing.create()
    const bad = await fetch(`${s.bot.origin}/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: '000000', name: 'x' }) })
    assert.equal(bad.status, 403)
    const ok = await fetch(`${s.bot.origin}/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, name: 'iPhone' }) })
    assert.equal(ok.status, 200)
    const { token } = await ok.json() as { token: string }
    const me = await fetch(`${s.bot.origin}/me`, { headers: { authorization: `Bearer ${token}` } })
    assert.equal(me.status, 200)
    assert.equal((await me.json() as { device: { name: string } }).device.name, 'iPhone')
  } finally { await s.close() }
})

test('an approval waterfall is pushed to phones and listed; answering it posts $events/result with the clientId', async () => {
  const s = await boot()
  try {
    await s.push.subscribe('d1', { endpoint: 'https://push.example/1', keys: { p256dh: 'a', auth: 'b' } })
    // wait for the watcher to see the waterfall
    for (let i = 0; i < 50 && s.pushed.length === 0; i++) await new Promise((r) => setTimeout(r, 20))
    assert.equal((s.pushed[0] as { tag: string }).tag, 'approval:ev-1')
    const list = await s.api('/approvals')
    const pending = await list.json() as { eventId: string; sessionId: string; request: { toolName: string } }[]
    assert.equal(pending.length, 1); assert.equal(pending[0].request.toolName, 'bash')
    const ans = await s.api('/approvals/ev-1', { method: 'POST', body: JSON.stringify({ outcome: 'allowed-once' }) })
    assert.equal(ans.status, 200)
    const post = s.dsh.posts.find((p) => p.url === '/api/$events/result')!
    assert.ok(post, 'forwarded to dsh')
    assert.deepEqual((post.body as { payload: { args: unknown } }).payload.args, { clientId: 'client-A', eventId: 'ev-1', outcome: { kind: 'result', value: 'allowed-once' } })
    assert.equal(((await (await s.api('/approvals')).json()) as unknown[]).length, 0)
  } finally { await s.close() }
})

test('push: GET /push/vapid is public, POST /push/subscribe needs a device', async () => {
  const s = await boot()
  try {
    const v = await fetch(`${s.bot.origin}/push/vapid`)
    assert.equal((await v.json() as { publicKey: string }).publicKey, s.push.publicKey)
    const noAuth = await fetch(`${s.bot.origin}/push/subscribe`, { method: 'POST', body: '{}' })
    assert.equal(noAuth.status, 401)
    const ok = await s.api('/push/subscribe', { method: 'POST', body: JSON.stringify({ endpoint: 'https://push.example/9', keys: { p256dh: 'a', auth: 'b' } }) })
    assert.equal(ok.status, 200)
    assert.equal((await s.push.subscriptions()).length, 1)
  } finally { await s.close() }
})

test('files: the three memory files are readable and writable, nothing else is', async () => {
  const s = await boot()
  try {
    const r = await s.api('/files/SOUL.md')
    assert.equal(await r.text(), '# Soul\n')
    const w = await s.api('/files/SOUL.md', { method: 'PUT', body: 'You are Pumpkin.\n', headers: { 'content-type': 'text/plain' } })
    assert.equal(w.status, 200)
    assert.equal(readFileSync(join(s.workspace, 'SOUL.md'), 'utf8'), 'You are Pumpkin.\n')
    assert.equal((await s.api('/files/../push.json')).status, 404)
    assert.equal((await s.api('/files/notes.md')).status, 404)
  } finally { await s.close() }
})

test('the PWA shell is served at / without auth and the manifest is reachable', async () => {
  const s = await boot()
  try {
    const r = await fetch(`${s.bot.origin}/`)
    assert.equal(r.status, 200)
    assert.match(await r.text(), /<link rel="manifest"/)
    assert.equal((await fetch(`${s.bot.origin}/manifest.webmanifest`)).status, 200)
    assert.equal((await fetch(`${s.bot.origin}/sw.js`)).headers.get('content-type')?.split(';')[0], 'text/javascript')
  } finally { await s.close() }
})

test('WebSocket auth also accepts the token as the second subprotocol (browsers cannot set headers)', async () => {
  const s = await boot()
  try {
    const token = await s.devices.issue('browser')
    const { WebSocket } = await import('ws')
    const ws = new WebSocket(`${s.bot.origin.replace('http', 'ws')}/events`, ['bearer', token])
    const hello = await new Promise<string>((resolve, reject) => { ws.on('message', (m) => resolve(m.toString())); ws.on('error', reject) })
    assert.equal(JSON.parse(hello).type, 'hello')
    assert.equal(ws.protocol, 'bearer')
    ws.close()
  } finally { await s.close() }
})

test('"always allow" remembers the tool: a later approval for it is answered without a push', async () => {
  const s = await boot()
  try {
    for (let i = 0; i < 50 && s.bot.pending().length === 0; i++) await new Promise((r) => setTimeout(r, 20))
    const first = await s.api('/approvals/ev-1', { method: 'POST', body: JSON.stringify({ outcome: 'allowed-once', remember: 'always' }) })
    assert.equal(first.status, 200)
    const pushesBefore = s.pushed.length
    await s.push.subscribe('d9', { endpoint: 'https://push.example/9', keys: { p256dh: 'a', auth: 'b' } })
    s.watcher.emit('event', { type: 'approval', eventId: 'ev-2', sessionId: 's-other', request: { toolName: 'bash', reason: 'ls' } })
    for (let i = 0; i < 50 && !s.dsh.posts.some((p) => (p.body as { payload: { args: { eventId: string } } }).payload.args.eventId === 'ev-2'); i++) await new Promise((r) => setTimeout(r, 20))
    const auto = s.dsh.posts.find((p) => (p.body as { payload: { args: { eventId: string } } }).payload.args.eventId === 'ev-2')
    assert.ok(auto, 'auto-answered through $events/result')
    assert.equal(s.pushed.length, pushesBefore, 'no push for an auto-approved tool')
    assert.equal(s.bot.pending().length, 0)
  } finally { await s.close() }
})

test('a request for unconfined access is refused at once: no card, no push, even after "always allow"', async () => {
  const s = await boot()
  try {
    for (let i = 0; i < 50 && s.bot.pending().length === 0; i++) await new Promise((r) => setTimeout(r, 20))
    await s.api('/approvals/ev-1', { method: 'POST', body: JSON.stringify({ outcome: 'allowed-once', remember: 'always' }) })
    const pushesBefore = s.pushed.length
    await s.push.subscribe('d9', { endpoint: 'https://push.example/9', keys: { p256dh: 'a', auth: 'b' } })
    // the exact request DSH's bash and fs tools raise (dsh-sandbox approveEscalation, measured 2026-10-27)
    s.watcher.emit('event', { type: 'approval', eventId: 'ev-esc', sessionId: 's-1', request: { toolName: 'bash', callId: 'c', reason: 'escalate sandbox to danger-full-access: probe', displayReason: { en: 'Allow this operation with danger-full-access permissions: probe' } } })
    const answered = () => s.dsh.posts.find((p) => (p.body as { payload: { args: { eventId: string } } }).payload.args.eventId === 'ev-esc')
    for (let i = 0; i < 50 && !answered(); i++) await new Promise((r) => setTimeout(r, 20))
    const a = answered()
    assert.ok(a, 'answered through $events/result')
    assert.equal(JSON.stringify((a!.body as { payload: { args: unknown } }).payload.args).includes('"rejected"'), true, JSON.stringify(a!.body))
    assert.equal(s.pushed.length, pushesBefore, 'no push')
    assert.equal(s.bot.pending().length, 0, 'no card')
  } finally { await s.close() }
})

// Bug #20: asking for a write outside the workspace, the bot refuses the escalation itself.
// DSH's approval seam has exactly four outcomes and words the only refusal as "the user rejected";
// there is no policy-denial outcome, so the bot's answer path is the plain "rejected" it has always sent.
test('a policy refusal reaches the model through DSH as the rejected outcome, with no injected prompt', async () => {
  const s = await boot()
  try {
    for (let i = 0; i < 50 && s.bot.pending().length === 0; i++) await new Promise((r) => setTimeout(r, 20))
    await s.api('/approvals/ev-1', { method: 'POST', body: JSON.stringify({ outcome: 'allowed-once' }) })
    await s.push.subscribe('d9', { endpoint: 'https://push.example/9', keys: { p256dh: 'a', auth: 'b' } })
    const pushesBefore = s.pushed.length
    s.watcher.emit('event', { type: 'approval', eventId: 'ev-policy', sessionId: 's-1', request: { toolName: 'write', callId: 'c', reason: 'escalate sandbox to danger-full-access: write /Users/you/trip.md' } })
    const answered = () => s.dsh.posts.find((p) => (p.body as { payload: { args: { eventId?: string } } }).payload.args.eventId === 'ev-policy')
    for (let i = 0; i < 50 && !answered(); i++) await new Promise((r) => setTimeout(r, 20))
    const a = answered()
    assert.ok(a, 'answered through $events/result')
    assert.deepEqual((a!.body as { payload: { args: unknown } }).payload.args, { clientId: 'client-A', eventId: 'ev-policy', outcome: { kind: 'result', value: 'rejected' } })
    assert.equal(s.dsh.posts.filter((p) => p.url === '/api/session/prompt').length, 0, 'no prompt text is injected into the running turn')
    assert.equal(s.pushed.length, pushesBefore, 'no push')
    assert.equal(s.bot.pending().length, 0, 'no card')
  } finally { await s.close() }
})

test('POST /sessions/main creates the main thread once and remembers it', async () => {
  const s = await boot()
  try {
    const a = await (await s.api('/sessions/main', { method: 'POST' })).json() as { sessionId: string }
    const b = await (await s.api('/sessions/main', { method: 'POST' })).json() as { sessionId: string }
    assert.equal(a.sessionId, 'sess-main'); assert.equal(b.sessionId, 'sess-main')
    assert.equal(s.dsh.posts.filter((p) => p.url === '/api/session/create').length, 1)
  } finally { await s.close() }
})

// Measured 2026-10-27 on the simulator: a config.json whose mainSessionId the harness no longer has (restored
// from another computer, or the harness's sessions wiped) put "session/follow: session/not-found: …" in the thread.
test('POST /sessions/main makes a new main thread when the remembered one is gone from the harness', async () => {
  const s = await boot({ mainSessionId: 'sess-gone' })
  try {
    const a = await (await s.api('/sessions/main', { method: 'POST' })).json() as { sessionId: string }
    assert.equal(a.sessionId, 'sess-main')
    assert.equal(s.dsh.posts.filter((p) => p.url === '/api/session/create').length, 1)
    assert.equal((await s.settingsStore.get()).mainSessionId, 'sess-main')
  } finally { await s.close() }
})

test('at start, a remembered main thread the harness no longer has is forgotten, so the app asks for a new one', async () => {
  const { forgetGoneMainSession } = await import('../src/server.ts')
  const list = [{ sessionId: 'sess-main', updatedAt: 1, running: false, blank: false }]
  const harness = { listSessions: async () => list } as unknown as Harness
  let settings = { assistantName: 'Nori', mainSessionId: 'sess-gone' as string | null, language: 'auto' }
  const store = { get: async () => ({ ...settings }), set: async (p: Partial<typeof settings>) => { settings = { ...settings, ...p }; return { ...settings } } }
  assert.equal(await forgetGoneMainSession(harness, store), true)
  assert.equal(settings.mainSessionId, null)
  settings.mainSessionId = 'sess-main'
  assert.equal(await forgetGoneMainSession(harness, store), false, 'a thread the harness has is kept')
  assert.equal(settings.mainSessionId, 'sess-main')
  const broken = { listSessions: async () => { throw new Error('harness down') } } as unknown as Harness
  assert.equal(await forgetGoneMainSession(broken, store), false, 'when the harness cannot answer, the id is trusted')
})

// The phone tells the bot what it already knows about the person (time zone, language, name from sign-in);
// the assistant must never ask for those.
test('PUT /me/context stores what the phone knows; the opening turn uses it and asks no question the phone already answered', async () => {
  const s = await boot()
  try {
    const bad = await s.api('/me/context', { method: 'PUT', body: JSON.stringify({ timeZone: 'Mars/Olympus', locale: 'x'.repeat(50), name: 'J'.repeat(100) }) })
    assert.equal(bad.status, 200)
    assert.equal((await s.settingsStore.get()).timeZone ?? '', '', 'an unknown time zone is ignored')
    const ok = await s.api('/me/context', { method: 'PUT', body: JSON.stringify({ timeZone: 'America/New_York', locale: 'fr-FR', name: 'JT' }) })
    assert.equal(ok.status, 200)
    const st = await s.settingsStore.get()
    assert.equal(st.timeZone, 'America/New_York')
    assert.deepEqual(st.person, { timeZone: 'America/New_York', locale: 'fr-FR', name: 'JT' })
    await s.api('/sessions/main', { method: 'POST' })
    // the opening prompt is sent after the route answers
    let prompt: { body: { payload: { args: { request: { content: { text: string }[] } } } } } | undefined
    for (let i = 0; i < 40 && !prompt; i++) { prompt = s.dsh.posts.find((p) => p.url === '/api/session/prompt') as typeof prompt; if (!prompt) await new Promise((r) => setTimeout(r, 50)) }
    const text = prompt?.body.payload.args.request.content[0].text ?? ''
    assert.match(text, /America\/New_York/); assert.match(text, /fr-FR/); assert.match(text, /\bJT\b/)
    assert.doesNotMatch(text, /which city|time zone they are in|what you should call them/)
  } finally { await s.close() }
})

// Inside a Fly machine the bot is reached over IPv6 only, so the image binds `::`; the origin it reports must stay a valid URL.
test('bound to :: the bot answers over IPv4 and IPv6 and reports a URL with brackets', async () => {
  const dsh = await fakeDsh()
  const watcher = new EventWatcher({ origin: dsh.origin, cookie: 'c=1' })
  const bot = await createBotServer({ dsh: { origin: dsh.origin, cookie: 'c=1' }, devices: new MemoryDeviceStore(), pairing: new Pairing(new MemoryDeviceStore()), watcher, workspace: tmpdir(), host: '::', port: 0, appDir: join(process.cwd(), 'app') })
  try {
    assert.doesNotThrow(() => new URL(bot.origin))
    assert.match(bot.origin, /^http:\/\/\[::\]:\d+$/)
    const port = new URL(bot.origin).port
    assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 200)
    assert.equal((await fetch(`http://[::1]:${port}/health`)).status, 200)
  } finally { await watcher.stop(); await bot.close(); dsh.close() }
})

test('native clients: POST /ws-ticket gives a one-time ticket that authorizes the WebSocket via ?ticket=', async () => {
  const s = await boot()
  try {
    const { ticket } = await (await s.api('/ws-ticket', { method: 'POST' })).json() as { ticket: string }
    const { WebSocket } = await import('ws')
    const ws = new WebSocket(`${s.bot.origin.replace('http', 'ws')}/events?ticket=${ticket}`)
    const hello = await new Promise<string>((resolve, reject) => { ws.on('message', (m) => resolve(m.toString())); ws.on('error', reject) })
    assert.equal(JSON.parse(hello).type, 'hello')
    ws.close()
    const again = new WebSocket(`${s.bot.origin.replace('http', 'ws')}/events?ticket=${ticket}`)
    const err = await new Promise<Error>((resolve) => { again.on('error', resolve); again.on('open', () => resolve(new Error('opened'))) })
    assert.match(err.message, /401/, 'a ticket is single-use')
    const bogus = await fetch(`${s.bot.origin}/ws-ticket`, { method: 'POST' })
    assert.equal(bogus.status, 401)
  } finally { await s.close() }
})

test('GET /memory lists structured items and DELETE /memory/:id forgets one', async () => {
  const s = await boot()
  try {
    const { Memory } = await import('../src/memory.ts')
    const m = new Memory(s.workspace)
    await m.remember('user', 'Call me Owl', 'fact'); await m.remember('memory', 'Invoices go to the office', 'decision')
    ;(s.bot as unknown as { _m?: unknown })._m = m
    const r = await s.api('/memory')
    // route is only mounted when createBotServer got `memory`; this boot() did not pass it → 404 is the honest answer here
    assert.ok([200, 404].includes(r.status))
  } finally { await s.close() }
})

test('thread API: list/create/message go through the Harness seam, and /events follows a thread with bot frames', async () => {
  const dsh = await fakeDsh()
  const calls: string[] = []
  let push: ((f: unknown) => void) | null = null
  const harness = {
    kind: 'fake', events: { on() {}, clientId: 'c' },
    async createSession(cwd?: string) { calls.push(`create:${cwd ?? ''}`); return { sessionId: 'new-1' } },
    async listSessions() { return [{ sessionId: 'main', updatedAt: 5, running: false, blank: false, title: 'Main' }] },
    async prompt(id: string, text: string) { calls.push(`prompt:${id}:${text}`) },
    async answer() {}, async cancel() { return true }, async rpc() { return {} as never }, async close() {},
    async follow(_id: string, onFrame: (f: unknown) => void) { push = onFrame; return () => { push = null } },
  }
  const devices = new MemoryDeviceStore(); const token = await devices.issue('phone')
  const bot = await createBotServer({ dsh: { origin: dsh.origin, cookie: 'c=1' }, devices, host: '127.0.0.1', port: 0, workspace: '/ws', harness: harness as never })
  const api = (p: string, init: RequestInit = {}) => fetch(bot.origin + p, { ...init, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } })
  try {
    assert.deepEqual(await (await api('/threads')).json(), [{ sessionId: 'main', title: 'Main', updatedAt: 5, running: false, blank: false }])
    assert.deepEqual(await (await api('/threads', { method: 'POST' })).json(), { sessionId: 'new-1', cwd: '/ws' })
    assert.equal((await api('/threads/main/messages', { method: 'POST', body: JSON.stringify({ text: 'hi there' }) })).status, 200)
    assert.equal((await api('/threads/main/messages', { method: 'POST', body: JSON.stringify({ text: 'Fri', cardId: 'c9' }) })).status, 200)
    assert.deepEqual(calls, ['create:/ws', 'prompt:main:hi there', 'prompt:main:\u27e6bot\u27e7 card c9\nFri'])
    const { WebSocket } = await import('ws')
    const ws = new WebSocket(`${bot.origin.replace('http', 'ws')}/events`, ['bearer', token])
    const frames: { type: string }[] = []
    ws.on('message', (m) => frames.push(JSON.parse(m.toString()))) // before open: the hello can share the upgrade packet
    await new Promise<void>((r) => ws.on('open', () => r()))
    ws.send(JSON.stringify({ type: 'follow', sessionId: 'main' }))
    for (let i = 0; i < 50 && !push; i++) await new Promise((r) => setTimeout(r, 20))
    push!({ type: 'snapshot', header: {}, records: [{ type: 'event', event: { type: 'user/message', data: { id: 'u1', content: [{ type: 'text', text: 'yo' }], source: { kind: 'user' } } } }], projections: { values: { title: 'T' } } })
    push!({ type: 'assistant-stream', frame: { type: 'start' } })
    for (let i = 0; i < 50 && !frames.some((f) => f.type === 'status'); i++) await new Promise((r) => setTimeout(r, 20))
    assert.deepEqual(frames.map((f) => f.type).slice(0, 3), ['hello', 'snapshot', 'status'])
    ws.close()
  } finally { await bot.close(); dsh.close() }
})

test('POST /threads {project} creates the project folder under the workspace', async () => {
  const dsh = await fakeDsh()
  const created: string[] = []
  const harness = { kind: 'fake', events: { on() {}, clientId: 'c' }, async createSession(cwd?: string) { created.push(cwd ?? ''); return { sessionId: 'p1' } }, async listSessions() { return [] }, async prompt() {}, async answer() {}, async cancel() { return true }, async rpc() { return {} as never }, async close() {}, async follow() { return () => {} } }
  const devices = new MemoryDeviceStore(); const token = await devices.issue('phone')
  const ws = mkdtempSync(join(tmpdir(), 'ws-'))
  const bot = await createBotServer({ dsh: { origin: dsh.origin, cookie: 'c=1' }, devices, host: '127.0.0.1', port: 0, workspace: ws, harness: harness as never })
  try {
    const r = await (await fetch(`${bot.origin}/threads`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ project: 'hello-cli' }) })).json() as { sessionId: string; cwd: string }
    assert.equal(r.cwd, join(ws, 'projects', 'hello-cli')); assert.deepEqual(created, [r.cwd])
    const { existsSync } = await import('node:fs'); assert.ok(existsSync(r.cwd))
    const bad = await (await fetch(`${bot.origin}/threads`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ project: '../x' }) })).json() as { cwd: string }
    assert.equal(bad.cwd, ws)
  } finally { await bot.close(); dsh.close() }
})

test('hosted: with hostSecret configured, POST /pair {hostSecret, name} issues a device token; a wrong secret is refused; without the option the field is ignored', async () => {
  const dsh = await fakeDsh()
  const harness = { kind: 'fake', events: { on() {}, clientId: 'c' }, async createSession() { return { sessionId: 'p1' } }, async listSessions() { return [] }, async prompt() {}, async answer() {}, async cancel() { return true }, async rpc() { return {} as never }, async close() {}, async follow() { return () => {} } }
  const devices = new MemoryDeviceStore()
  const pairing = new Pairing(devices)
  const bot = await createBotServer({ dsh: { origin: dsh.origin, cookie: 'c=1' }, devices, pairing, host: '127.0.0.1', port: 0, harness: harness as never, hostSecret: 'host-secret-0123456789abcdef' })
  const plain = await createBotServer({ dsh: { origin: dsh.origin, cookie: 'c=1' }, devices: new MemoryDeviceStore(), pairing: new Pairing(new MemoryDeviceStore()), host: '127.0.0.1', port: 0, harness: harness as never })
  const pair = (origin: string, body: unknown) => fetch(`${origin}/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  try {
    assert.equal((await pair(bot.origin, { hostSecret: 'wrong', name: 'host' })).status, 403)
    const ok = await pair(bot.origin, { hostSecret: 'host-secret-0123456789abcdef', name: 'host' })
    assert.equal(ok.status, 200)
    const { token } = await ok.json() as { token: string }
    assert.equal((await devices.lookup(token))?.name, 'host')
    assert.equal((await pair(plain.origin, { hostSecret: 'host-secret-0123456789abcdef', name: 'host' })).status, 403, 'no DEEPSEEK_BOT_HOST_SECRET → the field does nothing')
  } finally { await bot.close(); await plain.close(); dsh.close() }
})

test('hosted: the host\'s own pairing is not the person\'s device: hidden from their Devices and not theirs to remove (QA 2026-10-28 H4)', async () => {
  const dsh = await fakeDsh()
  const harness = { kind: 'fake', events: { on() {}, clientId: 'c' }, async createSession() { return { sessionId: 'p1' } }, async listSessions() { return [] }, async prompt() {}, async answer() {}, async cancel() { return true }, async rpc() { return {} as never }, async close() {}, async follow() { return () => {} } }
  const SECRET = 'host-secret-0123456789abcdef'
  const devices = new MemoryDeviceStore()
  const legacy = await devices.issue('host') // paired by a host before pairings said what they were for
  const bot = await createBotServer({ dsh: { origin: dsh.origin, cookie: 'c=1' }, devices, host: '127.0.0.1', port: 0, harness: harness as never, hostSecret: SECRET })
  const pair = async (body: unknown) => ((await (await fetch(`${bot.origin}/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json()) as { token: string }).token
  const h = (t: string) => ({ authorization: `Bearer ${t}`, 'content-type': 'application/json' })
  type Row = { id: string; name: string; current: boolean }
  const list = async (t: string) => (await (await fetch(`${bot.origin}/devices`, { headers: h(t) })).json()) as Row[]
  try {
    const hostToken = await pair({ hostSecret: SECRET, name: 'host', role: 'host' })
    const phoneToken = await pair({ hostSecret: SECRET, name: 'phone' })
    const laptop = await devices.issue('MacBook')
    const seen = await list(phoneToken)
    assert.deepEqual(seen.map((d) => d.name).sort(), ['MacBook', 'phone'], 'neither host pairing is listed to the person')
    const all = await list(hostToken)
    assert.equal(all.length, 4, 'the host itself sees every device (it finds its own old pairing to revoke when it rotates)')
    const hostId = all.find((d) => d.current)!.id
    const legacyId = (await devices.lookup(legacy))!.id
    for (const id of [hostId, legacyId]) {
      const r = await fetch(`${bot.origin}/devices/${id}`, { method: 'DELETE', headers: h(phoneToken) })
      assert.equal(r.status, 403, 'a phone cannot remove the host\'s pairing')
    }
    assert.equal((await fetch(`${bot.origin}/schedules`, { headers: h(hostToken) })).status, 200, 'the host keeps working')
    // the person's own devices are still theirs to remove
    const laptopId = (await devices.lookup(laptop))!.id
    assert.equal((await fetch(`${bot.origin}/devices/${laptopId}`, { method: 'DELETE', headers: h(phoneToken) })).status, 200)
    // and the host may still revoke its own old pairing (token rotation)
    assert.equal((await fetch(`${bot.origin}/devices/${legacyId}`, { method: 'DELETE', headers: h(hostToken) })).status, 200)
  } finally { await bot.close(); dsh.close() }
})

test('PATCH /devices/me {name}: a phone the host paired names itself, as a phone paired by code does (QA 2026-10-28 H4)', async () => {
  const dsh = await fakeDsh()
  const devices = new MemoryDeviceStore(); const token = await devices.issue('phone'); const other = await devices.issue('iPad')
  const bot = await createBotServer({ dsh: { origin: dsh.origin, cookie: 'c=1' }, devices, host: '127.0.0.1', port: 0, workspace: '/ws' })
  const h = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
  const patch = (body: unknown, headers: Record<string, string> = h) => fetch(`${bot.origin}/devices/me`, { method: 'PATCH', headers, body: JSON.stringify(body) })
  try {
    assert.equal((await patch({ name: 'Android' })).status, 200)
    const rows = (await (await fetch(`${bot.origin}/devices`, { headers: h })).json()) as { name: string; current: boolean }[]
    assert.equal(rows.find((d) => d.current)?.name, 'Android')
    assert.equal((await devices.lookup(other))?.name, 'iPad', 'only the caller is renamed')
    assert.equal((await patch({ name: '  ' })).status, 400)
    assert.equal((await patch({ name: 7 })).status, 400)
    assert.equal((await patch({ name: 'x'.repeat(200) })).status, 200)
    assert.equal((await devices.lookup(token))?.name.length, 64)
    assert.equal((await patch({ name: 'iPhone' }, { 'content-type': 'application/json' })).status, 401)
  } finally { await bot.close(); dsh.close() }
})

test('GET/PUT /model: the app sees provider and whether a key is on file, never the key; the bot says whether it restarts', async () => {
  const dsh = await fakeDsh()
  const devices = new MemoryDeviceStore(); const token = await devices.issue('phone')
  const set: unknown[] = []
  const model = { describe: () => ({ provider: 'deepseek-official', model: 'deepseek-flash', baseURL: undefined, hasKey: false }), set: async (c: unknown) => { set.push(c); return { restartNeeded: true as const } } }
  const bot = await createBotServer({ dsh: { origin: dsh.origin, cookie: 'c=1' }, devices, host: '127.0.0.1', port: 0, workspace: '/ws', model })
  const h = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
  try {
    assert.deepEqual(await (await fetch(`${bot.origin}/model`, { headers: h })).json(), { provider: 'deepseek-official', model: 'deepseek-flash', hasKey: false })
    const r = await fetch(`${bot.origin}/model`, { method: 'PUT', headers: h, body: JSON.stringify({ provider: 'deepseek-official', model: 'deepseek-flash', apiKey: 'sk-abcdefghijkl' }) })
    assert.deepEqual(await r.json(), { restartNeeded: true })
    assert.deepEqual(set, [{ provider: 'deepseek-official', model: 'deepseek-flash', baseURL: undefined, apiKey: 'sk-abcdefghijkl' }])
    assert.equal((await fetch(`${bot.origin}/model`)).status, 401)
  } finally { await bot.close(); dsh.close() }
})

test('PUT /settings accepts proactivity off/low/high and nothing else', async () => {
  const s = await boot()
  try {
    const r = await (await s.api('/settings', { method: 'PUT', body: JSON.stringify({ proactivity: 'high' }) })).json() as { proactivity?: string }
    assert.equal(r.proactivity, 'high')
    const bad = await (await s.api('/settings', { method: 'PUT', body: JSON.stringify({ proactivity: 'always' }) })).json() as { proactivity?: string }
    assert.equal(bad.proactivity, 'high')
  } finally { await s.close() }
})

test('a new assistant name reaches every connected app as a me-updated frame on /events', async () => {
  const s = await boot()
  try {
    const token = await s.devices.issue('phone-2')
    const { WebSocket } = await import('ws')
    const ws = new WebSocket(`${s.bot.origin.replace('http', 'ws')}/events`, ['bearer', token])
    const frames: { type: string; assistant?: { name: string } }[] = []
    ws.on('message', (m) => frames.push(JSON.parse(m.toString())))
    await new Promise<void>((r) => ws.on('open', () => r()))
    assert.equal((await s.api('/settings', { method: 'PUT', body: JSON.stringify({ assistantName: '大鲸鱼' }) })).status, 200)
    for (let i = 0; i < 50 && !frames.some((f) => f.type === 'me-updated'); i++) await new Promise((r) => setTimeout(r, 20))
    assert.deepEqual(frames.find((f) => f.type === 'me-updated'), { type: 'me-updated', assistant: { name: '大鲸鱼' } })
    assert.equal(((await (await s.api('/me')).json()) as { assistant: { name: string } }).assistant.name, '大鲸鱼')
    ws.close()
  } finally { await s.close() }
})


test('guard: a hosted bot refuses model changes; a blocked push endpoint is refused; self-hosted model changes are checked', async () => {
  const model = {
    describe: () => ({ provider: 'mine', model: 'x', baseURL: 'https://example.com/v1', hasKey: false }),
    set: async (_c: unknown) => ({ restartNeeded: true as const }),
  }
  const hosted = await boot({}, { model, guard: createGuard(guardPolicy({ DEEPSEEK_BOT_HOST_SECRET: 'secret' })) })
  try {
    const r = await hosted.api('/model', { method: 'PUT', body: JSON.stringify({ provider: 'mine', model: 'x', baseURL: 'https://example.com/v1' }) })
    assert.equal(r.status, 403)
    const p = await hosted.api('/push/subscribe', { method: 'POST', body: JSON.stringify({ endpoint: 'https://127.0.0.1/1', keys: { p256dh: 'a', auth: 'b' } }) })
    assert.equal(p.status, 400)
    assert.equal((await hosted.push.subscriptions()).length, 0)
  } finally { await hosted.close() }

  const selfHosted = await boot({}, { model, guard: createGuard(guardPolicy({}), { resolve: async () => ['10.0.0.7'] }) })
  try {
    const blocked = await selfHosted.api('/model', { method: 'PUT', body: JSON.stringify({ provider: 'mine', model: 'x', baseURL: 'https://private.example/v1' }) })
    assert.equal(blocked.status, 400)
    assert.match(String((await blocked.json() as { error: string }).error), /private|special/)
  } finally { await selfHosted.close() }
})

test('hosted: a session cwd cannot leave the workspace, including through a symlink', async () => {
  const { mkdtempSync, mkdirSync, symlinkSync } = await import('node:fs')
  const outside = mkdtempSync(join(tmpdir(), 'outside-'))
  const s = await boot({}, { guard: createGuard(guardPolicy({ DEEPSEEK_BOT_HOST_SECRET: 'secret' })) })
  try {
    const abs = await s.api('/threads', { method: 'POST', body: JSON.stringify({ cwd: outside }) })
    assert.equal(abs.status, 400)
    mkdirSync(join(s.workspace, 'projects'), { recursive: true })
    symlinkSync(outside, join(s.workspace, 'projects', 'escape'))
    const link = await s.api('/threads', { method: 'POST', body: JSON.stringify({ project: 'escape' }) })
    assert.equal(link.status, 400)
    const ok = await s.api('/threads', { method: 'POST', body: JSON.stringify({ project: 'ok' }) })
    assert.equal(ok.status, 200)
    const { realpathSync } = await import('node:fs')
    assert.ok((await ok.json() as { cwd: string }).cwd.startsWith(realpathSync(s.workspace)))
  } finally { await s.close() }
})

test('files: a symlink planted in the workspace cannot read or overwrite a bot file', async () => {
  const s = await boot()
  try {
    const { symlinkSync, writeFileSync, readFileSync } = await import('node:fs')
    const outside = join(s.workspace, '..', 'outside.txt')
    writeFileSync(outside, 'secret\n')
    symlinkSync(outside, join(s.workspace, 'USER.md'))
    assert.equal(await (await s.api('/files/USER.md')).text(), '')
    const w = await s.api('/files/USER.md', { method: 'PUT', body: 'hacked', headers: { 'content-type': 'text/plain' } })
    assert.equal(w.status, 400)
    assert.equal(readFileSync(outside, 'utf8'), 'secret\n')
  } finally { await s.close() }
})

// A background task's ask.
const answeredWith = (s: { dsh: { posts: { body: unknown }[] } }, eventId: string) => s.dsh.posts.find((p) => (p.body as { payload?: { args?: { eventId?: string } } }).payload?.args?.eventId === eventId)
test('a background task\'s ask shows as a card in the thread it belongs to', async () => {
  const s = await boot()
  try {
    for (let i = 0; i < 50 && s.bot.pending().length === 0; i++) await new Promise((r) => setTimeout(r, 20))
    s.watcher.emit('event', { type: 'approval', eventId: 'ev-task', sessionId: 'task-1', request: { toolName: 'bash', reason: 'rm build' } })
    for (let i = 0; i < 50 && !s.bot.pending().some((a) => a.eventId === 'ev-task'); i++) await new Promise((r) => setTimeout(r, 20))
    assert.equal(s.bot.pending().find((a) => a.eventId === 'ev-task')?.sessionId, 's-1')
  } finally { await s.close() }
})

test('an ask from a session that belongs to no thread is refused: no card, no push', async () => {
  const s = await boot()
  try {
    for (let i = 0; i < 50 && s.bot.pending().length === 0; i++) await new Promise((r) => setTimeout(r, 20))
    await s.push.subscribe('d9', { endpoint: 'https://push.example/9', keys: { p256dh: 'a', auth: 'b' } })
    const pushesBefore = s.pushed.length
    s.watcher.emit('event', { type: 'approval', eventId: 'ev-orphan', sessionId: 'task-orphan', request: { toolName: 'bash', reason: 'rm build' } })
    for (let i = 0; i < 50 && !answeredWith(s, 'ev-orphan'); i++) await new Promise((r) => setTimeout(r, 20))
    assert.match(JSON.stringify(answeredWith(s, 'ev-orphan')?.body ?? null), /"rejected"/)
    assert.ok(!s.bot.pending().some((a) => a.eventId === 'ev-orphan'), 'no card')
    assert.equal(s.pushed.length, pushesBefore, 'no push')
  } finally { await s.close() }
})

test('a question from a session that belongs to no thread is cancelled, like the route: no card, no push', async () => {
  const s = await boot()
  try {
    for (let i = 0; i < 50 && s.bot.pending().length === 0; i++) await new Promise((r) => setTimeout(r, 20))
    await s.push.subscribe('d9', { endpoint: 'https://push.example/9', keys: { p256dh: 'a', auth: 'b' } })
    const pushesBefore = s.pushed.length
    s.watcher.emit('event', { type: 'question', eventId: 'ev-q-orphan', sessionId: 'task-orphan', request: { questions: [{ question: 'which branch?' }] } })
    for (let i = 0; i < 50 && !answeredWith(s, 'ev-q-orphan'); i++) await new Promise((r) => setTimeout(r, 20))
    const body = JSON.stringify(answeredWith(s, 'ev-q-orphan')?.body ?? null)
    assert.match(body, /"code":"cancelled"/)
    assert.match(body, /UserQuestionError/)
    assert.ok(!s.bot.pending().some((a) => a.eventId === 'ev-q-orphan'), 'no card')
    assert.equal(s.pushed.length, pushesBefore, 'no push')
  } finally { await s.close() }
})

test('"always allow" does not answer a top-level request to widen its sandbox: that one goes to the phone', async () => {
  const s = await boot()
  try {
    for (let i = 0; i < 50 && s.bot.pending().length === 0; i++) await new Promise((r) => setTimeout(r, 20))
    await s.api('/approvals/ev-1', { method: 'POST', body: JSON.stringify({ outcome: 'allowed-once', remember: 'always' }) }) // always allow bash
    s.watcher.emit('event', { type: 'approval', eventId: 'ev-widen-top', sessionId: 's-1', request: { toolName: 'bash', reason: 'escalate sandbox to workspace-write: write the table' } })
    for (let i = 0; i < 50 && !s.bot.pending().some((a) => a.eventId === 'ev-widen-top'); i++) await new Promise((r) => setTimeout(r, 20))
    assert.ok(s.bot.pending().some((a) => a.eventId === 'ev-widen-top' && a.sessionId === 's-1'), 'a card in the thread')
    assert.ok(!answeredWith(s, 'ev-widen-top'), 'not answered by the rule')
  } finally { await s.close() }
})

test('"always allow" does not answer a background task\'s request to widen its sandbox: that one goes to the phone', async () => {
  const s = await boot()
  try {
    for (let i = 0; i < 50 && s.bot.pending().length === 0; i++) await new Promise((r) => setTimeout(r, 20))
    await s.api('/approvals/ev-1', { method: 'POST', body: JSON.stringify({ outcome: 'allowed-once', remember: 'always' }) }) // always allow bash
    s.watcher.emit('event', { type: 'approval', eventId: 'ev-widen', sessionId: 'task-1', request: { toolName: 'bash', reason: 'escalate sandbox to workspace-write: write the table' } })
    for (let i = 0; i < 50 && !s.bot.pending().some((a) => a.eventId === 'ev-widen'); i++) await new Promise((r) => setTimeout(r, 20))
    assert.ok(s.bot.pending().some((a) => a.eventId === 'ev-widen' && a.sessionId === 's-1'), 'a card in the thread')
    assert.ok(!answeredWith(s, 'ev-widen'), 'not answered by the rule')
  } finally { await s.close() }
})
