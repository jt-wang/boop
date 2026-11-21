import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { checkRoutes, listenPlan, parseRoutesFlag, Pocket, pocketWanted, routesLine, windowSeconds, type PocketRoute } from '../src/pocket.ts'
import { writeFileSync } from 'node:fs'
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

// No default is plain HTTP on the local network: without the helper local use stays on loopback; a chosen address says so.
test('listenPlan: local use stays on 127.0.0.1 with or without the helper; only a chosen address is plain on the network', () => {
  const local = { inContainer: false, configHost: '0.0.0.0', argv: [] as string[] }
  assert.deepEqual(listenPlan(local, true), { host: '127.0.0.1', pocket: true, plain: false })
  assert.deepEqual(listenPlan(local, false), { host: '127.0.0.1', pocket: false, plain: false }, 'no helper: no phone gets in, and nothing listens on 0.0.0.0')
  assert.deepEqual(listenPlan({ ...local, argv: ['--host', '0.0.0.0'] }, false), { host: '0.0.0.0', pocket: false, plain: true })
  assert.deepEqual(listenPlan({ ...local, argv: ['--no-tailpocket'] }, true), { host: '0.0.0.0', pocket: false, plain: true }, 'no TailPocket, even with the helper there')
  assert.deepEqual(listenPlan({ ...local, configHost: '192.168.1.5' }, true), { host: '192.168.1.5', pocket: false, plain: true })
  assert.equal(listenPlan({ ...local, tunnel: 'cloudflared' }, true).plain, true, 'cloudflared reaches it on loopback, but the port is still open on the network')
  assert.equal(listenPlan({ ...local, configHost: '127.0.0.1', argv: ['--host', '127.0.0.1'] }, false).plain, false, 'loopback is no network')
  assert.equal(listenPlan({ ...local, inContainer: true }, false).plain, false, 'deploy/ and Fly: TLS in front')
  assert.equal(listenPlan({ ...local, publicUrl: 'https://bot.example' }, false).plain, false)
})

test('windowSeconds: TailPocket opens a window for at most 15 minutes, at least one', () => {
  assert.equal(windowSeconds(12 * 60 * 60_000), 900)
  assert.equal(windowSeconds(10 * 60_000), 600)
  assert.equal(windowSeconds(1000), 60)
})

function fakeHost() {
  const calls = { revoked: [] as string[], pairs: [] as { ttl?: number; payload?: string; emoji?: boolean }[], closed: 0, confirms: [] as boolean[] }
  // what the pre.4 helper answers to an emoji window: only the v2 QR, then a `request` per phone, answered with confirm
  let resolvePaired: (p: { phone: string; device: string }) => void = () => {}
  let window: EventEmitter | null = null
  const host = {
    allowed: [] as string[],
    async pair(o: { ttl?: number; payload?: string; emoji?: boolean }) {
      calls.pairs.push(o)
      window = Object.assign(new EventEmitter(), { qr2: `tailpocket2:${calls.pairs.length}`, expiresAt: new Date(0), paired: new Promise((r) => { resolvePaired = r as never }), closed: new Promise(() => {}), cancel() {}, confirm(yes: boolean) { calls.confirms.push(yes) } })
      return window as never
    },
    async revoke(p: string) { calls.revoked.push(p) },
    async close() { calls.closed++ },
  }
  return { host, calls, paired: (phone: string) => resolvePaired({ phone, device: 'Pixel' }), window: () => window! }
}
const quiet = { ask() {}, askEnded() {} }

type StartOpts = { identity?: string; allowed?: string[]; keys?: Record<string, string>; relays?: { url: string; token: string; opaque?: boolean; appAuth?: boolean }[]; noLan?: boolean; tailcatOnly?: boolean; routes?: string[]; save?: (s: unknown) => Promise<void>; forward?: string }
async function open(o: { relay?: { url: string; token: string }; noLan?: boolean; tailcatOnly?: boolean; routes?: PocketRoute[]; saved?: object } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pocket-'))
  if (o.saved) writeFileSync(join(dir, 'tailpocket.json'), JSON.stringify(o.saved))
  const f = fakeHost()
  let opts: StartOpts = {}
  const pocket = await Pocket.open({ statePath: join(dir, 'tailpocket.json'), forward: '127.0.0.1:3850', name: 'Studio Mac', relay: o.relay, noLan: o.noLan, tailcatOnly: o.tailcatOnly, routes: o.routes, start: (async (x: StartOpts) => { opts = x; return f.host }) as never })
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

// v0.3: a phone that synced its Noise key (or paired on v0.3) is only known on the encrypted routes through `keys`.
test('the phones\' Noise keys come back after a restart, saved alongside the rest', async () => {
  const a = await open()
  assert.equal(a.opts().keys, undefined, 'nothing saved yet')
  await a.opts().save!({ identity: 'node-private', allowed: ['nodekey:a'], keys: { 'nodekey:a': 'noise-a' } })
  await a.pocket.window('123456', 900, quiet); a.paired('nodekey:a'); await tick(); await a.pocket.claimed('123456', 'd1'); await tick()
  // a later save from the helper (a second phone synced) replaces the keys and keeps which device is which phone
  await a.opts().save!({ identity: 'node-private', allowed: ['nodekey:a', 'nodekey:b'], keys: { 'nodekey:a': 'noise-a', 'nodekey:b': 'noise-b' } })
  let restored: StartOpts = {}
  const f = fakeHost()
  const again = await Pocket.open({ statePath: join(a.dir, 'tailpocket.json'), forward: '127.0.0.1:3850', start: (async (o: StartOpts) => { restored = o; return f.host }) as never })
  assert.deepEqual(restored.keys, { 'nodekey:a': 'noise-a', 'nodekey:b': 'noise-b' })
  assert.deepEqual(restored.allowed, ['nodekey:a', 'nodekey:b'])
  await again.deviceRevoked('d1')
  assert.deepEqual(f.calls.revoked, ['nodekey:a'])
})

test('no relay: no relays for the helper, the local network on, and the QR is the v2 invite of an emoji window', async () => {
  const a = await open()
  assert.equal(a.opts().relays, undefined)
  assert.equal(a.opts().noLan, undefined, 'the local network route is TailPocket\'s default')
  assert.equal(a.opts().tailcatOnly, undefined)
  assert.equal((await a.pocket.window('123456', 900, quiet)).qr, 'tailpocket2:1')
  assert.equal(a.calls.pairs[0].emoji, true)
})

test('a relay: the helper registers with it end-to-end encrypted (not opaque, so no appAuth), and the QR names it', async () => {
  const a = await open({ relay: { url: 'wss://relay.example.com', token: 'relay-token' } })
  assert.deepEqual(a.opts().relays, [{ url: 'wss://relay.example.com', token: 'relay-token' }])
  assert.equal(a.opts().relays![0].opaque, undefined)
  assert.equal(a.opts().relays![0].appAuth, undefined)
  const w = await a.pocket.window('123456', 900, quiet)
  assert.equal(w.qr, 'tailpocket2:1')
  assert.deepEqual(a.calls.pairs[0], { ttl: 900, payload: '123456', emoji: true }, 'the Boop code still goes inside the tunnel')
})

test('the settings: noLan goes to the helper; Tailcat only goes alone, without the relay the helper would refuse with it', async () => {
  assert.equal((await open({ noLan: true })).opts().noLan, true)
  const only = await open({ tailcatOnly: true, noLan: true, relay: { url: 'wss://relay.example.com', token: 'relay-token' } })
  assert.equal(only.opts().tailcatOnly, true)
  assert.equal(only.opts().relays, undefined)
  assert.equal(only.opts().noLan, undefined, 'Tailcat only already has no local network route')
})

// TailPocket v0.3.2: routes, Tailcat optional. A wrong set is refused by Boop with a sentence, before the helper sees it.
test('routes: every non-empty set of tailcat, lan, relay passes; what TailPocket would refuse comes back as a sentence', () => {
  const ok = { relay: true, from: 'config' as const }
  for (const routes of [['tailcat'], ['lan'], ['relay'], ['lan', 'relay'], ['relay', 'tailcat'], ['tailcat', 'lan', 'relay']]) assert.equal(checkRoutes({ ...ok, routes }), null, routes.join(','))
  assert.equal(checkRoutes({ ...ok, routes: undefined }), null, 'unset: as in v0.3.1')
  assert.match(checkRoutes({ ...ok, routes: [] })!, /empty.*tailcat, lan, relay/)
  assert.match(checkRoutes({ ...ok, routes: ['wifi'] })!, /"wifi" is not a route/)
  assert.match(checkRoutes({ ...ok, routes: ['LAN'] })!, /"LAN" is not a route/, 'names are exact')
  assert.match(checkRoutes({ ...ok, routes: ['lan', 'lan'] })!, /"lan" is listed twice/)
  assert.match(checkRoutes({ ...ok, routes: 'lan' })!, /empty/, 'a string in config.json is not a list')
  assert.match(checkRoutes({ ...ok, routes: ['relay'], relay: false })!, /DEEPSEEK_BOT_RELAY_URL.*DEEPSEEK_BOT_RELAY_TOKEN/)
  assert.equal(checkRoutes({ ...ok, routes: ['lan'], relay: false }), null, 'no relay needed without the relay route')
  assert.match(checkRoutes({ ...ok, routes: ['lan'], noLan: true })!, /"routes" replaces "noLan" in config\.json/)
  assert.match(checkRoutes({ ...ok, routes: ['lan'], tailcatOnly: true, from: 'flag' })!, /--routes replaces --tailcat-only/)
})

test('--routes: a comma list as written; all drops the setting; nothing after it is an empty set, not every route', () => {
  assert.deepEqual(parseRoutesFlag('lan, relay'), ['lan', 'relay'])
  assert.equal(parseRoutesFlag('all'), undefined)
  assert.deepEqual(parseRoutesFlag(undefined), [])
  assert.match(checkRoutes({ routes: parseRoutesFlag(undefined), relay: false, from: 'flag' })!, /empty/)
})

test('routesLine says what a set costs: LAN only does not reach a phone away from home; no Tailcat talks to no tailcat.dev', () => {
  assert.match(routesLine(['lan']), /local network\. No Tailcat.*cannot connect/)
  assert.doesNotMatch(routesLine(['lan', 'relay']), /cannot connect/)
  assert.doesNotMatch(routesLine(['tailcat', 'lan']), /No Tailcat/)
})

test('routes go to the helper alone: no noLan or tailcatOnly beside them, the relay only when relay is in them', async () => {
  const relay = { url: 'wss://relay.example.com', token: 'relay-token' }
  const lan = await open({ routes: ['lan'], relay, noLan: true, tailcatOnly: true })
  assert.deepEqual(lan.opts().routes, ['lan'])
  assert.equal(lan.opts().relays, undefined, 'TailPocket refuses relays without the relay route')
  assert.equal(lan.opts().noLan, undefined); assert.equal(lan.opts().tailcatOnly, undefined)
  const both = await open({ routes: ['lan', 'relay'], relay })
  assert.deepEqual(both.opts().relays, [relay])
  assert.equal((await open()).opts().routes, undefined, 'unset stays unset: v0.3.1 behaviour')
})

test('without Tailcat, phones that never sent an end-to-end key are counted: TailPocket forgets them and they pair again', async () => {
  const saved = { identity: 'id', allowed: ['nodekey:old', 'nodekey:new'], keys: { 'nodekey:new': 'noise' } }
  assert.equal((await open({ routes: ['lan'], saved })).pocket.mustPairAgain, 1)
  assert.equal((await open({ routes: ['tailcat', 'lan'], saved })).pocket.mustPairAgain, 0, 'with Tailcat it can still sync the key')
  assert.equal((await open({ saved })).pocket.mustPairAgain, 0)
})

test('emoji: the person sees the phone\'s name and emoji, and only their answer pairs it', async () => {
  const a = await open()
  const asked: unknown[] = []; let ended = 0
  const w = await a.pocket.window('123456', 900, { ask: (x) => asked.push(x), askEnded: () => { ended++ } })
  a.window().emit('request', { phone: 'nodekey:p1', device: 'Pixel', route: 'lan', emoji: ['🐶', '🌙', '🍕', '🔑'] })
  assert.deepEqual(asked, [{ device: 'Pixel', route: 'lan', emoji: ['🐶', '🌙', '🍕', '🔑'] }])
  assert.deepEqual(a.calls.confirms, [], 'nothing is answered for the person')
  w.confirm(false)
  assert.deepEqual(a.calls.confirms, [false])
  a.window().emit('requestCancelled')
  assert.equal(ended, 1)
  a.window().emit('request', { phone: 'nodekey:p2', device: 'Old', route: 'tailcat', emoji: null })
  assert.deepEqual(asked.at(-1), { device: 'Old', route: 'tailcat', emoji: [] }, 'no emoji (a v1 phone): an empty list, not null')
})

test('the Boop pairing code goes to the phone inside the tunnel, never in the QR', async () => {
  const a = await open()
  const w = await a.pocket.window('123456', 900, quiet)
  assert.equal(w.qr, 'tailpocket2:1')
  assert.deepEqual(a.calls.pairs[0], { ttl: 900, payload: '123456', emoji: true })
  assert.doesNotMatch(w.qr, /123456/)
})

for (const order of ['phone first', 'device first']) {
  test(`removing a device cuts its phone off the tunnel (${order})`, async () => {
    const a = await open()
    await a.pocket.window('123456', 900, quiet)
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
  await a.pocket.window('123456', 900, quiet)
  a.paired('nodekey:p1'); await tick()
  await a.pocket.claimed('123456', 'd1'); await tick()
  const f = fakeHost()
  const again = await Pocket.open({ statePath: join(a.dir, 'tailpocket.json'), forward: '127.0.0.1:3850', start: (async () => f.host) as never })
  await again.deviceRevoked('d1')
  assert.deepEqual(f.calls.revoked, ['nodekey:p1'])
})

test('a phone paired again takes over its entry: removing the old device leaves it connected', async () => {
  const a = await open()
  await a.pocket.window('111111', 900, quiet); a.paired('nodekey:p1'); await tick(); await a.pocket.claimed('111111', 'old'); await tick()
  await a.pocket.window('222222', 900, quiet); a.paired('nodekey:p1'); await tick(); await a.pocket.claimed('222222', 'new'); await tick()
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
