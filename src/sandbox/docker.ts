// SandboxProvider on the local Docker daemon through the `docker` CLI.
//   create → docker run -d --name dsb-<id> --restart unless-stopped -v dsb-<id>-data:/data -p 127.0.0.1:<port>:3850 -e K … <image>
//   get/status → docker inspect (State.Status, NetworkSettings.Ports)
//   start/stop/remove → docker start / stop / rm -f + volume rm
// Env values ride in the child process environment (`-e KEY` without a value),
// so secrets never appear on a command line. Measured 2026-10-27 against Docker
// 29.8.2 on macOS: test/sandbox-docker.test.ts.
import { execFile } from 'node:child_process'
import { assertSandboxId, type CreateOptions, type Sandbox, type SandboxProvider, type SandboxStatus } from './provider.ts'

export interface DockerOptions {
  /** Host ports to publish the bot on (inclusive). Default: Docker picks an ephemeral port (`-p 127.0.0.1::3850`). */
  hostPortRange?: [number, number]
  /** Put sandboxes on this Docker network and address them by name (`http://dsb-<id>:3850`) instead of publishing a port.
   *  For a host that itself runs in a container on the same daemon (deploy/host.compose.yml). */
  network?: string
  /** `docker` binary. */
  bin?: string
  /** Extra `docker run` arguments (e.g. `--memory 1g`). */
  runArgs?: string[]
  exec?: Exec
}

export type Exec = (args: string[], env?: NodeJS.ProcessEnv) => Promise<{ stdout: string; stderr: string }>

const BOT_PORT = 3850

function dockerExec(bin: string): Exec {
  return (args, env) => new Promise((resolve, reject) => {
    execFile(bin, args, { env: env ?? process.env, maxBuffer: 8 << 20 }, (err, stdout, stderr) => {
      if (err) { const e = err as Error & { stderr?: string; code?: number | string }; e.message = `docker ${args[0]} failed: ${String(stderr).trim() || e.message}`; e.stderr = String(stderr); return reject(e) }
      resolve({ stdout: String(stdout), stderr: String(stderr) })
    })
  })
}

export interface InspectRow { State?: { Status?: string }; NetworkSettings?: { Ports?: Record<string, { HostIp?: string; HostPort?: string }[] | null> }; HostConfig?: { PortBindings?: Record<string, { HostIp?: string; HostPort?: string }[]> } }

/** docker inspect → status + origin. Ports are only listed while the container runs; HostConfig keeps the fixed binding. */
export function parseInspect(row: InspectRow): { status: SandboxStatus; origin: string | null } {
  const s = row.State?.Status ?? ''
  const status: SandboxStatus = s === 'running' ? 'running' : s === 'created' || s === 'restarting' ? 'creating' : 'stopped'
  const binding = row.NetworkSettings?.Ports?.[`${BOT_PORT}/tcp`]?.[0] ?? (status === 'running' ? row.HostConfig?.PortBindings?.[`${BOT_PORT}/tcp`]?.[0] : undefined)
  const port = binding?.HostPort
  const ip = binding?.HostIp && binding.HostIp !== '0.0.0.0' && binding.HostIp !== '' ? binding.HostIp : '127.0.0.1'
  return { status, origin: port && status === 'running' ? `http://${ip}:${port}` : null }
}

export class DockerProvider implements SandboxProvider {
  readonly kind = 'docker'
  private readonly opts: DockerOptions
  private readonly exec: Exec
  constructor(opts: DockerOptions = {}) { this.opts = opts; this.exec = opts.exec ?? dockerExec(opts.bin ?? 'docker') }

  private name(id: string) { assertSandboxId(id); return `dsb-${id}` }
  private volume(id: string) { return `dsb-${id}-data` }

  private async inspect(id: string): Promise<InspectRow | null> {
    try {
      const { stdout } = await this.exec(['inspect', '--type', 'container', this.name(id)])
      const rows = JSON.parse(stdout) as InspectRow[]
      return rows[0] ?? null
    } catch (e) {
      if (/No such (object|container)|not found/i.test(String((e as { stderr?: string }).stderr ?? (e as Error).message))) return null
      throw e
    }
  }

  /** Host ports already bound by other dsb-* containers (running or not). */
  private async usedPorts(): Promise<Set<number>> {
    const { stdout } = await this.exec(['ps', '-a', '--filter', 'name=^dsb-', '--format', '{{.Names}}'])
    const names = stdout.split('\n').map((s) => s.trim()).filter(Boolean)
    const used = new Set<number>()
    if (!names.length) return used
    const { stdout: js } = await this.exec(['inspect', '--type', 'container', '-f', '{{json .HostConfig.PortBindings}}', ...names])
    for (const line of js.split('\n')) {
      if (!line.trim()) continue
      try { for (const b of (JSON.parse(line) as Record<string, { HostPort?: string }[] | null>)[`${BOT_PORT}/tcp`] ?? []) if (b.HostPort) used.add(Number(b.HostPort)) } catch { /* not JSON */ }
    }
    return used
  }

  async create(id: string, opts: CreateOptions): Promise<Sandbox> {
    const name = this.name(id)
    let publish = `127.0.0.1::${BOT_PORT}`
    if (this.opts.network) publish = ''
    else if (this.opts.hostPortRange) {
      const [from, to] = this.opts.hostPortRange
      const used = await this.usedPorts()
      let port = from
      while (port <= to && used.has(port)) port++
      if (port > to) throw new Error(`no free port in ${from}-${to} for sandbox ${id}`)
      publish = `127.0.0.1:${port}:${BOT_PORT}`
    }
    const args = ['run', '-d', '--name', name, '--restart', 'unless-stopped', '-v', `${this.volume(id)}:/data`, ...(publish ? ['-p', publish] : ['--network', this.opts.network!]),
      // the bot inside reaches the host service (push relay) at host.docker.internal on Linux too
      '--add-host', 'host.docker.internal:host-gateway', '--label', 'deepseek-bot.sandbox=1', ...(this.opts.runArgs ?? [])]
    for (const k of Object.keys(opts.env)) args.push('-e', k)
    args.push(opts.image)
    await this.exec(args, { ...process.env, ...opts.env })
    const sb = await this.get(id)
    if (!sb) throw new Error(`docker run succeeded but ${name} has no published port`)
    return sb
  }

  async get(id: string): Promise<Sandbox | null> {
    const row = await this.inspect(id)
    if (!row) return null
    if (this.opts.network) return { id, origin: `http://${this.name(id)}:${BOT_PORT}` }
    const { origin } = parseInspect(row)
    // a stopped container keeps its binding in HostConfig; report it so callers can wake and retry
    const fixed = row.HostConfig?.PortBindings?.[`${BOT_PORT}/tcp`]?.[0]?.HostPort
    return { id, origin: origin ?? (fixed ? `http://127.0.0.1:${fixed}` : '') }
  }

  async status(id: string): Promise<SandboxStatus> {
    const row = await this.inspect(id)
    return row ? parseInspect(row).status : 'missing'
  }

  async start(id: string) { await this.exec(['start', this.name(id)]) }
  async stop(id: string) { await this.exec(['stop', '-t', '15', this.name(id)]) }
  async remove(id: string) {
    await this.exec(['rm', '-f', '-v', this.name(id)]).catch((e) => { if (!/No such container/i.test(String((e as { stderr?: string }).stderr ?? ''))) throw e })
    await this.exec(['volume', 'rm', '-f', this.volume(id)]).catch(() => {})
  }
}
