// Pairing and reconnection between a phone and its computer (REGRESSION.md, "Pairing and reconnection").
// The phone's /events socket drops (a tunnel that went away, a phone that slept): the bot lets go of what that socket
// followed, and a new socket follows the thread again from a clean snapshot. The computer restarts: a phone it paired
// before is let back in with the token it already has, and one removed before the restart stays out.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { createBotServer } from '../src/server.ts'
import { FileDeviceStore, MemoryDeviceStore, type DeviceStore } from '../src/devices.ts'
import { Pairing } from '../src/pairing.ts'

const AT = 1700000000000
const userRecord = (id: string, text: string, i: number) => ({ type: 'event', event: { type: 'user/message', time: AT + i, data: { id, content: [{ type: 'text', text }], source: { kind: 'user' } } } })

/** A harness whose thread grows as messages arrive; it counts the follows still running. */
function fakeHarness() {
  const records: unknown[] = []
  const live = new Set<(f: unknown) => void>()
  return {
    live, records,
    harness: {
      kind: 'fake', events: { on() {}, clientId: 'c' },
      async createSession() { return { sessionId: 'main' } },
      async listSessions() { return [{ sessionId: 'main', updatedAt: AT, running: false, blank: false }] },
      async prompt(_id: string, text: string) { const r = userRecord(`u${records.length}`, text, records.length); records.push(r); for (const f of live) f({ type: 'event', ...r }) },
      async answer() {}, async cancel() { return true }, async rpc() { return {} as never }, async close() {},
      async follow(_id: string, onFrame: (f: unknown) => void) {
        live.add(onFrame)
        onFrame({ type: 'snapshot', header: {}, records: [...records], projections: { values: { title: '' } } })
        return () => { live.delete(onFrame) }
      },
    },
  }
}

async function boot(devices: DeviceStore, harness: unknown, port = 0) {
  const pairing = new Pairing(devices)
  const bot = await createBotServer({ dsh: { origin: 'http://127.0.0.1:9', cookie: 'c=1' }, devices, pairing, harness: harness as never, watcher: { clientId: 'c', on() {} } as never, host: '127.0.0.1', port, workspace: mkdtempSync(join(tmpdir(), 'reconnect-ws-')) })
  return { bot, pairing }
}

/** The app's way in: a one-time ticket, then /events?ticket= (mobile/src/state.ts connectEvents). Resolves with the socket and the frames it got. */
async function openEvents(origin: string, token: string) {
  const r = await fetch(`${origin}/ws-ticket`, { method: 'POST', headers: { authorization: `Bearer ${token}` } })
  if (r.status !== 200) return { status: r.status }
  const { ticket } = await r.json() as { ticket: string }
  const ws = new WebSocket(`${origin.replace('http', 'ws')}/events?ticket=${ticket}`)
  const frames: { type: string; rows?: { kind: string; text?: string }[] }[] = []
  ws.on('message', (m) => frames.push(JSON.parse(m.toString())))
  await new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject) })
  return { status: 200, ws, frames }
}
const until = async (ok: () => boolean, what: string) => { for (let i = 0; i < 100 && !ok(); i++) await new Promise((r) => setTimeout(r, 20)); assert.ok(ok(), what) }

test('a socket that drops lets go of its thread; a new one follows it again and gets what was said in between', async () => {
  const h = fakeHarness()
  const devices = new MemoryDeviceStore(); const token = await devices.issue('Phone')
  const { bot } = await boot(devices, h.harness)
  const post = (text: string) => fetch(`${bot.origin}/threads/main/messages`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ text }) })
  try {
    const first = await openEvents(bot.origin, token)
    first.ws!.send(JSON.stringify({ type: 'follow', sessionId: 'main' }))
    await until(() => h.live.size === 1, 'the first socket follows the thread')
    assert.equal((await post('before the drop')).status, 200)
    // the phone goes away without a close handshake: the tunnel dropped
    first.ws!.terminate()
    await until(() => h.live.size === 0, 'the dropped socket no longer follows the thread')
    assert.equal((await post('while the phone was away')).status, 200)
    const second = await openEvents(bot.origin, token)
    second.ws!.send(JSON.stringify({ type: 'follow', sessionId: 'main' }))
    await until(() => second.frames.some((f) => f.type === 'snapshot'), 'the new socket gets a snapshot')
    const snap = second.frames.find((f) => f.type === 'snapshot')!
    assert.deepEqual(snap.rows!.filter((r) => r.kind === 'you').map((r) => r.text), ['before the drop', 'while the phone was away'])
    assert.equal(h.live.size, 1, 'one follow for the one socket left')
    second.ws!.close()
  } finally { await bot.close() }
})

test('the computer restarts: a phone paired before is let back in with its token; one removed before stays out', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'reconnect-devices-')), 'devices.json')
  const h = fakeHarness()
  let { bot, pairing } = await boot(await FileDeviceStore.open(file), h.harness)
  const pair = async (name: string) => {
    const r = await fetch(`${bot.origin}/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: pairing.create(), name }) })
    assert.equal(r.status, 200); return (await r.json() as { token: string }).token
  }
  const kept = await pair('Kept phone')
  const removed = await pair('Removed phone')
  const me = (t: string) => fetch(`${bot.origin}/me`, { headers: { authorization: `Bearer ${t}` } })
  const removedId = (await (await me(removed)).json() as { device: { id: string } }).device.id
  assert.equal((await fetch(`${bot.origin}/devices/${removedId}`, { method: 'DELETE', headers: { authorization: `Bearer ${kept}` } })).status, 200)
  const port = Number(new URL(bot.origin).port)
  await bot.close()
  ;({ bot, pairing } = await boot(await FileDeviceStore.open(file), h.harness, port))
  try {
    assert.equal((await me(kept)).status, 200, 'the kept phone opens /me after the restart')
    const events = await openEvents(bot.origin, kept)
    assert.equal(events.status, 200, 'and its events socket')
    events.ws!.close()
    assert.equal((await me(removed)).status, 401, 'the removed phone is refused after the restart')
    assert.equal((await openEvents(bot.origin, removed)).status, 401, 'and gets no events ticket')
  } finally { await bot.close() }
})
