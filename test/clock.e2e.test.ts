// The assistant knows what time it is without running a command. On the Android pass of 2026-10-29
// 「现在几点？一句话。」 at 19:14 got 「现在 19:25，周四。」 with no tool call: the model guessed. DSH's own
// clock (`@deepseek-ai/dsh-time-context`) adds a reading to the model's request at each step, in the zone the request
// carries (`clientTimeZone` on session/prompt, as DSH's Web UI sends it). Real dsh, scripted model.
// Run: DEEPSEEK_BOT_E2E=1 node --test test/clock.e2e.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { openHome } from '../src/home.ts'
import { startDshWeb } from '../src/dsh.ts'
import { rpc } from '../src/dshclient.ts'
import { startScriptedModel } from './fixtures/scripted-model.ts'

test('a message carries the person\'s zone and the model gets the current time in it', { skip: process.env.DEEPSEEK_BOT_E2E !== '1', timeout: 120_000 }, async () => {
  const model = await startScriptedModel([{ text: 'It is evening.' }])
  const root = mkdtempSync(join(tmpdir(), 'bot-clock-'))
  const home = await openHome(root, { model: { provider: 'scripted', model: 'scripted', baseURL: model.url, apiKeyEnv: 'DEEPSEEK_BOT_MODEL_KEY' }, person: { timeZone: 'America/New_York' } })
  const dsh = await startDshWeb({ dshHome: home.dshHome, env: { ...process.env, DEEPSEEK_BOT_MODEL_KEY: 'local' }, timeoutMs: 60_000 })
  try {
    const t = { origin: dsh.origin, cookie: dsh.cookie }
    const { sessionId } = await rpc<{ sessionId: string }>(t, 'session/create', { request: { cwd: home.workspace } })
    const before = Date.now()
    await rpc(t, 'session/prompt', { request: { requestId: randomUUID(), sessionId, mode: 'queue', content: [{ type: 'text', text: '现在里斯本几点？' }], clientTimeZone: 'America/New_York' } })
    for (let i = 0; i < 120 && !model.answers.length; i++) await new Promise((r) => setTimeout(r, 500))
    // the agent's request (DSH also asks the model for a thread title)
    const sent = model.requests.map((r) => JSON.stringify(r)).filter((r) => !r.includes('Create a concise title')).at(-1) ?? ''
    const reading = /Time sampled while preparing turn \d+, step \d+: (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2})\[America\/New_York\]/.exec(sent)
    assert.ok(reading, `the model's request has a clock reading in that zone's time: ${sent.slice(0, 600)}`)
    assert.ok(Math.abs(Date.parse(reading![1]) - before) < 60_000, `the reading is the current time: ${reading![1]}`)
    assert.match(sent, /Browser time zone for this request: America\/New_York\./, 'the zone is the one the message carried')
    assert.doesNotMatch(sent, /Ask the user to clarify/, 'the model is not told to ask for the zone')
  } finally {
    await dsh.stop()
    await model.close()
  }
})
