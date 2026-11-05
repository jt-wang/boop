import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startScriptedModel } from './fixtures/scripted-model.ts'

// A screenshot the assistant takes with its browser reaches the phone: the scripted model has the real harness open a
// local page in the bot's browser (Playwright MCP, the installed Chrome) and take a screenshot; DSH keeps the image in
// its attachment store; the bot's thread carries an image row for it and serves its bytes (GET /library/attachment);
// the app, opened headless against this bot over the network, draws it after the step. Before, the thread said 截图
// and showed nothing. Needs Chrome on this machine and `nsh` for the app part. Skipped unless DEEPSEEK_BOT_E2E=1 or
// DEEPSEEK_BOT_E2E_MODEL=1.
const run = process.env.DEEPSEEK_BOT_E2E === '1' || process.env.DEEPSEEK_BOT_E2E_MODEL === '1'

test('a screenshot the assistant takes with its browser shows in the thread on the phone', { skip: !run, timeout: 300_000 }, async () => {
  const page = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<title>Screenshot E2E</title><h1 style="font:48px sans-serif">Hello from the page</h1>') })
  await new Promise<void>((r) => page.listen(0, '127.0.0.1', r))
  const pageUrl = `http://127.0.0.1:${(page.address() as { port: number }).port}/`
  const model = await startScriptedModel([
    { name: 'mcp__browser__browser_navigate', arguments: { url: pageUrl } },
    { name: 'mcp__browser__browser_take_screenshot', arguments: {} },
  ])
  const home = mkdtempSync(join(tmpdir(), 'bot-shot-'))
  const bot: ChildProcess = spawn(process.execPath, ['src/main.ts', '--home', home, '--host', '127.0.0.1', '--port', '0', '--model', 'scripted/scripted', '--base-url', model.url, '--api-key-env', 'DEEPSEEK_BOT_MODEL_KEY'], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, DEEPSEEK_BOT_MODEL_KEY: 'local' } })
  let out = ''
  bot.stdout!.on('data', (d) => { out += d }); bot.stderr!.on('data', (d) => { out += d })
  const appDir = join(process.cwd(), 'mobile', '.nsh', 'e2e-shot')
  try {
    let pair = ''
    for (let i = 0; i < 300 && !pair; i++) { const m = /(http:\/\/[^\s]+\/pair\?code=\d{6})/.exec(out); if (m) pair = m[1]; else await new Promise((r) => setTimeout(r, 200)) }
    assert.ok(pair, out)
    for (let i = 0; i < 100 && !/listening to the assistant/.test(out); i++) await new Promise((r) => setTimeout(r, 200))
    const u = new URL(pair)
    const { token } = await (await fetch(`${u.origin}/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: u.searchParams.get('code'), name: 'e2e' }) })).json() as { token: string }
    const h = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
    await fetch(`${u.origin}/consent`, { method: 'PUT', headers: h, body: JSON.stringify({ ai: true, age: 'adult' }) }) // the person agreed to the AI provider
    await fetch(`${u.origin}/settings`, { method: 'PUT', headers: h, body: JSON.stringify({ assistantName: 'Nori' }) })
    const { sessionId } = await (await fetch(`${u.origin}/sessions/main`, { method: 'POST', headers: h })).json() as { sessionId: string }
    const idle = async () => { for (let i = 0; i < 240; i++) { const t = await (await fetch(`${u.origin}/threads`, { headers: h })).json() as { running: boolean }[]; if (Array.isArray(t) && !t.some((x) => x.running)) return; await new Promise((r) => setTimeout(r, 500)) } }
    await new Promise((r) => setTimeout(r, 2000)); await idle()
    assert.equal((await fetch(`${u.origin}/threads/${sessionId}/messages`, { method: 'POST', headers: h, body: JSON.stringify({ text: 'Open the page and show me' }) })).status, 200)
    await new Promise((r) => setTimeout(r, 2000)); await idle()

    // the harness got an image back from the screenshot tool (the model saw it as an image part, not text only)
    assert.ok(model.results.some((r) => /Screenshot/i.test(r)), `the screenshot tool ran: ${model.results.join(' | ').slice(0, 600)}\n${out.slice(-2000)}`)
    // the link names the file by its absolute path (src/fold.ts matches a presented file by path, never by name)
    assert.ok(model.results.some((r) => /\]\(\/[^)]+\.png\)/.test(r)), `the screenshot link is absolute: ${model.results.join(' | ').slice(0, 600)}`)

    // the app, against this bot: the screenshot is drawn after its step
    rmSync(appDir, { recursive: true, force: true }); mkdirSync(appDir, { recursive: true })
    writeFileSync(join(appDir, 'shot.test.tsx'), `import { expect, open, test } from 'nsh/test'
test('the screenshot is in the thread', async () => {
  const app = await open('../../App.tsx', { network: 'live', storage: { origin: ${JSON.stringify(u.origin)}, token: ${JSON.stringify(token)} } })
  for (let i = 0; i < 60 && !app.shows('id:file-call_2:img0-image-loaded'); i++) await app.wait(500)
  expect(app.shows('id:file-call_2:img0-image-loaded')).toBe(true)
  const req = app.requests().find((r) => r.url.includes('/library/attachment'))
  expect(Boolean(req)).toBe(true)
  expect(req!.headers.authorization).toBe(${JSON.stringify(`Bearer ${token}`)})
}, 60000)
`)
    const r = spawnSync('nsh', ['test', join(appDir, 'shot.test.tsx')], { cwd: join(process.cwd(), 'mobile'), encoding: 'utf8', timeout: 120_000 })
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`)
  } finally {
    rmSync(appDir, { recursive: true, force: true })
    await new Promise<void>((r) => { bot.once('exit', () => r()); bot.kill('SIGTERM') })
    await model.close(); page.close()
    rmSync(home, { recursive: true, force: true })
  }
})
