import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// "指哪打哪": with the real model, a project side chat gets a working program
// written, run, and reported — no refusals, no questions. Skipped unless
// DEEPSEEK_BOT_E2E_MODEL=1.
const run = process.env.DEEPSEEK_BOT_E2E_MODEL === '1'

async function startBot() {
  const home = mkdtempSync(join(tmpdir(), 'bot-code-'))
  const child: ChildProcess = spawn(process.execPath, ['src/main.ts', '--home', home, '--host', '127.0.0.1', '--port', '0', '--model', 'magpie/group/auto-deepseek-flash', '--base-url', 'http://127.0.0.1:3425/v1', '--api-key-env', 'DEEPSEEK_BOT_MODEL_KEY'], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, DEEPSEEK_BOT_MODEL_KEY: 'local' } })
  let out = ''
  const pairUrl = await new Promise<string>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`no pairing url:\n${out}`)), 90_000)
    child.stdout!.on('data', (d) => { out += d; const m = /(http:\/\/[^\s]+\/pair\?code=(\d{6}))/.exec(out); if (m) { clearTimeout(t); resolve(m[1]) } })
    child.stderr!.on('data', (d) => { out += d })
    child.on('exit', (c) => { clearTimeout(t); reject(new Error(`bot exited ${c}:\n${out}`)) })
  })
  for (let i = 0; i < 100 && !/listening to the assistant/.test(out); i++) await new Promise((r) => setTimeout(r, 200))
  return { home, origin: new URL(pairUrl).origin, code: new URL(pairUrl).searchParams.get('code')!, stop: () => new Promise<void>((r) => { child.once('exit', () => r()); child.kill('SIGTERM') }) }
}

test('a project side chat: the assistant writes, runs and reports a small program', { skip: !run, timeout: 400_000 }, async () => {
  const bot = await startBot()
  try {
    const { token } = await (await fetch(`${bot.origin}/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: bot.code, name: 'e2e' }) })).json() as { token: string }
    const h = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
    await fetch(`${bot.origin}/consent`, { method: 'PUT', headers: h, body: JSON.stringify({ ai: true, age: 'adult' }) }) // the person agreed to the AI provider (required since 1a602a4)
    await fetch(`${bot.origin}/settings`, { method: 'PUT', headers: h, body: JSON.stringify({ assistantName: 'Nori' }) })
    const t = await (await fetch(`${bot.origin}/threads`, { method: 'POST', headers: h, body: JSON.stringify({ project: 'hello-cli' }) })).json() as { sessionId: string; cwd: string }
    assert.ok(existsSync(t.cwd))
    // follow the thread with bot's own protocol over /events
    const { WebSocket } = await import('ws')
    const ws = new WebSocket(`${bot.origin.replace('http', 'ws')}/events`, ['bearer', token])
    const frames: { type: string; rows?: { kind: string; text?: string; name?: string }[]; running?: boolean }[] = []
    await new Promise<void>((r) => ws.on('open', () => r()))
    ws.on('message', (m) => frames.push(JSON.parse(m.toString())))
    ws.send(JSON.stringify({ type: 'follow', sessionId: t.sessionId }))
    const r = await fetch(`${bot.origin}/threads/${t.sessionId}/messages`, { method: 'POST', headers: h, body: JSON.stringify({ text: 'Create a Node.js script hello.js in this folder that prints "hello from " followed by the current year, run it with node, and reply with the exact output line. Do not ask me anything.' }) })
    assert.equal(r.status, 200)
    const end = Date.now() + 240_000
    while (Date.now() < end) {
      const idle = frames.some((f) => f.type === 'status' && f.running === false) && frames.filter((f) => f.type === 'status').at(-1)?.running === false
      if (idle && existsSync(join(t.cwd, 'hello.js'))) break
      await new Promise((x) => setTimeout(x, 1000))
    }
    ws.close()
    assert.ok(existsSync(join(t.cwd, 'hello.js')), 'hello.js written in the project folder')
    const src = readFileSync(join(t.cwd, 'hello.js'), 'utf8'); assert.match(src, /hello from/)
    const steps = frames.flatMap((f) => f.rows ?? []).filter((row) => row.kind === 'step').map((row) => row.name)
    assert.ok(steps.some((n) => n === 'bash'), `ran it: ${steps.join(',')}`)
    const texts = frames.flatMap((f) => f.rows ?? []).filter((row) => row.kind === 'them').map((row) => row.text ?? '')
    assert.ok(texts.some((x) => /hello from \d{4}/.test(x)), `reported the output: ${texts.slice(-2).join(' | ')}`)
  } finally { await bot.stop() }
})
