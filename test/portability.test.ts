import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exportBundle, importBundle } from '../src/portability.ts'

function home() {
  const root = mkdtempSync(join(tmpdir(), 'port-')); mkdirSync(join(root, 'workspace'))
  writeFileSync(join(root, 'workspace', 'SOUL.md'), '# Soul\nBe brief.\n')
  writeFileSync(join(root, 'workspace', 'USER.md'), '# USER\n- 2026-10-27 [fact] Call me Owl\n')
  writeFileSync(join(root, 'workspace', 'MEMORY.md'), '# MEMORY\n- 2026-10-27 [decision] Invoices go to the office\n')
  writeFileSync(join(root, 'goals.json'), JSON.stringify([{ id: 'g1', title: 'Run a 10k' }]))
  writeFileSync(join(root, 'connectors.json'), JSON.stringify([{ id: 'github', name: 'GitHub', env: { GITHUB_TOKEN: 'leak' }, headers: { authorization: 'Bearer leak' } }]))
  return root
}

test('export carries memory, goals and connectors without secrets', async () => {
  const b = await exportBundle(home(), 'Nori')
  assert.equal(b.format, 'deepseek-bot-memory/1'); assert.equal(b.assistantName, 'Nori')
  assert.match(b.files['USER.md'], /Call me Owl/)
  assert.equal((b.goals[0] as { id: string }).id, 'g1')
  assert.doesNotMatch(JSON.stringify(b), /leak/)
})

test('import appends new facts and rows, skips duplicates, never deletes', async () => {
  const src = home(); const dst = home()
  writeFileSync(join(src, 'workspace', 'MEMORY.md'), '# MEMORY\n- 2026-10-27 [decision] Invoices go to the office\n- 2026-10-20 [project] Waiting for visa\n')
  writeFileSync(join(src, 'goals.json'), JSON.stringify([{ id: 'g1', title: 'Run a 10k' }, { id: 'g2', title: 'Learn Portuguese' }]))
  const r = await importBundle(dst, await exportBundle(src))
  assert.deepEqual(r, { facts: 1, goals: 1, schedules: 0 })
  assert.match(readFileSync(join(dst, 'workspace', 'MEMORY.md'), 'utf8'), /Waiting for visa/)
  assert.equal(JSON.parse(readFileSync(join(dst, 'goals.json'), 'utf8')).length, 2)
  await assert.rejects(importBundle(dst, { format: 'other' }), /not a deepseek-bot memory file/)
})

test('export and import do not follow a symlink out of the workspace', async () => {
  const { mkdirSync, writeFileSync, symlinkSync, readFileSync } = await import('node:fs')
  const root = mkdtempSync(join(tmpdir(), 'port-link-'))
  const ws = join(root, 'workspace'); mkdirSync(ws)
  const outside = join(root, 'secret.txt'); writeFileSync(outside, 'SENTINEL\n')
  symlinkSync(outside, join(ws, 'USER.md'))
  const bundle = await exportBundle(root)
  assert.equal(bundle.files['USER.md'], '')
  await assert.rejects(importBundle(root, { format: 'deepseek-bot-memory/1', exportedAt: '', files: { 'SOUL.md': '', 'USER.md': '- 2026-10-27 [fact] x\n', 'MEMORY.md': '' }, goals: [], schedules: [], connectors: [] }), /not writable/)
  assert.equal(readFileSync(outside, 'utf8'), 'SENTINEL\n')
})
