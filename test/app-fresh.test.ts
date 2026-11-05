import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { appSourceHash } from '../scripts/app-source-hash.ts'

// The browser build (app/, what the bot serves at / and what npm ships) is made from mobile/ by scripts/build-web.sh
// and committed. After a round of mobile changes it was not rebuilt (2026-10-27): the browser still ran the old app.
// The build records the fingerprint of the sources it was made from; this fails when mobile/ moved on without it.
test('app/ is built from the current mobile/ sources (run scripts/build-web.sh after changing mobile/)', () => {
  let built = ''
  try { built = readFileSync(join(process.cwd(), 'app', 'source.sha256'), 'utf8').trim() } catch {}
  assert.equal(built, appSourceHash(), 'app/ is stale: run scripts/build-web.sh and commit app/')
})

test('the fingerprint covers the app and leaves its tests out', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const dir = mkdtempSync(join(tmpdir(), 'app-hash-'))
  mkdirSync(join(dir, 'src')); writeFileSync(join(dir, 'App.tsx'), 'a'); writeFileSync(join(dir, 'src', 'x.tsx'), 'x')
  const before = appSourceHash(dir)
  writeFileSync(join(dir, 'chat.test.tsx'), 't'); writeFileSync(join(dir, 'src', 'y.fixture.tsx'), 'f')
  assert.equal(appSourceHash(dir), before, 'tests and fixtures do not count')
  writeFileSync(join(dir, 'src', 'x.tsx'), 'x2')
  assert.notEqual(appSourceHash(dir), before, 'a source change does')
})
