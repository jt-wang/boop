// Generative UI, second layer: modules. The assistant writes a whole NSH TSX
// module (`ui` tool, src/tools.ts); this file type-checks it (`nsh check`),
// builds and signs it (`nsh publish`) with a release key the bot certified
// with its own root key, and keeps the package for the phone to download
// (GET /ui/:id.nshpkg, src/server.ts). The phone trusts the root key from
// GET /me, verifies the package and runs it in a sheet. The module posts its
// result once to POST /ui/:id/result with a one-time token; the server turns
// that into the person's next message (moduleAnswerPrompt).
//
// Measured with nsh 0.3.0 (76fa8a7) on 2026-10-27, Apple silicon:
//   keygen 5 ms each, certify 4 ms, `nsh check` 26–67 ms (its TypeScript is cached
//   after the first run), `nsh publish` 13 ms, package 9.3 KB for a 30-line module,
//   `nsh verify` 4 ms. `nsh build` alone does not type-check (a `const n: number =
//   'x'` passed), only `nsh check` does, so both run.
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmod, chown, copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { INJECT } from './cards.ts'
import { isPermission, type Permission } from './compliance.ts'
import { interfaceText } from './moderation.ts'
import { writeAtomic } from './atomic.ts'

export { moduleAnswerPrompt, parseModuleAnswer } from './cards.ts'

/** App ids the release key may sign for: one id per module under this prefix, so the phone's rollback protection (highest build per app id) never bites a new module. */
export const UI_APP_PREFIX = 'dev.deepseekbot.ui.'

export interface UiModule {
  id: string
  title: string
  /** One-time bearer for POST /ui/:id/result. Spent after the first result. */
  token: string
  at: number
  /** The thread the module belongs to: bound when the phone downloads the package with ?session=. */
  sessionId?: string
  spent?: boolean
  /** [compliance] What it asked for beyond its own screen (src/compliance.ts PERMISSIONS); each needs the person's yes, per interface. */
  permissions?: Permission[]
  /** [compliance] What the person allowed of `permissions`. */
  grants?: Permission[]
  /** [compliance] The person hid it (it no longer opens); `blocked`: the host's operators did, after a report. */
  hidden?: boolean
  blocked?: boolean
}

/** [compliance] Host functions a module may call (its declaration; the shells grant no more): its params and closing its sheet. */
export const MODULE_HOST_FUNCTIONS = ['launch.params', 'ui.close', 'ui.size']

/**
 * The module the assistant wrote, mounted so a shell that runs it inside the thread (the app says `inline`, the Android
 * shell's InlineModule) learns how tall it is: its root goes inside a view that measures it and calls `ui.size`. Full
 * screen it mounts as written. Only the `mount` imported by that name from nsh is taken over; anything else is left
 * as it is (the shell then gives it a fixed height). Appended, with the import renamed on its own line, so the check's
 * errors still point at the assistant's lines.
 */
// The measuring root is a row: a module's root is usually `flex-1` (it fills the screen when full screen), which in a
// column of no set height takes no height (only its padding: 32 dp measured on Android 2026-11-02); in a row `flex-1`
// fills the width and the height is what the module draws. `onLayout` gives `{ origin, size }` (nsh 0.3.0).
export function withSizeReport(source: string): string {
  const m = /^(import\s*\{)([^}]*)(\}\s*from\s*(['"])nsh\4)/m.exec(source)
  if (!m || !m[2].split(',').some((x) => x.trim() === 'mount')) return source
  const names = m[2].split(',').map((x) => (x.trim() === 'mount' ? x.replace('mount', 'mount as __nshMount') : x)).join(',')
  return source.slice(0, m.index) + m[1] + names + m[3] + source.slice(m.index + m[0].length) + `
import { host as __boopHost, View as __BoopView } from 'nsh'
function mount(app: any, props?: any) {
  if (!(__boopHost.params as any)?.inline) return __nshMount(app, props)
  const App = app
  return __nshMount(() => (
    <__BoopView style={{ position: 'absolute', left: 0, right: 0, top: 0, flexDirection: 'row', alignItems: 'flex-start' }} onLayout={(b: any) => { __boopHost.call('ui.size', { height: Math.ceil(b.size?.height ?? 0) }).catch(() => {}) }}>
      <App {...(props ?? {})} />
    </__BoopView>
  ))
}
`
}

/** [compliance] The capabilities an interface declares in nsh.json: the bot only, its host functions, and what it asked for. */
export function moduleCapabilities(hosts: string[], permissions: Permission[] = []): Record<string, unknown> {
  const c: Record<string, unknown> = { network: { hosts }, host: MODULE_HOST_FUNCTIONS }
  if (permissions.includes('openUrl')) c.openUrl = { schemes: ['https'] }
  if (permissions.includes('clipboard')) c.clipboard = true
  if (permissions.includes('picker')) c.picker = true
  return c
}

/** The hosts a module may fetch: the addresses a phone reaches the bot by, including the host in front of a hosted computer. */
export function moduleHosts(o: { publicOrigin: string; publicUrl?: string; bindHost: string }): string[] {
  return [...new Set([
    ...(o.publicUrl ? [new URL(o.publicUrl).hostname] : []),
    new URL(o.publicOrigin).hostname, '127.0.0.1', 'localhost',
    ...(o.bindHost !== '0.0.0.0' && o.bindHost !== '::' ? [o.bindHost] : []),
  ])]
}

/** The one import specifier an agent-written module may use. */
const UI_IMPORT = 'nsh'
/** The module kit beside every module (src/module-kit). */
const MAP_KIT = fileURLToPath(new URL('./module-kit/map.tsx', import.meta.url))

/**
 * The compiler runs in the bot process and resolves imports; a module that
 * imports `/data/connector-secrets.json` would put its contents in the bundle
 * served to the phone. Only the NSH runtime may be imported. This is the data
 * boundary; the compiler process itself is not sandboxed yet.
 *
 * The allowed import forms are removed first, then any module-loading token
 * left is refused. That covers comments and template literals between the
 * tokens, which a specifier-only regex would miss.
 */
export function importProblem(source: string): string | null {
  const allowed = source
    .replace(/\bimport\s+(?:type\s+)?(?:[^;]*?\s+from\s*)?(['"])nsh\1/g, '')
    .replace(/\b(?:const|let|var)\s+\w+\s*=\s*require\s*\(\s*(['"])nsh\1\s*\)/g, '')
    .replace(/\bimport\s+(?:type\s+)?\{[^}]*\}\s*from\s*(['"])\.\/map(?:\.tsx)?\1/g, '') // the module kit's MapView
  if (/\b(?:import|require)\b/.test(allowed)) return `the module may only import from "${UI_IMPORT}"`
  if (/\bfrom\s*['"`]/.test(allowed)) return `the module may only import from "${UI_IMPORT}"`
  if (/\/\/\/\s*<reference\b/.test(source)) return 'triple-slash references are not allowed'
  return null
}

/** Lets list items carry React's `key` (test/ui.test.ts: measured with nsh 0.3.0, the runtime warns and renders). */
const KEY_PROP = `import 'nsh/types'
declare module 'nsh/types' {
  namespace JSX { interface IntrinsicAttributes { key?: string | number | null } }
}
`

export type CreateResult = { ok: true; module: UiModule; size: number; ms: number } | { ok: false; errors: string }

export interface UiOptions {
  /** Path of the nsh CLI; default ~/.local/bin/nsh (NSH_BIN overrides). */
  nsh?: string
  /** Hosts a module may fetch from: the bot's own, nothing else. Settable later (the public origin is known after the server starts). */
  hosts?: string[]
  /** In the container, compile as the cell user instead of root; the release key is copied into the module dir. */
  runAs?: { uid: number; gid: number }
  /** Who this process is (tests stand in for root); default process.getuid. */
  getuid?: () => number
}

/** Copied from mobile/nsh.json `theme` so generated modules share the app's palette. */
const MODULE_THEME = {"cssVars": {"light": {"background": "#FCFCFA", "foreground": "#26251E", "card": "#F7F7F4", "card-foreground": "#26251E", "popover": "#FCFCFA", "popover-foreground": "#26251E", "primary": "#26251E", "primary-foreground": "#F7F7F4", "secondary": "#EFEEEA", "secondary-foreground": "#26251E", "muted": "#F2F1ED", "muted-foreground": "#85847E", "accent": "#EFEEEA", "accent-foreground": "#26251E", "destructive": "#CF2D56", "border": "#E5E4DF", "input": "#DCDBD6", "ring": "#26251E", "link": "#F54E00"}, "dark": {"background": "#14120B", "foreground": "#EDECEC", "card": "#1C1A14", "card-foreground": "#EDECEC", "popover": "#1C1A14", "popover-foreground": "#EDECEC", "primary": "#EDECEC", "primary-foreground": "#14120B", "secondary": "#27251F", "secondary-foreground": "#EDECEC", "muted": "#1C1A14", "muted-foreground": "#8E8D88", "accent": "#27251F", "accent-foreground": "#EDECEC", "destructive": "#CF2D56", "border": "#2B2923", "input": "#36342E", "ring": "#EDECEC", "link": "#F54E00"}}} as const

export const MODULE_THEME_FOR_TEST = MODULE_THEME

export class Ui {
  readonly root: string
  readonly dir: string
  readonly keysDir: string
  readonly nsh: string
  readonly runAs?: { uid: number; gid: number }
  private readonly isRoot: () => boolean
  hosts: string[]
  rootPublicKey = ''
  /** [compliance] The content filter (src/moderation.ts): an interface it flags is not built. */
  moderate: ((text: string) => Promise<{ flagged: boolean; categories: string[] }>) | null = null
  readonly timings: { keygenMs?: number } = {}
  private modules = new Map<string, UiModule>()
  private readonly indexPath: string

  private constructor(root: string, opts: UiOptions) {
    this.root = root
    this.dir = join(root, 'ui')
    this.keysDir = join(root, 'keys')
    this.nsh = opts.nsh ?? process.env.NSH_BIN ?? join(homedir(), '.local', 'bin', 'nsh')
    this.runAs = opts.runAs
    const getuid = opts.getuid ?? (typeof process.getuid === 'function' ? process.getuid : undefined)
    this.isRoot = () => getuid?.() === 0
    this.hosts = opts.hosts ?? ['127.0.0.1']
    this.indexPath = join(this.dir, 'modules.json')
  }

  /** Without the nsh CLI the tool tells the assistant so; nothing else changes. */
  get available() { return existsSync(this.nsh) }

  static async open(root: string, opts: UiOptions = {}): Promise<Ui> {
    const ui = new Ui(root, opts)
    await mkdir(ui.dir, { recursive: true })
    try { for (const m of JSON.parse(await readFile(ui.indexPath, 'utf8')) as UiModule[]) ui.modules.set(m.id, m) } catch {}
    if (ui.available) await ui.ensureKeys()
    return ui
  }

  /** Root key (offline in spirit: only used to certify) + release key certified for a year. Secrets 0600 in a 0700 directory; nothing is logged. Made as root: the directory is root's, and the cell user only ever gets a copy of the release key (create). */
  private async ensureKeys() {
    await mkdir(this.keysDir, { recursive: true, mode: 0o700 })
    await chmod(this.keysDir, 0o700)
    const need = ['root.secret', 'root.pub', 'release.secret', 'release.pub', 'release.cert'].some((f) => !existsSync(join(this.keysDir, f)))
    if (need) {
      const t0 = performance.now()
      await rm(join(this.keysDir, 'release.cert'), { force: true })
      if (!existsSync(join(this.keysDir, 'root.secret'))) await this.run(['keygen', join(this.keysDir, 'root')], this.keysDir, true)
      if (!existsSync(join(this.keysDir, 'release.secret'))) await this.run(['keygen', join(this.keysDir, 'release')], this.keysDir, true)
      await this.run(['certify', '--root', join(this.keysDir, 'root.secret'), '--key', join(this.keysDir, 'release.pub'), '--apps', `${UI_APP_PREFIX}*`, '--days', '365', '-o', join(this.keysDir, 'release.cert')], this.keysDir, true)
      this.timings.keygenMs = Math.round(performance.now() - t0)
    }
    for (const f of ['root.secret', 'release.secret']) await chmod(join(this.keysDir, f), 0o600)
    this.rootPublicKey = (await readFile(join(this.keysDir, 'root.pub'), 'utf8')).trim()
  }

  private run(args: string[], cwd: string, asRoot = false): Promise<{ ok: boolean; out: string }> {
    return new Promise((resolve) => {
      const env = {
        PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
        HOME: cwd,
        // one cache for every module: nsh downloads its TypeScript compiler there once (with HOME alone each
        // module folder got its own 26 MB copy, 2026-11-01)
        NSH_CACHE: this.cacheDir,
        TMPDIR: process.env.TMPDIR ?? '/tmp',
        NO_COLOR: '1',
        ...(process.env.LANG ? { LANG: process.env.LANG } : {}),
        // The TypeScript 7 compiler the image ships (Dockerfile). Without it `nsh check` downloads one from
        // registry.npmjs.org into $HOME, a fresh module dir every time; as uid 1000 with no proxy in this
        // environment the kernel's egress rules refuse that connection.
        ...(process.env.NSH_TSC ? { NSH_TSC: process.env.NSH_TSC } : {}),
      }
      const as = !asRoot && this.runAs && this.isRoot() ? this.runAs : undefined
      execFile(this.nsh, args, { cwd, timeout: 60_000, maxBuffer: 4 << 20, env, ...(as ? { uid: as.uid, gid: as.gid } : {}) }, (err, stdout, stderr) => {
        const out = `${stdout ?? ''}${stderr ?? ''}`.trim()
        resolve({ ok: !err, out: err && !out ? err.message : out })
      })
    })
  }

  /**
   * Write the module, type-check it, sign it. Errors come back as text for the
   * assistant to fix; a module that failed leaves nothing behind.
   */
  async create(input: { title: string; source: string; permissions?: Permission[] }): Promise<CreateResult> {
    const problem = importProblem(input.source)
    if (problem) return { ok: false, errors: problem }
    if (!this.available) return { ok: false, errors: `nsh is not installed at ${this.nsh}` }
    const t0 = performance.now()
    const id = `m${randomBytes(5).toString('hex')}`
    const dir = join(this.dir, id)
    const title = input.title.trim().slice(0, 80) || 'Interface'
    const permissions = [...new Set((input.permissions ?? []).filter(isPermission))]
    if (this.moderate) {
      const v = await this.moderate(interfaceText(title, input.source)).catch((e) => { console.error('[bot] content filter unavailable; building anyway:', (e as Error).message); return { flagged: false, categories: [] } })
      if (v.flagged) return { ok: false, errors: `The content filter refused this interface (${v.categories.join(', ') || 'flagged'}). Do not build it; tell the person in one line that you cannot make this.` }
    }
    await mkdir(dir, { recursive: true })
    const as = this.runAs && this.isRoot() ? this.runAs : undefined
    if (as) await chown(dir, as.uid, as.gid)
    try {
      await writeFile(join(dir, 'source.tsx'), input.source) // the assistant's own, as it wrote it
      await writeFile(join(dir, 'App.tsx'), withSizeReport(input.source))
      await copyFile(MAP_KIT, join(dir, 'map.tsx')) // `import { MapView } from './map'`
      // the app's own tokens (mobile/nsh.json): a module looks like the app, not like NSH's defaults (black bg-primary in light mode, seen 2026-10-27)
      await writeFile(join(dir, 'nsh.json'), JSON.stringify({ name: title, id: `${UI_APP_PREFIX}${id}`, version: '1.0.0', build: 1, appearance: 'system', theme: MODULE_THEME, capabilities: moduleCapabilities(this.hosts, permissions) }, null, 2))
      // `nsh check` wants a tsconfig next to the entry and writes the `nsh` type declarations (~550 KB) into ./.nsh itself; they go after the check.
      // React's `key` on list items is the model's habit; NSH ignores it at runtime (a warning), so the check takes it
      await writeFile(join(dir, 'keys.d.ts'), KEY_PROP)
      // not strict: `[]` in a signal typed never[] and `{}` lookups refused working code (test/ui.test.ts); NSH API misuse still fails
      await writeFile(join(dir, 'tsconfig.json'), JSON.stringify({ extends: './.nsh/tsconfig.json', compilerOptions: { strict: false }, include: ['App.tsx', 'map.tsx', 'keys.d.ts'] }))
      const check = await this.checkOnce(dir)
      await rm(join(dir, '.nsh'), { recursive: true, force: true })
      if (!check.ok) return await this.fail(dir, check.out)
      const pkg = join(dir, `${id}.nshpkg`)
      let key = join(this.keysDir, 'release.secret'), cert = join(this.keysDir, 'release.cert')
      if (as) {
        const keys = join(dir, '.keys')
        await mkdir(keys, { recursive: true })
        key = join(keys, 'release.secret'); cert = join(keys, 'release.cert')
        await copyFile(join(this.keysDir, 'release.secret'), key)
        await copyFile(join(this.keysDir, 'release.cert'), cert)
        await chmod(key, 0o600); await chmod(cert, 0o600)
        await chown(keys, as.uid, as.gid); await chown(key, as.uid, as.gid); await chown(cert, as.uid, as.gid)
      }
      const publish = await this.run(['publish', dir, '--key', key, '--cert', cert, '-o', pkg, '--source-map', 'none'], dir)
      if (!publish.ok) return await this.fail(dir, publish.out)
      // the browser build runs bundles, not packages (nsh 0.3.0 web player): keep the build too
      const build = await this.run(['build', dir, '-o', join(dir, 'build')], dir)
      if (!build.ok) return await this.fail(dir, build.out)
      const size = (await stat(pkg)).size
      const m: UiModule = { id, title, token: randomBytes(24).toString('base64url'), at: Date.now(), ...(permissions.length ? { permissions } : {}) }
      this.modules.set(id, m)
      await this.persist()
      return { ok: true, module: m, size, ms: Math.round(performance.now() - t0) }
    } catch (e) {
      return await this.fail(dir, (e as Error).message)
    }
  }

  private get cacheDir() { return join(this.dir, '.cache') }
  private warm = false
  private first: Promise<unknown> = Promise.resolve()
  /** `nsh check`; until one has passed, one at a time, so two first interfaces do not download the compiler into the cache together. */
  private async checkOnce(dir: string) {
    if (!existsSync(this.cacheDir)) {
      await mkdir(this.cacheDir, { recursive: true })
      if (this.runAs && this.isRoot()) await chown(this.cacheDir, this.runAs.uid, this.runAs.gid)
    }
    if (this.warm) return this.run(['check', dir], dir)
    const turn = this.first.then(() => this.run(['check', dir], dir))
    this.first = turn.catch(() => undefined)
    const r = await turn
    if (r.ok) this.warm = true
    return r
  }

  private async fail(dir: string, errors: string): Promise<CreateResult> {
    await rm(dir, { recursive: true, force: true })
    return { ok: false, errors: errors.replace(/\x1b\[[0-9;]*m/g, '').trim() || 'unknown error' }
  }

  module(id: string): UiModule | undefined { return this.modules.get(id) }
  list(): UiModule[] { return [...this.modules.values()] }

  /** [compliance] The person hides an interface (or shows it again); a blocked one stays hidden. False when there is no such module or it is blocked. */
  async setHidden(id: string, hidden: boolean): Promise<boolean> {
    const m = this.modules.get(id)
    if (!m || (m.blocked && !hidden)) return false
    m.hidden = hidden
    await this.persist()
    return true
  }

  /** [compliance] What the person allows this interface; only what it asked for. */
  async setGrants(id: string, grants: Permission[]): Promise<boolean> {
    const m = this.modules.get(id)
    if (!m || grants.some((g) => !(m.permissions ?? []).includes(g))) return false
    m.grants = [...new Set(grants)]
    await this.persist()
    return true
  }

  /** [compliance] The host's operators blocked it after a report: hidden for good. */
  async block(id: string): Promise<boolean> {
    const m = this.modules.get(id)
    if (!m) return false
    m.blocked = true; m.hidden = true
    await this.persist()
    return true
  }
  packagePath(id: string) { return join(this.dir, id, `${id}.nshpkg`) }
  sourcePath(id: string) { const own = join(this.dir, id, 'source.tsx'); return existsSync(own) ? own : join(this.dir, id, 'App.tsx') }
  bundlePath(id: string, file: 'bundle.js' | 'bundle.nshc') { return join(this.dir, id, 'build', file) }

  /** The phone downloaded the package from a thread: results go there. */
  async bind(id: string, sessionId: string) {
    const m = this.modules.get(id)
    if (!m || m.sessionId === sessionId) return
    m.sessionId = sessionId
    await this.persist()
  }

  /** The module's token, without spending it (the play page's runtime files use it). */
  verify(id: string, token: string | null): boolean {
    const m = this.modules.get(id)
    return Boolean(m && token && token.length === m.token.length && timingSafeEq(token, m.token))
  }

  /** Accept the module's result token once. An unknown module looks like a wrong token: no module oracle. */
  async spend(id: string, token: string | null): Promise<{ status: 200; module: UiModule } | { status: 401 | 409 }> {
    const m = this.modules.get(id)
    if (!m) return { status: 401 }
    if (!token || token.length !== m.token.length || !timingSafeEq(token, m.token)) return { status: 401 }
    if (m.spent) return { status: 409 }
    m.spent = true
    await this.persist()
    return { status: 200, module: m }
  }

  private async persist() {
    await writeAtomic(this.indexPath, () => JSON.stringify([...this.modules.values()]))
  }
}

function timingSafeEq(a: string, b: string) {
  let d = 0
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return d === 0
}

/** The words the module's result becomes in the thread: its own `text`, else the value as "key: value" pairs. */
export function resultText(body: { value?: unknown; text?: unknown }): string {
  if (typeof body.text === 'string' && body.text.trim()) return body.text.trim().slice(0, 2000)
  const v = body.value
  if (v === undefined || v === null) return '(no value)'
  if (typeof v !== 'object') return String(v).slice(0, 2000)
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(', ').slice(0, 2000)
  return Object.entries(v as Record<string, unknown>).map(([k, x]) => `${k}: ${typeof x === 'object' ? JSON.stringify(x) : String(x)}`).join(', ').slice(0, 2000) || '(no value)'
}

export { INJECT }
