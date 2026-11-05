import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PushService } from '../src/push.ts'

const sub = (ep: string) => ({ endpoint: ep, keys: { p256dh: 'BPk', auth: 'auth' } })

test('push service mints VAPID keys once and persists subscriptions per device', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'push-'))
  const sent: { endpoint: string; payload: string }[] = []
  const sender = async (s: { endpoint: string }, payload: string) => { sent.push({ endpoint: s.endpoint, payload }) }
  const p1 = await PushService.open(join(dir, 'push.json'), { sender })
  const pub = p1.publicKey
  assert.ok(pub.length > 60)
  await p1.subscribe('dev-1', sub('https://push.example/1'))
  await p1.subscribe('dev-2', sub('https://push.example/2'))
  await p1.notify({ title: 'Needs approval', body: 'rm -rf build', url: '/approvals/ev-1', tag: 'approval:ev-1' })
  assert.deepEqual(sent.map((s) => s.endpoint).sort(), ['https://push.example/1', 'https://push.example/2'])
  assert.equal(JSON.parse(sent[0].payload).title, 'Needs approval')

  const p2 = await PushService.open(join(dir, 'push.json'), { sender })
  assert.equal(p2.publicKey, pub, 'keys survive restart')
  assert.equal((await p2.subscriptions()).length, 2)
  assert.doesNotMatch(readFileSync(join(dir, 'push.json'), 'utf8'), /"privateKey":""/)
})

test('a subscription the push service rejects as gone (410) is dropped', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'push-'))
  const sender = async (s: { endpoint: string }) => { if (s.endpoint.endsWith('/dead')) { const e = new Error('gone') as Error & { statusCode: number }; e.statusCode = 410; throw e } }
  const p = await PushService.open(join(dir, 'push.json'), { sender })
  await p.subscribe('d1', sub('https://push.example/dead'))
  await p.subscribe('d2', sub('https://push.example/alive'))
  await p.notify({ title: 't', body: 'b' })
  assert.deepEqual((await p.subscriptions()).map((s) => s.endpoint), ['https://push.example/alive'])
})

test('revoking a device removes its subscription', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'push-'))
  const p = await PushService.open(join(dir, 'push.json'), { sender: async () => {} })
  await p.subscribe('d1', sub('https://push.example/1'))
  await p.unsubscribeDevice('d1')
  assert.equal((await p.subscriptions()).length, 0)
})

test('a push endpoint on a private host is refused at subscribe, and a stored one is dropped at send', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'push-'))
  const sent: string[] = []
  const sender = async (s: { endpoint: string }) => { sent.push(s.endpoint) }
  const blocked = async (url: string) => { if (url.includes('127.0.0.1')) throw new Error('blocked by the outbound guard') }
  const before = await PushService.open(join(dir, 'push.json'), { sender })
  await before.subscribe('old', sub('https://127.0.0.1/1'))
  const p = await PushService.open(join(dir, 'push.json'), { sender, check: blocked })
  await assert.rejects(p.subscribe('new', sub('https://127.0.0.1/2')), /outbound guard/)
  await p.subscribe('ok', sub('https://push.example/3'))
  await p.notify({ title: 't', body: 'b' })
  assert.deepEqual(sent, ['https://push.example/3'], 'the stored private endpoint was not called')
  assert.deepEqual((await p.subscriptions()).map((s) => s.endpoint), ['https://push.example/3'])
})

// A push the push service could not take for a moment (a 5xx, 429 or a dropped connection) is sent again, with growing
// waits, as DeepSeek's dsh-superagent prototype retries its outbox (src/app/outbox.ts); a refusal that will not change
// (400, 403, 404, 410) is not.
test('a push refused for a moment is sent again; one refused for good is not', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'push-'))
  const tries: Record<string, number> = {}
  const fail = (code?: number) => { const e = new Error('no') as Error & { statusCode?: number }; if (code) e.statusCode = code; throw e }
  const sender = async (s: { endpoint: string }) => {
    const n = tries[s.endpoint] = (tries[s.endpoint] ?? 0) + 1
    if (s.endpoint.endsWith('/busy') && n < 3) fail(503)
    if (s.endpoint.endsWith('/flaky') && n < 2) fail()
    if (s.endpoint.endsWith('/bad')) fail(400)
  }
  const p = await PushService.open(join(dir, 'push.json'), { sender, retryDelaysMs: [10, 20, 40] })
  for (const e of ['busy', 'flaky', 'bad']) await p.subscribe(e, sub(`https://push.example/${e}`))
  await p.notify({ title: 't', body: 'b' })
  await new Promise((r) => setTimeout(r, 200))
  assert.deepEqual(tries, { 'https://push.example/busy': 3, 'https://push.example/flaky': 2, 'https://push.example/bad': 1 })
})

test('a push the service keeps refusing stops after the last wait', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'push-'))
  let tries = 0
  const p = await PushService.open(join(dir, 'push.json'), { sender: async () => { tries++; const e = new Error('busy') as Error & { statusCode: number }; e.statusCode = 503; throw e }, retryDelaysMs: [5, 5] })
  await p.subscribe('d', sub('https://push.example/x'))
  await p.notify({ title: 't', body: 'b' })
  await new Promise((r) => setTimeout(r, 100))
  assert.equal(tries, 3, 'the first send and one per wait')
})
