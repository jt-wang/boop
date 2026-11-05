// The host for real: `node src/host-main.ts` with the docker provider and the
// slim image on this machine. Skipped (and says why) without Docker or the
// image. Sandboxes are named dsb-e2e-<pid>-*; the test sweeps only its own before
// and after, so another agent's run cannot remove them. Ports are picked free.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { createServer } from 'node:net'

const IMAGE = process.env.DEEPSEEK_BOT_TEST_IMAGE ?? 'deepseek-bot:slim'
// Other agents may run this test at the same time; a fixed port makes the two
// runs collide. Prefer the documented port, then the next free one.
async function freePort(start: number): Promise<number> {
  for (let p = start; p < start + 200; p++) {
    try {
      await new Promise<void>((resolve, reject) => {
        const s = createServer()
        s.once('error', reject)
        s.listen(p, '127.0.0.1', () => s.close(() => resolve()))
      })
      return p
    } catch { /* busy */ }
  }
  throw new Error(`no free port from ${start}`)
}
const PORT = Number(process.env.DEEPSEEK_BOT_HOST_E2E_PORT ?? await freePort(20000 + (process.pid % 1000) * 10))
const SB_FROM = PORT + 100
const SB_TO = SB_FROM + 6
const ID_PREFIX = `e2e-${process.pid}-`
const sh = (args: string[]) => execFileSync('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] }).toString()
let skip: string | false = false
try { sh(['info']) } catch { skip = 'docker info failed: no Docker here' }
if (!skip) { try { sh(['image', 'inspect', IMAGE]) } catch { skip = `image ${IMAGE} not built (docker build -t deepseek-bot:slim .)` } }

function sweepTestSandboxes() {
  const names = sh(['ps', '-aq', '--filter', `name=^dsb-${ID_PREFIX}`]).split('\n').filter(Boolean)
  if (names.length) sh(['rm', '-f', '-v', ...names])
  const vols = sh(['volume', 'ls', '-q', '--filter', `name=^dsb-${ID_PREFIX}`]).split('\n').filter(Boolean)
  if (vols.length) sh(['volume', 'rm', '-f', ...vols])
}

async function startHost(home: string): Promise<{ child: ChildProcess; log: () => string }> {
  const child = spawn(process.execPath, ['src/host-main.ts', '--host', '127.0.0.1', '--port', String(PORT), '--public-url', `http://127.0.0.1:${PORT}`, '--provider', 'docker', '--image', IMAGE, '--docker-seccomp', join(process.cwd(), 'deploy', 'seccomp-bwrap.json'),
    '--dev-sign-in', '--idle-minutes', '0.05', '--sweep-seconds', '1', '--port-range', `${SB_FROM}-${SB_TO}`, '--id-prefix', ID_PREFIX, '--home', home],
  { cwd: process.cwd(), env: { ...process.env, DEEPSEEK_BOT_HOST_SECRET: 'e2e-host-secret-0123456789abcdef', DEEPSEEK_API_KEY: 'sk-e2e-dummy' }, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  child.stdout!.on('data', (d) => { out += d })
  child.stderr!.on('data', (d) => { out += d })
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`host did not print ready:\n${out}`)), 30_000)
    const look = () => { if (out.includes('[host] ready')) { clearTimeout(t); resolve() } }
    child.stdout!.on('data', look)
    child.once('exit', (c) => { clearTimeout(t); reject(new Error(`host exited ${c}:\n${out}`)) })
  })
  return { child, log: () => out }
}

const until = async (what: string, f: () => Promise<boolean> | boolean, ms = 30_000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await f()) return Date.now() - t0; await new Promise((r) => setTimeout(r, 250)) } throw new Error(`timed out waiting for ${what}`) }
const dockerState = (id: string) => { try { return sh(['inspect', '-f', '{{.State.Status}}', `dsb-${id}`]).trim() } catch { return 'missing' } }

test('host e2e (docker): sign in → sandbox ready → /me and /events through the proxy → idle stop → wake on request → remove', { skip }, async () => {
  sweepTestSandboxes()
  const home = mkdtempSync(join(tmpdir(), 'host-e2e-'))
  const h = await startHost(home)
  const origin = `http://127.0.0.1:${PORT}`
  let sandboxId = ''
  try {
    const acct = (await (await fetch(`${origin}/host/sign-in`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'e2e@example.com' }) })).json() as { accountToken: string }).accountToken
    assert.ok(acct)
    const t0 = Date.now()
    let sb = await (await fetch(`${origin}/host/sandbox`, { method: 'POST', headers: { authorization: `Bearer ${acct}` } })).json() as { state: string; origin?: string; token?: string; sandboxId?: string; error?: string }
    while (sb.state === 'creating') { await new Promise((r) => setTimeout(r, 500)); sb = await (await fetch(`${origin}/host/sandbox`, { headers: { authorization: `Bearer ${acct}` } })).json() as typeof sb }
    assert.equal(sb.state, 'ready', JSON.stringify(sb) + '\n' + h.log())
    sandboxId = sb.sandboxId!
    console.log(`  sandbox ${sandboxId} ready in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
    assert.match(sandboxId, new RegExp(`^${ID_PREFIX}`))
    assert.equal(sb.origin, `${origin}/s/${sandboxId}`)
    assert.equal(dockerState(sandboxId), 'running')
    const env = sh(['inspect', '-f', '{{json .Config.Env}}', `dsb-${sandboxId}`])
    assert.match(env, new RegExp(`DEEPSEEK_BOT_PUSH_RELAY=http://host\\.docker\\.internal:${PORT}`))
    assert.match(env, /DEEPSEEK_BOT_HOST_SECRET=e2e-host-secret/)
    assert.match(env, /DEEPSEEK_API_KEY=sk-e2e-dummy/)
    const portInfo = (JSON.parse(sh(['inspect', `dsb-${sandboxId}`])) as { NetworkSettings: { Ports: Record<string, { HostPort: string }[]> } }[])[0]
    const port = Number(portInfo.NetworkSettings.Ports['3850/tcp'][0].HostPort)
    assert.ok(port >= SB_FROM && port <= SB_TO, `sandbox port ${port}`)

    // the phone's view: /me and the /events WebSocket through the proxy
    const me = await fetch(`${sb.origin}/me`, { headers: { authorization: `Bearer ${sb.token}`, 'x-account': acct } })
    assert.equal(me.status, 200)
    const meBody = await me.json() as { device: { name: string }; connected: boolean }
    assert.equal(meBody.device.name, 'phone'); assert.equal(meBody.connected, true, 'the bot inside is connected to its dsh')
    assert.equal((await fetch(`${sb.origin}/me`, { headers: { authorization: `Bearer ${sb.token}` } })).status, 200, 'the paired phone token is enough')
    assert.equal((await fetch(`${sb.origin}/me`, { headers: { authorization: 'Bearer wrongwrongwrongwrongwrongwrongwrongwrongwrong' } })).status, 401, 'a stranger is stopped at the host')
    assert.equal((await fetch(`${sb.origin}/me`, { headers: { authorization: 'Bearer wrongwrongwrongwrongwrong', 'x-account': acct } })).status, 401, 'bot rejects a bad device token')
    const ws = new WebSocket(`${sb.origin!.replace('http', 'ws')}/events?account=${acct}`, ['bearer', sb.token!])
    const hello = await new Promise<string>((resolve, reject) => { ws.on('message', (m) => resolve(m.toString())); ws.on('error', reject) })
    assert.equal(JSON.parse(hello).type, 'hello')
    assert.equal(JSON.parse(hello).connected, true)
    ws.close()
    await new Promise<void>((r) => ws.on('close', () => r()))

    // idle: 0.05 min = 3 s without requests and without open sockets → stopped
    const idleMs = await until('idle stop', () => dockerState(sandboxId) === 'exited', 40_000)
    console.log(`  idle stop after ${(idleMs / 1000).toFixed(1)}s`)
    const stopped = await (await fetch(`${origin}/host/sandbox`, { headers: { authorization: `Bearer ${acct}` } })).json() as { state: string }
    assert.equal(stopped.state, 'stopped')
    assert.equal((JSON.parse(readFileSync(join(home, 'accounts.json'), 'utf8')) as { sandbox: { wakeAt: string | null } }[])[0].sandbox.wakeAt, null, 'no schedules inside → no wake time')

    // wake on request
    const t1 = Date.now()
    const woke = await fetch(`${sb.origin}/me`, { headers: { authorization: `Bearer ${sb.token}`, 'x-account': acct } })
    const wokeText = await woke.text()
    assert.equal(woke.status, 200, wokeText)
    console.log(`  woke in ${((Date.now() - t1) / 1000).toFixed(1)}s`)
    assert.equal(dockerState(sandboxId), 'running')
    assert.equal((JSON.parse(wokeText) as { device: { name: string } }).device.name, 'phone', 'the same devices survive in the volume')

    // remove: container and volume gone
    assert.equal((await fetch(`${origin}/host/sandbox`, { method: 'DELETE', headers: { authorization: `Bearer ${acct}` } })).status, 200)
    assert.equal(dockerState(sandboxId), 'missing')
    assert.throws(() => sh(['volume', 'inspect', `dsb-${sandboxId}-data`]))
    assert.equal((await (await fetch(`${origin}/host/sandbox`, { headers: { authorization: `Bearer ${acct}` } })).json() as { state: string }).state, 'none')
  } finally {
    h.child.kill('SIGTERM')
    await new Promise((r) => { h.child.once('exit', r); setTimeout(r, 5000) })
    sweepTestSandboxes()
  }
})
