import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { openHome } from '../src/home.ts'
import { browserPatchYaml, enableBrowser, playwrightMcpCli } from '../src/browser.ts'
import { startDshWeb } from '../src/dsh.ts'
import { rpc, Mux, sessionAddress } from '../src/dshclient.ts'

// Unit part (always runs): the profile patch row that mounts the assistant's browser.
test('browserPatchYaml mounts Playwright MCP over stdio with a persistent profile under the bot home', () => {
  const y = browserPatchYaml({ root: '/home/x/.deepseek-bot', opts: { model: { provider: 'deepseek-official', model: 'deepseek-flash' } } })
  assert.match(y, /- insert:\n\s+- id: bot-browser\n\s+name: '@deepseek-ai\/dsh-mcp-client'/)
  assert.match(y, /serverName: browser/)
  assert.match(y, /transport: stdio/)
  assert.match(y, /"--browser", "chrome"/)
  assert.match(y, /"--headless"/)
  assert.match(y, /"--user-data-dir", "\/home\/x\/\.deepseek-bot\/browser-profile"/)
  assert.doesNotMatch(y, /--isolated/)
  assert.match(y, /cwd: "\/home\/x\/\.deepseek-bot\/workspace"/)
  assert.ok(existsSync(playwrightMcpCli()), playwrightMcpCli())
})

test('browser: false leaves the row out; openHome with the hook writes it by default', async () => {
  assert.equal(browserPatchYaml({ root: '/r', opts: { model: { provider: 'p', model: 'm' }, browser: false } }), '')
  enableBrowser()
  const root = mkdtempSync(join(tmpdir(), 'bot-browser-'))
  await openHome(root, { model: { provider: 'deepseek-official', model: 'deepseek-flash' } })
  const patch = readFileSync(join(root, 'dsh', 'profiles', 'web', 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /id: bot-browser/)
  assert.match(patch, new RegExp(`"--user-data-dir", "${join(root, 'browser-profile').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`))
  await openHome(root, { model: { provider: 'deepseek-official', model: 'deepseek-flash' }, browser: false })
  assert.doesNotMatch(readFileSync(join(root, 'dsh', 'profiles', 'web', 'cordis.patch.yml'), 'utf8'), /bot-browser/)
})

// Real dsh + real model (local Magpie gateway). Skipped unless DEEPSEEK_BOT_E2E_MODEL=1.
const run = process.env.DEEPSEEK_BOT_E2E_MODEL === '1'

test('the assistant opens a page in its own browser, reads it, and screenshots come back as image attachments', { skip: !run, timeout: 300_000 }, async () => {
  enableBrowser()
  const root = mkdtempSync(join(tmpdir(), 'bot-browser-e2e-'))
  const home = await openHome(root, { model: { provider: 'magpie', model: 'group/auto-deepseek-flash', baseURL: 'http://127.0.0.1:3425/v1', apiKeyEnv: 'DEEPSEEK_BOT_MODEL_KEY' } })
  const dsh = await startDshWeb({ dshHome: home.dshHome, env: { ...process.env, DEEPSEEK_BOT_MODEL_KEY: 'local' }, timeoutMs: 120_000 })
  const t = { origin: dsh.origin, cookie: dsh.cookie }
  const seen: { type: string; name?: string; content?: unknown }[] = []
  try {
    const { sessionId } = await rpc<{ sessionId: string }>(t, 'session/create', { request: { cwd: home.workspace } })
    const mux = new Mux(t)
    const follow = await mux.open('session/follow', { request: { address: sessionAddress(sessionId), assistantStream: true, maxMessages: 1 } })
    // Auto-approve anything the sandbox asks about, so a tool approval cannot stall the turn.
    const events = new Mux(t)
    const ev = await events.open('$events', {})
    ;(async () => { let clientId = ''; for await (const f of ev) { const v = f as { type: string; clientId?: string; eventId?: string; event?: string }; if (v.type === 'ready') clientId = String(v.clientId); if (v.type === 'waterfall' && v.event === 'approval/request') await rpc(t, '$events/result', { clientId, eventId: v.eventId, outcome: { kind: 'result', value: 'allowed-once' } }).catch(() => {}) } })().catch(() => {})

    await rpc(t, 'session/prompt', { request: { requestId: randomUUID(), sessionId, mode: 'queue', content: [{ type: 'text', text: 'Using your browser tools: open https://example.com, then take a screenshot of it, then tell me the page title and its main heading text in one line.' }] } })
    let answer = ''
    const deadline = Date.now() + 240_000
    for await (const frame of follow) {
      if (Date.now() > deadline) break
      const f = frame as { type: string; event?: { type: string; data?: Record<string, unknown> } }
      if (f.type !== 'event' || !f.event) continue
      const d = f.event.data ?? {}
      if (f.event.type === 'assistant/message') {
        const content = ((d.message as { content?: { type: string; text?: string; name?: string }[] })?.content ?? [])
        for (const c of content) if (c.type === 'tool-call') seen.push({ type: 'tool-call', name: c.name })
        const text = content.filter((c) => c.type === 'text').map((c) => c.text).join('')
        if (text.trim()) answer = text
      }
      if (f.event.type === 'tool/result') seen.push({ type: 'tool/result', content: (d.message as { content?: unknown })?.content })
      if (f.event.type === 'turn/end') break
    }
    follow.cancel(); ev.cancel(); mux.close(); events.close()
    const calls = seen.filter((s) => s.type === 'tool-call').map((s) => s.name)
    assert.ok(calls.some((n) => n === 'mcp__browser__browser_navigate'), `browser tool calls: ${calls.join(',')}`)
    assert.match(answer, /Example Domain/, `assistant said: ${JSON.stringify(answer)}; calls: ${calls.join(',')}`)
    // A screenshot comes back as an image block with a durable attachment reference, never inline bytes.
    const results = seen.filter((s) => s.type === 'tool/result').map((s) => s.content as { type: string; attachment?: Record<string, unknown>; data?: unknown }[] | undefined)
    const image = results.flatMap((c) => c ?? []).find((c) => c.type === 'image')
    assert.ok(image, `no image block in tool results: ${JSON.stringify(results).slice(0, 2000)}`)
    assert.equal(image!.data, undefined, 'image bytes must not be inline in the session log')
    assert.ok(image!.attachment && typeof image!.attachment.attachmentId === 'string', JSON.stringify(image))
    // The bytes are readable through session/attachment, the route the bot proxies under /api.
    const r = await fetch(`${t.origin}/api/session/attachment`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: t.cookie }, body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: 'session/attachment', payload: { args: { request: { sessionId, attachmentId: image!.attachment.attachmentId } } } }) })
    assert.equal(r.status, 200)
    const ct = r.headers.get('content-type') ?? ''
    const body = Buffer.from(await r.arrayBuffer())
    // Shape of the read-back: log it with the bytes elided.
    const shape = ct.includes('json') ? JSON.stringify(JSON.parse(body.toString()), (k, v) => (typeof v === 'string' && v.length > 80 ? `<${v.length} chars>` : v)) : `<${ct} ${body.length} bytes>`
    console.log(`[browser e2e] tool calls: ${calls.join(',')}\n[browser e2e] answer: ${answer}\n[browser e2e] image block: ${JSON.stringify(image)}\n[browser e2e] session/attachment → ${ct} ${body.length} bytes: ${shape}`)
    assert.ok(body.length > 1000, `attachment body ${body.length} bytes`)
  } finally { await dsh.stop() }
})
