import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, request, type IncomingMessage } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate, setTimeout } from 'node:timers/promises'
import { WebSocketServer, WebSocket } from 'ws'
import { createBotServer, type Settings } from '../src/server.ts'
import { MemoryDeviceStore } from '../src/devices.ts'
import { Compliance } from '../src/compliance.ts'
import type { Harness } from '../src/harness.ts'
import { Pairing } from '../src/pairing.ts'

interface Seen { url: string; headers: IncomingMessage['headers']; body: string }

async function fakeDsh() {
  const seen: Seen[] = []
  const wsFrames: string[] = []
  const srv = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      seen.push({ url: req.url ?? '', headers: req.headers, body })
      if (req.headers.cookie !== 'dsh-auth-x=ok') { res.writeHead(401); res.end(); return }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'server-response', rpcId: 'r', result: { ok: true, value: { echo: body } } }))
    })
  })
  const wss = new WebSocketServer({ noServer: true })
  srv.on('upgrade', (req, socket, head) => {
    seen.push({ url: req.url ?? '', headers: req.headers, body: '' })
    if (req.headers.cookie !== 'dsh-auth-x=ok') { socket.destroy(); return }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on('message', (m) => { wsFrames.push(m.toString()); ws.send(JSON.stringify({ type: 'item', streamId: '1', value: { type: 'ready', clientId: 'c1' } })) })
    })
  })
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
  const port = (srv.address() as { port: number }).port
  return { origin: `http://127.0.0.1:${port}`, seen, wsFrames, clients: wss.clients, close: () => { wss.close(); srv.close() } }
}

async function consentProxy(t: TestContext) {
  const dsh = await fakeDsh()
  const root = await mkdtemp(join(tmpdir(), 'bot-proxy-consent-'))
  let state: Settings = { assistantName: 'Boop', mainSessionId: null, language: 'en', age: 'adult' }
  const settings = { get: async () => state, set: async (patch: Partial<Settings>) => (state = { ...state, ...patch }) }
  const compliance = await Compliance.open(root, { settings, model: { provider: 'deepseek-official', model: 'deepseek-flash' }, origin: () => dsh.origin })
  const devices = new MemoryDeviceStore()
  const token = await devices.issue('phone')
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
  const bot = await createBotServer({ dsh: { origin: dsh.origin, cookie: 'dsh-auth-x=ok' }, devices, settings, compliance })
  t.after(async () => { await bot.close(); dsh.close(); await rm(root, { recursive: true, force: true }) })
  const call = (path: string, method = 'POST', body = method === 'GET' ? undefined : {}) => fetch(`${bot.origin}${path}`, { method, headers, body: JSON.stringify(body) })
  const consent = async (ai: boolean) => assert.equal((await call('/consent', 'PUT', { ai })).status, 200)
  const mux = () => new WebSocket(`${bot.origin.replace(/^http/, 'ws')}/api/remote.mux`, { headers })
  return { call, consent, dsh, mux, compliance, devices, origin: bot.origin, headers }
}

test('bot forwards /api with the dsh cookie and strips the device Authorization header', async () => {
  const dsh = await fakeDsh()
  const devices = new MemoryDeviceStore()
  const token = await devices.issue('phone-1')
  const bot = await createBotServer({ dsh: { origin: dsh.origin, cookie: 'dsh-auth-x=ok' }, devices, host: '127.0.0.1', port: 0 })
  try {
    const r = await fetch(`${bot.origin}/api/session/list`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: '{"hello":1}',
    })
    assert.equal(r.status, 200)
    assert.equal((await r.json() as { result: { value: { echo: string } } }).result.value.echo, '{"hello":1}')
    const fwd = dsh.seen.at(-1)!
    assert.equal(fwd.url, '/api/session/list')
    assert.equal(fwd.headers.cookie, 'dsh-auth-x=ok')
    assert.equal(fwd.headers.authorization, undefined)
  } finally { await bot.close(); dsh.close() }
})

test('bot refuses /api without a valid device token and never contacts dsh', async () => {
  const dsh = await fakeDsh()
  const bot = await createBotServer({ dsh: { origin: dsh.origin, cookie: 'dsh-auth-x=ok' }, devices: new MemoryDeviceStore(), host: '127.0.0.1', port: 0 })
  try {
    const none = await fetch(`${bot.origin}/api/session/list`, { method: 'POST' })
    assert.equal(none.status, 401)
    const bad = await fetch(`${bot.origin}/api/session/list`, { method: 'POST', headers: { authorization: 'Bearer nope' } })
    assert.equal(bad.status, 401)
    assert.equal(dsh.seen.length, 0)
  } finally { await bot.close(); dsh.close() }
})

test('bot bridges /api/remote.mux as a WebSocket with the dsh cookie', async () => {
  const dsh = await fakeDsh()
  const devices = new MemoryDeviceStore()
  const token = await devices.issue('phone-1')
  const bot = await createBotServer({ dsh: { origin: dsh.origin, cookie: 'dsh-auth-x=ok' }, devices, host: '127.0.0.1', port: 0 })
  try {
    const ws = new WebSocket(`${bot.origin.replace('http', 'ws')}/api/remote.mux`, { headers: { authorization: `Bearer ${token}` } })
    const first = await new Promise<string>((resolve, reject) => {
      ws.on('open', () => ws.send(JSON.stringify({ type: 'open', streamId: '1', endpoint: '$events', payload: { args: {} } })))
      ws.on('message', (m) => resolve(m.toString()))
      ws.on('error', reject)
    })
    assert.equal(JSON.parse(first).value.type, 'ready')
    assert.equal(dsh.wsFrames.length, 1)
    assert.equal(dsh.seen.at(-1)!.headers.cookie, 'dsh-auth-x=ok')
    ws.close()
  } finally { await bot.close(); dsh.close() }
})

test('bot refuses the WebSocket upgrade without a device token', async () => {
  const dsh = await fakeDsh()
  const bot = await createBotServer({ dsh: { origin: dsh.origin, cookie: 'dsh-auth-x=ok' }, devices: new MemoryDeviceStore(), host: '127.0.0.1', port: 0 })
  try {
    const ws = new WebSocket(`${bot.origin.replace('http', 'ws')}/api/remote.mux`)
    const err = await new Promise<Error>((resolve) => { ws.on('error', resolve); ws.on('open', () => resolve(new Error('opened'))) })
    assert.match(err.message, /401/)
    assert.equal(dsh.seen.length, 0)
  } finally { await bot.close(); dsh.close() }
})

test('revoking a paired device cuts its events and mux sockets, including the upstream, but not another device', async () => {
  const dsh = await fakeDsh()
  const devices = new MemoryDeviceStore()
  const pairing = new Pairing(devices)
  const otherToken = await devices.issue('other')
  const bot = await createBotServer({ dsh: { origin: dsh.origin, cookie: 'dsh-auth-x=ok' }, devices, pairing })
  const origin = bot.origin.replace('http', 'ws')
  const wait = (ws: WebSocket, event: 'open' | 'message' | 'close') => once(ws, event, { signal: AbortSignal.timeout(2000) })
  try {
    const paired = await fetch(`${bot.origin}/pair`, { method: 'POST', body: JSON.stringify({ name: 'phone', code: pairing.create() }) })
    assert.equal(paired.status, 200)
    const { token } = await paired.json() as { token: string }
    const headers = { authorization: `Bearer ${token}` }
    const me = await fetch(`${bot.origin}/me`, { headers })
    const { device } = await me.json() as { device: { id: string } }
    const ticket = async () => (await (await fetch(`${bot.origin}/ws-ticket`, { method: 'POST', headers })).json() as { ticket: string }).ticket

    const events = new WebSocket(`${origin}/events?ticket=${await ticket()}`)
    assert.equal(JSON.parse((await wait(events, 'message'))[0].toString()).type, 'hello')
    const mux = new WebSocket(`${origin}/api/remote.mux`, { headers })
    await wait(mux, 'open')
    const other = new WebSocket(`${origin}/events`, ['bearer', otherToken])
    await wait(other, 'message')
    const unusedTicket = await ticket()
    const [upstream] = dsh.clients
    assert.ok(upstream)
    const disconnected = Promise.all([events, mux, upstream].map((ws) => wait(ws, 'close')))
    const [revoked] = await Promise.all([fetch(`${bot.origin}/devices/${device.id}`, { method: 'DELETE', headers }), disconnected])
    assert.equal(revoked.status, 200)

    const pong = wait(other, 'message')
    other.send(JSON.stringify({ type: 'ping' }))
    assert.equal(JSON.parse((await pong)[0].toString()).type, 'pong')
    await Promise.all([
      new WebSocket(`${origin}/events?ticket=${unusedTicket}`),
      new WebSocket(`${origin}/api/remote.mux`, { headers }),
    ].map((ws) => assert.rejects(wait(ws, 'open'), /401/)))
    assert.equal(dsh.seen.length, 1, 'a revoked device cannot reach the upstream again')
  } finally { await bot.close(); dsh.close() }
})

test('revoking a device also aborts a mux upgrade still waiting for the upstream', async () => {
  const srv = createServer()
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
  const port = (srv.address() as { port: number }).port
  const devices = new MemoryDeviceStore()
  const token = await devices.issue('phone')
  const [device] = await devices.list()
  const bot = await createBotServer({ dsh: { origin: `http://127.0.0.1:${port}`, cookie: 'dsh-auth-x=ok' }, devices })
  const headers = { authorization: `Bearer ${token}` }
  const signal = AbortSignal.timeout(2000)
  try {
    const upgrading = once(srv, 'upgrade', { signal })
    const mux = new WebSocket(`${bot.origin.replace('http', 'ws')}/api/remote.mux`, { headers })
    const blocked = assert.rejects(once(mux, 'open', { signal }), /socket hang up/)
    const [, upstream] = await upgrading
    upstream.resume()
    const upstreamEnded = once(upstream, 'end', { signal })
    try {
      const [revoked] = await Promise.all([fetch(`${bot.origin}/devices/${device.id}`, { method: 'DELETE', headers }), blocked, upstreamEnded])
      assert.equal(revoked.status, 200)
    } finally { upstream.destroy() }
  } finally { await bot.close(); srv.close() }
})

test('revoking a device cancels a thread subscription that finishes opening after disconnect', async () => {
  const started = new EventEmitter()
  const release = Promise.withResolvers<void>()
  const active = new Set<string>()
  let cancels = 0
  const harness: Harness = {
    kind: 'fake', events: { on() {}, clientId: null },
    async createSession() { return { sessionId: 'main' } }, async listSessions() { return [] },
    async prompt() {}, async answer() {}, async cancel() { return true }, async rpc() { throw new Error('unexpected RPC') }, async close() {},
    async follow(id) {
      started.emit('follow', id)
      await release.promise
      active.add(id)
      return () => { cancels++; active.delete(id) }
    },
  }
  const devices = new MemoryDeviceStore()
  const token = await devices.issue('phone')
  const [device] = await devices.list()
  const bot = await createBotServer({ dsh: { origin: 'http://127.0.0.1:9', cookie: '' }, devices, harness })
  const headers = { authorization: `Bearer ${token}` }
  const signal = AbortSignal.timeout(2000)
  try {
    const ws = new WebSocket(`${bot.origin.replace('http', 'ws')}/events`, { headers })
    await once(ws, 'open', { signal })
    const following = once(started, 'follow', { signal })
    ws.send(JSON.stringify({ type: 'follow', sessionId: 'main' }))
    assert.deepEqual(await following, ['main'])

    const [revoked] = await Promise.all([
      fetch(`${bot.origin}/devices/${device.id}`, { method: 'DELETE', headers, signal }),
      once(ws, 'close', { signal }),
    ])
    assert.equal(revoked.status, 200)
    await setImmediate()
    release.resolve()
    await setImmediate()

    assert.equal(cancels, 1, 'the late subscription must be cancelled')
    assert.equal(active.size, 0, 'no subscription remains active')
  } finally {
    release.resolve()
    await bot.close()
  }
})

test('bot drops the browser Origin and Referer before forwarding (dsh would answer 403)', async () => {
  const dsh = await fakeDsh()
  const devices = new MemoryDeviceStore()
  const token = await devices.issue('phone-1')
  const bot = await createBotServer({ dsh: { origin: dsh.origin, cookie: 'dsh-auth-x=ok' }, devices, host: '127.0.0.1', port: 0 })
  try {
    await fetch(`${bot.origin}/api/session/prompt`, { method: 'POST', headers: { authorization: `Bearer ${token}`, origin: bot.origin, referer: `${bot.origin}/` }, body: '{}' })
    const fwd = dsh.seen.at(-1)!
    assert.equal(fwd.headers.origin, undefined)
    assert.equal(fwd.headers.referer, undefined)
  } finally { await bot.close(); dsh.close() }
})

for (const path of [
  '/api/session/prompt', '/api/session/steer', '/api/session/updateQueue', '/api/subagents/prompt',
  '/api/session/create', '/api/session/selectModel', '/api/commands/execute',
  '/api/goals/create', '/api/goals/edit', '/api/goals/resume', '/api/schedule/update',
  '/api/userQuestions/answer', '/api/$events/result', '/api/remote.mux', '/api/newPlugin/invoke',
]) {
  test(`bot requires model consent before proxying ${path}`, async (t) => {
    const p = await consentProxy(t)
    const denied = await p.call(path)
    assert.equal(denied.status, 403)
    assert.deepEqual(await denied.json(), { error: 'ai-consent' })
    assert.deepEqual(p.dsh.seen, [])
    await p.consent(true)
    const allowed = await p.call(path)
    assert.equal(allowed.status, 200)
    await allowed.json()
    assert.deepEqual(p.dsh.seen.map((r) => r.url), [path])
  })
}

for (const [path, method] of [
  ['/api/file?path=/workspace/example.png', 'GET'],
  ['/api/session/attachment', 'POST'],
  ['/api/session/cancel', 'POST'],
  ['/api/session/list', 'POST'],
  ['/api/session/page', 'POST'],
  ['/api/session/projections', 'POST'],
  ['/api/session/search', 'POST'],
]) {
  test(`bot still proxies model-free ${method} ${path} without consent`, async (t) => {
    const p = await consentProxy(t)
    const response = await p.call(path, method)
    assert.equal(response.status, 200)
    await response.json()
    assert.deepEqual(p.dsh.seen.map((r) => r.url), [path])
  })
}

test('bot returns HTTP 403 for a mux upgrade without consent, and opens it with consent', async (t) => {
  const p = await consentProxy(t)
  const denied = p.mux()
  const [error] = await once(denied, 'error')
  assert.match(error.message, /Unexpected server response: 403/)
  assert.deepEqual(p.dsh.seen, [])

  await p.consent(true)
  const allowed = p.mux()
  await once(allowed, 'open')
  const frame = JSON.stringify({ type: 'open', streamId: '1', endpoint: '$events', payload: { args: {} } })
  allowed.send(frame)
  await once(allowed, 'message')
  assert.deepEqual(p.dsh.wsFrames, [frame])

  await p.consent(false)
  allowed.send(frame)
  const [code, reason] = await once(allowed, 'close')
  assert.equal(code, 1008)
  assert.equal(reason.toString(), 'ai-consent')
  assert.deepEqual(p.dsh.wsFrames, [frame])
})

test('revoking a device during its mux consent check prevents the upstream connection', { timeout: 5000 }, async (t) => {
  const within = <T>(step: string, promise: Promise<T>) => Promise.race([
    promise,
    setTimeout(1000, undefined, { ref: false }).then(() => { throw new Error(`Timed out: ${step}`) }),
  ])
  const p = await within('start proxy', consentProxy(t))
  const [device] = await within('list devices', p.devices.list())
  const entered = Promise.withResolvers<void>()
  const gate = Promise.withResolvers<null>()
  t.mock.method(p.compliance, 'gate', () => { entered.resolve(); return gate.promise })
  const ws = p.mux()
  try {
    await Promise.all([
      assert.rejects(once(ws, 'open', { signal: AbortSignal.timeout(2500) }), /Unexpected server response: 401/),
      (async () => {
        try {
          await within('enter mux gate', entered.promise)
          await within('revoke device', p.devices.revoke(device.id))
        } finally { gate.resolve(null) }
      })(),
    ])
    assert.deepEqual(p.dsh.seen, [])
  } finally {
    ws.on('error', () => {})
    ws.terminate()
  }
})

test('revoking a device during a ticket-authenticated mux consent check rejects the upgrade', { timeout: 5000 }, async (t) => {
  const p = await consentProxy(t)
  const [device] = await p.devices.list()
  const headers = { authorization: p.headers.authorization }
  const response = await fetch(`${p.origin}/ws-ticket`, { method: 'POST', headers, signal: AbortSignal.timeout(1000) })
  assert.equal(response.status, 200)
  const { ticket } = await response.json() as { ticket: string }
  assert.ok(ticket)

  const gate = Promise.withResolvers<null>()
  const events = new EventEmitter()
  const entered = once(events, 'gate', { signal: AbortSignal.timeout(1000) })
  t.mock.method(p.compliance, 'gate', () => { events.emit('gate'); return gate.promise })
  const ws = new WebSocket(`${p.origin.replace(/^http/, 'ws')}/api/remote.mux?ticket=${ticket}`)
  try {
    await Promise.all([
      assert.rejects(once(ws, 'open', { signal: AbortSignal.timeout(2500) }), /Unexpected server response: 401/),
      (async () => {
        try {
          await entered
          const status = await new Promise<number | undefined>((resolve, reject) => {
            request(`${p.origin}/devices/${device.id}`, {
              method: 'DELETE', headers, agent: false, signal: AbortSignal.timeout(1000),
            }, (res) => {
              res.on('error', reject)
              res.on('end', () => resolve(res.statusCode))
              res.resume()
            }).on('error', reject).end()
          })
          assert.equal(status, 200)
        } finally { gate.resolve(null) }
      })(),
    ])
    assert.deepEqual(p.dsh.seen, [])
  } finally {
    ws.on('error', () => {})
    ws.terminate()
  }
})
