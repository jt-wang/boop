// SandboxProvider on Apple's `container` CLI (macOS 26+, Apple silicon; one
// lightweight VM per container). Same shape as the docker provider.
//
// Command shapes follow `container --help` as published at
// github.com/apple/container (read 2026-10-27):
//   container run --detach --name <n> --volume <vol>:/data --publish 127.0.0.1:<port>:3850/tcp --env K <image>
//   container inspect <n>   → JSON array [{status, configuration:{id, publishedPorts:[{hostAddress, hostPort, containerPort, proto}]}}]
//   container start|stop <n>; container rm <n>; container volume create|delete <vol>
// The CLI is NOT installed on this machine and none of this was run; the inspect
// field names are a best reading of the docs. Unit-tested with a mocked exec in
// test/sandbox-apple-container.test.ts; not run against a real container yet.
import { execFile } from 'node:child_process'
import { assertSandboxId, type CreateOptions, type Sandbox, type SandboxProvider, type SandboxStatus } from './provider.ts'
import type { Exec } from './docker.ts'

export interface AppleContainerOptions {
  /** Required: Apple's CLI publishes fixed host ports only. */
  hostPortRange: [number, number]
  bin?: string
  exec?: Exec
}

const BOT_PORT = 3850

export interface ContainerInspectRow { status?: string; configuration?: { id?: string; publishedPorts?: { hostAddress?: string; hostPort?: number | string; containerPort?: number | string; proto?: string }[] } }

export function parseContainerInspect(rows: ContainerInspectRow[]): { status: SandboxStatus; origin: string | null } {
  const row = rows[0]
  if (!row) return { status: 'missing', origin: null }
  const s = String(row.status ?? '').toLowerCase()
  const status: SandboxStatus = s === 'running' ? 'running' : s === 'stopped' || s === 'exited' ? 'stopped' : 'creating'
  const pub = (row.configuration?.publishedPorts ?? []).find((p) => Number(p.containerPort) === BOT_PORT)
  return { status, origin: pub && status === 'running' ? `http://${pub.hostAddress || '127.0.0.1'}:${pub.hostPort}` : null }
}

function cliExec(bin: string): Exec {
  return (args, env) => new Promise((resolve, reject) => {
    execFile(bin, args, { env: env ?? process.env, maxBuffer: 8 << 20 }, (err, stdout, stderr) => {
      if (err) { const e = err as Error & { stderr?: string }; e.message = `container ${args[0]} failed: ${String(stderr).trim() || e.message}`; e.stderr = String(stderr); return reject(e) }
      resolve({ stdout: String(stdout), stderr: String(stderr) })
    })
  })
}

export class AppleContainerProvider implements SandboxProvider {
  readonly kind = 'apple-container'
  private readonly opts: AppleContainerOptions
  private readonly exec: Exec
  /** id → published host port, remembered within this process; `inspect` is the source of truth. */
  private readonly ports = new Map<string, number>()
  constructor(opts: AppleContainerOptions) { this.opts = opts; this.exec = opts.exec ?? cliExec(opts.bin ?? 'container') }

  private name(id: string) { assertSandboxId(id); return `dsb-${id}` }
  private volume(id: string) { return `dsb-${id}-data` }

  private async inspect(id: string): Promise<ContainerInspectRow[]> {
    try { return JSON.parse((await this.exec(['inspect', this.name(id)])).stdout) as ContainerInspectRow[] }
    catch (e) { if (/not found|no such|does not exist/i.test(String((e as Error).message))) return []; throw e }
  }

  private async usedPorts(): Promise<Set<number>> {
    const used = new Set<number>(this.ports.values())
    try {
      const rows = JSON.parse((await this.exec(['ls', '--all', '--format', 'json'])).stdout) as ContainerInspectRow[]
      for (const r of rows) for (const p of r.configuration?.publishedPorts ?? []) if (p.hostPort) used.add(Number(p.hostPort))
    } catch { /* an older CLI without --format json: fall back to what this process knows */ }
    return used
  }

  async create(id: string, opts: CreateOptions): Promise<Sandbox> {
    const [from, to] = this.opts.hostPortRange
    const used = await this.usedPorts()
    let port = from
    while (port <= to && used.has(port)) port++
    if (port > to) throw new Error(`no free port in ${from}-${to} for sandbox ${id}`)
    await this.exec(['volume', 'create', this.volume(id)]).catch(() => { /* exists */ })
    const args = ['run', '--detach', '--name', this.name(id), '--volume', `${this.volume(id)}:/data`, '--publish', `127.0.0.1:${port}:${BOT_PORT}/tcp`]
    for (const k of Object.keys(opts.env)) args.push('--env', k)
    args.push(opts.image)
    await this.exec(args, { ...process.env, ...opts.env })
    this.ports.set(id, port)
    return { id, origin: `http://127.0.0.1:${port}` }
  }

  async get(id: string): Promise<Sandbox | null> {
    const rows = await this.inspect(id)
    if (!rows.length) return null
    const { origin } = parseContainerInspect(rows)
    const known = this.ports.get(id)
    return { id, origin: origin ?? (known ? `http://127.0.0.1:${known}` : '') }
  }

  async status(id: string): Promise<SandboxStatus> { return parseContainerInspect(await this.inspect(id)).status }
  async start(id: string) { await this.exec(['start', this.name(id)]) }
  async stop(id: string) { await this.exec(['stop', this.name(id)]) }
  async remove(id: string) {
    await this.exec(['rm', '--force', this.name(id)]).catch(() => {})
    await this.exec(['volume', 'delete', this.volume(id)]).catch(() => {})
    this.ports.delete(id)
  }
}
