import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { openHome } from '../src/home.ts'
import { startDshWeb } from '../src/dsh.ts'
import { rpc, Mux, sessionAddress } from '../src/dshclient.ts'

// Real dsh + real model through the local Magpie gateway (http://127.0.0.1:3425/v1,
// measured 2026-10-26: answers without a key from loopback). Skipped unless
// DEEPSEEK_BOT_E2E_MODEL=1 so CI without a model does not fail.
const run = process.env.DEEPSEEK_BOT_E2E_MODEL === '1'

test('a prompt through dsh reaches the model and an assistant message comes back on session/follow', { skip: !run, timeout: 180_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'bot-e2e-'))
  const home = await openHome(root, { model: { provider: 'magpie', model: 'group/auto-deepseek-flash', baseURL: 'http://127.0.0.1:3425/v1', apiKeyEnv: 'DEEPSEEK_BOT_MODEL_KEY' } })
  const dsh = await startDshWeb({ dshHome: home.dshHome, env: { ...process.env, DEEPSEEK_BOT_MODEL_KEY: process.env.DEEPSEEK_BOT_MODEL_KEY ?? 'local' } })
  const t = { origin: dsh.origin, cookie: dsh.cookie }
  try {
    const created = await rpc<{ sessionId: string }>(t, 'session/create', { request: { cwd: home.workspace } })
    assert.ok(created.sessionId)
    const mux = new Mux(t)
    const follow = await mux.open('session/follow', { request: { address: sessionAddress(created.sessionId), assistantStream: true } })
    const accepted = await rpc<{ accepted: true }>(t, 'session/prompt', { request: { requestId: randomUUID(), sessionId: created.sessionId, mode: 'queue', content: [{ type: 'text', text: 'Reply with exactly the word PONG and nothing else.' }] } })
    assert.equal(accepted.accepted, true)
    let text = ''
    const seen: string[] = []
    for await (const frame of follow) {
      const f = frame as { type: string; event?: { type: string; data?: { message?: { content?: { type: string; text?: string }[] } } } }
      seen.push(f.type === 'event' ? `event:${f.event!.type}` : f.type)
      if (f.type === 'event' && f.event!.type === 'assistant/message') {
        text = (f.event!.data?.message?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('')
      }
      if (f.type === 'event' && f.event!.type === 'turn/end') break
    }
    follow.cancel(); mux.close()
    assert.ok(seen.includes('snapshot'), `first frame is the snapshot: ${seen.join(',')}`)
    assert.match(text, /PONG/i, `assistant said: ${JSON.stringify(text)} frames: ${seen.join(',')}`)
  } finally { await dsh.stop() }
})
