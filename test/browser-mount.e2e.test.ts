// The browser installed during a turn is used in that same turn. On Fly the bot
// exited after install_browser to mount the browser on restart, and the restart ended the person's turn: they asked
// for a screenshot and got no reply. Here the real harness, the real installer (with a stand-in install script), the
// real Playwright MCP and Chrome behind the broker proxy, and a scripted model: install, then open a page and take a
// screenshot, then answer. The install takes 70 s, longer than an MCP call gets by default (60 s): on Fly
// it took 117 s, the call came back "Still installing" twice, and in
// between the assistant tried Chromium in its own shell. The call waits for the install instead.
// Needs Chrome on this machine. Skipped unless DEEPSEEK_BOT_E2E=1.
// Run: DEEPSEEK_BOT_E2E=1 node --test test/browser-mount.e2e.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:http'
import { createServer as createNetServer, connect } from 'node:net'
import { once } from 'node:events'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { openHome, type HomeOptions } from '../src/home.ts'
import { enableBrowser, playwrightMcpCli } from '../src/browser.ts'
import { startBrowserFront, workFolderWriter } from '../src/browser-broker.ts'
import { browserInstaller } from '../src/browser-install.ts'
import { startToolsServer } from '../src/tools.ts'
import { Memory } from '../src/memory.ts'
import { Scheduler } from '../src/scheduler.ts'
import { Goals } from '../src/goals.ts'
import { startDshWeb } from '../src/dsh.ts'
import { rpc } from '../src/dshclient.ts'
import { startScriptedModel } from './fixtures/scripted-model.ts'

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
    try { await new Promise<void>((r, j) => { const s = connect(port, '127.0.0.1'); s.once('connect', () => { s.destroy(); r() }); s.once('error', j) }); return } catch { await new Promise((r) => setTimeout(r, 200)) }
  }
  throw new Error(`no listener on ${port}`)
}

test('a browser installed during a turn is used in that turn', { skip: process.env.DEEPSEEK_BOT_E2E !== '1', timeout: 420_000 }, async () => {
  const page = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<title>Mounted</title><h1>Mounted in the turn</h1>') })
  page.listen(0, '127.0.0.1'); await once(page, 'listening')
  const pageUrl = `http://127.0.0.1:${(page.address() as { port: number }).port}/`
  const root = mkdtempSync(join(tmpdir(), 'bot-mount-'))
  // the image's layout: no browser until the install has put the executable there (src/browser.ts leaves the row out)
  const exe = join(root, 'chromium')
  process.env.DEEPSEEK_BOT_BROWSER_EXECUTABLE = exe
  const script = join(root, 'install.sh')
  writeFileSync(script, `echo "step: installing"\nsleep 70\ntouch ${JSON.stringify(exe)}\n`)
  const model = await startScriptedModel([
    { name: 'mcp__bot__install_browser', arguments: {} },
    { name: 'mcp__browser__browser_navigate', arguments: { url: pageUrl } },
    { name: 'mcp__browser__browser_take_screenshot', arguments: {} },
    { text: 'Here it is.' },
  ])
  const children: ChildProcess[] = []
  const closers: (() => Promise<void>)[] = []
  // what src/main.ts does at start: the broker's bearer proxy is up before the browser exists
  const front = await startBrowserFront({ saveShot: workFolderWriter({ dir: join(root, 'workspace', 'screenshots') }) })
  closers.push(front.proxy.close)
  let opts: HomeOptions = { model: { provider: 'scripted', model: 'scripted', baseURL: model.url, apiKeyEnv: 'DEEPSEEK_BOT_MODEL_KEY' } }
  const installBrowser = browserInstaller({
    exe, script,
    // what src/main.ts does: start the broker (here without the uid switch) behind the front and rewrite the profile patch
    mount: async () => {
      const port = await freePort()
      const child = spawn(process.execPath, [playwrightMcpCli(), '--browser', 'chrome', '--headless', '--user-data-dir', join(root, 'bp'), '--output-dir', join(root, 'bo'),
        '--viewport-size', '800x600', '--file-paths', 'absolute', '--host', '127.0.0.1', '--port', String(port), '--allowed-hosts', `127.0.0.1:${port}`],
      { cwd: root, stdio: 'ignore', env: { ...process.env, PLAYWRIGHT_MCP_PING_TIMEOUT_MS: '0' } })
      children.push(child)
      await waitPort(port, 30_000)
      front.proxy.setUpstream(`http://127.0.0.1:${port}`)
      opts = { ...opts, browserBroker: { url: front.proxy.url, secret: front.secret } }
      await openHome(root, opts)
      await front.proxy.listed
    },
  })
  const tools = await startToolsServer({ memory: new Memory(join(root, 'mem')), scheduler: await Scheduler.open(join(root, 's.json'), { onDue: async () => {} }), goals: await Goals.open(join(root, 'g.json')), notify: async () => {}, installBrowser })
  closers.push(tools.close)
  opts = { ...opts, tools: { url: tools.url, secret: tools.secret } }
  enableBrowser()
  const home = await openHome(root, opts)
  const dsh = await startDshWeb({ dshHome: home.dshHome, env: { ...process.env, DEEPSEEK_BOT_MODEL_KEY: 'local' }, timeoutMs: 300_000 })
  try {
    const t = { origin: dsh.origin, cookie: dsh.cookie }
    const { sessionId } = await rpc<{ sessionId: string }>(t, 'session/create', { request: { cwd: home.workspace } })
    await rpc(t, 'session/prompt', { request: { requestId: randomUUID(), sessionId, mode: 'queue', content: [{ type: 'text', text: 'Take a screenshot of the page.' }] } })
    for (let i = 0; i < 600 && !model.answers.length; i++) await new Promise((r) => setTimeout(r, 500))
    const results = model.results.join(' | ')
    assert.match(model.results[0] ?? '', /^Installed/, results)
    assert.match(model.results[1] ?? '', /Page Title: Mounted/, `the browser answers in the same turn: ${results}`)
    assert.match(model.results[2] ?? '', /Screenshot of viewport/, results)
    // the file is in the work folder, where the assistant can hand it over
    const saved = new RegExp(`\\]\\((${join(root, 'workspace', 'screenshots').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/page-[^)]+\\.png)\\)`).exec(model.results[2] ?? '')?.[1]
    assert.ok(saved && existsSync(saved), `the screenshot is saved in the work folder: ${model.results[2]}`)
    assert.deepEqual(model.answers.map((a) => a.text), ['Here it is.'], 'the turn ends with the answer')
  } finally {
    await dsh.stop()
    for (const c of closers) await c().catch(() => {})
    for (const c of children) c.kill('SIGTERM')
    await model.close()
    await new Promise<void>((r) => page.close(() => r()))
  }
})
