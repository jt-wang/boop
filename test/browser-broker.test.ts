// The browser runs outside the cell as its own user, and the cell reaches it
// through a bearer-checked loopback MCP endpoint. Chromium itself refuses
// file:// and chrome:// through the enterprise URLBlocklist.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { ALLOWED_BROWSER_TOOLS, brokerEnv, browserBrokerPatchYaml, filterToolsPayload, startMcpAuthProxy, workFolderWriter } from '../src/browser-broker.ts'

// Playwright MCP closes its server (and deletes the MCP session) when a 5 s heartbeat ping misses
// (PLAYWRIGHT_MCP_PING_TIMEOUT_MS, playwright-core/lib/coreBundle.js startHeartbeat). A slow tool call must not
// turn into "Session not found" for every later call.
test('the broker disables Playwright MCP\'s heartbeat so a slow call cannot close the browser session', () => {
  const env = brokerEnv({ home: '/broker/home', tmp: '/broker/tmp' })
  assert.equal(env.PLAYWRIGHT_MCP_PING_TIMEOUT_MS, '0')
})

test('the broker row is streamable HTTP with a per-boot bearer, not a stdio child in the cell', () => {
  const y = browserBrokerPatchYaml({ url: 'http://127.0.0.1:4123', secret: 'boot-secret' })
  assert.match(y, /id: bot-browser/)
  assert.match(y, /transport: streamable-http/)
  assert.match(y, /url: "http:\/\/127\.0\.0\.1:4123"/)
  assert.match(y, /authorization: Bearer boot-secret/)
  assert.doesNotMatch(y, /transport: stdio/)
})

test('the bearer proxy refuses a wrong token and forwards the MCP request with the allowed Host', async () => {
  const upstream = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(`upstream:${req.headers.host}:${req.headers.authorization ?? 'none'}`) })
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening')
  const upPort = (upstream.address() as { port: number }).port
  const proxy = await startMcpAuthProxy({ upstream: `http://127.0.0.1:${upPort}`, secret: 'right' })
  try {
    const no = await fetch(proxy.url, { method: 'POST' })
    assert.equal(no.status, 401)
    const yes = await fetch(proxy.url, { method: 'POST', headers: { authorization: 'Bearer right' } })
    assert.equal(yes.status, 200)
    assert.match(await yes.text(), new RegExp(`upstream:127\\.0\\.0\\.1:${upPort}:none`))
  } finally { await proxy.close(); await new Promise<void>((r) => upstream.close(() => r())) }
})

test('Chromium enterprise policy blocks file:// and chrome:// URLs', () => {
  const policy = JSON.parse(readFileSync(new URL('../deploy/chromium-policy.json', import.meta.url), 'utf8')) as { URLBlocklist?: string[] }
  assert.ok(policy.URLBlocklist?.includes('file://*'))
  assert.ok(policy.URLBlocklist?.includes('chrome://*'))
})

test('the browser tool list drops the arbitrary-code tools and keeps reading, navigation and input', () => {
  assert.equal(ALLOWED_BROWSER_TOOLS.has('browser_evaluate'), false)
  assert.equal(ALLOWED_BROWSER_TOOLS.has('browser_run_code_unsafe'), false)
  for (const name of ['browser_snapshot', 'browser_navigate', 'browser_click', 'browser_type', 'browser_find']) assert.ok(ALLOWED_BROWSER_TOOLS.has(name), name)
  const sse = `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'browser_navigate' }, { name: 'browser_evaluate' }, { name: 'browser_run_code_unsafe' }, { name: 'browser_snapshot' }] } })}\n\n`
  const out = filterToolsPayload(sse, ALLOWED_BROWSER_TOOLS)
  assert.match(out, /browser_navigate/)
  assert.match(out, /browser_snapshot/)
  assert.doesNotMatch(out, /browser_evaluate|browser_run_code_unsafe/)
  const json = filterToolsPayload(JSON.stringify({ jsonrpc: '2.0', id: 3, result: { tools: [{ name: 'browser_evaluate' }, { name: 'browser_click' }] } }), ALLOWED_BROWSER_TOOLS)
  assert.doesNotMatch(json, /browser_evaluate/)
  assert.match(json, /browser_click/)
})

test('the proxy lists only allowed tools and refuses a direct call to a removed one', async () => {
  const calls: string[] = []
  const upstream = createServer((req, res) => {
    let body = ''
    req.on('data', (d) => { body += d })
    req.on('end', () => {
      calls.push(body)
      const msg = JSON.parse(body) as { id: number; method: string }
      if (msg.method === 'tools/list') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'mcp-session-id': 's1' })
        res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'browser_snapshot' }, { name: 'browser_evaluate' }] } })}\n\n`)
      } else {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'ok' }] } })}\n\n`)
      }
    })
  })
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening')
  const upPort = (upstream.address() as { port: number }).port
  const proxy = await startMcpAuthProxy({ upstream: `http://127.0.0.1:${upPort}`, secret: 'right', allowedTools: ALLOWED_BROWSER_TOOLS })
  try {
    const list = await fetch(proxy.url, { method: 'POST', headers: { authorization: 'Bearer right', 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) })
    const text = await list.text()
    assert.match(text, /browser_snapshot/)
    assert.doesNotMatch(text, /browser_evaluate/)
    const before = calls.length
    const denied = await fetch(proxy.url, { method: 'POST', headers: { authorization: 'Bearer right', 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'browser_evaluate', arguments: {} } }) })
    assert.match(await denied.text(), /disabled by the containment policy/)
    assert.equal(calls.length, before, 'the removed tool never reached Playwright')
    const allowedCall = await fetch(proxy.url, { method: 'POST', headers: { authorization: 'Bearer right', 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'browser_snapshot', arguments: {} } }) })
    assert.match(await allowedCall.text(), /text.*ok|ok/)
  } finally { await proxy.close(); await new Promise<void>((r) => upstream.close(() => r())) }
})

// Fly 2026-10-29: the hosted model named its screenshot (`filename: "example.com.png"`), and
// Playwright MCP returns the image only for an unnamed screenshot (`if (!params.filename) registerImageResult`,
// @playwright/mcp 0.0.83). The file landed in the browser's own folder, which the cell cannot see, so neither the
// thread nor the model ever got the picture. The broker offers no filename and drops one if it is sent anyway.
test('the screenshot tool is listed without a filename, so its image always comes back', () => {
  const schema = { type: 'object', properties: { type: { type: 'string' }, filename: { type: 'string' }, fullPage: { type: 'boolean' } }, required: ['filename'] }
  const out = JSON.parse(filterToolsPayload(JSON.stringify({ jsonrpc: '2.0', id: 4, result: { tools: [{ name: 'browser_take_screenshot', inputSchema: schema }, { name: 'browser_snapshot', inputSchema: { type: 'object', properties: { filename: { type: 'string' } } } }] } }), ALLOWED_BROWSER_TOOLS)) as { result: { tools: { name: string; inputSchema: { properties: Record<string, unknown>; required?: string[] } }[] } }
  const shot = out.result.tools.find((t) => t.name === 'browser_take_screenshot')!
  assert.deepEqual(Object.keys(shot.inputSchema.properties), ['type', 'fullPage'])
  assert.deepEqual(shot.inputSchema.required ?? [], [])
  assert.ok('filename' in out.result.tools.find((t) => t.name === 'browser_snapshot')!.inputSchema.properties, 'other tools keep theirs')
})

test('the proxy drops a screenshot filename before Playwright sees the call', async () => {
  const calls: { name?: string; arguments?: Record<string, unknown> }[] = []
  const upstream = createServer((req, res) => {
    let body = ''
    req.on('data', (d) => { body += d })
    req.on('end', () => {
      const msg = JSON.parse(body) as { id: number; params?: { name?: string; arguments?: Record<string, unknown> } }
      calls.push(msg.params ?? {})
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'ok' }] } })}\n\n`)
    })
  })
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening')
  const upPort = (upstream.address() as { port: number }).port
  const proxy = await startMcpAuthProxy({ upstream: `http://127.0.0.1:${upPort}`, secret: 'right', allowedTools: ALLOWED_BROWSER_TOOLS })
  const call = (name: string, args: Record<string, unknown>) => fetch(proxy.url, { method: 'POST', headers: { authorization: 'Bearer right', 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name, arguments: args } }) }).then((r) => r.text())
  try {
    await call('browser_take_screenshot', { filename: 'example.com.png', fullPage: true })
    await call('browser_snapshot', { filename: 'page.md' })
    assert.deepEqual(calls[0], { name: 'browser_take_screenshot', arguments: { fullPage: true } })
    assert.deepEqual(calls[1], { name: 'browser_snapshot', arguments: { filename: 'page.md' } })
  } finally { await proxy.close(); await new Promise<void>((r) => upstream.close(() => r())) }
})

// A browser mounted during a turn is usable once the harness has its tool list; before that DSH answers
// "unknown tool" (test/browser-mount.e2e.test.ts). The proxy says when the harness first fetched the list.
test('the proxy reports when the harness has fetched the browser tool list', async () => {
  const upstream = createServer((req, res) => {
    let body = ''
    req.on('data', (d) => { body += d })
    req.on('end', () => {
      const msg = JSON.parse(body) as { id: number; method: string }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: msg.method === 'tools/list' ? { tools: [{ name: 'browser_snapshot' }] } : {} })}\n\n`)
    })
  })
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening')
  const upPort = (upstream.address() as { port: number }).port
  const proxy = await startMcpAuthProxy({ upstream: `http://127.0.0.1:${upPort}`, secret: 'right', allowedTools: ALLOWED_BROWSER_TOOLS })
  const post = (method: string) => fetch(proxy.url, { method: 'POST', headers: { authorization: 'Bearer right', 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method }) }).then((r) => r.text())
  try {
    let listed = false
    proxy.listed.then(() => { listed = true })
    await post('initialize')
    await new Promise((r) => setTimeout(r, 20))
    assert.equal(listed, false, 'not before the list')
    await post('tools/list')
    await new Promise((r) => setTimeout(r, 20))
    assert.equal(listed, true)
  } finally { await proxy.close(); await new Promise<void>((r) => upstream.close(() => r())) }
})

// The cell's kernel rules list the loopback ports it may reach once, at start (src/main.ts installEgressFirewall).
// A browser installed later must answer on a port that was in that list (Fly 2026-10-29: the broker
// started after the install, uid 1000 got ECONNREFUSED, DSH said "server is disconnected"). So the proxy is up from
// the start, answers 503 until the browser is there, then forwards.
test('the proxy can start before the browser and forwards once it is pointed at it', async () => {
  const upstream = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('upstream') })
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening')
  const upPort = (upstream.address() as { port: number }).port
  const proxy = await startMcpAuthProxy({ secret: 'right', allowedTools: ALLOWED_BROWSER_TOOLS })
  const post = () => fetch(proxy.url, { method: 'POST', headers: { authorization: 'Bearer right' } })
  try {
    assert.equal((await post()).status, 503)
    proxy.setUpstream(`http://127.0.0.1:${upPort}`)
    const r = await post()
    assert.equal(r.status, 200)
    assert.equal(await r.text(), 'upstream')
  } finally { await proxy.close(); await new Promise<void>((r) => upstream.close(() => r())) }
})

// Fly 2026-10-29: the screenshot reached the thread, but its file was in the browser's folder,
// which the cell cannot read, and the person's memory asks for files to be handed over with `present`; the model
// spent six minutes trying to copy it into the work folder. The proxy saves each screenshot into the work folder and
// names that file in the result, so `present`, `read_image` and `cp` find it.
test('the proxy saves a screenshot into the work folder and names that file in the result', async () => {
  const png = Buffer.from('89504e470d0a1a0a', 'hex')
  const old = '/data/browser-broker/output/page-2026-10-29T07-12-36-462Z.png'
  const upstream = createServer((req, res) => {
    let body = ''
    req.on('data', (d) => { body += d })
    req.on('end', () => {
      const msg = JSON.parse(body) as { id: number }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: `### Result\n- [Screenshot of viewport](${old})\n// Screenshot viewport and save it as ${old}` }, { type: 'image', data: png.toString('base64'), mimeType: 'image/png' }] } })}\n\n`)
    })
  })
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening')
  const upPort = (upstream.address() as { port: number }).port
  const saved: { name: string; bytes: Buffer }[] = []
  const proxy = await startMcpAuthProxy({ upstream: `http://127.0.0.1:${upPort}`, secret: 'right', allowedTools: ALLOWED_BROWSER_TOOLS, saveShot: async (name, bytes) => { saved.push({ name, bytes }); return `/data/workspace/screenshots/${name}` } })
  try {
    const text = await (await fetch(proxy.url, { method: 'POST', headers: { authorization: 'Bearer right', 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'browser_take_screenshot', arguments: {} } }) })).text()
    assert.deepEqual(saved.map((s) => [s.name, s.bytes.toString('hex')]), [['page-2026-10-29T07-12-36-462Z.png', png.toString('hex')]])
    const msg = JSON.parse(text.split('\n').find((l) => l.startsWith('data: '))!.slice(6)) as { result: { content: { type: string; text?: string; data?: string }[] } }
    assert.equal(msg.result.content[0].text, '### Result\n- [Screenshot of viewport](/data/workspace/screenshots/page-2026-10-29T07-12-36-462Z.png)\n// Screenshot viewport and save it as /data/workspace/screenshots/page-2026-10-29T07-12-36-462Z.png')
    assert.equal(msg.result.content[1].data, png.toString('base64'), 'the image still comes back')
  } finally { await proxy.close(); await new Promise<void>((r) => upstream.close(() => r())) }
})

test('the work-folder writer keeps a plain file name and writes the bytes', async () => {
  const { mkdtempSync, readFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = join(mkdtempSync(join(tmpdir(), 'bot-shots-')), 'screenshots')
  const save = workFolderWriter({ dir })
  const path = await save('../../etc/page 1.png', Buffer.from('abc'))
  assert.equal(path, join(dir, 'page-1.png'))
  assert.equal(readFileSync(path!, 'utf8'), 'abc')
})
