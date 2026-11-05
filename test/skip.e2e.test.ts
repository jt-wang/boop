// Skip on a question card, end to end: the real bot and harness, played by the scripted model. The phone's Skip
// (mobile/src/asks.tsx) sends DSH's skip shape, `{ id, selected: [] }` for each question (dsh-user-questions README).
// QA 2026-10-30 (iOS, zh): the model got `{"answers":[{"id":"destination","selected":[]}]}` and read it as "the harness
// returned empty, the person did not answer" (its reasoning, session log seq 85), then twice told the person it had
// not received their pick. DSH's legacy `ask_user_question` (the preset default) never tells the model what an empty
// `selected` means; its timed one does (dsh-tool-ask-user 0.2.0-rc.2 lib/index.js). This checks what the model is told.
//
// Needs only this machine. Skipped unless DEEPSEEK_BOT_E2E=1 or DEEPSEEK_BOT_E2E_MODEL=1.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startScriptedModel } from './fixtures/scripted-model.ts'

const run = process.env.DEEPSEEK_BOT_E2E === '1' || process.env.DEEPSEEK_BOT_E2E_MODEL === '1'
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
type Tool = { type: string; function: { name: string; description?: string; parameters?: unknown } }

test('Skip reaches the model as a skip it is told about, after the question waited for the person', { skip: !run, timeout: 300_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bot-skip-e2e-'))
  const model = await startScriptedModel([
    { text: 'Hello.' }, // the opening turn the bot starts with a new main thread
    { name: 'ask_user_question', arguments: { questions: [{ id: 'dest', question: 'Cascais, Evora or Sintra?', options: [{ label: 'Cascais' }, { label: 'Evora' }, { label: 'Sintra' }] }] } },
    { text: 'No preference, then.' },
  ])
  const bot: ChildProcess = spawn(process.execPath, ['src/main.ts', '--home', join(dir, 'home'), '--host', '127.0.0.1', '--port', '0', '--model', 'scripted/scripted', '--base-url', model.url, '--api-key-env', 'DEEPSEEK_BOT_MODEL_KEY'], {
    stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, DEEPSEEK_BOT_MODEL_KEY: 'local', DEEPSEEK_BOT_GUARD_ALLOW: '127.0.0.1' },
  })
  let out = ''
  bot.stdout!.on('data', (d) => { out += d }); bot.stderr!.on('data', (d) => { out += d })
  try {
    let pair = ''
    for (let i = 0; i < 300 && !pair; i++) { const m = /(http:\/\/[^\s]+\/pair\?code=\d{6})/.exec(out); if (m) pair = m[1]; else await wait(200) }
    assert.ok(pair, out)
    for (let i = 0; i < 100 && !/listening to the assistant/.test(out); i++) await wait(200)
    const origin = new URL(pair).origin
    const { token } = await (await fetch(`${origin}/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: new URL(pair).searchParams.get('code'), name: 'e2e' }) })).json() as { token: string }
    const h = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
    const api = async (method: string, path: string, b?: unknown) => { const r = await fetch(origin + path, { method, headers: h, body: b === undefined ? undefined : JSON.stringify(b) }); assert.ok(r.ok, `${method} ${path} → ${r.status} ${await r.clone().text()}`); return r.json() as Promise<Record<string, unknown>> }
    await api('PUT', '/consent', { age: 'adult', ai: true })
    const { sessionId: main } = await api('POST', '/sessions/main') as { sessionId: string }
    const idle = async () => { for (let i = 0; i < 200; i++) { const t = await (await fetch(`${origin}/threads`, { headers: h })).json() as { running: boolean }[]; if (Array.isArray(t) && !t.some((x) => x.running)) return; await wait(300) } }
    await wait(2000); await idle()

    await api('POST', `/threads/${main}/messages`, { text: 'Pick a weekend trip for me.' })
    let ask: { eventId: string; kind: string } | undefined
    for (let i = 0; i < 150 && !ask; i++) { ask = (await (await fetch(`${origin}/asks`, { headers: h })).json() as { eventId: string; kind: string }[]).find((a) => a.kind === 'question'); if (!ask) await wait(200) }
    assert.ok(ask, `a question card: ${out.slice(-3000)}`)
    // the question waits for the person: nothing goes back to the model on its own
    await wait(3000)
    assert.deepEqual(model.results, [], 'no result before the person answers')
    await api('POST', `/questions/${encodeURIComponent(ask.eventId)}`, { answers: [{ id: 'dest', selected: [] }] }) // what Skip sends
    for (let i = 0; i < 150 && !model.answers.some((a) => a.text === 'No preference, then.'); i++) await wait(200)
    await idle()

    // what came back is DSH's skip shape, not a timeout
    assert.deepEqual(model.results.map((r) => JSON.parse(r)), [{ answers: [{ id: 'dest', selected: [] }] }])
    // and the tool the model was given says what that shape means
    const tools = (model.requests as { tools?: Tool[] }[]).flatMap((r) => r.tools ?? [])
    const ask_ = tools.find((t) => t.function.name === 'ask_user_question')
    assert.ok(ask_, 'the model had ask_user_question')
    assert.match(JSON.stringify(ask_), /empty selected and no custom/i, 'the model is told an empty selected is a skip')
    assert.match(JSON.stringify(ask_), /default -1\)/, 'and by default the question waits until the person answers')
  } finally {
    await new Promise<void>((r) => { bot.once('exit', () => r()); bot.kill('SIGTERM') })
    await model.close()
  }
})
