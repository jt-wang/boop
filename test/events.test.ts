import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { WebSocketServer } from 'ws'
import { EventWatcher, type BotEvent } from '../src/events.ts'

// Frames measured against DSH 0.2.0-rc.2 on 2026-10-26 ($events `ready`) plus the
// waterfall / cancel / emit shapes from DSH Mobile's PROTOCOL.md (0.2.1-rc.2).
async function fakeMux(script: (send: (f: unknown) => void, received: unknown[]) => void) {
  const srv = createServer()
  const wss = new WebSocketServer({ server: srv, path: '/api/remote.mux' })
  const received: unknown[] = []
  const cookies: string[] = []
  wss.on('connection', (ws, req) => {
    cookies.push(req.headers.cookie ?? '')
    ws.on('message', (m) => {
      const f = JSON.parse(m.toString())
      received.push(f)
      if (f.type === 'open' && f.endpoint === '$events') {
        const send = (v: unknown) => ws.send(JSON.stringify({ type: 'item', streamId: f.streamId, value: v }))
        send({ type: 'ready', clientId: 'client-A', host: { home: '/home/x' } })
        script(send, received)
      }
    })
  })
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
  const port = (srv.address() as { port: number }).port
  return { origin: `http://127.0.0.1:${port}`, received, cookies, close: () => { wss.close(); srv.close() } }
}

function collect(w: EventWatcher, n: number) {
  return new Promise<BotEvent[]>((resolve) => {
    const out: BotEvent[] = []
    w.on('event', (e) => { out.push(e); if (out.length === n) resolve(out) })
  })
}

test('watcher opens $events with the dsh cookie and turns waterfalls into approval and question events', async () => {
  const dsh = await fakeMux((send) => {
    send({ type: 'waterfall', event: 'approval/request', eventId: 'ev-1', agentId: 's-1', request: { toolName: 'bash', reason: 'rm -rf build' } })
    send({ type: 'waterfall', event: 'user-questions/request', eventId: 'ev-2', agentId: 's-1', request: { questions: [{ id: 'q1', prompt: 'Which?', options: ['a', 'b'] }] } })
    send({ type: 'cancel', eventId: 'ev-1' })
  })
  const w = new EventWatcher({ origin: dsh.origin, cookie: 'dsh-auth-x=ok' })
  const got = collect(w, 4)
  w.start()
  try {
    const events = await got
    assert.deepEqual(events.map((e) => e.type), ['ready', 'approval', 'question', 'cancel'])
    assert.equal(w.clientId, 'client-A')
    assert.equal(dsh.cookies[0], 'dsh-auth-x=ok')
    const a = events[1] as Extract<BotEvent, { type: 'approval' }>
    assert.equal(a.eventId, 'ev-1'); assert.equal(a.sessionId, 's-1'); assert.equal(a.request.toolName, 'bash')
    assert.equal((events[3] as Extract<BotEvent, { type: 'cancel' }>).eventId, 'ev-1')
  } finally { await w.stop(); dsh.close() }
})

test('watcher reports session status emits', async () => {
  const dsh = await fakeMux((send) => {
    send({ type: 'emit', event: 'api-session/status', args: ['s-9', true] })
    send({ type: 'emit', event: 'api-session/status', args: ['s-9', false] })
  })
  const w = new EventWatcher({ origin: dsh.origin, cookie: 'dsh-auth-x=ok' })
  const got = collect(w, 3)
  w.start()
  try {
    const events = await got
    assert.deepEqual(events.slice(1), [{ type: 'status', sessionId: 's-9', running: true }, { type: 'status', sessionId: 's-9', running: false }])
  } finally { await w.stop(); dsh.close() }
})

test('watcher reconnects after the socket drops and gets a fresh clientId', async () => {
  let n = 0
  const dsh = await fakeMux(() => {})
  const srvWss = (dsh as unknown as { close: () => void })
  const w = new EventWatcher({ origin: dsh.origin, cookie: 'dsh-auth-x=ok', reconnectMs: 50 })
  const readies: string[] = []
  const done = new Promise<void>((resolve) => w.on('event', (e) => { if (e.type === 'ready') { readies.push(w.clientId!); if (++n === 2) resolve() } }))
  w.start()
  try {
    await new Promise((r) => setTimeout(r, 100))
    w.dropForTest()
    await done
    assert.equal(readies.length, 2)
  } finally { await w.stop(); srvWss.close() }
})
