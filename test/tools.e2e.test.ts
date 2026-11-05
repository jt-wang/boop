import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

// Real dsh + real model: does the assistant actually call the bot's MCP tools?
// Skipped unless DEEPSEEK_BOT_E2E_MODEL=1 (needs the local model gateway).
const run = process.env.DEEPSEEK_BOT_E2E_MODEL === '1'

async function startBot(): Promise<{ home: string; origin: string; code: string; stop(): Promise<void> }> {
  const home = mkdtempSync(join(tmpdir(), 'bot-tools-'))
  const child: ChildProcess = spawn(process.execPath, ['src/main.ts', '--home', home, '--host', '127.0.0.1', '--port', '0', '--model', 'magpie/group/auto-deepseek-flash', '--base-url', 'http://127.0.0.1:3425/v1', '--api-key-env', 'DEEPSEEK_BOT_MODEL_KEY'], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, DEEPSEEK_BOT_MODEL_KEY: 'local' } })
  let out = ''
  const pairUrl = await new Promise<string>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`no pairing url:\n${out}`)), 90_000)
    child.stdout!.on('data', (d) => { out += d; const m = /(http:\/\/[^\s]+\/pair\?code=(\d{6}))/.exec(out); if (m) { clearTimeout(t); resolve(m[1]) } })
    child.stderr!.on('data', (d) => { out += d })
    child.on('exit', (c) => { clearTimeout(t); reject(new Error(`bot exited ${c}:\n${out}`)) })
  })
  // wait for the watcher to attach, so dsh is fully up
  for (let i = 0; i < 100 && !/listening to the assistant/.test(out); i++) await new Promise((r) => setTimeout(r, 200))
  return { home, origin: new URL(pairUrl).origin, code: new URL(pairUrl).searchParams.get('code')!, stop: () => new Promise((r) => { child.once('exit', () => r()); child.kill('SIGTERM') }) }
}

async function ask(origin: string, token: string, sessionId: string, text: string) {
  const r = await fetch(`${origin}/api/session/prompt`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: 'session/prompt', payload: { args: { request: { requestId: randomUUID(), sessionId, mode: 'queue', content: [{ type: 'text', text }] } } } }) })
  assert.equal(r.status, 200)
}

async function until(fn: () => boolean | Promise<boolean>, ms: number, what: string) {
  const end = Date.now() + ms
  while (Date.now() < end) { if (await fn()) return; await new Promise((r) => setTimeout(r, 1000)) }
  throw new Error(`timed out waiting for ${what}`)
}

test('the assistant calls remember and schedule_create through MCP', { skip: !run, timeout: 300_000 }, async () => {
  const bot = await startBot()
  try {
    const { token } = await (await fetch(`${bot.origin}/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: bot.code, name: 'e2e' }) })).json() as { token: string }
    const h = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
    await fetch(`${bot.origin}/consent`, { method: 'PUT', headers: h, body: JSON.stringify({ ai: true, age: 'adult' }) }) // the person agreed to the AI provider (required since 1a602a4)
    await fetch(`${bot.origin}/settings`, { method: 'PUT', headers: h, body: JSON.stringify({ assistantName: 'Nori' }) })
    const { sessionId } = await (await fetch(`${bot.origin}/sessions/main`, { method: 'POST', headers: h })).json() as { sessionId: string }

    await ask(bot.origin, token, sessionId, 'Please remember that I take oat milk in my coffee. Then reply with just OK.')
    await until(() => /oat milk/i.test(readFileSync(join(bot.home, 'workspace', 'USER.md'), 'utf8') + readFileSync(join(bot.home, 'workspace', 'MEMORY.md'), 'utf8')), 120_000, 'the fact to land in a memory file')
    const activity = await (await fetch(`${bot.origin}/activity`, { headers: h })).json() as { kind: string; text: string }[]
    assert.ok(activity.some((a) => a.kind === 'memory' && /oat milk/i.test(a.text)), JSON.stringify(activity))

    await ask(bot.origin, token, sessionId, 'Set a reminder named "Stretch" for 10 minutes from now that says "Stand up and stretch". My time zone is America/New_York. Confirm in one line.')
    await until(async () => ((await (await fetch(`${bot.origin}/schedules`, { headers: h })).json()) as unknown[]).length > 0, 120_000, 'a schedule to be created')
    const tasks = await (await fetch(`${bot.origin}/schedules`, { headers: h })).json() as { name: string; nextRunAt: string; active: boolean }[]
    assert.equal(tasks.length, 1); assert.match(tasks[0].name, /stretch/i); assert.equal(tasks[0].active, true)
    const delta = Date.parse(tasks[0].nextRunAt) - Date.now()
    assert.ok(delta > 5 * 60_000 && delta < 15 * 60_000, `next run in ${Math.round(delta / 1000)}s`)
  } finally { await bot.stop() }
})
