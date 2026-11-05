// web_search is DSH's @deepseek-ai/dsh-web-search-deepseek: one Anthropic Messages call to `<base>/messages` with
// DeepSeek's native `web_search_20250305` server tool, and the model name "deepseek-v4-flash" unless configured. On
// the hosted computer (SiliconFlow, an OpenAI-compatible gateway) every search failed: "DeepSeek API error (HTTP
// 400): Model does not exist". The real bot and DSH with a scripted model:
// - a custom provider not marked as serving that search: the model is never handed web_search (web_fetch stays);
// - one marked with --web-search: web_search is offered, and the search names the configured model and goes
//   through the bot's model proxy with the real key, never the surrogate.
// Needs only this machine. Skipped unless DEEPSEEK_BOT_E2E=1.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startScriptedModel, type ScriptedModel } from './fixtures/scripted-model.ts'

const run = process.env.DEEPSEEK_BOT_E2E === '1'

async function turn(model: ScriptedModel, extra: string[]) {
  const home = mkdtempSync(join(tmpdir(), 'bot-search-'))
  const bot: ChildProcess = spawn(process.execPath, ['src/main.ts', '--home', home, '--host', '127.0.0.1', '--port', '0', '--model', 'scripted/scripted-flash', '--base-url', model.url, '--api-key-env', 'DEEPSEEK_BOT_MODEL_KEY', ...extra], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, DEEPSEEK_BOT_MODEL_KEY: 'REAL-KEY' } })
  let out = ''
  bot.stdout!.on('data', (d) => { out += d }); bot.stderr!.on('data', (d) => { out += d })
  try {
    let pair = ''
    for (let i = 0; i < 300 && !pair; i++) { const m = /(http:\/\/[^\s]+\/pair\?code=\d{6})/.exec(out); if (m) pair = m[1]; else await new Promise((r) => setTimeout(r, 200)) }
    assert.ok(pair, out)
    for (let i = 0; i < 100 && !/listening to the assistant/.test(out); i++) await new Promise((r) => setTimeout(r, 200))
    const u = new URL(pair)
    const { token } = await (await fetch(`${u.origin}/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: u.searchParams.get('code'), name: 'e2e' }) })).json() as { token: string }
    const h = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
    await fetch(`${u.origin}/consent`, { method: 'PUT', headers: h, body: JSON.stringify({ ai: true, age: 'adult' }) })
    const { sessionId } = await (await fetch(`${u.origin}/threads`, { method: 'POST', headers: h, body: JSON.stringify({}) })).json() as { sessionId: string }
    assert.equal((await fetch(`${u.origin}/threads/${sessionId}/messages`, { method: 'POST', headers: h, body: JSON.stringify({ text: '搜一下今天里斯本的天气' }) })).status, 200)
    for (let i = 0; i < 120 && model.answers.length === 0; i++) await new Promise((r) => setTimeout(r, 500))
    assert.ok(model.answers.length > 0, `the turn ended: ${out.slice(-2000)}`)
    const first = model.requests.find((x) => Array.isArray((x as { tools?: unknown[] }).tools) && (x as { tools: unknown[] }).tools.length) as { tools: { function: { name: string } }[] }
    return first.tools.map((t) => t.function.name)
  } finally {
    await new Promise<void>((r) => { bot.once('exit', () => r()); bot.kill('SIGTERM') })
  }
}

test('a custom provider that does not serve DeepSeek\'s native search is never handed web_search', { skip: !run, timeout: 300_000 }, async () => {
  const model = await startScriptedModel([{ name: 'web_fetch', arguments: { url: 'https://example.com' } }])
  try {
    const tools = await turn(model, [])
    assert.ok(tools.includes('web_fetch'), tools.join(', '))
    assert.ok(!tools.includes('web_search'), `web_search is not offered: ${tools.join(', ')}`)
    assert.equal(model.messages.length, 0)
  } finally { await model.close() }
})

test('a custom provider marked --web-search: web_search names the configured model and goes through the model proxy', { skip: !run, timeout: 300_000 }, async () => {
  const model = await startScriptedModel([{ name: 'web_search', arguments: { queries: ['里斯本 天气'] } }])
  try {
    const tools = await turn(model, ['--web-search'])
    assert.ok(tools.includes('web_search'), tools.join(', '))
    assert.equal(model.messages.length, 1, JSON.stringify(model.messages))
    const m = model.messages[0]
    assert.equal(m.path, '/v1/messages')
    assert.equal(m.body.model, 'scripted-flash', 'the configured model, not DSH\'s default "deepseek-v4-flash"')
    assert.deepEqual((m.body.tools as { type: string }[]).map((t) => t.type), ['web_search_20250305'])
    assert.equal(m.authorization, 'Bearer REAL-KEY', 'the proxy put the real key on it')
    assert.ok(model.results.some((r) => r.includes('SCRIPTED-RESULT')), `the search result reached the model: ${model.results.join(' | ').slice(0, 800)}`)
  } finally { await model.close() }
})
