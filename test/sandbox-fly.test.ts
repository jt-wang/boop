// Fly Machines provider against a fake of api.machines.dev. Shapes from
// docs.fly.io/machines/api (read 2026-10-27); not run against a real Fly
// account (no token here).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FlyProvider, mapFlyState } from '../src/sandbox/fly.ts'

interface Call { method: string; path: string; auth?: string; body?: unknown }

/** In-memory Fly: one app, machines and volumes keyed by id. */
function fakeFly(opts: { appExists?: boolean; noSuspend?: boolean } = {}) {
  const calls: Call[] = []
  const apps = new Set<string>(opts.appExists ? ['dsb-host'] : [])
  const machines = new Map<string, { id: string; name: string; state: string; private_ip: string; config: unknown; instance_id: string }>()
  const volumes = new Map<string, { id: string; name: string; state: string; attached_machine_id: string | null }>()
  let n = 0
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input))
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method, path: url.pathname + url.search, auth: (init?.headers as Record<string, string>)?.authorization, body })
    const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } })
    const m = url.pathname
    if (m === '/v1/apps' && method === 'POST') { apps.add(body.app_name); return json(201, { id: 'app1', created_at: 1 }) }
    const app = /^\/v1\/apps\/([^/]+)/.exec(m)?.[1]
    if (!app) return json(404, { error: 'no' })
    if (m === `/v1/apps/${app}` && method === 'GET') return apps.has(app) ? json(200, { id: 'app1', name: app, status: 'deployed', organization: { slug: 'personal' } }) : json(404, { error: 'App not found' })
    if (!apps.has(app)) return json(404, { error: 'App not found' })
    if (m === `/v1/apps/${app}/volumes` && method === 'POST') { const id = `vol_${++n}`; volumes.set(id, { id, name: body.name, state: 'created', attached_machine_id: null }); return json(200, volumes.get(id)) }
    if (m === `/v1/apps/${app}/volumes` && method === 'GET') return json(200, [...volumes.values()])
    const vol = /\/volumes\/([^/]+)$/.exec(m)?.[1]
    if (vol && method === 'DELETE') { const v = volumes.get(vol); if (!v) return json(404, {}); volumes.delete(vol); return json(200, { ...v, state: 'destroyed' }) }
    if (m === `/v1/apps/${app}/machines` && method === 'POST') { const id = `m${++n}`; machines.set(id, { id, name: body.name, state: 'started', private_ip: `fdaa:0:1::${n}`, config: body.config, instance_id: `i${n}` }); return json(200, machines.get(id)) }
    if (m === `/v1/apps/${app}/machines` && method === 'GET') return json(200, [...machines.values()])
    const mm = /\/machines\/([^/]+)(\/(start|stop|suspend|wait))?$/.exec(m)
    if (mm) {
      const mc = machines.get(mm[1]); if (!mc) return json(404, { error: 'machine not found' })
      if (mm[3] === 'start') { mc.state = 'started'; return json(200, { previous_state: 'stopped', migrated: false, new_host: '' }) }
      if (mm[3] === 'stop') { mc.state = 'stopped'; return json(200, { ok: true }) }
      if (mm[3] === 'suspend') { if (opts.noSuspend) return json(412, { error: 'suspend is not supported for this machine' }); mc.state = 'suspended'; return json(200, { ok: true }) }
      if (mm[3] === 'wait') return json(200, { ok: true })
      if (method === 'DELETE') { machines.delete(mm[1]); return json(200, { ok: true }) }
      return json(200, mc)
    }
    return json(404, { error: `unhandled ${method} ${m}` })
  }
  return { calls, machines, volumes, apps, fetchImpl }
}

const cfg = { token: 'fo1_test', org: 'personal', region: 'iad', app: 'dsb-host' }

test('mapFlyState: Fly machine states → SandboxStatus', () => {
  assert.equal(mapFlyState('created'), 'creating'); assert.equal(mapFlyState('starting'), 'creating'); assert.equal(mapFlyState('replacing'), 'creating')
  assert.equal(mapFlyState('started'), 'running')
  assert.equal(mapFlyState('stopping'), 'stopped'); assert.equal(mapFlyState('stopped'), 'stopped'); assert.equal(mapFlyState('suspended'), 'stopped')
  assert.equal(mapFlyState('destroying'), 'missing'); assert.equal(mapFlyState('destroyed'), 'missing')
})

test('fly: create makes the app once, a volume, and a machine with the image, env, /data mount and the bot port; origin is the 6PN private IP', async () => {
  const fly = fakeFly()
  const p = new FlyProvider({ ...cfg, fetchImpl: fly.fetchImpl })
  const sb = await p.create('acct1', { image: 'registry.fly.io/dsb:slim', env: { DEEPSEEK_API_KEY: 'sk-x' } })
  assert.equal(sb.id, 'acct1')
  assert.equal(sb.origin, 'http://[fdaa:0:1::2]:3850')
  const create = fly.calls.find((c) => c.method === 'POST' && c.path === '/v1/apps')!
  assert.deepEqual(create.body, { app_name: 'dsb-host', org_slug: 'personal' })
  assert.equal(create.auth, 'Bearer fo1_test')
  const vol = fly.calls.find((c) => c.method === 'POST' && c.path.endsWith('/volumes'))!
  assert.equal((vol.body as { name: string }).name, 'dsb_acct1_data')
  assert.equal((vol.body as { region: string }).region, 'iad')
  const mach = fly.calls.find((c) => c.method === 'POST' && c.path.endsWith('/machines'))!.body as { name: string; region: string; config: Record<string, unknown> }
  assert.equal(mach.name, 'dsb-acct1'); assert.equal(mach.region, 'iad')
  assert.equal(mach.config.image, 'registry.fly.io/dsb:slim')
  assert.deepEqual(mach.config.env, { DEEPSEEK_API_KEY: 'sk-x' })
  assert.deepEqual(mach.config.mounts, [{ volume: 'vol_1', path: '/data' }])
  assert.deepEqual((mach.config.services as { internal_port: number }[])[0].internal_port, 3850)
  assert.deepEqual(mach.config.guest, { cpu_kind: 'shared', cpus: 1, memory_mb: 1024 })
  assert.equal((mach.config.restart as { policy: string }).policy, 'on-failure')
  // waited for started
  assert.ok(fly.calls.some((c) => /\/machines\/m2\/wait\?state=started/.test(c.path)))

  // the app already exists next time: no second POST /v1/apps
  await p.create('acct2', { image: 'img', env: {} })
  assert.equal(fly.calls.filter((c) => c.method === 'POST' && c.path === '/v1/apps').length, 1)
})

test('fly: get/status/start/stop/remove find the machine by name; remove deletes machine then volume', async () => {
  const fly = fakeFly({ appExists: true })
  const p = new FlyProvider({ ...cfg, fetchImpl: fly.fetchImpl })
  assert.equal(await p.status('acct1'), 'missing')
  assert.equal(await p.get('acct1'), null)
  await p.create('acct1', { image: 'img', env: {} })
  assert.equal(await p.status('acct1'), 'running')
  await p.stop('acct1')
  assert.equal(await p.status('acct1'), 'stopped')
  assert.ok(fly.calls.some((c) => c.method === 'POST' && c.path.endsWith('/machines/m2/suspend'))) // idle = suspend first
  await p.start('acct1')
  assert.equal(await p.status('acct1'), 'running')
  assert.equal((await p.get('acct1'))?.origin, 'http://[fdaa:0:1::2]:3850')
  await p.remove('acct1')
  assert.equal(await p.status('acct1'), 'missing')
  assert.ok(fly.calls.some((c) => c.method === 'DELETE' && c.path === '/v1/apps/dsb-host/machines/m2?force=true'))
  assert.ok(fly.calls.some((c) => c.method === 'DELETE' && c.path === '/v1/apps/dsb-host/volumes/vol_1'))
  assert.equal(fly.volumes.size, 0)
})

// Idle sandboxes are suspended (a memory snapshot: resume skips the bot's own boot), and stopped only where
// Fly refuses to suspend. Either way the status reads `stopped` and `start` brings it back.
test('fly: stop suspends the machine when Fly allows it, and falls back to a plain stop when it does not', async () => {
  const fly = fakeFly({ appExists: true })
  const p = new FlyProvider({ ...cfg, fetchImpl: fly.fetchImpl })
  await p.create('acct1', { image: 'img', env: {} })
  await p.stop('acct1')
  assert.ok(fly.calls.some((c) => c.method === 'POST' && c.path.endsWith('/machines/m2/suspend')))
  assert.ok(!fly.calls.some((c) => c.method === 'POST' && c.path.endsWith('/machines/m2/stop')))
  assert.equal(await p.status('acct1'), 'stopped')
  await p.start('acct1')
  assert.equal(await p.status('acct1'), 'running')

  const noSuspend = fakeFly({ appExists: true, noSuspend: true })
  const q = new FlyProvider({ ...cfg, fetchImpl: noSuspend.fetchImpl })
  await q.create('acct2', { image: 'img', env: {} })
  await q.stop('acct2')
  assert.ok(noSuspend.calls.some((c) => c.method === 'POST' && c.path.endsWith('/suspend')))
  assert.ok(noSuspend.calls.some((c) => c.method === 'POST' && c.path.endsWith('/stop')))
  assert.equal(await q.status('acct2'), 'stopped')
})

test('fly: an API error surfaces with status and body', async () => {
  const p = new FlyProvider({ ...cfg, fetchImpl: async () => new Response('{"error":"Unauthorized"}', { status: 401 }) })
  await assert.rejects(p.status('xyz'), /Fly API 401/)
})
