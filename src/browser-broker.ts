// The assistant's browser lives outside the cell.
// The bot starts Playwright MCP as its own unprivileged user (uid 1001, never
// the cell's 1000 and never root); the profile is that user's and is not in the
// cell. DSH reaches it over loopback HTTP MCP with a per-boot bearer, through a
// tiny authenticating proxy, the same shape as the bot-tools server. Chromium's
// enterprise URLBlocklist (deploy/chromium-policy.json) is what refuses file://
// and chrome:// — not a custom page check.
import { createServer, request as httpRequest } from 'node:http'
import { createServer as createNetServer, connect as netConnect } from 'node:net'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { chmod, chown, mkdir } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { basename, join } from 'node:path'
import { CHROME_QUIET_CONFIG, playwrightMcpCli } from './playwright-mcp.ts'

export interface BrowserBroker {
  /** The bearer-checked MCP endpoint the cell uses. */
  url: string
  secret: string
  profileDir: string
  outputDir: string
  mcpPort: number
  /** See McpAuthProxy.listed. */
  listed: Promise<void>
  close(): Promise<void>
}

export function brokerPaths(root: string) {
  const base = join(root, 'browser-broker')
  return { base, profile: join(base, 'profile'), output: join(base, 'output'), home: join(base, 'home'), tmp: join(base, 'tmp') }
}

/** Patch row for the broker. YAML, like the bot-tools row in src/home.ts. */
export function browserBrokerPatchYaml(b: { url: string; secret: string }): string {
  const q = (s: string) => JSON.stringify(s)
  return `- insert:
    - id: bot-browser
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: browser
        transport: streamable-http
        url: ${q(b.url)}
        headers:
          authorization: Bearer ${b.secret}
        toolCallTimeoutMs: 90000
        failOnStartupError: false
`
}

export interface McpAuthProxy {
  url: string
  port: number
  /** Settles when the harness first got the tool list back: a row added at runtime is usable from then on. */
  listed: Promise<void>
  /** Point the proxy at Playwright MCP; until then it answers 503. */
  setUpstream(url: string): void
  close(): Promise<void>
}

/**
 * The browser tool surface: navigation, page reading
 * (accessibility snapshot, console/network logs, screenshots) and input. The
 * arbitrary-code tools (`browser_evaluate`, `browser_run_code_unsafe`) are not
 * in this list; Playwright MCP 0.0.83 has no option to omit them, so the
 * bearer proxy filters them out of `tools/list` and refuses `tools/call`.
 */
export const ALLOWED_BROWSER_TOOLS = new Set([
  'browser_click', 'browser_close', 'browser_console_messages', 'browser_drag', 'browser_drop',
  'browser_emulate_media', 'browser_file_upload', 'browser_fill_form', 'browser_find',
  'browser_handle_dialog', 'browser_hover', 'browser_navigate', 'browser_navigate_back',
  'browser_network_request', 'browser_network_requests', 'browser_press_key',
  'browser_resize', 'browser_select_option', 'browser_snapshot', 'browser_tabs',
  'browser_take_screenshot', 'browser_type', 'browser_wait_for',
])

/** Remove tools outside `allowed` from a tools/list response, JSON or SSE. Exported for tests. */
export function filterToolsPayload(body: string, allowed: Set<string>): string {
  const filter = (value: unknown): unknown => {
    const v = value as { result?: { tools?: { name?: string; inputSchema?: { properties?: Record<string, unknown>; required?: string[] } }[] } }
    if (Array.isArray(v.result?.tools)) v.result.tools = v.result.tools.filter((t) => allowed.has(String(t.name)))
    const shot = v.result?.tools?.find((t) => t.name === 'browser_take_screenshot')?.inputSchema
    if (shot?.properties) { delete shot.properties.filename; if (shot.required) shot.required = shot.required.filter((k) => k !== 'filename') }
    return value
  }
  if (/^\s*\{/.test(body)) {
    try { return JSON.stringify(filter(JSON.parse(body))) } catch { return body }
  }
  return body.split('\n').map((line) => {
    if (!line.startsWith('data: ')) return line
    try { return `data: ${JSON.stringify(filter(JSON.parse(line.slice(6))))}` } catch { return line }
  }).join('\n')
}

/** Each JSON-RPC message in a response body (plain JSON or SSE `data:` lines), passed through `fn`. */
async function mapRpcPayload(body: string, fn: (value: unknown) => Promise<void>): Promise<string> {
  if (/^\s*\{/.test(body)) {
    try { const v = JSON.parse(body); await fn(v); return JSON.stringify(v) } catch { return body }
  }
  const out: string[] = []
  for (const line of body.split('\n')) {
    if (!line.startsWith('data: ')) { out.push(line); continue }
    try { const v = JSON.parse(line.slice(6)); await fn(v); out.push(`data: ${JSON.stringify(v)}`) } catch { out.push(line) }
  }
  return out.join('\n')
}

/** A screenshot result's image, saved by `save`; the text then names the saved file instead of the browser's own. */
async function keepShot(value: unknown, save: (name: string, bytes: Buffer) => Promise<string | null>): Promise<void> {
  const content = (value as { result?: { content?: { type?: string; text?: unknown; data?: unknown }[] } }).result?.content
  if (!Array.isArray(content)) return
  const image = content.find((c) => c?.type === 'image' && typeof c.data === 'string')
  const text = content.find((c) => c?.type === 'text' && typeof c.text === 'string')
  const old = text ? /\]\(([^)\s]+\.(?:png|jpe?g))\)/i.exec(String(text.text))?.[1] : undefined
  if (!image || !old) return
  const saved = await save(basename(old), Buffer.from(String(image.data), 'base64'))
  if (saved) for (const c of content) if (c?.type === 'text' && typeof c.text === 'string') c.text = c.text.split(old).join(saved)
}

/**
 * Writes a file into the cell's work folder as the cell's own user (`uid`, when the bot runs as root), so a link the
 * cell planted there can only send the write where the cell could write anyway. Returns the path, or null.
 */
export function workFolderWriter(o: { dir: string; uid?: number; gid?: number }): (name: string, bytes: Buffer) => Promise<string | null> {
  return (name, bytes) => {
    const file = join(o.dir, basename(name).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+/, '') || 'screenshot.png')
    const as = o.uid !== undefined && typeof process.getuid === 'function' && process.getuid() === 0 ? { uid: o.uid, gid: o.gid ?? o.uid } : {}
    const code = "const fs=require('fs');fs.mkdirSync(process.argv[1],{recursive:true});fs.writeFileSync(process.argv[2],fs.readFileSync(0))"
    return new Promise((resolve) => {
      const child = spawn(process.execPath, ['-e', code, o.dir, file], { stdio: ['pipe', 'ignore', 'ignore'], ...as })
      child.on('error', () => resolve(null))
      child.on('close', (code) => resolve(code === 0 ? file : null))
      child.stdin!.on('error', () => {})
      child.stdin!.end(bytes)
    })
  }
}

function rpcError(res: import('node:http').ServerResponse, id: unknown, message: string) {
  const body = `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message } })}\n\n`
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  res.end(body)
}

/** Bearer check in front of Playwright MCP, which has no authentication of its own. */
export async function startMcpAuthProxy(o: { upstream?: string; secret: string; port?: number; allowedTools?: Iterable<string>; saveShot?: (name: string, bytes: Buffer) => Promise<string | null> }): Promise<McpAuthProxy> {
  let upstream = o.upstream ? new URL(o.upstream) : undefined
  const allowed = o.allowedTools ? new Set(o.allowedTools) : undefined
  let onListed = () => {}
  const listed = new Promise<void>((r) => { onListed = r })
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${o.secret}`) { res.writeHead(401); return res.end() }
    const up = upstream
    if (!up) { res.writeHead(503); return res.end() }
    const chunks: Buffer[] = []
    let size = 0
    for await (const ch of req) {
      size += (ch as Buffer).length
      if (size > 4 << 20) { res.writeHead(413); return res.end() }
      chunks.push(ch as Buffer)
    }
    let body = chunks.length ? Buffer.concat(chunks) : undefined
    let filterList = false
    let shot = false
    if (allowed && body) {
      try {
        const msg = JSON.parse(body.toString()) as { method?: string; id?: unknown; params?: { name?: string } }
        if (msg.method === 'tools/list') filterList = true
        if (msg.method === 'tools/call') {
          const raw = String(msg.params?.name ?? '')
          const name = raw.startsWith('mcp__browser__') ? raw.slice('mcp__browser__'.length) : raw
          if (!allowed.has(name)) return rpcError(res, msg.id, `browser tool ${name} is disabled by the containment policy`)
          // Playwright MCP returns a screenshot's image only when it is unnamed, and a named file stays in the
          // browser's folder, which the cell cannot see
          const args = (msg.params as { arguments?: Record<string, unknown> } | undefined)?.arguments
          if (name === 'browser_take_screenshot' && args && 'filename' in args) { delete args.filename; body = Buffer.from(JSON.stringify(msg)) }
          shot = name === 'browser_take_screenshot' && Boolean(o.saveShot)
        }
      } catch { /* not JSON: let the upstream decide */ }
    }
    const headers: Record<string, string | string[]> = {}
    for (const [k, v] of Object.entries(req.headers)) if (v !== undefined && k !== 'authorization' && k !== 'host' && k !== 'content-length') headers[k] = v
    headers.host = up.host
    const fwd = httpRequest({ host: up.hostname, port: Number(up.port || 80), method: req.method, path: req.url, headers }, (upRes) => {
      if ((filterList || shot) && /text\/event-stream|application\/json/.test(String(upRes.headers['content-type'] ?? ''))) {
        const out: Buffer[] = []
        upRes.on('data', (d) => out.push(d as Buffer))
        upRes.on('end', async () => {
          const h = { ...upRes.headers }
          delete h['content-length']; delete h['transfer-encoding']; delete h['content-encoding']
          const raw = Buffer.concat(out).toString()
          const payload = filterList ? filterToolsPayload(raw, allowed!) : await mapRpcPayload(raw, (v) => keepShot(v, o.saveShot!))
          res.writeHead(upRes.statusCode ?? 502, h)
          res.end(payload)
          if (filterList && (upRes.statusCode ?? 502) < 300) onListed()
        })
        return
      }
      res.writeHead(upRes.statusCode ?? 502, upRes.headers)
      upRes.pipe(res)
    })
    fwd.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end() })
    fwd.end(body)
  })
  server.listen(o.port ?? 0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address() as { port: number }
  return { url: `http://127.0.0.1:${port}`, port, listed, setUpstream: (u) => { upstream = new URL(u) }, close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()) }) }
}

async function freePort(): Promise<number> {
  const s = createNetServer()
  s.listen(0, '127.0.0.1'); await once(s, 'listening')
  const p = (s.address() as { port: number }).port
  await new Promise<void>((r) => s.close(() => r()))
  return p
}

async function waitPort(port: number, ms: number): Promise<void> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    try { await new Promise<void>((r, j) => { const s = netConnect(port, '127.0.0.1'); s.once('connect', () => { s.destroy(); r() }); s.once('error', j) }) ; return } catch { await new Promise((r) => setTimeout(r, 200)) }
  }
  throw new Error(`browser broker did not listen on 127.0.0.1:${port} within ${ms}ms`)
}

/** Playwright MCP's environment. Its 5 s heartbeat closes the server (and deletes the MCP session) when a ping
 * misses; a slow tool call then leaves DSH with a dead session id, and every later call says "Session not found".
 * The bot owns the broker lifecycle, so disable that heartbeat. */
export function brokerEnv(p: { home: string; tmp: string }): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', HOME: p.home, TMPDIR: p.tmp, LANG: process.env.LANG ?? 'C.UTF-8', NODE_ENV: 'production', PLAYWRIGHT_MCP_PING_TIMEOUT_MS: '0' }
}

/** The broker's bearer proxy, started before the browser exists: the cell's kernel rules take their loopback ports
 * once, at start (src/main.ts), so a browser installed later must answer on a port that was already listed. */
export async function startBrowserFront(o: { saveShot?: (name: string, bytes: Buffer) => Promise<string | null> } = {}): Promise<{ proxy: McpAuthProxy; secret: string }> {
  const secret = randomBytes(24).toString('base64url')
  return { proxy: await startMcpAuthProxy({ secret, allowedTools: ALLOWED_BROWSER_TOOLS, saveShot: o.saveShot }), secret }
}

export async function startBrowserBroker(o: { root: string; exe: string; uid?: number; gid?: number; cli?: string; timeoutMs?: number; proxy?: string; front?: { proxy: McpAuthProxy; secret: string } }): Promise<BrowserBroker> {
  const uid = o.uid ?? 1001
  const gid = o.gid ?? 1001
  const p = brokerPaths(o.root)
  for (const d of [p.base, p.profile, p.output, p.home, p.tmp]) await mkdir(d, { recursive: true })
  // Every broker dir belongs to the browser user, and only that user may enter it. Explicit screenshot names are
  // resolved against Playwright MCP's cwd (p.base), so p.base itself must be writable by uid 1001; the cell's uid
  // 1000 is never mounted here and cannot write (or read) it.
  for (const d of [p.base, p.profile, p.output, p.home, p.tmp]) { await chown(d, uid, gid); await chmod(d, 0o700) }
  const mcpPort = await freePort()
  const cli = o.cli ?? playwrightMcpCli()
  const inner = [process.execPath, cli, '--browser', 'chromium', '--executable-path', o.exe, '--no-sandbox', '--headless',
    '--user-data-dir', p.profile, '--output-dir', p.output, '--viewport-size', '1280x720', '--config', CHROME_QUIET_CONFIG, '--file-paths', 'absolute',
    '--host', '127.0.0.1', '--port', String(mcpPort), '--allowed-hosts', `127.0.0.1:${mcpPort}`, ...(o.proxy ? ['--proxy-server', o.proxy] : [])]
  const env = brokerEnv(p)
  const child: ChildProcess = process.platform === 'linux' && typeof process.getuid === 'function' && process.getuid() === 0
    ? spawn('setpriv', [`--reuid=${uid}`, `--regid=${gid}`, '--clear-groups', '--', 'prlimit', '--nproc=256', '--nofile=4096', '--core=0', '--', ...inner], { env, stdio: ['ignore', 'pipe', 'pipe'], cwd: p.base })
    : spawn(inner[0], inner.slice(1), { env, stdio: ['ignore', 'pipe', 'pipe'], cwd: p.base })
  let stderr = ''
  child.stderr?.on('data', (d) => { stderr = (stderr + String(d)).slice(-4000) })
  child.on('exit', (code) => { if (code !== null && code !== 0) console.error(`[bot] browser broker exited (${code}): ${stderr.slice(-500)}`) })
  try {
    await waitPort(mcpPort, o.timeoutMs ?? 30_000)
  } catch (e) {
    child.kill('SIGKILL')
    throw new Error(`${(e as Error).message}\n${stderr.slice(-2000)}`)
  }
  const { proxy, secret } = o.front ?? await startBrowserFront()
  proxy.setUpstream(`http://127.0.0.1:${mcpPort}`)
  return {
    url: proxy.url,
    secret,
    profileDir: p.profile,
    outputDir: p.output,
    mcpPort,
    listed: proxy.listed,
    async close() {
      await proxy.close()
      if (child.exitCode === null) { child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 3000).unref() }
    },
  }
}
