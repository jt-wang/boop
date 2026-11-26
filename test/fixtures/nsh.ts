// The nsh CLI the tests run, found as scripts/nsh-require.sh finds it (NSH_BIN, else nsh on PATH, else
// ~/.local/bin/nsh) and held to the same release. None installed: the tests that need it skip on a developer's own run
// and fail in CI and source-export check (below). Another release: every
// test file that imports this fails at once and says which one it found, as the build scripts do, rather than running
// against it (a 0.3 CLI reports a module's size where 0.4 has `bounds`, and the test reads as a layout regression).
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const REQUIRE = join(import.meta.dirname, '..', '..', 'scripts', 'nsh-require.sh')
/** The release Boop is written against, from scripts/nsh-require.sh. */
export const NSH_REQUIRED = /^NSH_REQUIRED=(\S+)$/m.exec(readFileSync(REQUIRE, 'utf8'))![1]

function onPath(): string | null {
  const r = spawnSync('sh', ['-c', 'command -v nsh'], { encoding: 'utf8' })
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null
}

export const NSH = process.env.NSH_BIN || onPath() || join(homedir(), '.local', 'bin', 'nsh')
export const haveNsh = existsSync(NSH)

// Skipping is for a developer's own quick run only. CI (GitHub sets CI=true) and source-export check (which runs npm
// test with BOOP_REQUIRE_NSH=1) must run these tests: a missing CLI fails there, or a release would ship untested.
// an NSH_BIN that names no file is a mistake, never a reason to skip
if (!haveNsh && process.env.NSH_BIN) throw new Error(`NSH_BIN is ${process.env.NSH_BIN}, which is no file. Set it to an NSH ${NSH_REQUIRED} CLI, or unset it to use nsh on PATH`)
if (!haveNsh && (process.env.BOOP_REQUIRE_NSH === '1' || process.env.CI === 'true')) {
  throw new Error(`no nsh CLI at ${NSH}, and this run must not skip the tests that need it (BOOP_REQUIRE_NSH=1 or CI). Set NSH_BIN to an NSH ${NSH_REQUIRED} CLI: https://nsh.dev/docs/installation`)
}
if (haveNsh) {
  let version: string
  try { version = execFileSync(NSH, ['--version'], { encoding: 'utf8' }).trim() } catch (e) { version = `no version (${(e as Error).message.split('\n')[0]})` }
  if (!version.startsWith(`nsh ${NSH_REQUIRED}.`)) {
    throw new Error(`Boop needs NSH ${NSH_REQUIRED} and ${NSH} is ${version}. Set NSH_BIN to an NSH ${NSH_REQUIRED} CLI: https://nsh.dev/docs/installation`)
  }
}
