import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Connectors } from '../src/connectors.ts'
import { startScriptedModel } from './fixtures/scripted-model.ts'

// A custom connector's env var reaches its server. The harness runs with an allow-listed env (src/dsh.ts), and the
// row reads the value from the harness's env, so before this fix the probe server answered "marker=" (2026-11-01).
// Scripted model: needs only this machine.
const run = process.env.DEEPSEEK_BOT_E2E === '1' || process.env.DEEPSEEK_BOT_E2E_MODEL === '1'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

test("a custom connector's server gets the env var the person named for it", { skip: !run, timeout: 180_000 }, async () => {
  const model = await startScriptedModel([{ name: 'mcp__envprobe__probe', arguments: {} }, { text: 'done' }])
  const home = mkdtempSync(join(tmpdir(), 'bot-connector-env-'))
  const store = await Connectors.open(join(home, 'connectors.json'))
  await store.add({ custom: true, name: 'envprobe', transport: 'stdio', command: process.execPath, args: [join(process.cwd(), 'test', 'fixtures', 'env-mcp.mjs')], envNames: ['BOT_E2E_PROBE_TOKEN'] })
  const bot = spawn(process.execPath, ['src/main.ts', '--home', home, '--host', '127.0.0.1', '--port', '0', '--model', 'scripted/scripted', '--base-url', model.url, '--api-key-env', 'DEEPSEEK_BOT_MODEL_KEY'], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, DEEPSEEK_BOT_MODEL_KEY: 'local', BOT_E2E_PROBE_TOKEN: 'probe-value-5521' } })
  let out = ''
  bot.stdout!.on('data', (d) => { out += d }); bot.stderr!.on('data', (d) => { out += d })
  try {
    let pair = ''
    for (let i = 0; i < 300 && !(pair && /listening to the assistant/.test(out)); i++) { pair = /(http:\/\/[^\s]+\/pair\?code=\d{6})/.exec(out)?.[1] ?? ''; await sleep(200) }
    assert.ok(pair, out)
    const u = new URL(pair)
    const { token } = await (await fetch(`${u.origin}/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: u.searchParams.get('code'), name: 'e2e' }) })).json() as { token: string }
    const h = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
    await fetch(`${u.origin}/consent`, { method: 'PUT', headers: h, body: JSON.stringify({ ai: true, age: 'adult' }) })
    const t = await (await fetch(`${u.origin}/threads`, { method: 'POST', headers: h, body: JSON.stringify({}) })).json() as { sessionId: string }
    await fetch(`${u.origin}/threads/${t.sessionId}/messages`, { method: 'POST', headers: h, body: JSON.stringify({ text: 'probe' }) })
    for (let i = 0; i < 150 && !model.results.length; i++) await sleep(200)
    assert.deepEqual(model.results.slice(0, 1), ['marker=probe-value-5521'], out)
  } finally { bot.kill('SIGTERM'); await model.close() }
})
