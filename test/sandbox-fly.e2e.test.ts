// The Fly provider against a real Fly account: one sandbox machine + volume is
// created, reached through `fly proxy` (WireGuard into the org network),
// stopped, woken and removed. Prints the measured times. Needs:
//   FLY_API_TOKEN                 a token for the org
//   DEEPSEEK_BOT_FLY_APP          an app in that org (the machines go there)
//   DEEPSEEK_BOT_FLY_IMAGE        the sandbox image, pushed to a registry Fly can pull
//   DEEPSEEK_BOT_FLY_ORG=personal DEEPSEEK_BOT_FLY_REGION=iad (defaults)
// Skipped (and says why) without them. Costs: a shared-1x machine for ~2 minutes and a 1 GB volume, removed at the end.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { FlyProvider } from '../src/sandbox/fly.ts'
import { waitHealthy } from '../src/sandbox/provider.ts'

const token = process.env.FLY_API_TOKEN
const app = process.env.DEEPSEEK_BOT_FLY_APP
const image = process.env.DEEPSEEK_BOT_FLY_IMAGE
const skip = !token ? 'FLY_API_TOKEN not set' : !app ? 'DEEPSEEK_BOT_FLY_APP not set' : !image ? 'DEEPSEEK_BOT_FLY_IMAGE not set' : ''
const LOCAL_PORT = 13850

/** `fly proxy` opens a WireGuard tunnel to one machine's private address; resolves once the local port answers anything. */
async function proxyTo(privateIp: string): Promise<ChildProcess> {
  const p = spawn('fly', ['proxy', `${LOCAL_PORT}:3850`, privateIp, '-a', app!], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } })
  let out = ''
  p.stdout?.on('data', (d) => { out += d }); p.stderr?.on('data', (d) => { out += d })
  // The first `fly proxy` in a session also creates the WireGuard peer, which can take a minute; the health
  // poll that follows allows for the machine's own boot on top of that.
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    if (/Proxying/.test(out)) return p
    if (p.exitCode !== null) throw new Error(`fly proxy exited: ${out}`)
    await new Promise((r) => setTimeout(r, 500))
  }
  p.kill(); throw new Error(`fly proxy did not come up: ${out}`)
}

test('a sandbox on Fly Machines: create, boot, suspend, wake, remove', { skip: skip || undefined }, async () => {
  const provider = new FlyProvider({ token: token!, org: process.env.DEEPSEEK_BOT_FLY_ORG ?? 'personal', region: process.env.DEEPSEEK_BOT_FLY_REGION ?? 'iad', app: app!, volumeGb: 1 })
  const id = `e2e-${Date.now().toString(36)}`
  const times: Record<string, number> = {}
  let proxy: ChildProcess | null = null
  try {
    let t = Date.now()
    const sb = await provider.create(id, { image: image!, env: { DEEPSEEK_BOT_HOST_SECRET: 'e2e-host-secret-0123456789abcdef', DEEPSEEK_BOT_MODEL_KEY: 'none' } })
    times.createToStarted = Date.now() - t
    assert.match(sb.origin, /^http:\/\/\[fdaa:/, 'the origin is the machine\'s private 6PN address')
    const ip = /^http:\/\/\[(.+)\]:3850$/.exec(sb.origin)![1]
    proxy = await proxyTo(ip)
    t = Date.now()
    await waitHealthy(`http://127.0.0.1:${LOCAL_PORT}`, { timeoutMs: 180_000, intervalMs: 1000 })
    times.startedToHealthy = Date.now() - t
    assert.equal(await provider.status(id), 'running')

    // idle → suspend (or stop where Fly refuses) → a request wakes it
    t = Date.now()
    await provider.stop(id)
    while (await provider.status(id) !== 'stopped') { if (Date.now() - t > 60_000) throw new Error('did not stop'); await new Promise((r) => setTimeout(r, 500)) }
    times.idle = Date.now() - t
    times.idleState = (await provider.rawState(id)) === 'suspended' ? 1 : 0

    t = Date.now()
    await provider.start(id)
    times.startToStarted = Date.now() - t
    await waitHealthy(`http://127.0.0.1:${LOCAL_PORT}`, { timeoutMs: 120_000 })
    times.wakeToHealthy = Date.now() - t
    assert.equal(await provider.status(id), 'running')
    const me = await fetch(`http://127.0.0.1:${LOCAL_PORT}/health`).then((r) => r.json()) as { ok: boolean; dsh: boolean }
    assert.deepEqual({ ok: me.ok, dsh: me.dsh }, { ok: true, dsh: true })
  } finally {
    proxy?.kill()
    const t = Date.now()
    if (process.env.DEEPSEEK_BOT_FLY_KEEP) { console.log(`[fly e2e] keeping ${id} for inspection`); return }
    await provider.remove(id)
    times.remove = Date.now() - t
    console.log(`[fly e2e] ${JSON.stringify(times)} (ms)`)
  }
  assert.equal(await provider.status(id), 'missing')
})
