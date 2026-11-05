import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { ThreadView } from './threadview.ts'

// The real bot and a real model: DEEPSEEK_BOT_LIVE_BASE_URL (OpenAI-compatible) and DEEPSEEK_BOT_LIVE_MODEL (`provider/model`).
// English in, English out, what it remembers included; Chinese in, Chinese out. One run cannot prove the rate:
// test/reply-language.test.ts holds the cause.
const BASE = process.env.DEEPSEEK_BOT_LIVE_BASE_URL
const MODEL = process.env.DEEPSEEK_BOT_LIVE_MODEL ?? 'magpie/group/auto-deepseek-flash'
const CJK = /[㐀-鿿]/

const freePort = () => new Promise<number>((resolve) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address() as { port: number }; s.close(() => resolve(port)) }) })

async function ask(text: string) {
  const port = await freePort()
  const home = mkdtempSync(join(tmpdir(), 'reply-lang-live-'))
  const hostSecret = randomBytes(24).toString('hex')
  const bot = spawn(process.execPath, ['src/main.ts', '--home', home, '--host', '127.0.0.1', '--port', String(port), '--model', MODEL, '--base-url', BASE!, '--api-key-env', 'DEEPSEEK_BOT_MODEL_KEY'], { env: { ...process.env, DEEPSEEK_BOT_MODEL_KEY: process.env.DEEPSEEK_BOT_MODEL_KEY ?? 'unused', DEEPSEEK_BOT_HOST_SECRET: hostSecret }, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  bot.stdout.on('data', (d) => { out += d }); bot.stderr.on('data', (d) => { out += d })
  try {
    for (let i = 0; i < 300 && !/listening to the assistant/.test(out); i++) await new Promise((r) => setTimeout(r, 200))
    const origin = `http://127.0.0.1:${port}`
    const { token } = await (await fetch(`${origin}/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostSecret, name: 'live' }) })).json() as { token: string }
    const h = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
    await fetch(`${origin}/consent`, { method: 'PUT', headers: h, body: JSON.stringify({ ai: true, age: 'adult' }) })
    const t = await (await fetch(`${origin}/threads`, { method: 'POST', headers: h, body: JSON.stringify({}) })).json() as { sessionId: string }
    await fetch(`${origin}/threads/${t.sessionId}/messages`, { method: 'POST', headers: h, body: JSON.stringify({ text, timeZone: 'America/Los_Angeles' }) })
    for (let i = 0; i < 240; i++) {
      await new Promise((r) => setTimeout(r, 1000))
      const list = await (await fetch(`${origin}/threads`, { headers: h })).json() as { sessionId: string; running: boolean }[]
      if (i > 3 && !list.find((x) => x.sessionId === t.sessionId)?.running) break
    }
    const view = new ThreadView(t.sessionId)
    const ws = new WebSocket(`${origin.replace('http', 'ws')}/events`, ['bearer', token])
    ws.on('message', (raw) => view.apply(JSON.parse(raw.toString()) as never))
    await new Promise<void>((r) => ws.on('open', () => { ws.send(JSON.stringify({ type: 'follow', sessionId: t.sessionId, lang: 'en' })); r() }))
    for (let i = 0; i < 50 && !view.rows().some((r) => r.kind === 'them'); i++) await new Promise((r) => setTimeout(r, 200))
    ws.close()
    const replies = view.rows().filter((r) => r.kind === 'them').map((r) => r.text ?? '').join('\n')
    const remembered = readFileSync(join(home, 'workspace', 'USER.md'), 'utf8') + readFileSync(join(home, 'workspace', 'MEMORY.md'), 'utf8')
    return { replies, remembered }
  } finally { bot.kill('SIGTERM') }
}

test('English in, English out, and it remembers in English', { skip: !BASE, timeout: 300_000 }, async () => {
  const r = await ask('Remember that I am vegetarian, and give me one dinner idea in one sentence.')
  assert.ok(r.replies.length > 0)
  assert.equal(CJK.exec(r.replies)?.[0], undefined, r.replies)
  assert.equal(CJK.exec(r.remembered)?.[0], undefined, r.remembered)
  assert.match(r.remembered, /vegetarian/i, 'it saved the fact')
})

test('Chinese in, Chinese out', { skip: !BASE, timeout: 300_000 }, async () => {
  const r = await ask('记住我吃素，再用一句话给我一个晚餐主意。')
  assert.match(r.replies, CJK)
  assert.match(r.remembered, /素/, 'and saved the fact in Chinese')
})
