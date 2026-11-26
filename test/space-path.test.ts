// Tests that find a file next to themselves must work from a checkout whose path has spaces:
// `new URL(…, import.meta.url).pathname` keeps the space as %20 and the file is not found. Each test below runs from
// a copy under a directory with a space in its name.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cp, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

for (const [name, files] of [
  ['mac-run.test.ts', ['test/mac-run.test.ts', 'mac/bot/run.sh']],
  ['mac-qr.test.ts', ['test/mac-qr.test.ts', 'mac/bot/qr.mjs']],
] as const) {
  test(`${name} passes from a checkout whose path has a space`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'with space-'))
    try {
      for (const f of ['package.json', ...files]) await cp(join(root, f), join(dir, f), { recursive: true })
      await symlink(join(root, 'node_modules'), join(dir, 'node_modules'))
      // without NODE_TEST_CONTEXT, which node --test sets for its children: with it, the inner run reports to this
      // runner and exits 0 whatever its tests did
      const { NODE_TEST_CONTEXT: _, ...env } = process.env
      const r = spawnSync(process.execPath, ['--test', join(dir, 'test', name)], { encoding: 'utf8', timeout: 60_000, env })
      assert.equal(r.status, 0, `${name} from ${dir}:\n${r.stdout.slice(-1500)}${r.stderr.slice(-500)}`)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
}
