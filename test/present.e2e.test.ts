import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startScriptedModel } from './fixtures/scripted-model.ts'

// A file the assistant makes and hands over reaches the phone: the scripted model has the real harness write a PNG
// with bash and present it with DSH's `present`; the bot's thread carries a `file` row for it; the library serves
// its bytes to the device; and the app, opened headless against this bot over the network, draws the image in the
// thread. The owner saw blank space where three charts were (Android APK, 2026-10-27).
// Needs only this machine (and `nsh` for the app part). Skipped unless DEEPSEEK_BOT_E2E=1 or DEEPSEEK_BOT_E2E_MODEL=1.
const run = process.env.DEEPSEEK_BOT_E2E === '1' || process.env.DEEPSEEK_BOT_E2E_MODEL === '1'
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

test('a PNG the assistant presents shows in the thread on the phone', { skip: !run, timeout: 300_000 }, async () => {
  const model = await startScriptedModel([
    { name: 'bash', arguments: { command: `mkdir -p charts && printf '%s' '${PNG}' | base64 -d > charts/e2e.png && ls -l charts/e2e.png`, description: 'draw the chart' } },
    { name: 'present', arguments: { files: [{ path: 'charts/e2e.png', description: 'E2E chart' }] } },
  ])
  const home = mkdtempSync(join(tmpdir(), 'bot-present-'))
  const bot: ChildProcess = spawn(process.execPath, ['src/main.ts', '--home', home, '--host', '127.0.0.1', '--port', '0', '--model', 'scripted/scripted', '--base-url', model.url, '--api-key-env', 'DEEPSEEK_BOT_MODEL_KEY'], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, DEEPSEEK_BOT_MODEL_KEY: 'local' } })
  let out = ''
  bot.stdout!.on('data', (d) => { out += d }); bot.stderr!.on('data', (d) => { out += d })
  const appDir = join(process.cwd(), 'mobile', '.nsh', 'e2e')
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
    const idle = async () => { for (let i = 0; i < 150; i++) { const t = await (await fetch(`${u.origin}/threads`, { headers: h })).json() as { running: boolean }[]; if (Array.isArray(t) && !t.some((x) => x.running)) return; await new Promise((r) => setTimeout(r, 500)) } }
    await new Promise((r) => setTimeout(r, 2000)); await idle()
    assert.equal((await fetch(`${u.origin}/threads/${sessionId}/messages`, { method: 'POST', headers: h, body: JSON.stringify({ text: 'Make me a chart' }) })).status, 200)
    await new Promise((r) => setTimeout(r, 2000)); await idle()

    // the library serves the presented file to the device, as an image
    const lib = await (await fetch(`${u.origin}/library/file?path=${encodeURIComponent('charts/e2e.png')}&format=json`, { headers: h })).json() as { kind: string; base64?: string }
    assert.equal(lib.kind, 'image', JSON.stringify(lib).slice(0, 200))
    assert.equal(lib.base64, PNG)

    // the app, against this bot: the thread shows the image
    rmSync(appDir, { recursive: true, force: true }); mkdirSync(appDir, { recursive: true })
    writeFileSync(join(appDir, 'present.test.tsx'), `import { expect, open, test } from 'nsh/test'
test('the presented PNG is in the thread', async () => {
  const app = await open('../../App.tsx', { network: 'live', storage: { origin: ${JSON.stringify(u.origin)}, token: ${JSON.stringify(token)} } })
  // the image is a view labelled with its description; it says so in words when its bytes do not come
  for (let i = 0; i < 40 && !app.shows('label:E2E chart'); i++) await app.wait(500)
  expect(app.shows('label:E2E chart')).toBe(true)
  await app.wait(2000)
  expect(app.shows('text:This file cannot be opened.')).toBe(false)

}, 60000)
`)
    const r = spawnSync('nsh', ['test', join(appDir, 'present.test.tsx')], { cwd: join(process.cwd(), 'mobile'), encoding: 'utf8', timeout: 120_000 })
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`)
  } finally {
    rmSync(appDir, { recursive: true, force: true })
    await new Promise<void>((r) => { bot.once('exit', () => r()); bot.kill('SIGTERM') })
    await model.close()
  }
})
