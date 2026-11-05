import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocketServer, WebSocket } from 'ws'
import { createBotServer } from '../src/server.ts'
import { MemoryDeviceStore } from '../src/devices.ts'
import { PushService } from '../src/push.ts'
import { EventWatcher } from '../src/events.ts'

// When the main thread finishes a turn and no phone is connected, the person
// gets a push with the assistant's last line. Fake dsh: $events emits
// api-session/status, and session/follow replays one assistant message.
async function fakeDsh() {
  const srv = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'server-response', rpcId: 'r', result: { ok: true, value: {} } })) })
  const wss = new WebSocketServer({ server: srv, path: '/api/remote.mux' })
  const sockets: WebSocket[] = []
  wss.on('connection', (ws) => {
    sockets.push(ws)
    ws.on('message', (m) => {
      const f = JSON.parse(m.toString())
      const send = (v: unknown) => ws.send(JSON.stringify({ type: 'item', streamId: f.streamId, value: v }))
      if (f.type === 'open' && f.endpoint === '$events') send({ type: 'ready', clientId: 'c1', host: { home: '/x' } })
      if (f.type === 'open' && f.endpoint === 'session/follow') {
        send({ type: 'snapshot', header: { id: 'main' }, cursor: 0, records: [], hasMore: false, projections: { values: {} } })
        ;(ws as unknown as { follows: string[] }).follows = [(f.payload.args.request.address.sessionId)]
      }
    })
  })
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
  const port = (srv.address() as { port: number }).port
  const emit = (v: unknown) => { for (const s of sockets) s.send(JSON.stringify({ type: 'item', streamId: 'events', value: v })) }
  const followEvent = (ev: unknown) => { for (const s of sockets) s.send(JSON.stringify({ type: 'item', streamId: '1', value: { type: 'event', event: ev } })) }
  return { origin: `http://127.0.0.1:${port}`, emit, followEvent, close: () => { wss.close(); srv.close() } }
}

test('turn end on the main thread with no phone connected pushes the last assistant line', async () => {
  const dsh = await fakeDsh()
  const dir = mkdtempSync(join(tmpdir(), 'finish-')); mkdirSync(join(dir, 'ws'))
  const pushed: { title: string; body: string }[] = []
  const push = await PushService.open(join(dir, 'push.json'), { sender: async (_s, p) => { pushed.push(JSON.parse(p)) } })
  await push.subscribe('d1', { endpoint: 'https://push.example/1', keys: { p256dh: 'a', auth: 'b' } })
  const watcher = new EventWatcher({ origin: dsh.origin, cookie: 'c=1' })
  let settings = { assistantName: 'Nori', mainSessionId: 'main' as string | null, language: 'auto' }
  const bot = await createBotServer({ dsh: { origin: dsh.origin, cookie: 'c=1' }, devices: new MemoryDeviceStore(), push, watcher, workspace: join(dir, 'ws'), host: '127.0.0.1', port: 0, settings: { get: async () => settings, set: async (p) => (settings = { ...settings, ...p }) } })
  watcher.start()
  try {
    await new Promise((r) => setTimeout(r, 150))
    dsh.emit({ type: 'emit', event: 'api-session/status', args: ['main', true] })
    await new Promise((r) => setTimeout(r, 600))
    dsh.followEvent({ type: 'assistant/message', seq: 5, data: { message: { role: 'assistant', content: [{ type: 'text', text: 'Booked the table for 7pm. Confirmation #4821.' }] } } })
    dsh.followEvent({ type: 'turn/end', seq: 6, data: { turn: 1, reason: { kind: 'completed' } } })
    dsh.emit({ type: 'emit', event: 'api-session/status', args: ['main', false] })
    for (let i = 0; i < 40 && pushed.length === 0; i++) await new Promise((r) => setTimeout(r, 50))
    assert.equal(pushed.length, 1)
    assert.equal(pushed[0].title, 'Nori is done') // distinct from "has a question" for screen readers
    assert.match(pushed[0].body, /Booked the table/)
  } finally { await watcher.stop(); await bot.close(); dsh.close() }
})

test('no push when a phone is connected to /events', async () => {
  const dsh = await fakeDsh()
  const dir = mkdtempSync(join(tmpdir(), 'finish-')); mkdirSync(join(dir, 'ws'))
  const pushed: unknown[] = []
  const push = await PushService.open(join(dir, 'push.json'), { sender: async (_s, p) => { pushed.push(JSON.parse(p)) } })
  await push.subscribe('d1', { endpoint: 'https://push.example/1', keys: { p256dh: 'a', auth: 'b' } })
  const devices = new MemoryDeviceStore(); const token = await devices.issue('phone')
  const watcher = new EventWatcher({ origin: dsh.origin, cookie: 'c=1' })
  const settings = { assistantName: 'Nori', mainSessionId: 'main', language: 'auto' }
  const bot = await createBotServer({ dsh: { origin: dsh.origin, cookie: 'c=1' }, devices, push, watcher, workspace: join(dir, 'ws'), host: '127.0.0.1', port: 0, settings: { get: async () => settings, set: async () => settings } })
  watcher.start()
  const phone = new WebSocket(`${bot.origin.replace('http', 'ws')}/events`, ['bearer', token])
  await new Promise((r) => phone.on('open', r))
  try {
    await new Promise((r) => setTimeout(r, 150))
    dsh.emit({ type: 'emit', event: 'api-session/status', args: ['main', true] })
    await new Promise((r) => setTimeout(r, 600))
    dsh.followEvent({ type: 'assistant/message', seq: 5, data: { message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } } })
    dsh.emit({ type: 'emit', event: 'api-session/status', args: ['main', false] })
    await new Promise((r) => setTimeout(r, 400))
    assert.equal(pushed.length, 0)
  } finally { phone.close(); await watcher.stop(); await bot.close(); dsh.close() }
})
