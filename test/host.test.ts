// The host service with a fake SandboxProvider whose sandboxes are real bot
// servers (src/server.ts with a fake harness) on loopback. Nothing here needs
// Docker; test/host.e2e.test.ts runs the same flows against the real one.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'
import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { writeFileSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { createHostServer } from '../src/host/server.ts'
import { verifyAppleIdentityToken } from '../src/host/apple.ts'
import { createBotServer, type BotServer } from '../src/server.ts'
import { MemoryDeviceStore } from '../src/devices.ts'
import type { Sandbox, SandboxProvider, SandboxStatus, CreateOptions } from '../src/sandbox/provider.ts'

const HOST_SECRET = 'host-secret-0123456789abcdef'
const fakeHarness = { kind: 'fake', events: { on() {}, clientId: 'c' }, async createSession() { return { sessionId: 'p1' } }, async listSessions() { return [] }, async prompt() {}, async answer() {}, async cancel() { return true }, async rpc() { return {} as never }, async close() {}, async follow() { return () => {} } }

/** In-memory provider: each sandbox is a bot server; stop closes it, start opens a new one on a new port (as Docker does). */
class FakeProvider implements SandboxProvider {
  kind = 'fake'
  rows = new Map<string, { status: SandboxStatus; env: Record<string, string>; devices: MemoryDeviceStore; bot: BotServer | null; schedules: unknown[] }>()
  calls: string[] = []
  private async boot(id: string) {
    const r = this.rows.get(id)!
    r.bot = await createBotServer({ dsh: { origin: 'http://127.0.0.1:9', cookie: 'c=1' }, devices: r.devices, harness: fakeHarness as never, watcher: { clientId: 'c', on() {} } as never, host: '127.0.0.1', port: 0, hostSecret: r.env.DEEPSEEK_BOT_HOST_SECRET, scheduler: { list: () => r.schedules, async remove() { return false }, async update() { return undefined } } })
    r.status = 'running'
  }
  async create(id: string, opts: CreateOptions): Promise<Sandbox> {
    this.calls.push(`create:${id}`)
    this.rows.set(id, { status: 'creating', env: opts.env, devices: new MemoryDeviceStore(), bot: null, schedules: [] })
    await this.boot(id)
    return { id, origin: this.rows.get(id)!.bot!.origin }
  }
  async get(id: string) { const r = this.rows.get(id); return r ? { id, origin: r.bot?.origin ?? '' } : null }
  async start(id: string) { this.calls.push(`start:${id}`); await this.boot(id) }
  async stop(id: string) { this.calls.push(`stop:${id}`); const r = this.rows.get(id)!; await r.bot?.close(); r.bot = null; r.status = 'stopped' }
  async remove(id: string) { this.calls.push(`remove:${id}`); await this.rows.get(id)?.bot?.close(); this.rows.delete(id) }
  async status(id: string) { return this.rows.get(id)?.status ?? 'missing' }
  async closeAll() { for (const r of this.rows.values()) await r.bot?.close() }
}

async function boot(extra: Partial<Parameters<typeof createHostServer>[0]> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'host-'))
  const provider = new FakeProvider()
  const pushed: unknown[] = []
  let now = Date.UTC(2026, 9, 27, 0, 0)
  const host = await createHostServer({
    provider, image: 'fake:img', accountsPath: join(dir, 'accounts.json'), hostSecret: HOST_SECRET,
    sandboxEnv: { DEEPSEEK_API_KEY: 'sk-test' }, devSignIn: true, host: '127.0.0.1', port: 0, idleMinutes: 30, now: () => now,
    apns: { origin: 'fake-apns', async send(token, n) { pushed.push({ token, ...n }) }, close() {} },
    ...extra,
  })
  const publicUrl = host.origin
  const signIn = async (email: string) => (await (await fetch(`${host.origin}/host/sign-in`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }) })).json() as { accountToken: string }).accountToken
  const sandbox = async (account: string, method = 'POST') => (await fetch(`${host.origin}/host/sandbox`, { method, headers: { authorization: `Bearer ${account}` } })).json() as Promise<{ state: string; origin?: string; token?: string; sandboxId?: string; error?: string }>
  const ready = async (account: string) => { let r = await sandbox(account); for (let i = 0; i < 100 && r.state === 'creating'; i++) { await new Promise((s) => setTimeout(s, 50)); r = await sandbox(account, 'GET') } assert.equal(r.state, 'ready', JSON.stringify(r)); return r as { state: string; origin: string; token: string; sandboxId: string } }
  return { host, provider, dir, pushed, publicUrl, signIn, sandbox, ready, tick: (ms: number) => { now += ms }, close: async () => { await host.close(); await provider.closeAll() } }
}

test('dev sign-in gives an account token; the same email gets the same account; without --dev-sign-in email is refused', async () => {
  const s = await boot()
  try {
    const a = await s.signIn('a@example.com'); const b = await s.signIn('a@example.com')
    assert.ok(a.length > 30 && b.length > 30 && a !== b, 'a fresh token each time')
    const me1 = await (await fetch(`${s.host.origin}/host/me`, { headers: { authorization: `Bearer ${a}` } })).json() as { id: string }
    const me2 = await (await fetch(`${s.host.origin}/host/me`, { headers: { authorization: `Bearer ${b}` } })).json() as { id: string }
    assert.equal(me1.id, me2.id)
    assert.equal((await fetch(`${s.host.origin}/host/me`, { headers: { authorization: 'Bearer nope-nope-nope-nope-nope' } })).status, 401)
    assert.equal((await fetch(`${s.host.origin}/host/sign-in`, { method: 'POST', body: '{}' })).status, 400)
    const file = JSON.parse(readFileSync(join(s.dir, 'accounts.json'), 'utf8')) as { tokenHashes: string[] }[]
    assert.doesNotMatch(JSON.stringify(file), new RegExp(a), 'tokens are stored hashed')
  } finally { await s.close() }
  const strict = await boot({ devSignIn: false })
  try { assert.equal((await fetch(`${strict.host.origin}/host/sign-in`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'x@example.com' }) })).status, 403) } finally { await strict.close() }
})

/** A stand-in for Apple: an RSA key pair, a JWKS endpoint, and identity tokens signed with it. */
async function fakeApple() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const jwk = { ...(publicKey.export({ format: 'jwk' }) as Record<string, string>), kid: 'kid-1', alg: 'RS256', use: 'sig' }
  const srv = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ keys: [jwk] })) })
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
  const jwksUrl = `http://127.0.0.1:${(srv.address() as { port: number }).port}/auth/keys`
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const token = (claims: Record<string, unknown>, kid = 'kid-1') => { const h = b64({ alg: 'RS256', kid }); const p = b64({ iss: 'https://appleid.apple.com', aud: 'io.jingtao.boop', exp: Math.floor(Date.now() / 1000) + 600, iat: Math.floor(Date.now() / 1000), sub: '001234.abcdef', email: 'someone@privaterelay.appleid.com', ...claims }); return `${h}.${p}.${sign('sha256', Buffer.from(`${h}.${p}`), privateKey).toString('base64url')}` }
  return { jwksUrl, token, close: () => srv.close() }
}

test('Apple identity token: signature against JWKS, issuer, audience and expiry are checked', async () => {
  const apple = await fakeApple()
  try {
    const ok = await verifyAppleIdentityToken(apple.token({}), { bundleId: 'io.jingtao.boop', jwksUrl: apple.jwksUrl })
    assert.equal(ok.sub, '001234.abcdef'); assert.equal(ok.email, 'someone@privaterelay.appleid.com')
    await assert.rejects(verifyAppleIdentityToken(apple.token({ aud: 'com.other.app' }), { bundleId: 'io.jingtao.boop', jwksUrl: apple.jwksUrl }), /audience/)
    await assert.rejects(verifyAppleIdentityToken(apple.token({ exp: Math.floor(Date.now() / 1000) - 10 }), { bundleId: 'io.jingtao.boop', jwksUrl: apple.jwksUrl }), /expired/)
    await assert.rejects(verifyAppleIdentityToken(apple.token({ iss: 'https://evil.example' }), { bundleId: 'io.jingtao.boop', jwksUrl: apple.jwksUrl }), /issuer/)
    await assert.rejects(verifyAppleIdentityToken(apple.token({}, 'kid-unknown'), { bundleId: 'io.jingtao.boop', jwksUrl: apple.jwksUrl }), /key/)
    const [h, p] = apple.token({}).split('.'); const forged = `${h}.${p}.${Buffer.from('nope').toString('base64url')}`
    await assert.rejects(verifyAppleIdentityToken(forged, { bundleId: 'io.jingtao.boop', jwksUrl: apple.jwksUrl }), /signature/)
  } finally { apple.close() }
})

test('POST /host/sign-in {apple} creates one account per Apple user', async () => {
  const apple = await fakeApple()
  const s = await boot({ devSignIn: false, apple: { bundleId: 'io.jingtao.boop', jwksUrl: apple.jwksUrl }, now: Date.now }) // the token's exp is real time
  try {
    const r1 = await fetch(`${s.host.origin}/host/sign-in`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ apple: apple.token({}) }) })
    assert.equal(r1.status, 200)
    const t1 = (await r1.json() as { accountToken: string }).accountToken
    const t2 = (await (await fetch(`${s.host.origin}/host/sign-in`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ apple: apple.token({}) }) })).json() as { accountToken: string }).accountToken
    const id = async (t: string) => ((await (await fetch(`${s.host.origin}/host/me`, { headers: { authorization: `Bearer ${t}` } })).json()) as { id: string }).id
    assert.equal(await id(t1), await id(t2))
    assert.equal((await fetch(`${s.host.origin}/host/sign-in`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ apple: apple.token({ aud: 'x' }) }) })).status, 401)
  } finally { await s.close(); apple.close() }
})

test('POST /host/sandbox creates the sandbox with the model env, host secret and relay, pairs a phone device, and GET returns the same', async () => {
  const s = await boot()
  try {
    const acct = await s.signIn('a@example.com')
    const r = await s.ready(acct)
    assert.equal(r.origin, `${s.publicUrl}/s/${r.sandboxId}`)
    assert.ok(r.token.length > 30)
    const row = s.provider.rows.get(r.sandboxId)!
    assert.equal(row.env.DEEPSEEK_API_KEY, 'sk-test')
    assert.equal(row.env.DEEPSEEK_BOT_HOST_SECRET, HOST_SECRET)
    assert.equal(row.env.DEEPSEEK_BOT_PUSH_RELAY, s.publicUrl)
    assert.equal((await row.devices.lookup(r.token))?.name, 'phone')
    assert.equal((await row.devices.list()).map((d) => d.name).sort().join(','), 'host,phone')
    const again = await s.sandbox(acct, 'GET')
    assert.deepEqual(again, { state: 'ready', origin: r.origin, token: r.token, sandboxId: r.sandboxId })
    assert.equal(s.provider.calls.filter((c) => c.startsWith('create:')).length, 1, 'POST twice does not create twice')
    assert.equal((await fetch(`${s.host.origin}/host/sandbox`)).status, 401)
  } finally { await s.close() }
})

test('the proxy forwards /s/<id>/* to the sandbox for its owner only; the bot inside still checks the device token', async () => {
  const s = await boot()
  try {
    const a = await s.signIn('a@example.com'); const b = await s.signIn('b@example.com')
    const ra = await s.ready(a)
    const me = await fetch(`${ra.origin}/me`, { headers: { authorization: `Bearer ${ra.token}`, 'x-account': a } })
    assert.equal(me.status, 200)
    assert.equal((await me.json() as { device: { name: string } }).device.name, 'phone')
    assert.equal((await fetch(`${ra.origin}/me`, { headers: { authorization: `Bearer ${ra.token}` } })).status, 200, 'the phone token the host paired is enough (what the app sends)')
    assert.equal((await fetch(`${ra.origin}/me`, { headers: { authorization: 'Bearer wrongwrongwrongwrongwrongwrongwrongwrongwrong' } })).status, 401, 'a stranger with a made-up token is stopped at the host')
    // the app's WebSocket path: a one-time ticket from the bot, then an upgrade carrying only ?ticket=
    const { ticket } = await (await fetch(`${ra.origin}/ws-ticket`, { method: 'POST', headers: { authorization: `Bearer ${ra.token}` } })).json() as { ticket: string }
    const tws = new WebSocket(`${ra.origin.replace('http', 'ws')}/events?ticket=${ticket}`)
    const thello = await new Promise<string>((resolve, reject) => { tws.on('message', (m) => resolve(m.toString())); tws.on('error', reject) })
    assert.equal(JSON.parse(thello).type, 'hello'); tws.close()
    assert.equal((await fetch(`${ra.origin}/me`, { headers: { authorization: `Bearer ${ra.token}`, 'x-account': b } })).status, 403, 'another account')
    assert.equal((await fetch(`${ra.origin}/me`, { headers: { authorization: 'Bearer wrongwrongwrongwrongwrong', 'x-account': a } })).status, 401, 'the bot refuses a bad device token')
    assert.equal((await fetch(`${ra.origin}/me`, { headers: { authorization: `Bearer ${ra.token}`, cookie: `account=${a}` } })).status, 200, 'cookie works too')
    assert.equal((await fetch(`${s.publicUrl}/s/nope-nope/me`, { headers: { 'x-account': a } })).status, 403)
    // the path and query reach the bot untouched
    const h = await fetch(`${ra.origin}/health?x=1`, { headers: { 'x-account': a } })
    assert.deepEqual(await h.json(), { ok: true, dsh: true })
    // WebSocket /events through the proxy, token as subprotocol, account as query (clients that cannot set headers)
    const ws = new WebSocket(`${ra.origin.replace('http', 'ws')}/events?account=${a}`, ['bearer', ra.token])
    const hello = await new Promise<string>((resolve, reject) => { ws.on('message', (m) => resolve(m.toString())); ws.on('error', reject) })
    assert.equal(JSON.parse(hello).type, 'hello')
    assert.equal(ws.protocol, 'bearer')
    ws.close()
    const denied = new WebSocket(`${ra.origin.replace('http', 'ws')}/events`, ['bearer', ra.token], { headers: { 'x-account': b } })
    const err = await new Promise<Error>((resolve) => { denied.on('error', resolve); denied.on('open', () => resolve(new Error('opened'))) })
    assert.match(err.message, /403/)
  } finally { await s.close() }
})

test('the OAuth callback reaches the sandbox without an account token (a browser redirect carries none); the sandbox learns its public URL', async () => {
  const s = await boot()
  try {
    const a = await s.signIn('a@example.com')
    const ra = await s.ready(a)
    const r = await fetch(`${ra.origin}/connectors/callback?code=x&state=y`, { redirect: 'manual' })
    assert.notEqual(r.status, 401, 'the gate let it through')
    assert.notEqual(r.status, 403)
    assert.equal((await fetch(`${ra.origin}/connectors`)).status, 401, 'the rest of /connectors still needs a token')
    assert.equal((await fetch(`${ra.origin}/connectors/callback`, { method: 'POST' })).status, 401, 'only GET passes')
    const env = s.provider.rows.get(ra.sandboxId)!.env
    assert.equal(env.DEEPSEEK_BOT_PUBLIC_URL, `${s.publicUrl}/s/${ra.sandboxId}`)
  } finally { await s.close() }
})

test('POST /host/push relays an APNs notification from a sandbox with the host secret', async () => {
  const s = await boot()
  try {
    const body = JSON.stringify({ kind: 'apns', token: 'a'.repeat(64), title: 'Done', body: 'It finished', url: '/', tag: 'turn' })
    assert.equal((await fetch(`${s.host.origin}/host/push`, { method: 'POST', headers: { 'content-type': 'application/json' }, body })).status, 401)
    assert.equal((await fetch(`${s.host.origin}/host/push`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer wrong' }, body })).status, 401)
    const ok = await fetch(`${s.host.origin}/host/push`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${HOST_SECRET}` }, body })
    assert.equal(ok.status, 200)
    assert.deepEqual(s.pushed, [{ token: 'a'.repeat(64), title: 'Done', body: 'It finished', url: '/', tag: 'turn' }])
    assert.equal((await fetch(`${s.host.origin}/host/push`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${HOST_SECRET}` }, body: JSON.stringify({ kind: 'apns', token: 'zz', title: 't', body: 'b' }) })).status, 400)
  } finally { await s.close() }
  const noApns = await boot({ apns: null })
  try {
    const r = await fetch(`${noApns.host.origin}/host/push`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${HOST_SECRET}` }, body: JSON.stringify({ kind: 'apns', token: 'a'.repeat(64), title: 't', body: 'b' }) })
    assert.equal(r.status, 503)
  } finally { await noApns.close() }
})

test('idle: a sandbox with no requests for idleMinutes is stopped after its schedules are read; a request wakes it; a due schedule wakes it a minute early', async () => {
  const s = await boot({ idleMinutes: 30 })
  try {
    const a = await s.signIn('a@example.com')
    const r = await s.ready(a)
    const row = s.provider.rows.get(r.sandboxId)!
    row.schedules = [{ id: 't1', name: 'stand-up', active: true, nextRunAt: new Date(Date.UTC(2026, 9, 27, 2, 0)).toISOString() }, { id: 't2', name: 'old', active: false, nextRunAt: new Date(Date.UTC(2026, 9, 27, 1, 0)).toISOString() }]
    await s.host.sweep()
    assert.equal(row.status, 'running', 'not idle yet')
    s.tick(31 * 60_000)
    await s.host.sweep()
    assert.equal(row.status, 'stopped')
    assert.deepEqual(await s.sandbox(a, 'GET'), { state: 'stopped', origin: r.origin, token: r.token, sandboxId: r.sandboxId })
    const acct = JSON.parse(readFileSync(join(s.dir, 'accounts.json'), 'utf8')) as { sandbox: { wakeAt: string } }[]
    assert.equal(acct[0].sandbox.wakeAt, new Date(Date.UTC(2026, 9, 27, 2, 0)).toISOString(), 'earliest active schedule recorded')

    // a request wakes it (new port inside the fake provider, as with Docker)
    const me = await fetch(`${r.origin}/me`, { headers: { authorization: `Bearer ${r.token}`, 'x-account': a } })
    assert.equal(me.status, 200)
    assert.equal(row.status, 'running')
    assert.deepEqual(s.provider.calls.filter((c) => !c.startsWith('create')), [`stop:${r.sandboxId}`, `start:${r.sandboxId}`])

    // idle again → stopped; then the clock reaches wakeAt - 60s → started without any request
    s.tick(31 * 60_000)
    await s.host.sweep()
    assert.equal(row.status, 'stopped')
    s.tick(2 * 60 * 60_000 - 62 * 60_000 - 30_000) // 01:59:30
    await s.host.sweep()
    assert.equal(row.status, 'running', 'woken for the schedule')
    assert.equal((JSON.parse(readFileSync(join(s.dir, 'accounts.json'), 'utf8')) as { sandbox: { wakeAt: string | null } }[])[0].sandbox.wakeAt, null)
  } finally { await s.close() }
})

test('an open WebSocket counts as activity: no idle stop while the phone is connected', async () => {
  const s = await boot({ idleMinutes: 1 })
  try {
    const a = await s.signIn('a@example.com')
    const r = await s.ready(a)
    const ws = new WebSocket(`${r.origin.replace('http', 'ws')}/events?account=${a}`, ['bearer', r.token])
    await new Promise<void>((resolve, reject) => { ws.on('open', () => resolve()); ws.on('error', reject) })
    s.tick(5 * 60_000)
    await s.host.sweep()
    assert.equal(s.provider.rows.get(r.sandboxId)!.status, 'running')
    ws.close()
    await new Promise<void>((resolve) => ws.on('close', () => resolve()))
    await new Promise((resolve) => setTimeout(resolve, 50))
    s.tick(5 * 60_000)
    await s.host.sweep()
    assert.equal(s.provider.rows.get(r.sandboxId)!.status, 'stopped')
  } finally { await s.close() }
})

// Nobody should wait for a machine to be built after signing in: the host keeps `warm` sandboxes made ahead
// and suspended, hands one over at sign-in (resume + pair), and makes the next one in the background.
test('warm pool: a sandbox made ahead is handed to the next account instead of a fresh create; the pool refills', async () => {
  const s = await boot({ warm: 1, sweepMs: 0 })
  try {
    await s.host.warmed()
    const pool = s.provider.calls.filter((c) => c.startsWith('create:'))
    assert.equal(pool.length, 1); assert.match(pool[0], /^create:pool-/)
    assert.ok(s.provider.calls.includes(`stop:${pool[0].slice(7)}`), 'a warm sandbox is suspended until it is claimed')
    const a = await s.signIn('a@example.com')
    const r = await s.ready(a)
    assert.equal(r.sandboxId, pool[0].slice(7), 'the warm sandbox is the one the account gets')
    assert.ok(s.provider.calls.includes(`start:${r.sandboxId}`))
    assert.equal(s.provider.calls.filter((c) => c === `create:${r.sandboxId}`).length, 1, 'not created again')
    await s.host.warmed()
    const after = s.provider.calls.filter((c) => c.startsWith('create:'))
    assert.equal(after.length, 2, 'the pool refilled with one more')
    assert.notEqual(after[1], pool[0])
    // the phone's token works through the proxy on the claimed sandbox
    const me = await fetch(`${s.host.origin}/s/${r.sandboxId}/me`, { headers: { authorization: `Bearer ${r.token}` } })
    assert.equal(me.status, 200)
  } finally { await s.close() }
})

test('DELETE /host/sandbox removes the sandbox and its record', async () => {
  const s = await boot()
  try {
    const a = await s.signIn('a@example.com')
    const r = await s.ready(a)
    assert.equal((await fetch(`${s.host.origin}/host/sandbox`, { method: 'DELETE', headers: { authorization: `Bearer ${a}` } })).status, 200)
    assert.equal(await s.provider.status(r.sandboxId), 'missing')
    assert.equal((await s.sandbox(a, 'GET')).state, 'none')
  } finally { await s.close() }
})

test('the host serves the app at / with its own URL in a meta tag (web/host.js reads it as hostUrl)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'host-app-'))
  writeFileSync(join(dir, 'index.html'), '<!doctype html><html><head><title>x</title></head><body></body></html>')
  const s = await boot({ appDir: dir })
  try {
    const html = await (await fetch(`${s.host.origin}/`)).text()
    assert.match(html, new RegExp(`<meta name="deepseek-bot-host" content="${s.host.origin}">`))
    const pair = await (await fetch(`${s.host.origin}/pair?code=1`)).text()   // SPA fallback keeps the meta
    assert.match(pair, /deepseek-bot-host/)
    assert.equal((await fetch(`${s.host.origin}/host/health`)).status, 200)
  } finally { await s.close() }
})

test('the account store survives concurrent writes (every request touches lastSeenAt)', async () => {
  const s = await boot()
  try {
    const a = await s.signIn('a@example.com'); const r = await s.ready(a)
    const results = await Promise.all(Array.from({ length: 25 }, () => fetch(`${r.origin}/health`, { headers: { 'x-account': a } })))
    assert.ok(results.every((x) => x.status === 200), results.map((x) => x.status).join(','))
    assert.ok(JSON.parse(readFileSync(join(s.dir, 'accounts.json'), 'utf8')).length === 1)
  } finally { await s.close() }
})

// One `fly deploy` must update every computer an account gets next: a warm sandbox built from the
// previous image is removed when the host comes back on a new one, and the pool is rebuilt.
test('warm pool after a deploy: sandboxes made from the old image are removed and rebuilt from the new one; the next account gets a new-image sandbox', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'host-'))
  const provider = new FakeProvider()
  const opts = (image: string) => ({ provider, image, accountsPath: join(dir, 'accounts.json'), hostSecret: HOST_SECRET, sandboxEnv: {}, devSignIn: true, host: '127.0.0.1', port: 0, warm: 1, sweepMs: 0, apns: { origin: 'fake-apns', async send() {}, close() {} } })
  const images = new Map<string, string>()
  const create = provider.create.bind(provider)
  provider.create = async (id, o) => { images.set(id, o.image); return create(id, o) }
  const v1 = await createHostServer(opts('app:v1'))
  await v1.warmed()
  const old = [...images.keys()]
  assert.equal(old.length, 1); await v1.close()

  const v2 = await createHostServer(opts('app:v2'))
  try {
    await v2.warmed()
    assert.ok(provider.calls.includes(`remove:${old[0]}`), 'the old-image warm sandbox is removed')
    const fresh = [...images].filter(([, img]) => img === 'app:v2').map(([id]) => id)
    assert.equal(fresh.length, 1, 'one new warm sandbox from the new image')
    const acct = (await (await fetch(`${v2.origin}/host/sign-in`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'd@example.com' }) })).json() as { accountToken: string }).accountToken
    let r = await (await fetch(`${v2.origin}/host/sandbox`, { method: 'POST', headers: { authorization: `Bearer ${acct}` } })).json() as { state: string; sandboxId?: string }
    for (let i = 0; i < 100 && r.state === 'creating'; i++) { await new Promise((x) => setTimeout(x, 50)); r = await (await fetch(`${v2.origin}/host/sandbox`, { headers: { authorization: `Bearer ${acct}` } })).json() as typeof r }
    assert.equal(images.get(r.sandboxId!), 'app:v2', 'the account gets a sandbox made from the deployed image')
  } finally { await v2.close(); await provider.closeAll() }
})

// A model key added after the pool was filled (`fly secrets set DEEPSEEK_API_KEY=…` restarts the host with a
// new environment) must reach the next account too: a warm sandbox made with the old environment is rebuilt.
// pool.json keeps a hash of the environment, never its values.
test('warm pool after the sandbox environment changes: old warm sandboxes are rebuilt; pool.json holds no secret', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'host-'))
  const provider = new FakeProvider()
  const opts = (env: Record<string, string>) => ({ provider, image: 'app:v1', accountsPath: join(dir, 'accounts.json'), hostSecret: HOST_SECRET, sandboxEnv: env, devSignIn: true, host: '127.0.0.1', port: 0, warm: 1, sweepMs: 0 })
  const envs = new Map<string, Record<string, string>>()
  const create = provider.create.bind(provider)
  provider.create = async (id, o) => { envs.set(id, o.env); return create(id, o) }
  const a = await createHostServer(opts({}))
  await a.warmed()
  const old = [...envs.keys()]
  assert.equal(old.length, 1); await a.close()

  const b = await createHostServer(opts({ DEEPSEEK_API_KEY: 'sk-test-new-key' }))
  try {
    await b.warmed()
    assert.ok(provider.calls.includes(`remove:${old[0]}`), 'the warm sandbox made without the key is removed')
    const fresh = [...envs].filter(([id, env]) => id !== old[0] && env.DEEPSEEK_API_KEY === 'sk-test-new-key')
    assert.equal(fresh.length, 1, 'one new warm sandbox with the key')
    const { readFileSync } = await import('node:fs')
    assert.doesNotMatch(readFileSync(join(dir, 'pool.json'), 'utf8'), /sk-test-new-key/)
  } finally { await b.close(); await provider.closeAll() }
})

// Only people the owner approves get a computer: email sign-in needs the owner's access code, repeated wrong
// codes are refused for a while, and the number of accounts has a ceiling.
test('owner approval: sign-in needs the access code, wrong codes are limited, accounts are capped', async () => {
  const s = await boot({ devSignIn: false, accessCode: 'owner-code-for-tests', maxAccounts: 2 })
  const signIn = (body: Record<string, string>) => fetch(`${s.host.origin}/host/sign-in`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  try {
    const cfg = await (await fetch(`${s.host.origin}/host/config`)).json() as { codeRequired: boolean }
    assert.equal(cfg.codeRequired, true)
    assert.equal((await signIn({ email: 'a@example.com' })).status, 403, 'no code')
    assert.equal((await signIn({ email: 'a@example.com', code: 'nope' })).status, 403, 'wrong code')
    assert.equal((await signIn({ email: 'a@example.com', code: 'owner-code-for-tests' })).status, 200)
    assert.equal((await signIn({ email: 'b@example.com', code: 'owner-code-for-tests' })).status, 200)
    assert.equal((await signIn({ email: 'c@example.com', code: 'owner-code-for-tests' })).status, 403, 'third account is over the cap')
    assert.equal((await signIn({ email: 'a@example.com', code: 'owner-code-for-tests' })).status, 200, 'an existing account still signs in')
    for (let i = 0; i < 5; i++) await signIn({ email: 'a@example.com', code: `wrong-${i}` })
    assert.equal((await signIn({ email: 'a@example.com', code: 'owner-code-for-tests' })).status, 429, 'too many wrong codes: wait')
  } finally { await s.close() }
})

test('a host without an access code and without --dev-sign-in refuses email sign-in', async () => {
  const s = await boot({ devSignIn: false })
  try {
    const r = await fetch(`${s.host.origin}/host/sign-in`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'a@example.com' }) })
    assert.equal(r.status, 403)
    assert.equal((await (await fetch(`${s.host.origin}/host/config`)).json() as { codeRequired: boolean }).codeRequired, false)
  } finally { await s.close() }
})

test('the module openings do not wake a stopped sandbox and do not touch it; the phone token still does', async () => {
  const s = await boot()
  try {
    const a = await s.signIn('a@example.com')
    const r = await s.ready(a)
    await s.provider.stop(r.sandboxId)
    const before = s.provider.calls.length
    const paths = [
      `${r.origin}/ui/m1234567890/play?ticket=x`,
      `${r.origin}/ui/m1234567890/runtime/nsh.abcdef.js?token=x`,
      `${r.origin}/ui/m1234567890/tiles/1/0/0.png?token=x`,
    ]
    for (const p of paths) assert.equal((await fetch(p)).status, 401, p)
    assert.equal((await fetch(`${r.origin}/ui/m1234567890/result`, { method: 'POST', headers: { authorization: 'Bearer nope-nope-nope-nope', 'content-type': 'application/json' }, body: '{}' })).status, 401)
    assert.ok(!s.provider.calls.slice(before).some((c) => c.startsWith('start:')), 'no unauthenticated wake')
    // the app's own request wakes it and works as before
    assert.equal((await fetch(`${r.origin}/me`, { headers: { authorization: `Bearer ${r.token}` } })).status, 200)
    assert.ok(s.provider.calls.slice(before).includes(`start:${r.sandboxId}`), 'the phone token wakes it')
  } finally { await s.close() }
})

test('the access code is still the only way in: the module openings create no account and do not sign in', async () => {
  const s = await boot({ devSignIn: false, accessCode: 'owner-code', maxAccounts: 1 })
  try {
    for (const p of [
      '/s/abcdef123456/ui/m1234567890/play?ticket=x',
      '/s/abcdef123456/ui/m1234567890/runtime/nsh.abcdef.js?token=x',
      '/s/abcdef123456/ui/m1234567890/tiles/1/0/0.png?token=x',
    ]) assert.equal((await fetch(`${s.host.origin}${p}`)).status, 401, p)
    assert.equal((await fetch(`${s.host.origin}/s/abcdef123456/ui/m1234567890/result`, { method: 'POST', headers: { authorization: 'Bearer nope-nope-nope-nope' } })).status, 401)
    assert.equal((await (await fetch(`${s.host.origin}/host/health`)).json() as { accounts: number }).accounts, 0)
    assert.equal((await fetch(`${s.host.origin}/host/sign-in`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'a@example.com' }) })).status, 403)
  } finally { await s.close() }
})

// Rotating an account's sandbox tokens (docs/hosting.md 「Rotate an account's tokens」): the host and phone device
// tokens it keeps in accounts.json were printed once into a tool log; the operator must be able to replace them.
const ADMIN = 'admin-token-0123456789abcdef'
const rotate = (origin: string, body: unknown, token = ADMIN) => fetch(`${origin}/host/admin/rotate-tokens`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
const accountId = async (origin: string, acct: string) => ((await (await fetch(`${origin}/host/me`, { headers: { authorization: `Bearer ${acct}` } })).json()) as { id: string }).id

test('admin rotate-tokens: new host and phone devices are paired and saved, the old ones are revoked on the bot and refused at the proxy; other devices keep working', async () => {
  const s = await boot({ adminToken: ADMIN })
  let ws: WebSocket | undefined
  try {
    const acct = await s.signIn('a@example.com')
    const r = await s.ready(acct)
    const id = await accountId(s.host.origin, acct)
    const before = s.host.accounts.get(id)!.sandbox!
    const bot = s.provider.rows.get(r.sandboxId)!
    const laptop = await bot.devices.issue('laptop') // a device the person paired by code: not the host's to revoke
    // an open socket of the old phone, through the proxy
    const { ticket } = await (await fetch(`${r.origin}/ws-ticket`, { method: 'POST', headers: { authorization: `Bearer ${before.phoneToken}` } })).json() as { ticket: string }
    ws = new WebSocket(`${r.origin.replace('http', 'ws')}/events?ticket=${ticket}`)
    await new Promise<void>((resolve, reject) => { ws!.on('message', () => resolve()); ws.on('error', reject) })
    const closed = new Promise<void>((resolve) => ws!.on('close', () => resolve()))

    assert.equal((await rotate(s.host.origin, { account: id }, 'wrong-wrong-wrong-wrong')).status, 401)
    assert.equal((await rotate(s.host.origin, { account: 'nope' })).status, 404)
    assert.equal((await rotate(s.host.origin, {})).status, 400)
    const res = await rotate(s.host.origin, { email: 'A@example.com ' })
    const text = await res.text()
    assert.equal(res.status, 200, text)
    const after = s.host.accounts.get(id)!.sandbox!
    assert.ok(after.hostToken && after.phoneToken)
    assert.notEqual(after.hostToken, before.hostToken); assert.notEqual(after.phoneToken, before.phoneToken)
    for (const t of [before.hostToken!, before.phoneToken!, after.hostToken!, after.phoneToken!]) assert.ok(!text.includes(t), 'the answer carries no token')
    assert.deepEqual(JSON.parse(text), { ok: true, account: id, sandboxId: r.sandboxId, revoked: 2 })

    const status = (o: string, t: string, p = '/me') => fetch(`${o}${p}`, { headers: { authorization: `Bearer ${t}` } }).then((x) => x.status)
    const direct = (await s.provider.get(r.sandboxId))!.origin
    assert.equal(await status(direct, before.phoneToken!), 401, 'old phone token, on the bot')
    assert.equal(await status(direct, before.hostToken!, '/schedules'), 401, 'old host token, on the bot')
    assert.equal(await status(direct, after.hostToken!, '/schedules'), 200, 'new host token, on the bot')
    assert.equal(await status(direct, laptop), 200, 'the person\'s other device')
    assert.equal(await status(r.origin, before.phoneToken!), 401, 'old phone token, at the proxy')
    assert.equal(await status(r.origin, before.phoneToken!, '/ws-ticket'), 401)
    const fresh = await s.sandbox(acct, 'GET')
    assert.equal(fresh.token, after.phoneToken, 'sign-in hands out the new phone token')
    assert.equal(await status(r.origin, fresh.token!), 200, 'new phone token, at the proxy')
    await closed // the old phone's open socket is cut
    const live = (await bot.devices.list()).filter((d) => !d.revokedAt).map((d) => d.name).sort()
    assert.deepEqual(live, ['host', 'laptop', 'phone'])
    assert.doesNotMatch(readFileSync(join(s.dir, 'accounts.json'), 'utf8'), new RegExp(before.phoneToken!), 'the old token is gone from accounts.json')
  } finally { ws?.terminate(); await s.close() }
})

test('the person sees only their phone in Devices, named by the phone; the host\'s pairing cannot be removed; rotating keeps the phone\'s name (QA 2026-10-28 H4)', async () => {
  const s = await boot({ adminToken: ADMIN })
  try {
    const acct = await s.signIn('a@example.com')
    const r = await s.ready(acct)
    const h = { authorization: `Bearer ${r.token}`, 'content-type': 'application/json' }
    const list = async (token = r.token) => ((await (await fetch(`${r.origin}/devices`, { headers: { authorization: `Bearer ${token}` } })).json()) as { id: string; name: string; current: boolean; revokedAt: string | null }[]).filter((d) => !d.revokedAt)
    assert.deepEqual((await list()).map((d) => d.name), ['phone'], 'the host\'s own pairing is not listed')
    assert.equal((await fetch(`${r.origin}/devices/me`, { method: 'PATCH', headers: h, body: JSON.stringify({ name: 'Android' }) })).status, 200)
    assert.deepEqual((await list()).map((d) => [d.name, d.current]), [['Android', true]])
    const bot = s.provider.rows.get(r.sandboxId)!
    const hostDevice = (await bot.devices.list()).find((d) => d.role === 'host')!
    assert.ok(hostDevice, 'the host pairs itself as the host')
    assert.equal((await fetch(`${r.origin}/devices/${hostDevice.id}`, { method: 'DELETE', headers: h })).status, 403)
    const id = await accountId(s.host.origin, acct)
    assert.equal((await rotate(s.host.origin, { account: id })).status, 200, 'the host can still rotate (and revoke its own old pairing)')
    const fresh = await s.sandbox(acct, 'GET')
    assert.deepEqual((await list(fresh.token!)).map((d) => d.name), ['Android'], 'the new phone pairing keeps the name the phone gave')
  } finally { await s.close() }
})

test('admin rotate-tokens refuses a sandbox that is not ready; a stopped (idle) one is woken and rotated', async () => {
  const s = await boot({ adminToken: ADMIN })
  try {
    const a = await s.signIn('a@example.com')
    const ida = await accountId(s.host.origin, a)
    assert.equal((await rotate(s.host.origin, { account: ida })).status, 409, 'no sandbox yet')
    const r = await s.ready(a)
    for (const state of ['creating', 'failed'] as const) {
      await s.host.accounts.patchSandbox(ida, { state })
      assert.equal((await rotate(s.host.origin, { account: ida })).status, 409, state)
    }
    await s.host.accounts.patchSandbox(ida, { state: 'ready' })
    await s.provider.stop(r.sandboxId)
    const old = s.host.accounts.get(ida)!.sandbox!.phoneToken
    assert.equal((await rotate(s.host.origin, { account: ida })).status, 200)
    assert.equal(await s.provider.status(r.sandboxId), 'running')
    assert.notEqual(s.host.accounts.get(ida)!.sandbox!.phoneToken, old)
  } finally { await s.close() }
  const off = await boot() // no admin token configured: the action does not exist
  try { assert.equal((await rotate(off.host.origin, { account: 'x' }, 'anything-anything-anything')).status, 401) } finally { await off.close() }
})

test('`node src/host-main.ts rotate` runs it on the host machine with the admin token from <home>/admin-token and prints no token', async () => {
  const s = await boot({ adminToken: ADMIN })
  try {
    const acct = await s.signIn('a@example.com')
    await s.ready(acct)
    const id = await accountId(s.host.origin, acct)
    const before = s.host.accounts.get(id)!.sandbox!
    const home = mkdtempSync(join(tmpdir(), 'host-home-'))
    writeFileSync(join(home, 'admin-token'), ADMIN + '\n')
    const main = fileURLToPath(new URL('../src/host-main.ts', import.meta.url))
    const run = (args: string[], env: Record<string, string> = {}) => new Promise<{ code: number; out: string }>((resolve) => {
      execFile(process.execPath, [main, 'rotate', ...args], { timeout: 30_000, env: { ...process.env, DEEPSEEK_BOT_HOST_ADMIN_TOKEN: '', ...env } }, (err, stdout, stderr) => resolve({ code: err ? Number((err as { code?: number }).code ?? 1) : 0, out: stdout + stderr }))
    })
    const ok = await run(['--home', home, '--url', s.host.origin, '--email', 'a@example.com'])
    assert.equal(ok.code, 0, ok.out)
    assert.match(ok.out, new RegExp(`${id}.*rotated`))
    const after = s.host.accounts.get(id)!.sandbox!
    assert.notEqual(after.phoneToken, before.phoneToken)
    for (const t of [before.hostToken!, before.phoneToken!, after.hostToken!, after.phoneToken!, ADMIN]) assert.ok(!ok.out.includes(t), 'no token printed')
    const byId = await run(['--home', home, '--url', s.host.origin, '--account', id])
    assert.equal(byId.code, 0, byId.out)
    const wrong = await run(['--home', home, '--url', s.host.origin, '--account', id], { DEEPSEEK_BOT_HOST_ADMIN_TOKEN: 'wrong-wrong-wrong-wrong' })
    assert.notEqual(wrong.code, 0); assert.match(wrong.out, /401/)
    assert.equal((await run(['--home', home, '--url', s.host.origin])).code, 2, 'usage without --account or --email')
  } finally { await s.close() }
})
