import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigFile } from '../src/config.ts'
import { JsonList } from '../src/store.ts'
import { writeAtomic } from '../src/atomic.ts'

// Three threads sent a message at once (test/genui.eval, concurrency 3, 2026-11-01): each saved the person's time
// zone, all three wrote config.json through the same `config.json.<pid>.tmp`, and two answered the POST with
// "ENOENT: rename …". Writes to one file go one at a time, each with the newest value, and leave no temp file.
test('settings saved at the same moment all succeed, and the file ends with the last one', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bot-atomic-'))
  const c = await ConfigFile.open(join(dir, 'config.json'))
  await Promise.all(Array.from({ length: 20 }, (_, i) => c.settings.set({ assistantName: `N${i}` })))
  assert.equal(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')).settings.assistantName, 'N19')
  assert.deepEqual(readdirSync(dir), ['config.json'])
})

test('a list changed from several places at once keeps every row', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bot-atomic-'))
  const l = await JsonList.open<{ id: string }>(join(dir, 'rows.json'))
  await Promise.all(Array.from({ length: 20 }, (_, i) => l.insert({ id: `r${i}` })))
  assert.equal(JSON.parse(readFileSync(join(dir, 'rows.json'), 'utf8')).length, 20)
  assert.deepEqual(readdirSync(dir), ['rows.json'])
})

test('writeAtomic: a failed write leaves the old file and no temp file; the next write still goes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bot-atomic-'))
  const p = join(dir, 'f.json')
  await writeAtomic(p, () => 'one')
  await assert.rejects(writeAtomic(p, () => { throw new Error('boom') }), /boom/)
  assert.equal(readFileSync(p, 'utf8'), 'one')
  await writeAtomic(p, async () => 'two')
  assert.equal(readFileSync(p, 'utf8'), 'two')
  assert.deepEqual(readdirSync(dir), ['f.json'])
})
