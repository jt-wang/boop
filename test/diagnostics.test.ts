import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { DiagnosticLog, MAX_BYTES, MAX_EVENTS, observeRequest } from '../mobile/src/diagnostic-log.ts'

const all = { interaction: true, performance: true, network: true, resources: true }
function storage() {
  let value: string | null = null, writes = 0
  return { get value() { return value }, get writes() { return writes },
    async getItem() { return value }, async setItem(_key: string, text: string) { value = text; writes++ }, async removeItem() { value = null; writes++ } }
}

test('diagnostics are off by default; opt-in categories, stop, retention and clear survive new instances', async () => {
  const disk = storage(), log = new DiagnosticLog(disk, () => 1000)
  await log.load()
  log.record('ui.navigation', { screen: 'settings' }); await log.flush()
  assert.equal(log.count, 0); assert.equal(disk.writes, 0)
  assert.deepEqual(log.selected, { interaction: false, performance: false, network: false, resources: false })
  log.configure(true, log.selected, false)
  log.record('ui.navigation', { screen: 'chat' })
  log.record('device.sample', { batteryLevel: 0.5 })
  assert.equal(log.count, 0, 'the master switch alone selects no capture categories')
  log.configure(true, { ...all, network: false }, true)
  log.record('ui.navigation', { screen: 'settings' })
  log.record('http.request', { method: 'POST', status: 201 })
  await log.flush()
  const restored = new DiagnosticLog(disk)
  await restored.load()
  assert.equal(restored.enabled, false)
  assert.deepEqual(restored.selected, { ...all, network: false }, 'an upgrade keeps stored choices without enabling capture')
  assert.deepEqual(restored.snapshot(0, 2000), [{ at: 1000, category: 'interaction', event: 'ui.navigation', fields: { screen: 'settings' } }])
  log.configure(false, all, true); await log.flush()
  const before = disk.writes
  log.record('ui.navigation', { screen: 'chat' }); await log.flush()
  assert.equal(log.count, 1); assert.equal(disk.writes, before)
  await restored.clear()
  const cleared = new DiagnosticLog(disk); await cleared.load(); assert.equal(cleared.count, 0)
  log.configure(true, all, false); await log.flush(); assert.equal(disk.value, null)
})

test('rolling journal is bounded and time/category export filters use inclusive boundaries', async () => {
  const disk = storage(); let now = 0
  const log = new DiagnosticLog(disk, () => ++now)
  log.configure(true, all, true)
  for (let i = 0; i < 1700; i++) log.record('ui.navigation', { screen: i % 2 ? 'chat' : 'settings' })
  await log.flush()
  assert.equal(log.count, MAX_EVENTS)
  assert.ok(Buffer.byteLength(disk.value!) <= MAX_BYTES)
  const events = log.snapshot(0, 2000)
  assert.equal(events[0].at, 1189); assert.equal(events.at(-1)!.at, 1700)
  assert.deepEqual(log.snapshot(1699, 1700).map(e => e.fields.screen), ['settings', 'chat'])
  assert.equal(log.snapshot(0, 2000, { ...all, interaction: false }).length, 0)
  const restored = new DiagnosticLog(disk); await restored.load()
  assert.deepEqual(restored.snapshot(0, 2000), events)
})

test('fixed fields reject sensitive strings, unknown events, object coercion and nonfinite numbers before storage', async () => {
  const disk = storage(), log = new DiagnosticLog(disk)
  log.configure(true, all, true)
  const secret = 'private-diag-canary-42' // gitleaks:allow -- synthetic privacy-test canary
  log.record(secret, { screen: 'chat' })
  log.record('__proto__', { message: secret })
  log.record('http.request', { operation: secret, method: 'GET', status: 203, durationMs: Infinity, contentLength: { toString: () => secret }, url: secret, error: secret, deviceId: secret, token: secret })
  log.record('device.sample', { batteryLevel: 0.37, lowPower: 'on', thermal: secret, microphone: secret })
  await log.flush()
  assert.equal(disk.value!.includes(secret), false)
  assert.deepEqual(log.snapshot(0, Date.now()).map(e => e.fields), [{ method: 'GET', status: 203 }, { batteryLevel: 0.37, lowPower: 'on' }])
})

test('real HTTP metadata does not read content, leak bait or add requests; in-flight requests cannot cross stop/clear', async () => {
  const bait = { token: 'CANARY_TOKEN_Q1', auth: 'CANARY_AUTH_Q2', query: 'CANARY_QUERY_Q3', fragment: 'CANARY_FRAGMENT_Q4', path: 'CANARY_PATH_Q5', prompt: 'CANARY_PROMPT_Q6', reply: 'CANARY_REPLY_Q7', terminal: 'CANARY_TERMINAL_Q8', input: 'CANARY_INPUT_Q9', error: 'CANARY_ERROR_Q10' } // gitleaks:allow -- synthetic privacy-test canaries
  let requests = 0
  const server = createServer((req, res) => { requests++; req.resume(); res.writeHead(201, { 'content-length': Buffer.byteLength(bait.reply) }); res.end(bait.reply) })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  const disk = storage(), log = new DiagnosticLog(disk)
  const invoke = () => fetch(`http://127.0.0.1:${port}/${bait.path}?key=${bait.query}#${bait.fragment}`, { method: 'POST', headers: { authorization: bait.auth, 'x-token': bait.token }, body: JSON.stringify(bait) })
  try {
    await observeRequest(log, 'prompt', 'POST', invoke)
    assert.equal(log.count, 0); assert.equal(disk.writes, 0)
    log.configure(true, all, true)
    const response = await observeRequest(log, 'prompt', 'POST', invoke)
    assert.equal(response.bodyUsed, false)
    assert.equal(await response.text(), bait.reply)
    await assert.rejects(observeRequest(log, 'get', 'GET', async () => { throw new Error(bait.error) }), { message: bait.error })
    await log.flush()
    for (const secret of Object.values(bait)) assert.equal(disk.value!.includes(secret), false, secret)
    assert.equal(requests, 2)
    const events = log.snapshot(0, Date.now())
    assert.equal(events.length, 2)
    assert.equal(events[0].fields.status, 201)
    assert.equal(events[0].fields.contentLength, Buffer.byteLength(bait.reply))
    assert.equal(events[1].fields.outcome, 'transport-error')
    let finish!: (r: Response) => void
    const pending = observeRequest(log, 'get', 'GET', () => new Promise(r => { finish = r }))
    await log.clear(); log.configure(false, all, true); log.configure(true, all, true)
    finish(new Response('late reply')); await pending
    assert.equal(log.count, 0)
  } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())) }
})

test('journal failures are visible and a clear waits for an earlier write', async () => {
  const disk = storage(); let release!: () => void
  let slow = true
  const log = new DiagnosticLog({ ...disk, async setItem(k, v) { if (slow) { slow = false; await new Promise<void>(r => { release = r }) }; await disk.setItem(k, v) } })
  log.configure(true, all, true); log.record('ui.navigation', { screen: 'chat' })
  const writing = log.flush(); const clearing = log.clear(); release(); await Promise.all([writing, clearing])
  const restored = new DiagnosticLog(disk); await restored.load(); assert.equal(restored.count, 0)
  const failing = new DiagnosticLog({ ...disk, async setItem() { throw Error('CANARY_DISK_PATH') } })
  failing.configure(true, all, true); await failing.flush(); assert.equal(failing.error, 'storage')
  assert.equal(failing.enabled, false)
  failing.record('ui.navigation', { screen: 'chat' }); assert.equal(failing.count, 0)
})
