// SandboxProvider on Fly Machines (Firecracker microVMs; a stopped machine
// costs only its volume). One Fly app per host, one machine + one volume per
// sandbox, found by name `dsb-<id>`.
//
// REST shapes from https://docs.fly.io/machines/api/ (apps, machines, volumes
// resources, read 2026-10-27):
//   POST /v1/apps {app_name, org_slug}                → 201 {id, created_at}
//   POST /v1/apps/{app}/volumes {name, region, size_gb} → {id, name, state, …}
//   POST /v1/apps/{app}/machines {name, region, config:{image, env, guest, mounts:[{volume, path}], services, restart}}
//                                                     → {id, name, state, private_ip, instance_id, config}
//   GET  /v1/apps/{app}/machines                      → [machine]
//   POST …/machines/{id}/start | /stop | /suspend     → {previous_state,…} | {ok} | {ok}
//   GET  …/machines/{id}/wait?state=started&timeout=60 → {ok}
//   DELETE …/machines/{id}?force=true                 → {ok}
//   DELETE …/volumes/{volume_id}                      → volume with state destroyed
// Machine states: created, starting, started, stopping, stopped, suspended, replacing, destroying, destroyed.
//
// The origin is the machine's 6PN private IPv6 (`http://[fdaa:…]:3850`): the
// host must run inside the same Fly organisation network (another machine in
// the org, or over `fly wireguard`). Unit-tested against a fake in
// test/sandbox-fly.test.ts; run against a real account by
// test/sandbox-fly.e2e.test.ts.
import { assertSandboxId, type CreateOptions, type Sandbox, type SandboxProvider, type SandboxStatus } from './provider.ts'

export interface FlyOptions {
  /** A Fly API token (`fly tokens create org`). */
  token: string
  /** Organisation slug the app belongs to. */
  org: string
  /** Region for machines and volumes: a code from `fly platform regions`. */
  region: string
  /** The one Fly app that holds every sandbox machine. */
  app: string
  /** Volume size per sandbox. Default 3 GB (Fly's default). */
  volumeGb?: number
  guest?: { cpu_kind: string; cpus: number; memory_mb: number }
  apiBase?: string
  fetchImpl?: typeof fetch
}

interface FlyMachine { id: string; name: string; state: string; private_ip?: string; instance_id?: string; config?: { mounts?: { volume: string; path: string }[] } }
interface FlyVolume { id: string; name: string; state: string; attached_machine_id?: string | null }

export function mapFlyState(state: string): SandboxStatus {
  switch (state) {
    case 'started': return 'running'
    case 'created': case 'starting': case 'replacing': return 'creating'
    case 'stopping': case 'stopped': case 'suspended': return 'stopped'
    case 'destroying': case 'destroyed': return 'missing'
    default: return 'creating'
  }
}

export class FlyProvider implements SandboxProvider {
  readonly kind = 'fly'
  private readonly o: FlyOptions
  private readonly base: string
  private readonly f: typeof fetch
  private appChecked = false
  constructor(o: FlyOptions) { this.o = o; this.base = (o.apiBase ?? 'https://api.machines.dev').replace(/\/$/, ''); this.f = o.fetchImpl ?? fetch }

  private async api<T>(method: string, path: string, body?: unknown, okStatuses: number[] = [200, 201, 202]): Promise<{ status: number; body: T }> {
    const res = await this.f(`${this.base}${path}`, { method, headers: { authorization: `Bearer ${this.o.token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    const text = await res.text()
    let parsed: unknown = null
    try { parsed = text ? JSON.parse(text) : null } catch { parsed = text }
    if (!okStatuses.includes(res.status)) throw Object.assign(new Error(`Fly API ${res.status} on ${method} ${path}: ${typeof parsed === 'string' ? parsed : JSON.stringify(parsed)}`), { status: res.status })
    return { status: res.status, body: parsed as T }
  }

  private machineName(id: string) { assertSandboxId(id); return `dsb-${id}` }
  private volumeName(id: string) { return `dsb_${id.replace(/-/g, '_')}_data` }

  private async ensureApp() {
    if (this.appChecked) return
    const r = await this.api('GET', `/v1/apps/${this.o.app}`, undefined, [200, 404])
    if (r.status === 404) {
      if (!this.o.org) throw new Error(`Fly app ${this.o.app} does not exist and no --fly-org was given to create it`)
      await this.api('POST', '/v1/apps', { app_name: this.o.app, org_slug: this.o.org })
    }
    this.appChecked = true
  }

  private async findMachine(id: string): Promise<FlyMachine | null> {
    const name = this.machineName(id)
    const r = await this.api<FlyMachine[]>('GET', `/v1/apps/${this.o.app}/machines`, undefined, [200, 404])
    if (r.status === 404) return null
    return r.body.find((m) => m.name === name && m.state !== 'destroyed') ?? null
  }

  private origin(m: FlyMachine) { return m.private_ip ? `http://[${m.private_ip}]:3850` : '' }

  async create(id: string, opts: CreateOptions): Promise<Sandbox> {
    await this.ensureApp()
    const existing = await this.findMachine(id)
    if (existing) return { id, origin: this.origin(existing) }
    const vol = (await this.api<FlyVolume>('POST', `/v1/apps/${this.o.app}/volumes`, { name: this.volumeName(id), region: this.o.region, size_gb: this.o.volumeGb ?? 3 })).body
    const m = (await this.api<FlyMachine>('POST', `/v1/apps/${this.o.app}/machines`, {
      name: this.machineName(id),
      region: this.o.region,
      config: {
        image: opts.image,
        env: opts.env,
        guest: this.o.guest ?? { cpu_kind: 'shared', cpus: 1, memory_mb: 1024 },
        mounts: [{ volume: vol.id, path: '/data' }],
        services: [{ protocol: 'tcp', internal_port: 3850, ports: [] }],
        // "always" would bring a machine we stopped back; on-failure only restarts a crashed bot
        restart: { policy: 'on-failure', max_retries: 3 },
        metadata: { 'deepseek-bot.sandbox': id },
      },
    })).body
    await this.api('GET', `/v1/apps/${this.o.app}/machines/${m.id}/wait?state=started&timeout=60`)
    return { id, origin: this.origin(m) }
  }

  async get(id: string): Promise<Sandbox | null> {
    const m = await this.findMachine(id)
    return m ? { id, origin: this.origin(m) } : null
  }

  /** Fly's own state word (started, suspended, stopped, …), for tests and logs. */
  async rawState(id: string): Promise<string | null> { const m = await this.findMachine(id); return m ? m.state : null }

  async status(id: string): Promise<SandboxStatus> {
    const m = await this.findMachine(id)
    return m ? mapFlyState(m.state) : 'missing'
  }

  async start(id: string) {
    const m = await this.findMachine(id); if (!m) throw new Error(`sandbox ${id} missing`)
    await this.api('POST', `/v1/apps/${this.o.app}/machines/${m.id}/start`)
    await this.api('GET', `/v1/apps/${this.o.app}/machines/${m.id}/wait?state=started&timeout=60`)
  }

  /**
   * Idle: suspend (a memory snapshot; `start` resumes without the bot's own boot, measured in
   * test/sandbox-fly.e2e.test.ts). Where Fly refuses to suspend this machine, a plain stop.
   */
  async stop(id: string) {
    const m = await this.findMachine(id); if (!m) throw new Error(`sandbox ${id} missing`)
    const s = await this.api('POST', `/v1/apps/${this.o.app}/machines/${m.id}/suspend`, undefined, [200, 400, 412, 422])
    if (s.status === 200) return
    await this.api('POST', `/v1/apps/${this.o.app}/machines/${m.id}/stop`, { signal: 'SIGTERM', timeout: '15s' })
  }

  async remove(id: string) {
    const m = await this.findMachine(id)
    if (m) await this.api('DELETE', `/v1/apps/${this.o.app}/machines/${m.id}?force=true`)
    const vols = (await this.api<FlyVolume[]>('GET', `/v1/apps/${this.o.app}/volumes`, undefined, [200, 404])).body ?? []
    for (const v of Array.isArray(vols) ? vols : []) if (v.name === this.volumeName(id)) await this.api('DELETE', `/v1/apps/${this.o.app}/volumes/${v.id}`)
  }
}
