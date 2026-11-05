// One sandbox per account: the assistant's computer as an OCI container or
// microVM. The host (src/host/) only talks to this
// interface; `docker` (src/sandbox/docker.ts), `fly` (fly.ts) and
// `apple-container` (apple-container.ts) implement it.
export type SandboxStatus = 'creating' | 'running' | 'stopped' | 'missing'

export interface Sandbox {
  id: string
  /** `http://host:port` of the bot inside, reachable from the host service. */
  origin: string
}

export interface CreateOptions {
  image: string
  /** Environment for the bot inside (model key, host secret, push relay). */
  env: Record<string, string>
}

export interface SandboxProvider {
  kind: string
  /** Create and start. Resolves once the container exists; the bot inside may still be booting. */
  create(id: string, opts: CreateOptions): Promise<Sandbox>
  /** The sandbox and its current origin, or null when it does not exist. The origin can change across stop/start. */
  get(id: string): Promise<Sandbox | null>
  start(id: string): Promise<void>
  stop(id: string): Promise<void>
  /** Container and its data volume. */
  remove(id: string): Promise<void>
  status(id: string): Promise<SandboxStatus>
}

/** Sandbox ids come from the host's account store; keep them safe for container names and volume names. */
export const SANDBOX_ID_RE = /^[a-z0-9][a-z0-9-]{2,40}$/

export function assertSandboxId(id: string) {
  if (!SANDBOX_ID_RE.test(id)) throw new Error(`bad sandbox id ${JSON.stringify(id)}`)
}

/** Poll `GET <origin>/health` until it says `{ok:true, dsh:true}`. */
export async function waitHealthy(origin: string, opts: { timeoutMs?: number; intervalMs?: number; fetchImpl?: typeof fetch; requireDsh?: boolean } = {}): Promise<void> {
  const deadline = Date.now() + (opts.timeoutMs ?? 120_000)
  const f = opts.fetchImpl ?? fetch
  let last = ''
  while (Date.now() < deadline) {
    try {
      const r = await f(`${origin}/health`, { signal: AbortSignal.timeout(3000) })
      if (r.ok) {
        const b = await r.json() as { ok?: boolean; dsh?: boolean }
        if (b.ok && (b.dsh || opts.requireDsh === false)) return
        last = JSON.stringify(b)
      } else last = `HTTP ${r.status}`
    } catch (e) { last = (e as Error).message }
    await new Promise((r) => setTimeout(r, opts.intervalMs ?? 500))
  }
  throw new Error(`${origin}/health not ready after ${opts.timeoutMs ?? 120_000}ms (last: ${last})`)
}
