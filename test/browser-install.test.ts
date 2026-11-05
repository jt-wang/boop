// install_browser on a hosted computer: the tool
// call timed out after 60 s while apt-get kept going, the assistant called it
// again, and the second run failed with "Could not get lock
// /var/lib/dpkg/lock-frontend … held by process (apt-get)". One install at a
// time: a later call joins the running one, answers before the harness's
// tool timeout with where the install is, and the browser is mounted once, by
// the call that finds the install done, before that call answers.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { browserInstaller } from '../src/browser-install.ts'

/** A fake installer: logs each start, prints a step, waits for a release file, then makes the "browser". */
function fakeScript(opts: { fail?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'browser-install-'))
  const exe = join(dir, 'chromium')
  const release = join(dir, 'release')
  const starts = join(dir, 'starts')
  const script = join(dir, 'install.sh')
  writeFileSync(script, `#!/bin/sh
echo start >> '${starts}'
echo "step: downloading the browser"
while [ ! -e '${release}' ]; do sleep 0.05; done
${opts.fail ? `echo "E: Unable to fetch some archives" >&2; exit 100` : `printf '#!/bin/sh\\n' > '${exe}'; chmod +x '${exe}'; echo "installed ${exe}"`}
`)
  chmodSync(script, 0o755)
  return { dir, exe, script, release: () => writeFileSync(release, ''), starts: () => existsSync(starts) ? readFileSync(starts, 'utf8').trim().split('\n').length : 0 }
}

test('a call while an install runs joins it: the installer runs once and both calls get the result', async () => {
  const f = fakeScript()
  let mounts = 0
  const install = browserInstaller({ exe: f.exe, script: f.script, waitMs: 5_000, mount: async () => { mounts++ } })
  const a = install()
  const b = install()
  await new Promise((r) => setTimeout(r, 200))
  f.release()
  const [ra, rb] = await Promise.all([a, b])
  assert.equal(f.starts(), 1, 'the installer ran once')
  for (const r of [ra, rb]) assert.match(r, /^Installed\./, r)
  assert.equal(mounts, 1, 'one mount, before the assistant is told')
})

test('an install longer than the wait answers in plain words before the tool times out; a later call joins it instead of starting apt again', async () => {
  const f = fakeScript()
  let mounts = 0
  const install = browserInstaller({ exe: f.exe, script: f.script, waitMs: 300, mount: async () => { mounts++ } })
  const t0 = Date.now()
  const first = await install()
  assert.ok(Date.now() - t0 < 2_000, 'the first call came back after the wait, not after the install')
  assert.match(first, /still installing/i, first)
  assert.match(first, /downloading the browser/, `the step it is on: ${first}`)
  assert.match(first, /call install_browser again/i, first)
  assert.doesNotMatch(first, /step:/, 'the script\'s marker is not shown')
  const second = await install()
  assert.match(second, /still installing/i, second)
  assert.equal(f.starts(), 1, 'the second call did not start another install')
  assert.equal(mounts, 0, 'no mount while no call is waiting for it')
  f.release()
  await new Promise((r) => setTimeout(r, 300))
  assert.equal(mounts, 0, 'finishing in the background mounts nothing on its own')
  const third = await install()
  assert.match(third, /^Installed\./, third)
  assert.equal(f.starts(), 1)
  assert.equal(mounts, 1)
})

test('a failed install says so in plain words with the installer\'s last lines; the next call tries again', async () => {
  const f = fakeScript({ fail: true })
  const install = browserInstaller({ exe: f.exe, script: f.script, waitMs: 5_000, mount: async () => {} })
  f.release()
  const r = await install()
  assert.match(r, /^The browser install failed/, r)
  assert.match(r, /Unable to fetch some archives/, r)
  await install()
  assert.equal(f.starts(), 2, 'a later call retries')
})

test('already installed: nothing runs and nothing is mounted again', async () => {
  const f = fakeScript()
  writeFileSync(f.exe, '#!/bin/sh\n'); chmodSync(f.exe, 0o755)
  let mounts = 0
  const install = browserInstaller({ exe: f.exe, script: f.script, waitMs: 1_000, mount: async () => { mounts++ } })
  assert.match(await install(), /already installed/i)
  assert.equal(f.starts(), 0)
  assert.equal(mounts, 0)
})
