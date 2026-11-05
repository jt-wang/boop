import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// A public APK must not carry the builder's home folder. NSH's arm64 libnsh.so holds it in 666 panic locations (cargo registry
// paths, measured 2026-11-03). Each location is a pointer and a length, so the bytes change in place and the size stays.
const SCRUB = join(import.meta.dirname, '..', 'scripts', 'android-scrub-home.sh')

test('the home folder is overwritten in place, every time, and nothing else moves', () => {
  const dir = mkdtempSync(join(tmpdir(), 'scrub-'))
  try {
    const f = join(dir, 'lib.so')
    const home = '/Users/somebody'
    const before = Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(`${home}/.cargo/a.rs\0`), Buffer.from([0xff, 0xfe]), Buffer.from(`x${home}/.cargo/b.rs\0/usr/lib/keep`)])
    writeFileSync(f, before)
    const r = spawnSync('sh', [SCRUB, home, f], { encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    const after = readFileSync(f)
    assert.equal(statSync(f).size, before.length, 'pointers and lengths stay right')
    assert.equal(after.includes(home), false)
    assert.equal(after.includes('/.cargo/a.rs'), true)
    assert.equal(after.includes('/usr/lib/keep'), true)
    assert.deepEqual([...after.subarray(0, 3)], [0, 1, 2], 'bytes that are not text survive')
    assert.equal(after.includes(Buffer.from([0xff, 0xfe])), true)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('an NSH checkout on another disk is overwritten too: the runtime was built there', () => {
  const dir = mkdtempSync(join(tmpdir(), 'scrub-'))
  try {
    const f = join(dir, 'lib.so')
    const before = Buffer.concat([Buffer.from([0, 1]), Buffer.from('/Volumes/Some Disk 4TB/work/nsh/crates/a.rs\0'), Buffer.from('/Volumes/unrelated/keep\0')])
    writeFileSync(f, before)
    const r = spawnSync('sh', [SCRUB, '/Users/somebody', f], { encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    const after = readFileSync(f)
    assert.equal(statSync(f).size, before.length, 'pointers and lengths stay right')
    assert.equal(after.includes('Some Disk'), false)
    assert.equal(after.includes('/nsh/crates/a.rs'), true)
    assert.equal(after.includes('/Volumes/unrelated/keep'), true)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('it refuses a home it could not mean', () => {
  for (const home of ['', '/']) assert.notEqual(spawnSync('sh', [SCRUB, home, '/nonexistent']).status, 0, JSON.stringify(home))
})
