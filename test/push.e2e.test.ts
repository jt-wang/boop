// Notifications end to end: the real bot and harness, played by the scripted model, send every push through the
// real host relay to stand-ins for Apple (an HTTP/2 server), Firebase (a token endpoint and messages:send) and a
// browser's push service (an HTTPS endpoint whose payload the test decrypts with the subscription's own keys).
// Each records the request; the test checks what a closed app gets, and that an app open on the thread gets none.
//
//   bot (src/main.ts, DEEPSEEK_BOT_PUSH_RELAY) → host POST /host/push → ApnsSender → fake APNs
//                                                                    → FcmSender  → fake Google token + FCM
//   bot → web-push → fake push service
//
// Needs only this machine (and openssl). Skipped unless DEEPSEEK_BOT_E2E=1 or DEEPSEEK_BOT_E2E_MODEL=1.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createECDH, generateKeyPairSync, randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync } from 'node:fs'
import { createServer as createHttpServer, type IncomingMessage } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import http2 from 'node:http2'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { startScriptedModel } from './fixtures/scripted-model.ts'
import { createHostServer } from '../src/host/server.ts'
import { ApnsSender } from '../src/push-apns.ts'
import { FcmSender } from '../src/push-fcm.ts'

const run = process.env.DEEPSEEK_BOT_E2E === '1' || process.env.DEEPSEEK_BOT_E2E_MODEL === '1'
const ece = createRequire(import.meta.url)('http_ece') as { decrypt(b: Buffer, p: Record<string, unknown>): Buffer }
const HOST_SECRET = 'host-secret-e2e-0123456789abcdef'
const APNS_TOKEN = 'ab'.repeat(40) // the simulator's length
const FCM_TOKEN = 'eE2e_fcm:APA91b' + 'Z'.repeat(140)
const body = async (req: IncomingMessage | http2.Http2ServerRequest) => { const parts: Buffer[] = []; for await (const c of req) parts.push(Buffer.from(c)); return Buffer.concat(parts) }
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

type Push = { title: string; body: string; url: string; tag?: string }

async function fakeApple() {
  const seen: { headers: http2.IncomingHttpHeaders; body: { aps: { alert: { title: string; body: string }; 'thread-id'?: string }; url: string } }[] = []
  const srv = http2.createServer(async (req, res) => { seen.push({ headers: req.headers, body: JSON.parse((await body(req)).toString()) }); res.writeHead(200, { 'apns-id': String(req.headers['apns-id']) }); res.end() })
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
  return { origin: `http://127.0.0.1:${(srv.address() as { port: number }).port}`, seen, close: () => new Promise<void>((r) => srv.close(() => r())) }
}

async function fakeGoogle() {
  const sends: { path: string; authorization: string; message: { token: string; data: Push; android: { priority: string; collapse_key?: string } } }[] = []
  let tokens = 0
  const srv = createHttpServer(async (req, res) => {
    const b = (await body(req)).toString()
    if (req.url === '/token') { tokens++; res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ access_token: 'ya29.e2e', expires_in: 3599 })); return }
    sends.push({ path: req.url ?? '', authorization: String(req.headers.authorization), message: JSON.parse(b).message })
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"name":"projects/e2e/messages/1"}')
  })
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
  return { origin: `http://127.0.0.1:${(srv.address() as { port: number }).port}`, sends, tokens: () => tokens, close: () => new Promise<void>((r) => srv.close(() => r())) }
}

/** A browser's push service on https://127.0.0.1 with a throwaway certificate the bot is told to trust. */
async function fakePushService(dir: string) {
  const r = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'), '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  const ecdh = createECDH('prime256v1'); ecdh.generateKeys()
  const auth = randomBytes(16)
  const seen: { headers: IncomingMessage['headers']; payload: Push }[] = []
  const srv = createHttpsServer({ key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem')) }, async (req, res) => {
    const b = await body(req)
    seen.push({ headers: req.headers, payload: JSON.parse(ece.decrypt(b, { version: 'aes128gcm', privateKey: ecdh, authSecret: auth.toString('base64url') }).toString()) })
    res.writeHead(201); res.end()
  })
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
  const endpoint = `https://127.0.0.1:${(srv.address() as { port: number }).port}/push/e2e`
  return { ca: join(dir, 'cert.pem'), subscription: { endpoint, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } }, seen, close: () => new Promise<void>((r) => srv.close(() => r())) }
}

test('pushes reach Apple, Firebase and a browser through the host relay; an app open on the thread gets none', { skip: !run, timeout: 300_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bot-push-e2e-'))
  const model = await startScriptedModel([
    // the opening turn the bot starts with a new main thread
    { text: 'Hello.' },
    // turn 1, main thread: a reminder (due three seconds after the model asks for it), then a line
    { name: 'mcp__bot__schedule_create', arguments: { name: 'Water', instruction: 'Tell me to drink a glass of water.', get when() { return { kind: 'once', at: new Date(Date.now() + 3_000).toISOString() } } } },
    { text: 'I will remind you.' },
    // the reminder's own turn
    { text: 'Time for a glass of water.' },
    // turn 2, main thread: a question card, then a line once it is answered
    { name: 'ask_user_question', arguments: { questions: [{ id: 'seat', question: 'Window or aisle?', options: [{ label: 'Window' }, { label: 'Aisle' }] }] } },
    { text: 'Window it is.' },
    // turn 3, main thread, the app open on it
    { text: 'Any time.' },
    // turn 4, a side thread, the app open on the main thread
    { text: 'The side task is finished.' },
  ])
  const apple = await fakeApple()
  const google = await fakeGoogle()
  const web = await fakePushService(dir)
  const { privateKey: ec } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const { privateKey: rsa } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const provider = { kind: 'none', async create() { throw new Error('not used') }, async get() { return null }, async start() {}, async stop() {}, async remove() {}, async status() { return 'missing' as const } }
  const host = await createHostServer({
    provider: provider as never, image: 'none', accountsPath: join(dir, 'accounts.json'), hostSecret: HOST_SECRET, sandboxEnv: {}, host: '127.0.0.1', port: 0,
    apns: new ApnsSender({ keyId: 'ABC123DEFG', teamId: 'TEAM123456', keyPath: '-', bundleId: 'io.jingtao.boop', sandbox: true }, ec.export({ type: 'pkcs8', format: 'pem' }) as string, { origin: apple.origin }),
    fcm: new FcmSender({ project_id: 'deepseek-bot-e2e', client_email: 'push@deepseek-bot-e2e.iam.gserviceaccount.com', private_key: rsa.export({ type: 'pkcs8', format: 'pem' }) as string, token_uri: `${google.origin}/token` }, { origin: google.origin }),
  })
  const home = join(dir, 'home')
  const bot: ChildProcess = spawn(process.execPath, ['src/main.ts', '--home', home, '--host', '127.0.0.1', '--port', '0', '--model', 'scripted/scripted', '--base-url', model.url, '--api-key-env', 'DEEPSEEK_BOT_MODEL_KEY'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, DEEPSEEK_BOT_MODEL_KEY: 'local', DEEPSEEK_BOT_PUSH_RELAY: host.origin, DEEPSEEK_BOT_HOST_SECRET: HOST_SECRET, DEEPSEEK_BOT_GUARD_ALLOW: '127.0.0.1', NODE_EXTRA_CA_CERTS: web.ca },
  })
  let out = ''
  bot.stdout!.on('data', (d) => { out += d }); bot.stderr!.on('data', (d) => { out += d })
  let phone: WebSocket | null = null
  try {
    let pair = ''
    for (let i = 0; i < 300 && !pair; i++) { const m = /(http:\/\/[^\s]+\/pair\?code=\d{6})/.exec(out); if (m) pair = m[1]; else await wait(200) }
    assert.ok(pair, out)
    for (let i = 0; i < 100 && !/listening to the assistant/.test(out); i++) await wait(200)
    assert.match(out, /APNs and FCM through the host/)
    const origin = new URL(pair).origin
    const { token } = await (await fetch(`${origin}/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: new URL(pair).searchParams.get('code'), name: 'e2e' }) })).json() as { token: string }
    const h = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
    const api = async (method: string, path: string, b?: unknown) => { const r = await fetch(origin + path, { method, headers: h, body: b === undefined ? undefined : JSON.stringify(b) }); assert.ok(r.ok, `${method} ${path} → ${r.status} ${await r.clone().text()}`); return r.json() as Promise<Record<string, unknown>> }
    await api('PUT', '/settings', { assistantName: 'Nori' })
    await api('PUT', '/consent', { age: 'adult', ai: true })
    // three phones: an iPhone, an Android phone, a browser
    await api('POST', '/push/subscribe', { kind: 'apns', token: APNS_TOKEN })
    await api('POST', '/push/subscribe', { kind: 'fcm', token: FCM_TOKEN })
    await api('POST', '/push/subscribe', web.subscription)
    const { sessionId: main } = await api('POST', '/sessions/main') as { sessionId: string }
    const idle = async () => { for (let i = 0; i < 200; i++) { const t = await (await fetch(`${origin}/threads`, { headers: h })).json() as { running: boolean }[]; if (Array.isArray(t) && !t.some((x) => x.running)) return; await wait(300) } }
    await wait(2000); await idle()
    // the opening turn ("Hello.") is not part of this test
    const base = { apple: apple.seen.length, google: google.sends.length, web: web.seen.length }
    const pushes = () => apple.seen.slice(base.apple).map((s) => ({ title: s.body.aps.alert.title, body: s.body.aps.alert.body, url: s.body.url, tag: s.headers['apns-collapse-id'] as string | undefined }))
    const until = async (n: number, what: string, ms = 60_000) => { const end = Date.now() + ms; while (pushes().length < n && Date.now() < end) await wait(200); assert.ok(pushes().length >= n, `${what}: ${JSON.stringify(pushes())}\n${out.slice(-3000)}`) }

    // 1. the app is closed: a turn's line, then the reminder (and no second push for the reminder's own turn)
    await api('POST', `/threads/${main}/messages`, { text: 'Remind me to drink water.' })
    await until(1, 'the turn’s push')
    await until(2, 'the reminder’s push', 40_000)
    await wait(1500); await idle(); await wait(1000)
    // 2. a question card
    await api('POST', `/threads/${main}/messages`, { text: 'Book me a seat.' })
    await until(3, 'the question’s push')
    const ask = (await (await fetch(`${origin}/asks`, { headers: h })).json() as { eventId: string; kind: string }[]).find((a) => a.kind === 'question')!
    assert.ok(ask)
    await api('POST', `/questions/${encodeURIComponent(ask.eventId)}`, { answers: [{ id: 'seat', selected: ['Window'] }] })
    await until(4, 'the push after the answer')
    await idle(); await wait(1000)
    assert.deepEqual(pushes(), [
      { title: 'Nori is done', body: 'I will remind you.', url: `/threads/${main}`, tag: `turn:${main}` },
      { title: 'Water', body: 'It’s time.', url: `/threads/${main}`, tag: pushes()[1].tag },
      { title: 'Nori has a question', body: 'Window or aisle?', url: `/threads/${main}/asks/${ask.eventId}`, tag: `question:${ask.eventId}` },
      { title: 'Nori is done', body: 'Window it is.', url: `/threads/${main}`, tag: `turn:${main}` },
    ])
    assert.match(String(pushes()[1].tag), /^schedule:/)

    // 3. the app open on the main thread: nothing for its turn; 4. a side thread still pushes
    const { ticket } = await api('POST', '/ws-ticket') as { ticket: string }
    phone = new WebSocket(`${origin.replace('http', 'ws')}/events?ticket=${ticket}`)
    await new Promise((r) => phone!.on('open', r))
    phone.send(JSON.stringify({ type: 'follow', sessionId: main }))
    await wait(300)
    await api('POST', `/threads/${main}/messages`, { text: 'Thanks.' })
    await wait(3000); await idle(); await wait(1500)
    assert.equal(pushes().length, 4, 'no push for the thread on the screen')
    const side = await api('POST', '/threads', {}) as { sessionId: string }
    await api('POST', `/threads/${side.sessionId}/messages`, { text: 'Do the side task.' })
    await until(5, 'the side thread’s push')
    assert.deepEqual(pushes()[4], { title: 'Nori is done', body: 'The side task is finished.', url: `/threads/${side.sessionId}`, tag: `turn:${side.sessionId}` })

    // Apple got what a phone needs: the token in the path, the topic, an alert, the place to open
    const a = apple.seen[base.apple]
    assert.equal(a.headers[':path'], `/3/device/${APNS_TOKEN}`)
    assert.equal(a.headers['apns-topic'], 'io.jingtao.boop')
    assert.equal(a.headers['apns-push-type'], 'alert')
    assert.match(String(a.headers.authorization), /^bearer [\w-]+\.[\w-]+\.[\w-]+$/)
    assert.equal(a.body.aps['thread-id'], `turn:${main}`)
    // Firebase got the same five, data-only and high priority, with one access token
    const g = google.sends.slice(base.google)
    assert.deepEqual(g.map((s) => s.message.data), pushes().map((p) => ({ title: p.title, body: p.body, url: p.url, tag: p.tag })))
    assert.ok(g.every((s) => s.path === '/v1/projects/deepseek-bot-e2e/messages:send' && s.authorization === 'Bearer ya29.e2e' && s.message.token === FCM_TOKEN && s.message.android.priority === 'HIGH'))
    assert.equal(google.tokens(), 1)
    // the browser got the same five, encrypted to its keys and signed with the bot's VAPID key
    const w = web.seen.slice(base.web)
    assert.deepEqual(w.map((s) => s.payload), pushes().map((p) => ({ title: p.title, body: p.body, url: p.url, tag: p.tag })))
    assert.equal(w[0].headers['content-encoding'], 'aes128gcm')
    assert.match(String(w[0].headers.authorization), /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/)
  } finally {
    phone?.close()
    await new Promise<void>((r) => { bot.once('exit', () => r()); bot.kill('SIGTERM') })
    await host.close(); await apple.close(); await google.close(); await web.close(); await model.close()
  }
})
