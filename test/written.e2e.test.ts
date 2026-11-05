import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startScriptedModel } from './fixtures/scripted-model.ts'

// "Write me a haiku and save it as haiku.md": the reply showed the haiku and nothing in the thread opened the file
// (side-by-side run against DS-Bot, 2026-10-27). The scripted model has the real harness write haiku.md with its
// `write` tool and a scratch file in /tmp; the app, opened headless against this bot over the network, shows a card
// for haiku.md only, and tapping it opens the file's page with the haiku.
// Needs only this machine (and `nsh`). Skipped unless DEEPSEEK_BOT_E2E=1 or DEEPSEEK_BOT_E2E_MODEL=1.
const run = process.env.DEEPSEEK_BOT_E2E === '1' || process.env.DEEPSEEK_BOT_E2E_MODEL === '1'

test('a file the assistant writes opens from the thread on the phone', { skip: !run, timeout: 300_000 }, async () => {
  const model = await startScriptedModel([
    { name: 'write', arguments: { file_path: 'haiku.md', content: 'Old pond\nA frog jumps in\nThe sound of water\n' } },
    { name: 'write', arguments: { file_path: '/tmp/e2e-scratch-haiku.txt', content: 'draft' } },
  ], '127.0.0.1', {
    // the bot greets a fresh main thread first; that turn must not spend the script meant for the person's ask
    respond: ({ messages }) => JSON.stringify(messages).includes('save it as haiku.md') ? undefined : { text: 'hello' },
  })
  const home = mkdtempSync(join(tmpdir(), 'bot-written-'))
  const bot: ChildProcess = spawn(process.execPath, ['src/main.ts', '--home', home, '--host', '127.0.0.1', '--port', '0', '--model', 'scripted/scripted', '--base-url', model.url, '--api-key-env', 'DEEPSEEK_BOT_MODEL_KEY'], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, DEEPSEEK_BOT_MODEL_KEY: 'local' } })
  let out = ''
  bot.stdout!.on('data', (d) => { out += d }); bot.stderr!.on('data', (d) => { out += d })
  const appDir = join(process.cwd(), 'mobile', '.nsh', 'e2e-written')
  try {
    let pair = ''
    for (let i = 0; i < 300 && !pair; i++) { const m = /(http:\/\/[^\s]+\/pair\?code=\d{6})/.exec(out); if (m) pair = m[1]; else await new Promise((r) => setTimeout(r, 200)) }
    assert.ok(pair, out)
    for (let i = 0; i < 100 && !/listening to the assistant/.test(out); i++) await new Promise((r) => setTimeout(r, 200))
    const u = new URL(pair)
    const { token } = await (await fetch(`${u.origin}/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: u.searchParams.get('code'), name: 'e2e' }) })).json() as { token: string }
    const h = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
    await fetch(`${u.origin}/settings`, { method: 'PUT', headers: h, body: JSON.stringify({ assistantName: 'Nori' }) })
    await fetch(`${u.origin}/consent`, { method: 'PUT', headers: h, body: JSON.stringify({ ai: true, age: 'adult' }) }) // the person agreed to the AI provider
    const { sessionId } = await (await fetch(`${u.origin}/sessions/main`, { method: 'POST', headers: h })).json() as { sessionId: string }
    const idle = async () => { for (let i = 0; i < 150; i++) { const t = await (await fetch(`${u.origin}/threads`, { headers: h })).json() as { running: boolean }[]; if (Array.isArray(t) && !t.some((x) => x.running)) return; await new Promise((r) => setTimeout(r, 500)) } }
    await new Promise((r) => setTimeout(r, 2000)); await idle()
    assert.equal((await fetch(`${u.origin}/threads/${sessionId}/messages`, { method: 'POST', headers: h, body: JSON.stringify({ text: 'write me a haiku and save it as haiku.md' }) })).status, 200)
    await new Promise((r) => setTimeout(r, 2000)); await idle()
    assert.ok(model.results.some((r) => /Created file/.test(r)), model.results.join('\n---\n'))

    // the app, against this bot: the thread has a card for haiku.md (none for the scratch file in /tmp) that opens it
    rmSync(appDir, { recursive: true, force: true }); mkdirSync(appDir, { recursive: true })
    writeFileSync(join(appDir, 'written.test.tsx'), `import { expect, open, test } from 'nsh/test'
test('the written file opens from the thread', async () => {
  const app = await open('../../App.tsx', { network: 'live', storage: { origin: ${JSON.stringify(u.origin)}, token: ${JSON.stringify(token)}, lang: 'en' } })
  for (let i = 0; i < 40 && !app.shows('text:haiku.md'); i++) await app.wait(500)
  expect(app.shows('text:haiku.md')).toBe(true)
  expect(app.shows('text:New file')).toBe(true)
  expect(app.shows('text:e2e-scratch-haiku.txt')).toBe(false)
  await app.press('label:haiku.md')
  for (let i = 0; i < 20 && !app.shows('text:/The sound of water/'); i++) await app.wait(500)
  expect(app.shows('text:/The sound of water/')).toBe(true)
}, 60000)
`)
    const r = spawnSync('nsh', ['test', join(appDir, 'written.test.tsx')], { cwd: join(process.cwd(), 'mobile'), encoding: 'utf8', timeout: 120_000 })
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`)
  } finally {
    rmSync(appDir, { recursive: true, force: true })
    await new Promise<void>((r) => { bot.once('exit', () => r()); bot.kill('SIGTERM') })
    await model.close()
  }
})
