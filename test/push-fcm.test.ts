// FCM for the Android app: the service-account assertion, the HTTP v1 request, how PushService fans out to
// Android tokens, and the host relay. Fake HTTP servers stand in for Google's token endpoint and FCM; nothing
// here reaches Google.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, verify } from 'node:crypto'
import { createServer, type IncomingMessage } from 'node:http'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FcmSender, RelayFcmSender, fcmAssertion, fcmMessage } from '../src/push-fcm.ts'
import { PushService } from '../src/push.ts'
import { createBotServer } from '../src/server.ts'
import { MemoryDeviceStore } from '../src/devices.ts'
import { createHostServer } from '../src/host/server.ts'

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
const TOKEN = 'dK3x_Yz:APA91bH' + 'q'.repeat(140)
const b64 = (s: string) => Buffer.from(s, 'base64url')
const body = async (req: IncomingMessage) => { let s = ''; for await (const c of req) s += c; return s }

/** Google's token endpoint and FCM on one loopback server; `gone` tokens answer 404 UNREGISTERED. */
async function fakeGoogle(gone: string[] = []) {
  const seen: { path: string; headers: IncomingMessage['headers']; body: string }[] = []
  let tokens = 0
  const srv = createServer(async (req, res) => {
    const b = await body(req)
    seen.push({ path: req.url ?? '', headers: req.headers, body: b })
    if (req.url === '/token') { tokens++; res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ access_token: `ya29.fake-${tokens}`, expires_in: 3599, token_type: 'Bearer' })); return }
    const m = JSON.parse(b) as { message: { token: string } }
    if (gone.includes(m.message.token)) { res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { code: 404, status: 'NOT_FOUND', details: [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode: 'UNREGISTERED' }] } })); return }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ name: 'projects/p/messages/1' }))
  })
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
  const origin = `http://127.0.0.1:${(srv.address() as { port: number }).port}`
  return { origin, seen, tokens: () => tokens, close: () => new Promise<void>((r) => srv.close(() => r())) }
}
const account = (origin: string) => ({ project_id: 'deepseek-bot-test', client_email: 'push@deepseek-bot-test.iam.gserviceaccount.com', private_key: pem, token_uri: `${origin}/token` })

test('fcmAssertion: RS256 over the service account’s claims for the messaging scope, verifiable with its public key', () => {
  const jwt = fcmAssertion(pem, { client_email: 'push@x.iam.gserviceaccount.com', token_uri: 'https://oauth2.googleapis.com/token' }, 1_700_000_000)
  const [h, c, s] = jwt.split('.')
  assert.deepEqual(JSON.parse(b64(h).toString()), { alg: 'RS256', typ: 'JWT' })
  assert.deepEqual(JSON.parse(b64(c).toString()), { iss: 'push@x.iam.gserviceaccount.com', scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: 'https://oauth2.googleapis.com/token', iat: 1_700_000_000, exp: 1_700_003_600 })
  assert.ok(verify('sha256', Buffer.from(`${h}.${c}`), publicKey, b64(s)))
})

test('fcmMessage: data only (the app draws it), high priority, collapsed by tag', () => {
  assert.deepEqual(fcmMessage(TOKEN, { title: 'Nori is done', body: 'Booked.', url: '/threads/main', tag: 'turn:main' }), {
    message: { token: TOKEN, data: { title: 'Nori is done', body: 'Booked.', url: '/threads/main', tag: 'turn:main' }, android: { priority: 'HIGH', ttl: '3600s', collapse_key: 'turn:main' } },
  })
  assert.throws(() => fcmMessage('not a token!', { title: 't', body: 'b' }), /unexpected characters/)
})

test('FcmSender: one access token for many sends, POST messages:send with it, Google’s error code surfaced', async () => {
  const g = await fakeGoogle(['gone' + 'x'.repeat(30)])
  try {
    const s = new FcmSender(account(g.origin), { origin: g.origin })
    await s.send(TOKEN, { title: 'a', body: 'b', url: '/threads/main', tag: 'turn:main' })
    await s.send(TOKEN, { title: 'c', body: 'd' })
    assert.equal(g.tokens(), 1, 'the access token is reused')
    const tok = g.seen.find((x) => x.path === '/token')!
    const form = new URLSearchParams(tok.body)
    assert.equal(form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer')
    assert.equal(form.get('assertion')!.split('.').length, 3)
    const sends = g.seen.filter((x) => x.path !== '/token')
    assert.equal(sends[0].path, '/v1/projects/deepseek-bot-test/messages:send')
    assert.equal(sends[0].headers.authorization, 'Bearer ya29.fake-1')
    assert.equal(JSON.parse(sends[0].body).message.data.url, '/threads/main')
    await assert.rejects(s.send('gone' + 'x'.repeat(30), { title: 't', body: 'b' }), (e: { statusCode: number; reason: string }) => e.statusCode === 404 && e.reason === 'UNREGISTERED')
  } finally { await g.close() }
})

test('FcmSender.fromConfig reads the service account file and names the path, never the key, when it is wrong', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fcm-'))
  writeFileSync(join(dir, 'sa.json'), JSON.stringify(account('https://oauth2.googleapis.com')))
  const s = await FcmSender.fromConfig({ serviceAccountPath: join(dir, 'sa.json') })
  assert.equal(s.origin, 'https://fcm.googleapis.com')
  writeFileSync(join(dir, 'bad.json'), JSON.stringify({ project_id: 'p', client_email: 'e', private_key: 'not a key' }))
  await assert.rejects(FcmSender.fromConfig({ serviceAccountPath: join(dir, 'bad.json') }), (e: Error) => e.message.includes('bad.json') && !e.message.includes('not a key'))
  await assert.rejects(FcmSender.fromConfig({ serviceAccountPath: join(dir, 'missing.json') }), /missing\.json/)
})

test('PushService fans a notification out to FCM tokens too, drops tokens Firebase reports gone, forgets a revoked phone', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fcm-'))
  const sent: { token: string; title: string }[] = []
  const gone = 'gone' + 'y'.repeat(30)
  const p = await PushService.open(join(dir, 'push.json'), { sender: async () => {} })
  p.fcm = { origin: 'fake', async send(token, n) { if (token === gone) throw Object.assign(new Error('gone'), { statusCode: 404, reason: 'UNREGISTERED' }); sent.push({ token, title: n.title }) }, close() {} }
  await p.subscribeFcm('d1', TOKEN)
  await p.subscribeFcm('d2', gone)
  await p.notify({ title: 'Nori is done', body: 'b', url: '/threads/main', tag: 'turn:main' })
  assert.deepEqual(sent, [{ token: TOKEN, title: 'Nori is done' }])
  assert.deepEqual(p.fcmTokens(), [TOKEN])
  const again = await PushService.open(join(dir, 'push.json'), { sender: async () => {} })
  assert.deepEqual(again.fcmTokens(), [TOKEN], 'kept across restarts')
  await again.unsubscribeDevice('d1')
  assert.deepEqual(again.fcmTokens(), [])
})

test('POST /push/subscribe accepts { kind: "fcm", token } from a paired phone and refuses a malformed token', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fcm-'))
  const push = await PushService.open(join(dir, 'push.json'), { sender: async () => {} })
  const devices = new MemoryDeviceStore(); const token = await devices.issue('Pixel')
  const bot = await createBotServer({ dsh: { origin: 'http://127.0.0.1:9', cookie: 'c=1' }, devices, push, host: '127.0.0.1', port: 0, workspace: dir })
  try {
    const post = (b: unknown) => fetch(`${bot.origin}/push/subscribe`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(b) })
    assert.equal((await post({ kind: 'fcm', token: TOKEN })).status, 200)
    assert.deepEqual(push.fcmTokens(), [TOKEN])
    assert.equal((await post({ kind: 'fcm', token: 'bad token' })).status, 400)
  } finally { await bot.close() }
})

test('the host relays { kind: "fcm" } with its own sender; RelayFcmSender posts it with the host secret', async () => {
  const pushed: unknown[] = []
  const dir = mkdtempSync(join(tmpdir(), 'fcm-host-'))
  const provider = { kind: 'fake', async create() { throw new Error('no') }, async get() { return null }, async start() {}, async stop() {}, async remove() {}, async status() { return 'missing' as const } }
  const host = await createHostServer({ provider: provider as never, image: 'x', accountsPath: join(dir, 'accounts.json'), hostSecret: 'host-secret-0123456789abcdef', sandboxEnv: {}, host: '127.0.0.1', port: 0, apns: null, fcm: { origin: 'fake-fcm', async send(token, n) { pushed.push({ token, ...n }) }, close() {} } })
  const noFcm = await createHostServer({ provider: provider as never, image: 'x', accountsPath: join(dir, 'accounts2.json'), hostSecret: 'host-secret-0123456789abcdef', sandboxEnv: {}, host: '127.0.0.1', port: 0, apns: null })
  try {
    await new RelayFcmSender(host.origin, 'host-secret-0123456789abcdef').send(TOKEN, { title: 'Nori needs a yes', body: 'Writing a file', url: '/threads/main/asks/e1', tag: 'approval:e1' })
    assert.deepEqual(pushed, [{ token: TOKEN, title: 'Nori needs a yes', body: 'Writing a file', url: '/threads/main/asks/e1', tag: 'approval:e1' }])
    await assert.rejects(new RelayFcmSender(host.origin, 'wrong').send(TOKEN, { title: 't', body: 'b' }), (e: { statusCode: number }) => e.statusCode === 401)
    await assert.rejects(new RelayFcmSender(noFcm.origin, 'host-secret-0123456789abcdef').send(TOKEN, { title: 't', body: 'b' }), (e: { statusCode: number }) => e.statusCode === 503)
  } finally { await host.close(); await noFcm.close() }
})
