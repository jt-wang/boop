import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Memory } from '../src/memory.ts'
import { createBotServer } from '../src/server.ts'
import { MemoryDeviceStore } from '../src/devices.ts'

const fresh = () => new Memory(mkdtempSync(join(tmpdir(), 'mem-')))

test('update: replaces one line in place, keeps its file, kind and position, gets a new id', async () => {
  const m = fresh()
  await m.remember('user', 'Call me Owl', 'fact')
  await m.remember('user', 'Coffee with oat milk', 'preference')
  await m.remember('memory', 'Invoices go to the office', 'decision')
  const [owl] = await m.items()
  const r = await m.update(owl.id, { text: '  Call me  Lao Wang ' })
  assert.ok(r)
  assert.equal(r!.text, 'Call me Lao Wang')
  assert.equal(r!.kind, 'fact')
  assert.equal(r!.file, 'user')
  assert.notEqual(r!.id, owl.id)
  const items = await m.items()
  assert.deepEqual(items.map((i) => i.text), ['Call me Lao Wang', 'Coffee with oat milk', 'Invoices go to the office'])
  const user = readFileSync(join(m['workspace' as never] as string, 'USER.md'), 'utf8')
  assert.match(user, /^- \d{4}-\d{2}-\d{2} \[fact\] Call me Lao Wang$/m)
  assert.doesNotMatch(user, /Owl/)
})

test('update: a new kind moves the line to the file that kind belongs to', async () => {
  const m = fresh()
  await m.remember('memory', 'Xiaoyu is my daughter', 'decision')
  const [it] = await m.items()
  const r = await m.update(it.id, { kind: 'person' })
  assert.equal(r!.kind, 'person')
  assert.equal(r!.text, 'Xiaoyu is my daughter')
  assert.deepEqual((await m.items()).map((i) => `${i.file}:${i.kind}:${i.text}`), ['memory:person:Xiaoyu is my daughter'])
  const r2 = await m.update(r!.id, { kind: 'preference' })
  assert.equal(r2!.file, 'user')
  assert.deepEqual((await m.items()).map((i) => `${i.file}:${i.kind}`), ['user:preference'])
})

test('update: unknown id, empty text, a duplicate of another line, or a bad kind are refused', async () => {
  const m = fresh()
  await m.remember('user', 'Call me Owl', 'fact')
  await m.remember('user', 'Coffee with oat milk', 'preference')
  const [owl] = await m.items()
  assert.equal(await m.update('user:nope', { text: 'x' }), null)
  await assert.rejects(m.update(owl.id, { text: '   ' }), /empty/)
  await assert.rejects(m.update(owl.id, { text: 'coffee with OAT milk' }), /already/)
  await assert.rejects(m.update(owl.id, { kind: 'secret' as never }), /kind/)
  assert.deepEqual((await m.items()).map((i) => i.text), ['Call me Owl', 'Coffee with oat milk'])
})

test('PATCH /memory/:id edits one item for a paired phone; 404 for an unknown id; 400 for a bad body; 401 without a device', async () => {
  const m = fresh()
  await m.remember('user', 'Call me Owl', 'fact')
  const devices = new MemoryDeviceStore(); const token = await devices.issue('phone')
  const bot = await createBotServer({ dsh: { origin: 'http://127.0.0.1:9', cookie: 'c=1' }, devices, host: '127.0.0.1', port: 0, memory: m })
  const patch = (id: string, body: unknown, auth = true) => fetch(`${bot.origin}/memory/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { ...(auth ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' }, body: JSON.stringify(body) })
  try {
    const [owl] = await m.items()
    assert.equal((await patch(owl.id, { text: 'Call me Lao Wang' }, false)).status, 401)
    const ok = await patch(owl.id, { text: 'Call me Lao Wang' })
    assert.equal(ok.status, 200)
    const item = await ok.json() as { id: string; text: string; kind: string }
    assert.equal(item.text, 'Call me Lao Wang'); assert.equal(item.kind, 'fact')
    assert.deepEqual((await m.items()).map((i) => i.text), ['Call me Lao Wang'])
    assert.equal((await patch(owl.id, { text: 'again' })).status, 404)
    assert.equal((await patch(item.id, { text: '' })).status, 400)
    assert.equal((await patch(item.id, { kind: 'nope' })).status, 400)
  } finally { await bot.close() }
})

test('memory never follows a symlink out of the workspace', async () => {
  const { mkdirSync, writeFileSync, symlinkSync } = await import('node:fs')
  const root = mkdtempSync(join(tmpdir(), 'mem-link-'))
  const ws = join(root, 'workspace'); mkdirSync(ws)
  const outside = join(root, 'secret.json'); writeFileSync(outside, '{"secret":true}\n')
  symlinkSync(outside, join(ws, 'USER.md'))
  const m = new Memory(ws)
  assert.equal(await m.read('user'), '')
  assert.equal(await m.remember('user', 'Call me Owl', 'fact'), false)
  assert.equal(readFileSync(outside, 'utf8'), '{"secret":true}\n')
  assert.deepEqual(await m.items(), [])
})

// A memory learned early in the morning, east of UTC, said "Learned Oct 29": the line was dated with the UTC day (QA, Android, 2026-10-30).
test('remember: dates the line with the day in the person’s time zone', async () => {
  const now = () => new Date('2026-10-29T18:08:00Z')
  for (const [zone, day] of [['Pacific/Auckland', '2026-10-30'], ['America/Los_Angeles', '2026-10-29']] as const) {
    const m = new Memory(mkdtempSync(join(tmpdir(), 'mem-')), { zone: () => zone, now })
    await m.remember('memory', 'Picked Sintra', 'decision')
    assert.equal((await m.items())[0].date, day)
  }
})
