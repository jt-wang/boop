import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NSH, haveNsh } from './fixtures/nsh.ts'

// test/ui.test.ts builds real modules, about 27 MB each with their keys and packages. Run on their own in a temporary
// directory of their own, they leave nothing in it: left behind, 767 of them filled a Mac's system disk (17.7 GB).
test('the generative UI tests leave no directory behind', { skip: !haveNsh, timeout: 180_000 }, () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ui-temp-'))
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: tmp, NSH_BIN: NSH }
    delete env.NODE_TEST_CONTEXT   // the child is a test run of its own, not a part of this one
    const r = spawnSync(process.execPath, ['--test', join(import.meta.dirname, 'ui.test.ts')], { encoding: 'utf8', env, timeout: 170_000 })
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`.slice(-2000))
    assert.match(r.stdout, /ℹ pass [1-9]/, 'the tests ran')
    assert.deepEqual(readdirSync(tmp), [])
  } finally { rmSync(tmp, { recursive: true, force: true }) }
})
