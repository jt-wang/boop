import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')

// A fake install: `bin/nsh` says a version, the framework and the AAR sit next to it, as in a real one.
function fakeNsh(version: string) {
  const dir = mkdtempSync(join(tmpdir(), 'nsh-version-'))
  mkdirSync(join(dir, 'bin'))
  mkdirSync(join(dir, 'embed', 'ios', 'NativeShell.xcframework'), { recursive: true })
  writeFileSync(join(dir, 'bin', 'nsh'), `#!/bin/sh\nif [ "$1" = --version ]; then echo "nsh ${version} (abc)"; exit 0; fi\nexit 7\n`)
  chmodSync(join(dir, 'bin', 'nsh'), 0o755)
  return dir
}
const require = (nsh: string) => spawnSync('bash', ['-c', `set -euo pipefail; . scripts/nsh-require.sh; echo "$NSH_HOME"`], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, NSH_BIN: join(nsh, 'bin', 'nsh'), NSH_HOME: '' } })

test('the build scripts refuse another NSH release and say which one they found', () => {
  const nsh = fakeNsh('0.3.0')
  try {
    const r = require(nsh)
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, /Boop needs NSH 0\.4/)
    assert.match(r.stderr, /nsh 0\.3\.0/)
  } finally { rmSync(nsh, { recursive: true, force: true }) }
})

test('the framework comes from the same install as the CLI', () => {
  const nsh = fakeNsh('0.4.0')
  try {
    const r = require(nsh)
    assert.equal(r.status, 0, r.stderr)
    assert.equal(r.stdout.trim().replace(/^\/private/, ''), nsh.replace(/^\/private/, ''))
  } finally { rmSync(nsh, { recursive: true, force: true }) }
})

test('every script that builds a phone app or the web app goes through that check', () => {
  for (const s of ['ios-bundle.sh', 'android-build.sh', 'android-test.sh', 'build-web.sh', 'mac-build.sh', 'tailpocket-sync.sh']) {
    assert.match(readFileSync(join(ROOT, 'scripts', s), 'utf8'), /nsh-require\.sh/, s)
  }
})

test('no build script swaps NSH\'s runtime or warns about a framework without the wss fix any more', () => {
  for (const s of ['ios-bundle.sh', 'android-build.sh']) {
    const text = readFileSync(join(ROOT, 'scripts', s), 'utf8')
    assert.doesNotMatch(text, /ring_core|NSH_RUNTIME_LIBS|wss fix|patched/, s)
  }
})

test('the sync links the framework of the NSH in use, even when an older link is already there', () => {
  const nsh = fakeNsh('0.4.0')
  const t = mkdtempSync(join(tmpdir(), 'tailpocket-'))
  const repo = mkdtempSync(join(tmpdir(), 'boop-'))
  try {
    mkdirSync(join(t, 'sdk', 'node', 'bin'), { recursive: true })
    mkdirSync(join(t, 'sdk', 'js'), { recursive: true })
    mkdirSync(join(t, 'sdk', 'apple', 'NSH'), { recursive: true })
    mkdirSync(join(t, 'build', 'apple', 'TailPocketMobile.xcframework'), { recursive: true })
    const arch = process.arch === 'arm64' ? 'arm64' : 'amd64'
    const os = process.platform === 'darwin' ? 'darwin' : 'linux'
    writeFileSync(join(t, 'sdk', 'node', 'bin', `tailpocket-host-${os}-${arch}`), '#!/bin/sh\n'); chmodSync(join(t, 'sdk', 'node', 'bin', `tailpocket-host-${os}-${arch}`), 0o755)
    for (const f of ['sdk/node/index.js', 'sdk/node/index.d.ts', 'sdk/node/package.json', 'LICENSE', 'NOTICE', 'sdk/js/client.ts', 'sdk/js/nsh.ts']) writeFileSync(join(t, f), '')
    spawnSync('ln', ['-s', '/nowhere/old-nsh/NativeShell.xcframework', join(t, 'sdk', 'apple', 'NSH', 'NativeShell.xcframework')])
    mkdirSync(join(repo, 'scripts'))
    for (const f of ['tailpocket-sync.sh', 'nsh-require.sh']) cpSync(join(ROOT, 'scripts', f), join(repo, 'scripts', f))
    const r = spawnSync('sh', [join(repo, 'scripts', 'tailpocket-sync.sh'), 'ios'], { encoding: 'utf8', env: { ...process.env, TAILPOCKET_DIR: t, NSH_BIN: join(nsh, 'bin', 'nsh'), NSH_HOME: nsh, NSH_IOS_XCFRAMEWORK: '' } })
    assert.equal(r.status, 0, r.stderr)
    assert.ok(existsSync(join(t, 'sdk', 'apple', 'NSH', 'NativeShell.xcframework')), 'the link points at the NSH in use')
  } finally { for (const d of [nsh, t, repo]) rmSync(d, { recursive: true, force: true }) }
})
