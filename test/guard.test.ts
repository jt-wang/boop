// The server-side outbound guard: what the bot may call, and which destinations
// a hosted phone may not point it at. The resolver is injected everywhere so
// these tests never touch DNS or the network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { createGuard, guardPolicy, isBlockedAddress, GuardError } from '../src/guard.ts'

const resolve = async (host: string): Promise<string[]> => ({
  'example.com': ['93.184.216.34'],
  'api.deepseek.com': ['1.1.1.1'],
  'private.example': ['10.0.0.7'],
  'mixed.example': ['93.184.216.34', '127.0.0.1'],
  'metadata.google.internal': ['169.254.169.254'],
  'fdaa.internal': ['fdaa::3'],
  'lan.example': ['192.168.1.10'],
  'other.example': ['192.168.1.20'],
}[host] ?? ['93.184.216.34'])

const guard = (env: NodeJS.ProcessEnv = {}, policy = guardPolicy(env)) => createGuard(policy, { resolve })

test('the guard is on by default; hosted mode locks the model; the switches parse', () => {
  const on = guardPolicy({})
  assert.equal(on.mode, 'on')
  assert.deepEqual(on.allow, [])
  assert.deepEqual(on.only, [])
  assert.equal(on.allowPrivate, false)
  assert.equal(on.hosted, false)
  assert.equal(on.lockModel, false)
  assert.equal(guardPolicy({ DEEPSEEK_BOT_GUARD: 'off' }).mode, 'off')
  const hosted = guardPolicy({ DEEPSEEK_BOT_HOST_SECRET: 'secret' })
  assert.equal(hosted.hosted, true)
  assert.equal(hosted.lockModel, true)
  assert.equal(guardPolicy({ DEEPSEEK_BOT_HOST_SECRET: 'secret', DEEPSEEK_BOT_ALLOW_MODEL_CHANGE: '1' }).lockModel, false)
  assert.deepEqual(guardPolicy({ DEEPSEEK_BOT_GUARD_ALLOW: 'Ollama.lan, *.home.arpa ,,', DEEPSEEK_BOT_GUARD_ONLY: 'api.deepseek.com' }).allow, ['ollama.lan', '*.home.arpa'])
  assert.deepEqual(guardPolicy({ DEEPSEEK_BOT_GUARD_ONLY: 'api.deepseek.com' }).only, ['api.deepseek.com'])
  assert.equal(guardPolicy({ DEEPSEEK_BOT_GUARD_ALLOW_PRIVATE: '1' }).allowPrivate, true)
})

test('loopback, private, link-local, metadata, multicast and Fly 6PN addresses are blocked', () => {
  for (const ip of ['127.0.0.1', '127.10.0.2', '10.1.2.3', '172.16.5.4', '172.31.255.254', '192.168.1.1', '169.254.169.254', '169.254.1.1', '0.0.0.0', '100.64.0.1', '::1', '::', 'fc00::1', 'fdaa::1', 'fdaa:2:3::4', 'fe80::1', 'ff02::1', '::ffff:127.0.0.1', '64:ff9b::7f00:1', '2002:7f00:1::']) {
    assert.equal(isBlockedAddress(ip), true, `${ip} must be blocked`)
  }
  for (const ip of ['93.184.216.34', '1.1.1.1', '2606:4700:4700::1111']) assert.equal(isBlockedAddress(ip), false, `${ip} is public`)
  assert.equal(isBlockedAddress('not-an-address'), true, 'garbage fails closed')
})

test('checkURL refuses metadata, loopback, private and userinfo; a public address passes', async () => {
  const g = guard()
  for (const url of [
    'http://169.254.169.254/latest/meta-data/',
    'http://127.0.0.1:3850/approvals',
    'http://[::1]/',
    'http://10.0.0.1/',
    'http://metadata.google.internal/computeMetadata/v1/',
    'http://fdaa.internal/',
    'http://private.example/',
    'http://mixed.example/',
    'http://user:pass@example.com/',
    'ftp://example.com/',
  ]) await assert.rejects(g.checkURL(url), GuardError, url)
  const ok = await g.checkURL('https://example.com/v1/chat')
  assert.equal(ok.hostname, 'example.com')
})

test('a push endpoint must be https and public', async () => {
  const g = guard()
  await assert.rejects(g.checkPushEndpoint('http://push.example/1'), /https/)
  await assert.rejects(g.checkPushEndpoint('https://127.0.0.1/1'), GuardError)
  assert.equal((await g.checkPushEndpoint('https://push.example/1')).hostname, 'push.example')
})

test('allow entries, wildcards, the all-private switch and the strict allowlist', async () => {
  const allowed = guard({ DEEPSEEK_BOT_GUARD_ALLOW: 'lan.example,*.home.arpa' })
  assert.equal((await allowed.checkURL('http://lan.example:11434/v1')).hostname, 'lan.example')
  assert.equal((await allowed.checkURL('http://box.home.arpa/')).hostname, 'box.home.arpa')
  await assert.rejects(allowed.checkURL('http://other.example/'), GuardError)

  const privateOk = guard({ DEEPSEEK_BOT_GUARD_ALLOW_PRIVATE: '1' })
  assert.equal((await privateOk.checkURL('http://192.168.1.10/')).hostname, '192.168.1.10')

  const only = guard({ DEEPSEEK_BOT_GUARD_ONLY: 'api.deepseek.com' })
  assert.equal((await only.checkURL('https://api.deepseek.com/v1')).hostname, 'api.deepseek.com')
  await assert.rejects(only.checkURL('https://example.com/'), /allowlist/)
})

test('hosted mode refuses model changes unless the operator allows them; self-hosted allows', () => {
  const hosted = guard({ DEEPSEEK_BOT_HOST_SECRET: 'secret' })
  assert.equal(hosted.canChangeModel().ok, false)
  assert.equal(hosted.canChangeModel().status, 403)
  assert.equal(guard({ DEEPSEEK_BOT_HOST_SECRET: 'secret', DEEPSEEK_BOT_ALLOW_MODEL_CHANGE: '1' }).canChangeModel().ok, true)
  assert.equal(guard({}).canChangeModel().ok, true)
  assert.equal(guard({ DEEPSEEK_BOT_HOST_SECRET: 'secret', DEEPSEEK_BOT_GUARD: 'off' }).canChangeModel().ok, true)
})

test('the guard can be turned off: every URL parses and nothing is blocked', async () => {
  const g = guard({ DEEPSEEK_BOT_GUARD: 'off' })
  const u = await g.checkURL('http://127.0.0.1:3850/approvals')
  assert.equal(u.hostname, '127.0.0.1')
  assert.equal((await g.checkPushEndpoint('http://127.0.0.1/1')).hostname, '127.0.0.1')
})


test('guard.fetch connects only to the validated address, even when the name changes after the check', async () => {
  const hits: string[] = []
  const srv = createServer((req, res) => { hits.push(String(req.headers.host)); res.end('ok') })
  srv.listen(0, '127.0.0.1'); await once(srv, 'listening')
  const port = (srv.address() as { port: number }).port
  const allowed = createGuard(guardPolicy({ DEEPSEEK_BOT_GUARD_ALLOW: 'pinned.example' }), { resolve: async () => ['127.0.0.1'] })
  try {
    await allowed.checkURL(`http://pinned.example:${port}/`)
    const r = await allowed.fetch(`http://pinned.example:${port}/`)
    assert.equal(r.status, 200)
    assert.equal(await r.text(), 'ok')
    assert.equal(hits[0], `pinned.example:${port}`, 'the Host header keeps the name')
  } finally { await allowed.close(); srv.close() }

  const hits2: string[] = []
  const srv2 = createServer((_req, res) => { hits2.push('hit'); res.end('hit') })
  srv2.listen(0, '127.0.0.1'); await once(srv2, 'listening')
  const port2 = (srv2.address() as { port: number }).port
  let calls = 0
  const rebind = createGuard(guardPolicy({}), { resolve: async () => (calls++ === 0 ? ['93.184.216.34'] : ['10.0.0.7']) })
  try {
    await rebind.checkURL(`http://rebind.example:${port2}/`) // the check sees a public address
    await assert.rejects(rebind.fetch(`http://rebind.example:${port2}/`), /private|special/) // the socket lookup sees a private one
    assert.deepEqual(hits2, [], 'no connection was made')
  } finally { await rebind.close(); srv2.close() }
})

test('guard.httpsAgent uses the same validated lookup (web-push)', async () => {
  const g = createGuard(guardPolicy({}), { resolve: async () => ['93.184.216.34'] })
  const lookup = (g.httpsAgent() as unknown as { options: { lookup: Function } }).options.lookup
  assert.equal(typeof lookup, 'function')
  const address = await new Promise<string>((resolve, reject) => lookup('api.example', {}, (err: Error | null, addr: string) => (err ? reject(err) : resolve(addr))))
  assert.equal(address, '93.184.216.34')
  await g.close()
})
