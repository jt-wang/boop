// APNs: the JWT, the HTTP/2 request, and how PushService fans out to iOS
// tokens. A fake HTTP/2 server stands in for api.push.apple.com; nothing here
// reaches Apple.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, verify } from 'node:crypto'
import http2 from 'node:http2'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ApnsSender, apnsJwt, apnsRequest, type ApnsConfig } from '../src/push-apns.ts'
import { PushService } from '../src/push.ts'

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
const cfg: ApnsConfig = { keyId: 'ABC123DEFG', teamId: 'TEAM123456', keyPath: '/dev/null', bundleId: 'io.jingtao.boop', sandbox: true }
const TOKEN = 'a'.repeat(64)
const b64 = (s: string) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64')

test('apnsJwt: ES256 over {alg,kid} / {iss,iat}, verifiable with the key’s public half', () => {
  const jwt = apnsJwt(pem, cfg, 1_700_000_000)
  const [h, p, s] = jwt.split('.')
  assert.deepEqual(JSON.parse(b64(h).toString()), { alg: 'ES256', kid: 'ABC123DEFG' })
  assert.deepEqual(JSON.parse(b64(p).toString()), { iss: 'TEAM123456', iat: 1_700_000_000 })
  assert.equal(b64(s).length, 64, 'raw r||s, not DER')
  assert.ok(verify('sha256', Buffer.from(`${h}.${p}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, b64(s)))
  assert.doesNotMatch(jwt, /PRIVATE KEY/)
})

test('apnsRequest: path, headers and aps payload for one token', () => {
  const r = apnsRequest(cfg, TOKEN, { title: 'Needs approval', body: 'rm -rf build', url: '/approvals/ev-1', tag: 'approval:ev-1' }, 'jwt-x', 1_700_000_000)
  assert.equal(r.headers[':method'], 'POST')
  assert.equal(r.headers[':path'], `/3/device/${TOKEN}`)
  assert.equal(r.headers.authorization, 'bearer jwt-x')
  assert.equal(r.headers['apns-topic'], 'io.jingtao.boop')
  assert.equal(r.headers['apns-push-type'], 'alert')
  assert.equal(r.headers['apns-priority'], '10')
  assert.equal(r.headers['apns-collapse-id'], 'approval:ev-1')
  assert.equal(r.headers['apns-expiration'], String(1_700_000_000 + 3600))
  const body = JSON.parse(r.body)
  assert.deepEqual(body.aps.alert, { title: 'Needs approval', body: 'rm -rf build' })
  assert.equal(body.aps.sound, 'default')
  assert.equal(body.url, '/approvals/ev-1')
})

test('apnsRequest refuses a token that is not hex; the simulator’s 80-byte token passes', () => {
  assert.throws(() => apnsRequest(cfg, 'not-a-token', { title: 't', body: 'b' }, 'j', 0), /device token/)
  assert.equal(apnsRequest(cfg, 'F'.repeat(160), { title: 't', body: 'b' }, 'j', 0).headers[':path'], `/3/device/${'f'.repeat(160)}`)
})

/** A fake APNs: records requests, answers by token. */
async function fakeApns(answer: (token: string) => { status: number; reason?: string }) {
  const seen: { headers: http2.IncomingHttpHeaders; body: string }[] = []
  const srv = http2.createServer()
  srv.on('stream', (stream, headers) => {
    let body = ''
    stream.on('data', (c) => { body += c })
    stream.on('end', () => {
      seen.push({ headers, body })
      const token = String(headers[':path']).split('/').pop()!
      const a = answer(token)
      stream.respond({ ':status': a.status, 'apns-id': 'fake' })
      stream.end(a.reason ? JSON.stringify({ reason: a.reason }) : '')
    })
  })
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
  const port = (srv.address() as { port: number }).port
  return { origin: `http://127.0.0.1:${port}`, seen, close: () => new Promise<void>((r) => srv.close(() => r())) }
}

test('ApnsSender posts over HTTP/2 with a cached JWT and surfaces Apple’s status and reason', async () => {
  const apns = await fakeApns((t) => (t.startsWith('b') ? { status: 410, reason: 'Unregistered' } : { status: 200 }))
  let now = 1_700_000_000
  const sender = new ApnsSender(cfg, pem, { origin: apns.origin, now: () => now })
  try {
    await sender.send(TOKEN, { title: 'Done', body: 'It finished', url: '/', tag: 'turn' })
    now += 60
    await sender.send(TOKEN, { title: 'Again', body: 'x' })
    assert.equal(apns.seen.length, 2)
    assert.equal(apns.seen[0].headers[':path'], `/3/device/${TOKEN}`)
    assert.equal(apns.seen[0].headers['apns-topic'], 'io.jingtao.boop')
    assert.equal(apns.seen[0].headers.authorization, apns.seen[1].headers.authorization, 'one JWT within the hour')
    assert.equal(JSON.parse(apns.seen[0].body).aps.alert.title, 'Done')

    now += 55 * 60
    await sender.send(TOKEN, { title: 'Later', body: 'y' })
    assert.notEqual(apns.seen[2].headers.authorization, apns.seen[0].headers.authorization, 'JWT refreshed after 50 minutes')

    await assert.rejects(sender.send('b'.repeat(64), { title: 't', body: 'b' }), (e: Error & { statusCode: number; reason: string }) => e.statusCode === 410 && e.reason === 'Unregistered')
  } finally { sender.close(); await apns.close() }
})

test('ApnsSender.fromConfig reads the .p8 from keyPath and picks the sandbox or production host', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'apns-'))
  const keyPath = join(dir, 'AuthKey_ABC123DEFG.p8')
  writeFileSync(keyPath, pem, { mode: 0o600 })
  const sandbox = await ApnsSender.fromConfig({ ...cfg, keyPath, sandbox: true })
  assert.equal(sandbox.origin, 'https://api.sandbox.push.apple.com')
  const prod = await ApnsSender.fromConfig({ ...cfg, keyPath, sandbox: false })
  assert.equal(prod.origin, 'https://api.push.apple.com')
  await assert.rejects(ApnsSender.fromConfig({ ...cfg, keyPath: join(dir, 'missing.p8') }), /missing\.p8/)
  sandbox.close(); prod.close()
})

test('PushService fans a notification out to APNs tokens too and drops tokens Apple reports gone', async () => {
  const apns = await fakeApns((t) => (t.startsWith('d') ? { status: 410, reason: 'Unregistered' } : { status: 200 }))
  const dir = mkdtempSync(join(tmpdir(), 'push-'))
  const web: string[] = []
  const svc = await PushService.open(join(dir, 'push.json'), { sender: async (s) => { web.push(s.endpoint) } })
  svc.apns = new ApnsSender(cfg, pem, { origin: apns.origin })
  try {
    await svc.subscribe('web-1', { endpoint: 'https://push.example/1', keys: { p256dh: 'a', auth: 'b' } })
    await svc.subscribeApns('ios-1', 'c'.repeat(64))
    await svc.subscribeApns('ios-2', 'd'.repeat(64))
    await svc.subscribeApns('ios-1', 'e'.repeat(64)) // the same phone again: one token per device
    assert.deepEqual(svc.apnsTokens().sort(), ['d'.repeat(64), 'e'.repeat(64)])

    await svc.notify({ title: 'Needs approval', body: 'rm -rf build', url: '/approvals/ev-1', tag: 'approval:ev-1' })
    assert.deepEqual(web, ['https://push.example/1'])
    assert.deepEqual(apns.seen.map((s) => String(s.headers[':path']).split('/').pop()).sort(), ['d'.repeat(64), 'e'.repeat(64)])
    assert.deepEqual(svc.apnsTokens(), ['e'.repeat(64)], '410 Unregistered drops the token')

    const again = await PushService.open(join(dir, 'push.json'), { sender: async () => {} })
    assert.deepEqual(again.apnsTokens(), ['e'.repeat(64)], 'tokens persist')
    await again.unsubscribeDevice('ios-1')
    assert.deepEqual(again.apnsTokens(), [])
  } finally { svc.apns.close(); await apns.close() }
})

test('without an apns section the token is kept and nothing is sent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'push-'))
  const svc = await PushService.open(join(dir, 'push.json'), { sender: async () => {} })
  await svc.subscribeApns('ios-1', 'f'.repeat(64))
  await svc.notify({ title: 't', body: 'b' })
  assert.deepEqual(svc.apnsTokens(), ['f'.repeat(64)])
})

test('POST /push/subscribe accepts { kind: "apns", token } and POST /push/unsubscribe forgets the phone', async () => {
  const { createBotServer } = await import('../src/server.ts')
  const { MemoryDeviceStore } = await import('../src/devices.ts')
  const dir = mkdtempSync(join(tmpdir(), 'routes-apns-'))
  const devices = new MemoryDeviceStore()
  const push = await PushService.open(join(dir, 'push.json'), { sender: async () => {} })
  const bot = await createBotServer({ dsh: { origin: 'http://127.0.0.1:9', cookie: 'c=1' }, devices, push, host: '127.0.0.1', port: 0, appDir: join(process.cwd(), 'app') })
  try {
    const token = await devices.issue('iPhone')
    const api = (path: string, body: unknown) => fetch(bot.origin + path, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    assert.equal((await api('/push/subscribe', { kind: 'apns', token: 'nope' })).status, 400)
    assert.equal((await api('/push/subscribe', { kind: 'apns', token: 'A'.repeat(64) })).status, 200)
    assert.deepEqual(push.apnsTokens(), ['a'.repeat(64)])
    assert.equal((await api('/push/unsubscribe', {})).status, 200)
    assert.deepEqual(push.apnsTokens(), [])
  } finally { await bot.close() }
})

test('RelayApnsSender posts {kind:"apns", token, title, body, url, tag} to the host with the host secret and surfaces the host’s status', async () => {
  const { RelayApnsSender } = await import('../src/push-apns.ts')
  const { createServer } = await import('node:http')
  const seen: { auth?: string; body: unknown }[] = []
  const srv = createServer((req, res) => { let b = ''; req.on('data', (c) => { b += c }); req.on('end', () => { seen.push({ auth: req.headers.authorization, body: JSON.parse(b) }); const t = (JSON.parse(b) as { token: string }).token; if (t.startsWith('b')) { res.writeHead(410, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'Unregistered' })) } else { res.writeHead(200); res.end('{"ok":true}') } }) })
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
  const origin = `http://127.0.0.1:${(srv.address() as { port: number }).port}`
  const relay = new RelayApnsSender(origin, 'host-secret-0123456789abcdef')
  try {
    await relay.send(TOKEN, { title: 'Done', body: 'It finished', url: '/', tag: 'turn' })
    assert.equal(seen[0].auth, 'Bearer host-secret-0123456789abcdef')
    assert.deepEqual(seen[0].body, { kind: 'apns', token: TOKEN, title: 'Done', body: 'It finished', url: '/', tag: 'turn' })
    await assert.rejects(relay.send('b'.repeat(64), { title: 't', body: 'b' }), (e: Error & { statusCode: number; reason: string }) => e.statusCode === 410 && e.reason === 'Unregistered')
    assert.equal(relay.origin, origin)
  } finally { relay.close(); srv.close() }
})
