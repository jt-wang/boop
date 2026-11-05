// mac/bot/run.sh starts the bot inside the Mac app and ties its life to the window:
// when the app process is gone (crash, kill, logout), the bot must stop too.
// Seen 2026-10-27: SIGTERM to the NSH app left the bot running with parent 1.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, copyFile, chmod, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const runSh = new URL('../mac/bot/run.sh', import.meta.url).pathname
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }

/** A bundle dir with run.sh and a fake `node` that records its pid, echoes a pairing line and waits. */
async function fakeBundle() {
  const dir = await mkdtemp(join(tmpdir(), 'dsb mac-'))
  await mkdir(join(dir, 'src'))
  await copyFile(runSh, join(dir, 'run.sh'))
  await writeFile(join(dir, 'node'), `#!/bin/sh\necho $$ > "${dir}/node.pid"\necho "  http://192.168.1.2:3850/pair?code=123456"\nwhile :; do sleep 1; done\n`)
  await chmod(join(dir, 'node'), 0o755)
  return dir
}

test('run.sh bot: the bot stops within a few seconds of its parent (the app) dying', async () => {
  const dir = await fakeBundle()
  // An intermediate shell stands in for the app: run.sh's parent. HOME is a temp dir so no real home is touched.
  const home = await mkdtemp(join(tmpdir(), 'dsb home-'))
  // `& wait` keeps the outer shell a process of its own (a lone command would be exec'd, and killing it would kill run.sh itself).
  const app = spawn('/bin/sh', ['-c', `sh "${dir}/run.sh" bot & wait`], { env: { ...process.env, HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  app.stdout.on('data', (d) => { out += d })
  const deadline = Date.now() + 5000
  while (!out.includes('/pair?code=') && Date.now() < deadline) await sleep(50)
  assert.match(out, /pair\?code=123456/)
  const nodePid = Number((await readFile(join(dir, 'node.pid'), 'utf8')).trim())
  assert.ok(alive(nodePid))
  app.kill('SIGKILL')
  const end = Date.now() + 8000
  while (alive(nodePid) && Date.now() < end) await sleep(100)
  assert.equal(alive(nodePid), false, 'the fake node should have been stopped after its parent died')
})

test('run.sh bot: a normal stop (SIGTERM to the group, as NSH kill() does) ends the bot and run.sh returns', async () => {
  const dir = await fakeBundle()
  const home = await mkdtemp(join(tmpdir(), 'dsb home-'))
  const sh = spawn('/bin/sh', [join(dir, 'run.sh'), 'bot'], { env: { ...process.env, HOME: home }, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  let out = ''
  sh.stdout.on('data', (d) => { out += d })
  const deadline = Date.now() + 5000
  while (!out.includes('/pair?code=') && Date.now() < deadline) await sleep(50)
  const nodePid = Number((await readFile(join(dir, 'node.pid'), 'utf8')).trim())
  process.kill(-sh.pid!, 'SIGTERM')
  const exited = await new Promise<boolean>((r) => { const t = setTimeout(() => r(false), 5000); sh.once('exit', () => { clearTimeout(t); r(true) }) })
  assert.ok(exited, 'run.sh should exit')
  const end = Date.now() + 3000
  while (alive(nodePid) && Date.now() < end) await sleep(100)
  assert.equal(alive(nodePid), false)
})
