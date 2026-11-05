import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Pocket, pocketWanted, windowSeconds } from '../src/pocket.ts'
import { Pairing } from '../src/pairing.ts'
import { MemoryDeviceStore } from '../src/devices.ts'

// Local use reaches the computer through TailPocket (docs/connection.md); a server keeps its own https.
test('pocketWanted: on for local use, off for what has its own address or asked for another way', () => {
  const local = { inContainer: false, configHost: '0.0.0.0', argv: [] as string[] }
  assert.equal(pocketWanted(local), true)
  assert.equal(pocketWanted({ ...local, tunnel: 'none' }), true, 'the config says none when no tunnel was asked for')
  assert.equal(pocketWanted({ ...local, inContainer: true }), false, 'deploy/ and Fly run the image')
  assert.equal(pocketWanted({ ...local, publicUrl: 'https://bot.example' }), false, 'a server with its own domain')
  assert.equal(pocketWanted({ ...local, tunnel: 'cloudflared' }), false)
  assert.equal(pocketWanted({ ...local, argv: ['--host', '0.0.0.0'] }), false, 'the person asked for the local network')
  assert.equal(pocketWanted({ ...local, configHost: '192.168.1.5' }), false, 'a host in the config is asked for too')
  assert.equal(pocketWanted({ ...local, argv: ['--no-tailpocket'] }), false)
})

test('windowSeconds: TailPocket opens a window for at most 15 minutes, at least one', () => {
  assert.equal(windowSeconds(12 * 60 * 60_000), 900)
  assert.equal(windowSeconds(10 * 60_000), 600)
  assert.equal(windowSeconds(1000), 60)
})

function fakeHost() {
  const calls = { revoked: [] as string[], pairs: [] as { ttl?: number; payload?: string }[], closed: 0 }
  let resolvePaired: (p: { phone: string; device: string }) => void = () => {}
  const host = {
    allowed: [] as string[],
    async pair(o: { ttl?: number; payload?: string }) {
      calls.pairs.push(o)
      return { qr: `tailpocket1:${calls.pairs.length}`, expiresAt: new Date(0), paired: new Promise((r) => { resolvePaired = r as never }), closed: new Promise(() => {}), cancel() {} }
    },
    async revoke(p: string) { calls.revoked.push(p) },
    async close() { calls.closed++ },
  }
  return { host, calls, paired: (phone: string) => resolvePaired({ phone, device: 'Pixel' }) }
}

async function open(start?: (o: Record<string, unknown>) => unknown) {
  const dir = mkdtempSync(join(tmpdir(), 'pocket-'))
  const f = fakeHost()
  let opts: { identity?: string; allowed?: string[]; save?: (s: unknown) => Promise<void>; forward?: string } = {}
  const pocket = await Pocket.open({ statePath: join(dir, 'tailpocket.json'), forward: '127.0.0.1:3850', name: 'Studio Mac', start: (async (o: typeof opts) => { opts = o; await start?.(o as never); return f.host }) as never })
  return { dir, ...f, pocket, opts: () => opts }
}
const tick = () => new Promise((r) => setTimeout(r, 5))

test('the state holds private keys: it stays 0600 and comes back after a restart, with which device is which phone', async () => {
  const a = await open()
  await a.opts().save!({ identity: 'node-private', allowed: ['nodekey:a'] })
  const path = join(a.dir, 'tailpocket.json')
  assert.equal(statSync(path).mode & 0o777, 0o600)
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).identity, 'node-private')
  let restored: { identity?: string; allowed?: string[] } = {}
  await Pocket.open({ statePath: path, forward: '127.0.0.1:3850', start: (async (o: typeof restored) => { restored = o; return a.host }) as never })
  assert.equal(restored.identity, 'node-private')
  assert.deepEqual(restored.allowed, ['nodekey:a'])
})

test('the Boop pairing code goes to the phone inside the tunnel, never in the QR', async () => {
  const a = await open()
  const w = await a.pocket.window('123456', 900)
  assert.equal(w.qr, 'tailpocket1:1')
  assert.deepEqual(a.calls.pairs[0], { ttl: 900, payload: '123456' })
  assert.doesNotMatch(w.qr, /123456/)
})

for (const order of ['phone first', 'device first']) {
  test(`removing a device cuts its phone off the tunnel (${order})`, async () => {
    const a = await open()
    await a.pocket.window('123456', 900)
    if (order === 'phone first') { a.paired('nodekey:p1'); await tick(); await a.pocket.claimed('123456', 'd1') }
    else { await a.pocket.claimed('123456', 'd1'); a.paired('nodekey:p1'); await tick() }
    await tick()
    await a.pocket.deviceRevoked('other')
    assert.deepEqual(a.calls.revoked, [], 'not another device')
    await a.pocket.deviceRevoked('d1')
    assert.deepEqual(a.calls.revoked, ['nodekey:p1'])
    const saved = JSON.parse(readFileSync(join(a.dir, 'tailpocket.json'), 'utf8'))
    assert.deepEqual(saved.phones, {})
  })
}

test('which device is which phone survives a restart, so a device removed later is still cut off', async () => {
  const a = await open()
  await a.pocket.window('123456', 900)
  a.paired('nodekey:p1'); await tick()
  await a.pocket.claimed('123456', 'd1'); await tick()
  const f = fakeHost()
  const again = await Pocket.open({ statePath: join(a.dir, 'tailpocket.json'), forward: '127.0.0.1:3850', start: (async () => f.host) as never })
  await again.deviceRevoked('d1')
  assert.deepEqual(f.calls.revoked, ['nodekey:p1'])
})

test('a phone paired again takes over its entry: removing the old device leaves it connected', async () => {
  const a = await open()
  await a.pocket.window('111111', 900); a.paired('nodekey:p1'); await tick(); await a.pocket.claimed('111111', 'old'); await tick()
  await a.pocket.window('222222', 900); a.paired('nodekey:p1'); await tick(); await a.pocket.claimed('222222', 'new'); await tick()
  await a.pocket.deviceRevoked('old')
  assert.deepEqual(a.calls.revoked, [])
  await a.pocket.deviceRevoked('new')
  assert.deepEqual(a.calls.revoked, ['nodekey:p1'])
})

test('Pairing tells who claimed which code; a refused code tells nobody', async () => {
  const seen: [string, string][] = []
  const devices = new MemoryDeviceStore()
  const p = new Pairing(devices, { onClaim: async (code, id) => { seen.push([code, id]) } })
  const code = p.create()
  assert.equal(await p.claim('000000' === code ? '000001' : '000000', 'x'), null)
  assert.deepEqual(seen, [])
  const token = await p.claim(code, 'iPhone')
  const d = await devices.lookup(token!)
  assert.deepEqual(seen, [[code, d!.id]])
})
