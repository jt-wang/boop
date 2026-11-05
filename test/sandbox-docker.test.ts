// The docker provider against the real local Docker and the slim image.
// Skipped (and says why) when `docker info` fails or the image is missing.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { DockerProvider, parseInspect } from '../src/sandbox/docker.ts'

const IMAGE = process.env.DEEPSEEK_BOT_TEST_IMAGE ?? 'deepseek-bot:slim'
const RUN_ARGS = [
  '--cap-add=SYS_ADMIN', '--cap-add=NET_ADMIN',
  '--security-opt', 'systempaths=unconfined',
  '--security-opt', `seccomp=${join(process.cwd(), 'deploy', 'seccomp-bwrap.json')}`,
  '--device', '/dev/loop-control', '--device-cgroup-rule', 'b 7:* rmw',
]
const sh = (args: string[]) => execFileSync('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] }).toString()
let skip: string | false = false
try { sh(['info']) } catch { skip = 'docker info failed: no Docker here' }
if (!skip) { try { sh(['image', 'inspect', IMAGE]) } catch { skip = `image ${IMAGE} not built (docker build -t deepseek-bot:slim .)` } }

const cleanup = (id: string) => { try { sh(['rm', '-f', `dsb-${id}`]) } catch { /* gone */ } try { sh(['volume', 'rm', '-f', `dsb-${id}-data`]) } catch { /* gone */ } }

test('parseInspect maps docker inspect JSON to status + origin', () => {
  const row = { State: { Status: 'running' }, NetworkSettings: { Ports: { '3850/tcp': [{ HostIp: '127.0.0.1', HostPort: '3891' }] } } }
  assert.deepEqual(parseInspect(row), { status: 'running', origin: 'http://127.0.0.1:3891' })
  assert.deepEqual(parseInspect({ State: { Status: 'exited' }, NetworkSettings: { Ports: { '3850/tcp': null } } }), { status: 'stopped', origin: null })
  assert.equal(parseInspect({ State: { Status: 'created' }, NetworkSettings: { Ports: {} } }).status, 'creating')
  assert.equal(parseInspect({ State: { Status: 'restarting' }, NetworkSettings: { Ports: {} } }).status, 'creating')
  assert.equal(parseInspect({ State: { Status: 'paused' }, NetworkSettings: { Ports: {} } }).status, 'stopped')
})

test('docker provider: create → running with a loopback origin in the port range → stop → start → remove, volume included', { skip }, async () => {
  const id = `unit-${Date.now().toString(36)}`
  cleanup(id)
  const p = new DockerProvider({ hostPortRange: [3900, 3906], runArgs: RUN_ARGS })
  try {
    assert.equal(await p.status(id), 'missing')
    assert.equal(await p.get(id), null)
    const sb = await p.create(id, { image: IMAGE, env: { DEEPSEEK_BOT_HOST_SECRET: 'unit-test-secret-0123456789' } })
    assert.equal(sb.id, id)
    const port = Number(new URL(sb.origin).port)
    assert.ok(port >= 3900 && port <= 3906, `port ${port} in range`)
    assert.equal(new URL(sb.origin).hostname, '127.0.0.1')
    assert.equal(await p.status(id), 'running')
    // the secret travelled through the environment, not the command line
    const env = sh(['inspect', '-f', '{{json .Config.Env}}', `dsb-${id}`])
    assert.match(env, /DEEPSEEK_BOT_HOST_SECRET=unit-test-secret-0123456789/)
    assert.match(sh(['inspect', '-f', '{{json .HostConfig.RestartPolicy.Name}}', `dsb-${id}`]), /unless-stopped/)
    assert.match(sh(['inspect', '-f', '{{json .Mounts}}', `dsb-${id}`]), new RegExp(`"Name":"dsb-${id}-data".*"Destination":"/data"`))

    await p.stop(id)
    assert.equal(await p.status(id), 'stopped')
    await p.start(id)
    assert.equal(await p.status(id), 'running')
    const again = await p.get(id)
    assert.ok(again && again.origin.startsWith('http://127.0.0.1:'), 'origin after restart')

    await p.remove(id)
    assert.equal(await p.status(id), 'missing')
    assert.throws(() => sh(['volume', 'inspect', `dsb-${id}-data`]), 'volume removed too')
  } finally { cleanup(id) }
})

test('docker provider: a second sandbox gets a different port from the range; a full range fails clearly', { skip }, async () => {
  const a = `unit-a${Date.now().toString(36)}`, b = `unit-b${Date.now().toString(36)}`
  cleanup(a); cleanup(b)
  const p = new DockerProvider({ hostPortRange: [3905, 3906], runArgs: RUN_ARGS })
  try {
    const sa = await p.create(a, { image: IMAGE, env: {} })
    const sb = await p.create(b, { image: IMAGE, env: {} })
    assert.notEqual(new URL(sa.origin).port, new URL(sb.origin).port)
    await assert.rejects(p.create(`unit-c${Date.now().toString(36)}`, { image: IMAGE, env: {} }), /no free port/)
  } finally { cleanup(a); cleanup(b) }
})

test('docker provider on a named network (host runs in a container too): no published port, origin is the container name, reachable from the network', { skip }, async () => {
  const id = `unit-n${Date.now().toString(36)}`
  const net = 'dsb-unit-net'
  cleanup(id)
  try { sh(['network', 'create', net]) } catch { /* exists */ }
  const p = new DockerProvider({ network: net, runArgs: RUN_ARGS })
  try {
    const sb = await p.create(id, { image: IMAGE, env: {} })
    assert.equal(sb.origin, `http://dsb-${id}:3850`)
    assert.equal(sh(['inspect', '-f', '{{json .NetworkSettings.Ports}}', `dsb-${id}`]).trim(), '{"3850/tcp":null}', 'nothing published on the Docker host')
    assert.match(sh(['inspect', '-f', '{{json .NetworkSettings.Networks}}', `dsb-${id}`]), new RegExp(`"${net}"`))
    // another container on the same network reaches the bot by name
    let out = ''
    for (let i = 0; i < 40 && !out.includes('"ok":true'); i++) { try { out = sh(['run', '--rm', '--network', net, IMAGE, 'curl', '-fsS', `http://dsb-${id}:3850/health`]) } catch { await new Promise((r) => setTimeout(r, 500)) } }
    assert.match(out, /"ok":true/)
    await p.stop(id)
    assert.equal((await p.get(id))?.origin, `http://dsb-${id}:3850`, 'the name is stable across stop/start')
    await p.start(id)
    assert.equal(await p.status(id), 'running')
  } finally { cleanup(id); try { sh(['network', 'rm', net]) } catch { /* in use */ } }
})
