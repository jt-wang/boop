import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage } from 'node:http'
import { WebSocketServer, WebSocket } from 'ws'
import { createBotServer } from '../src/server.ts'
import { MemoryDeviceStore } from '../src/devices.ts'

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
  return { origin: `http://127.0.0.1:${port}`, seen, wsFrames, close: () => { wss.close(); srv.close() } }
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
