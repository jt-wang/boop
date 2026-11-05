import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startScriptedModel, text, type Msg } from './fixtures/scripted-model.ts'

// What the model reads on every request, kept within a budget (DeepSeek's dsh-superagent prototype checks the same per
// role in tests/model-surface.spec.ts). It is the real request DSH sends: the system prompt (DSH's sections and our
// AGENTS.md) and every tool's schema. A bigger prompt costs tokens and attention on every step, so growing it past the
// budget is a decision: raise the number here in the same change and say why.
// Needs only this machine. Skipped unless DEEPSEEK_BOT_E2E=1 or DEEPSEEK_BOT_E2E_MODEL=1.
const run = process.env.DEEPSEEK_BOT_E2E === '1' || process.env.DEEPSEEK_BOT_E2E_MODEL === '1'

type Req = { messages: Msg[]; tools?: { function?: { name?: string } }[] }
const bytes = (v: unknown) => Buffer.byteLength(typeof v === 'string' ? v : JSON.stringify(v))

test('what the model reads stays within its budget', { skip: !run, timeout: 120_000 }, async () => {
  const model = await startScriptedModel([])
  const home = mkdtempSync(join(tmpdir(), 'bot-surface-'))
  const bot: ChildProcess = spawn(process.execPath, ['src/main.ts', '--home', home, '--host', '127.0.0.1', '--port', '0', '--model', 'scripted/scripted', '--base-url', model.url, '--api-key-env', 'DEEPSEEK_BOT_MODEL_KEY'], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, DEEPSEEK_BOT_MODEL_KEY: 'local' } })
  let out = ''
  bot.stdout!.on('data', (d) => { out += d }); bot.stderr!.on('data', (d) => { out += d })
  try {
    let pair = ''
    for (let i = 0; i < 300 && !pair; i++) { const m = /(http:\/\/[^\s]+\/pair\?code=\d{6})/.exec(out); if (m) pair = m[1]; else await new Promise((r) => setTimeout(r, 200)) }
    for (let i = 0; i < 100 && !/listening to the assistant/.test(out); i++) await new Promise((r) => setTimeout(r, 200))
    const u = new URL(pair)
    const { token } = await (await fetch(`${u.origin}/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: u.searchParams.get('code'), name: 'e2e' }) })).json() as { token: string }
    const h = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
    await fetch(`${u.origin}/consent`, { method: 'PUT', headers: h, body: JSON.stringify({ ai: true, age: 'adult' }) })
    const t = await (await fetch(`${u.origin}/threads`, { method: 'POST', headers: h, body: JSON.stringify({}) })).json() as { sessionId: string }
    await fetch(`${u.origin}/threads/${t.sessionId}/messages`, { method: 'POST', headers: h, body: JSON.stringify({ text: 'hi' }) })
    for (let i = 0; i < 300 && !model.requests.some((r) => (r as Req).tools?.length && JSON.stringify(r).includes('"hi"')); i++) await new Promise((r) => setTimeout(r, 200))
    const req = model.requests.find((r) => (r as Req).tools?.length && JSON.stringify(r).includes('"hi"')) as Req | undefined
    assert.ok(req, out)
    const system = req.messages.filter((m) => m.role !== 'assistant').map((m) => text(m.content)).join('\n')
    const tools = req.tools ?? []
    const agents = system.slice(Math.max(0, system.indexOf('Your memory is three Markdown files')))
    const ours = tools.filter((t) => t.function?.name?.startsWith('mcp__bot__'))
    const upToPerson = req.messages.slice(0, req.messages.findLastIndex((m) => m.role === 'user' && text(m.content).includes('hi')))
    const sizes = { system: bytes(system), before: bytes(upToPerson), roles: upToPerson.map((m) => `${m.role}:${bytes(m)}`).join(','), tools: bytes(tools), toolCount: tools.length, ourTools: bytes(ours), last: bytes(req.messages.at(-1)) }
    if (process.env.E2E_LOG) console.log(`model surface: ${JSON.stringify(sizes)}; tools: ${tools.map((t) => `${t.function?.name}=${bytes(t)}`).join(' ')}`)
    // Measured 2026-11-01 (DSH 0.2.0-rc.2, standard preset, the browser on): the prompt before the person's words
    // 19,010 bytes (system 5,849; our AGENTS.md, memory and skills 12,574); 65 tool schemas 53,450 bytes, of which the
    // browser's 27 are about 22,000 and the bot's own 12 are 12,567. Each budget is that plus about 10%.
    assert.ok(sizes.before <= 21_000, `the prompt is ${sizes.before} bytes, over its 21,000 budget`)
    assert.ok(sizes.tools <= 59_000, `the tool schemas are ${sizes.tools} bytes, over their 59,000 budget`)
    assert.ok(sizes.ourTools <= 14_000, `the bot's own tool schemas are ${sizes.ourTools} bytes, over their 14,000 budget`)
    assert.ok(sizes.toolCount <= 70, `the model is given ${sizes.toolCount} tools, over the budget of 70`)
    assert.ok(agents.length > 0, 'AGENTS.md is in the prompt')
  } finally {
    await new Promise<void>((r) => { bot.once('exit', () => r()); bot.kill('SIGTERM') })
    await model.close()
  }
})
