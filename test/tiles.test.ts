import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Tiles, tilePath } from '../src/tiles.ts'

// Map tiles for the interfaces the assistant writes (src/module-kit/map.tsx): a module may only fetch the bot, so the
// bot fetches OpenStreetMap's tiles for it, under the tile usage policy (operations.osmfoundation.org/policies/tiles,
// read 2026-11-02): a User-Agent naming the app, tiles kept at least 7 days, only tiles someone is looking at.
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'tiles-'))
  const calls: { url: string; ua: string | null }[] = []
  const tiles = new Tiles(dir, async (url, init) => {
    calls.push({ url: String(url), ua: new Headers(init?.headers).get('user-agent') })
    return new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } })
  })
  return { dir, calls, tiles, done: () => rmSync(dir, { recursive: true, force: true }) }
}

test('tilePath: z/x/y.png inside the world at that zoom; anything else is no tile', () => {
  assert.deepEqual(tilePath('/tiles/12/3638/1612.png'), { z: 12, x: 3638, y: 1612 })
  assert.deepEqual(tilePath('/tiles/0/0/0.png'), { z: 0, x: 0, y: 0 })
  for (const p of ['/tiles/12/4096/0.png', '/tiles/20/0/0.png', '/tiles/-1/0/0.png', '/tiles/3/1/1.jpg', '/tiles/3/1/1.png/..', '/tiles/a/1/1.png', '/tiles/3/1.png']) assert.equal(tilePath(p), null, p)
})

test('a tile comes from OpenStreetMap once, with the app named; the next ask is the kept copy', async () => {
  const s = setup()
  try {
    const a = await s.tiles.get({ z: 12, x: 3638, y: 1612 })
    assert.deepEqual(a, PNG)
    assert.equal(s.calls.length, 1)
    assert.equal(s.calls[0]!.url, 'https://tile.openstreetmap.org/12/3638/1612.png')
    assert.match(s.calls[0]!.ua ?? '', /^Boop\/\S+ \(\+https:\/\/\S+\)$/)
    assert.deepEqual(await s.tiles.get({ z: 12, x: 3638, y: 1612 }), PNG)
    assert.equal(s.calls.length, 1, 'kept: not fetched again')
  } finally { s.done() }
})

test('a kept tile older than 7 days is fetched again; a failed fetch is no tile and keeps nothing', async () => {
  const s = setup()
  try {
    await s.tiles.get({ z: 5, x: 1, y: 2 })
    const old = (Date.now() - 8 * 86400_000) / 1000
    utimesSync(join(s.dir, '5', '1', '2.png'), old, old)
    await s.tiles.get({ z: 5, x: 1, y: 2 })
    assert.equal(s.calls.length, 2)
    const failing = new Tiles(s.dir, async () => new Response('no', { status: 429 }))
    assert.equal(await failing.get({ z: 6, x: 1, y: 1 }), null)
    assert.equal(await s.tiles.get({ z: 6, x: 1, y: 1 }).then(() => s.calls.length), 3, 'nothing kept from the failure')
  } finally { s.done() }
})

test('prune removes what is past the 7 days and keeps the rest (a sandbox volume is 1 GB)', async () => {
  const s = setup()
  try {
    await s.tiles.get({ z: 5, x: 1, y: 2 })
    await s.tiles.get({ z: 5, x: 1, y: 3 })
    const old = (Date.now() - 8 * 86400_000) / 1000
    utimesSync(join(s.dir, '5', '1', '2.png'), old, old)
    assert.equal(await s.tiles.prune(), 1)
    assert.equal(existsSync(join(s.dir, '5', '1', '2.png')), false)
    assert.equal(existsSync(join(s.dir, '5', '1', '3.png')), true)
    assert.equal(await new Tiles(join(s.dir, 'never-made')).prune(), 0, 'no folder yet is nothing to do')
  } finally { s.done() }
})

test('GET /ui/:id/tiles/z/x/y.png answers with the module token (a canvas can send no header); without it no tile leaves the bot', async () => {
  const { createBotServer } = await import('../src/server.ts')
  const { MemoryDeviceStore } = await import('../src/devices.ts')
  const s = setup()
  const harness = { kind: 'fake', events: { on() {}, clientId: 'c' }, async createSession() { return { sessionId: 'p1' } }, async listSessions() { return [] }, async prompt() {}, async answer() {}, async cancel() { return true }, async rpc() { return {} as never }, async close() {}, async follow() { return () => {} } }
  const ui = { verify: (id: string, token: string | null) => id === 'm1' && token === 'good', list: () => [], get: () => undefined }
  const bot = await createBotServer({ dsh: { origin: 'http://127.0.0.1:9', cookie: 'c=1' }, devices: new MemoryDeviceStore(), harness: harness as never, host: '127.0.0.1', port: 0, workspace: s.dir, tiles: s.tiles, ui: ui as never, settings: { get: async () => ({ assistantName: 'Nori', mainSessionId: 'main-1', language: 'en' }), set: async (p) => p as never } })
  try {
    const r = await fetch(`${bot.origin}/ui/m1/tiles/12/3638/1612.png?token=good`)
    assert.equal(r.status, 200)
    assert.equal(r.headers.get('content-type'), 'image/png')
    assert.match(r.headers.get('cache-control') ?? '', /max-age=\d{6,}/)
    assert.deepEqual(Buffer.from(await r.arrayBuffer()), PNG)
    assert.equal((await fetch(`${bot.origin}/ui/m1/tiles/12/9999/1612.png?token=good`)).status, 404)
    const before = s.calls.length
    for (const p of ['/ui/m1/tiles/12/1/1.png', '/ui/m1/tiles/12/1/1.png?token=nope', '/ui/other/tiles/12/1/1.png?token=good']) assert.equal((await fetch(`${bot.origin}${p}`)).status, 401, p)
    assert.equal((await fetch(`${bot.origin}/tiles/12/1/1.png`)).status, 404, 'the old open path is gone')
    assert.equal(s.calls.length, before, 'none of them reached OpenStreetMap')
  } finally { await bot.close(); s.done() }
})
