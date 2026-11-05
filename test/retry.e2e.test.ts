import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// A model that is busy for a minute: six 429s in a row (more than DSH's default five retries, which
// gave up after ~20 s on SiliconFlow on 2026-10-27), then an answer. The turn must end with the answer.
// Needs only this machine. Skipped unless DEEPSEEK_BOT_E2E=1 or DEEPSEEK_BOT_E2E_MODEL=1 (it takes ~70 s).
const run = process.env.DEEPSEEK_BOT_E2E === '1' || process.env.DEEPSEEK_BOT_E2E_MODEL === '1'

test('a turn survives a model that answers 429 six times before it answers', { skip: !run, timeout: 300_000 }, async () => {
  let agentCalls = 0
  const model = createServer((req, res) => {
    let body = ''
    req.on('data', (d) => { body += d })
    req.on('end', () => {
      const r = JSON.parse(body || '{}') as { tools?: unknown[]; stream?: boolean }
      if (Array.isArray(r.tools) && r.tools.length && agentCalls++ < 6) { res.writeHead(429).end(); return }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const chunk = (c: object) => res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 0, model: 'busy', choices: [{ index: 0, ...c }] })}\n\n`)
      chunk({ delta: { role: 'assistant', content: 'BUSY-THEN-OK' }, finish_reason: null }); chunk({ delta: {}, finish_reason: 'stop' })
      res.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>((r) => model.listen(0, '127.0.0.1', () => r()))
  const port = (model.address() as { port: number }).port
  const home = mkdtempSync(join(tmpdir(), 'bot-retry-'))
  const bot: ChildProcess = spawn(process.execPath, ['src/main.ts', '--home', home, '--host', '127.0.0.1', '--port', '0', '--model', 'busy/busy-model', '--base-url', `http://127.0.0.1:${port}/v1`, '--api-key-env', 'DEEPSEEK_BOT_MODEL_KEY'], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, DEEPSEEK_BOT_MODEL_KEY: 'local' } })
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
    await fetch(`${u.origin}/consent`, { method: 'PUT', headers: h, body: JSON.stringify({ ai: true, age: 'adult' }) }) // the person agreed to the AI provider
    const t = await (await fetch(`${u.origin}/threads`, { method: 'POST', headers: h, body: JSON.stringify({}) })).json() as { sessionId: string }
    const { WebSocket } = await import('ws')
    const ws = new WebSocket(`${u.origin.replace('http', 'ws')}/events`, ['bearer', token])
    const frames: { rows?: { kind: string; text?: string }[] }[] = []
    await new Promise<void>((r) => ws.on('open', () => r()))
    ws.on('message', (m) => frames.push(JSON.parse(m.toString())))
    ws.send(JSON.stringify({ type: 'follow', sessionId: t.sessionId }))
    assert.equal((await fetch(`${u.origin}/threads/${t.sessionId}/messages`, { method: 'POST', headers: h, body: JSON.stringify({ text: 'hi' }) })).status, 200)
    const texts = () => frames.flatMap((f) => f.rows ?? []).filter((r) => r.kind === 'them').map((r) => r.text ?? '')
    const end = Date.now() + 240_000
    while (Date.now() < end && !texts().some((x) => x.includes('BUSY-THEN-OK'))) await new Promise((r) => setTimeout(r, 1000))
    ws.close()
    assert.ok(agentCalls >= 7, `the model was asked ${agentCalls} times`)
    assert.ok(texts().some((x) => x.includes('BUSY-THEN-OK')), `the answer arrived: ${texts().slice(-2).join(' | ')}`)
  } finally {
    await new Promise<void>((r) => { bot.once('exit', () => r()); bot.kill('SIGTERM') })
    model.close()
  }
})
