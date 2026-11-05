// The hosted browser's screenshot through the bot's broker proxy, with the real Playwright MCP and Chrome on this
// machine. On Fly the model named its screenshot, Playwright MCP then returned
// only a link into the browser's own folder and no image, so the thread showed nothing and the model could not
// look at it. Skipped unless DEEPSEEK_BOT_E2E=1. Run: DEEPSEEK_BOT_E2E=1 node --test test/broker-screenshot.e2e.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { createServer as createNetServer, connect } from 'node:net'
import { once } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { playwrightMcpCli } from '../src/browser.ts'
import { ALLOWED_BROWSER_TOOLS, startMcpAuthProxy } from '../src/browser-broker.ts'

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

test('a named screenshot through the broker still comes back as an image', { skip: process.env.DEEPSEEK_BOT_E2E !== '1', timeout: 120_000 }, async () => {
  const page = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<title>Shot</title><h1>Broker screenshot</h1>') })
  page.listen(0, '127.0.0.1'); await once(page, 'listening')
  const pagePort = (page.address() as { port: number }).port
  const dir = mkdtempSync(join(tmpdir(), 'bot-broker-shot-'))
  const mcpPort = await freePort()
  const child = spawn(process.execPath, [playwrightMcpCli(), '--browser', 'chrome', '--headless', '--user-data-dir', join(dir, 'profile'), '--output-dir', join(dir, 'output'),
    '--viewport-size', '800x600', '--file-paths', 'absolute', '--host', '127.0.0.1', '--port', String(mcpPort), '--allowed-hosts', `127.0.0.1:${mcpPort}`],
  { cwd: dir, stdio: 'ignore', env: { ...process.env, PLAYWRIGHT_MCP_PING_TIMEOUT_MS: '0' } })
  const proxy = await (async () => { await waitPort(mcpPort, 30_000); return startMcpAuthProxy({ upstream: `http://127.0.0.1:${mcpPort}`, secret: 's', allowedTools: ALLOWED_BROWSER_TOOLS }) })()
  try {
    let session = ''
    let id = 0
    const rpc = async (method: string, params?: unknown) => {
      const r = await fetch(`${proxy.url}/mcp`, { method: 'POST', headers: { authorization: 'Bearer s', 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(session ? { 'mcp-session-id': session } : {}) },
        body: JSON.stringify({ jsonrpc: '2.0', ...(method.startsWith('notifications/') ? {} : { id: ++id }), method, ...(params ? { params } : {}) }) })
      session ||= r.headers.get('mcp-session-id') ?? ''
      const text = await r.text()
      const data = text.split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)))
      return (data[0] ?? (text.trim().startsWith('{') ? JSON.parse(text) : {})) as { result?: { tools?: { name: string; inputSchema: { properties: Record<string, unknown> } }[]; content?: { type: string; text?: string }[] } }
    }
    await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } })
    await rpc('notifications/initialized')
    const list = await rpc('tools/list')
    assert.equal('filename' in list.result!.tools!.find((t) => t.name === 'browser_take_screenshot')!.inputSchema.properties, false, 'the tool offers no filename')
    const nav = await rpc('tools/call', { name: 'browser_navigate', arguments: { url: `http://127.0.0.1:${pagePort}/` } })
    assert.match(JSON.stringify(nav), /Page Title: Shot/)
    const shot = await rpc('tools/call', { name: 'browser_take_screenshot', arguments: { filename: 'example.com.png', type: 'png' } })
    const kinds = (shot.result?.content ?? []).map((c) => c.type)
    assert.deepEqual(kinds, ['text', 'image'], JSON.stringify(shot).slice(0, 400))
  } finally {
    await proxy.close()
    child.kill('SIGTERM')
    await new Promise<void>((r) => page.close(() => r()))
  }
})
