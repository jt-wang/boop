// Owns the `dsh web` child: spawn it on loopback, read the launch link it
// prints, and exchange the token for the browser-session cookie every
// forwarded request needs.
//
// Measured 2026-10-26 against DSH 0.2.0-rc.2 (scratchpad/probe.mjs):
//   stdout line      dsh web: http://127.0.0.1:55765/?token=<token>
//   GET /?token=…    303, Set-Cookie: dsh-auth-<id>=<value>; Path=/; HttpOnly; SameSite=Lax
//   POST /api/*      401 without that cookie, 200 with it
import { spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { once } from 'node:events'
import { rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { cellMountArgs, prepareDshCell, type CellPaths } from './cell.ts'

export interface LaunchLink { origin: string; token: string }

export function parseLaunchUrl(line: string): LaunchLink | null {
  const m = /(https?:\/\/[^\s/?#]+)\/?\?token=([A-Za-z0-9_-]+)/.exec(line)
  return m ? { origin: m[1], token: m[2] } : null
}

export async function exchangeToken(link: LaunchLink, fetchImpl: typeof fetch = fetch): Promise<string> {
  const res = await fetchImpl(`${link.origin}/?token=${link.token}`, { redirect: 'manual' })
  const setCookie = res.headers.get('set-cookie')
  if (!setCookie) throw new Error(`dsh token exchange returned HTTP ${res.status} without a cookie`)
  return setCookie.split(';')[0]
}

export interface DshHandle {
  origin: string
  cookie: string
  child: ChildProcess
  stop(): Promise<void>
}

export interface StartOptions {
  dshHome: string
  profile?: string
  /** Extra args after `web`; `--no-open --port 0` are always added. */
  args?: string[]
  /** Bound on waiting for the launch link. */
  timeoutMs?: number
  env?: NodeJS.ProcessEnv
  /** Extra env names the harness may keep (model surrogate, proxy base URL). */
  allowedEnv?: string[]
  /** Run `dsh web` in a bubblewrap cell as this unprivileged user. */
  cell?: CellPaths & { uid?: number; gid?: number }
  /** Don't delete `.credentials.yaml` after the cookie exchange (tests that inspect it). */
  keepCredentials?: boolean
}

/** The `dsh` script of the installed @deepseek-ai/dsh, resolved from `from` (a file path or URL; this module by default). */
export function dshBin(from: string = import.meta.url): string {
  const require = createRequire(from)
  const pkg = require.resolve('@deepseek-ai/dsh/package.json')
  const { bin } = require(pkg) as { bin: Record<string, string> }
  // A path, not a URL's pathname: inside "DeepSeek Bot.app" the space would stay %20 (test/dsh.test.ts).
  return resolve(dirname(pkg), bin.dsh)
}

// The harness only needs a small, known environment. Everything else in the
// bot process (connector OAuth tokens, the host secret, the real model key,
// GitHub/AWS credentials) stays outside the cell. `allowedEnv` names the
// surrogate model variables this deployment adds on purpose.
const HARNESS_ENV = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TMPDIR', 'NODE_ENV', 'NO_COLOR', 'TERM', 'SSL_CERT_FILE', 'SSL_CERT_DIR']

export function harnessEnv(env: NodeJS.ProcessEnv, allowedEnv: string[] = []): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const k of [...HARNESS_ENV, ...allowedEnv]) if (env[k] !== undefined) out[k] = env[k]
  return out
}

/**
 * The surrogate model variables DSH gets. Chat uses the provider's key variable and base URL; web_search
 * (`@deepseek-ai/dsh-web-search-deepseek`) reads `DEEPSEEK_API_KEY` and `DEEPSEEK_SEARCH_BASE_URL` and appends
 * `/messages`, so it must point at the same loopback model proxy. The real key stays in the bot.
 */
export function dshModelEnv(o: { official: boolean; modelKeyEnv: string; proxyUrl: string; upstreamPath: string; surrogate: string }): NodeJS.ProcessEnv {
  if (o.official) return {
    DEEPSEEK_API_KEY: o.surrogate,
    DEEPSEEK_BASE_URL: `${o.proxyUrl}/anthropic`,
    DEEPSEEK_SEARCH_BASE_URL: `${o.proxyUrl}/anthropic/v1`,
  }
  return {
    [o.modelKeyEnv]: o.surrogate,
    DEEPSEEK_API_KEY: o.surrogate,
    DEEPSEEK_SEARCH_BASE_URL: `${o.proxyUrl}${o.upstreamPath}`,
  }
}

/** The harness's env: skills come from its own home (DSH reads ~/.agents/skills by default, the person's on a Mac). */
export function dshSpawnEnv(opts: Pick<StartOptions, 'dshHome' | 'env' | 'allowedEnv'>): NodeJS.ProcessEnv {
  return {
    ...harnessEnv(opts.env ?? process.env, opts.allowedEnv ?? ['DEEPSEEK_BOT_MODEL_KEY']),
    DSH_HOME: opts.dshHome,
    DSH_AGENTS_HOME: join(opts.dshHome, 'agents'),
    // DSH uploads the session log after feedback by default (dsh-base/cordis.patch.yml). Boop never does; last, so nothing overrides it.
    DSH_TELEMETRY_MODE: 'DISABLED',
  }
}

export async function startDshWeb(opts: StartOptions): Promise<DshHandle> {
  const inner = [dshBin(), '--profile', opts.profile ?? 'web', '--no-open', '--port', '0', ...(opts.args ?? [])]
  const env = dshSpawnEnv(opts)
  let command = process.execPath
  let args = inner
  let spawnOpts: Parameters<typeof spawn>[2] = {}
  if (opts.cell) {
    const cell = { ...opts.cell, dshHome: opts.dshHome }
    await prepareDshCell(cell, opts.cell.uid ?? 1000, opts.cell.gid ?? 1000)
    env.HOME = opts.cell.home
    // setpriv drops to the cell uid and clears root's supplementary groups;
    // prlimit then lowers the hard limits (the child cannot raise them again),
    // and bwrap builds the cell.
    command = 'setpriv'
    args = [
      `--reuid=${opts.cell.uid ?? 1000}`, `--regid=${opts.cell.gid ?? 1000}`, '--clear-groups', '--',
      'prlimit', '--nproc=384', '--nofile=4096', '--core=0', '--',
      'bwrap', ...cellMountArgs(cell), '--', ...inner,
    ]
    spawnOpts = { cwd: opts.cell.workspace }
  }
  const child = spawn(command as string, args as string[], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...spawnOpts,
  })
  if (opts.cell && typeof process.getuid === 'function' && process.getuid() === 0) {
    writeFile(`/proc/${child.pid}/oom_score_adj`, '-1000').catch(() => {})
  }
  const link = await new Promise<LaunchLink>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`dsh web printed no launch link within ${opts.timeoutMs ?? 60_000}ms\n${stderr}`)), opts.timeoutMs ?? 60_000)
    let stderr = ''
    let buf = ''
    child.stdout!.on('data', (d: Buffer) => {
      buf += d.toString()
      const found = parseLaunchUrl(buf)
      if (found) { clearTimeout(timer); resolve(found) }
    })
    child.stderr!.on('data', (d: Buffer) => { stderr = (stderr + d.toString()).slice(-4000) })
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`dsh web exited with ${code} before printing a launch link\n${stderr}`)) })
  })
  // The bot's own DSH plugin (src/dsh-plugin.js) logs on DSH's stderr: its lines go to the bot's log.
  let pluginBuf = ''
  child.stderr!.on('data', (d: Buffer) => {
    pluginBuf += d.toString()
    const lines = pluginBuf.split('\n'); pluginBuf = lines.pop() ?? ''
    for (const l of lines) if (l.includes('deepseek-bot: ')) console.error(`[dsh] ${l.slice(l.indexOf('deepseek-bot: '))}`)
  })
  const cookie = await exchangeToken(link)
  // DSH's browser-session secret is only needed in its memory after this
  // exchange. Delete the on-disk copy so neither the shell (whose view of
  // /data/dsh is masked anyway) nor a future read tool can forge its cookie.
  if (!opts.keepCredentials) {
    for (const f of ['.credentials.yaml', '.credentials.yaml.lock']) await rm(join(opts.dshHome, f), { force: true }).catch(() => {})
  }
  return {
    origin: link.origin,
    cookie,
    child,
    async stop() {
      if (child.exitCode !== null) return
      child.kill('SIGTERM')
      const t = setTimeout(() => child.kill('SIGKILL'), 5000)
      await once(child, 'exit')
      clearTimeout(t)
    },
  }
}
