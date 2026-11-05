import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

// The whole reminder loop with a real model: ask in chat → tool creates the
// task → bot fires it → the assistant answers in the main thread. The push that
// follows is test/push.e2e.test.ts (through the host relay, with a scripted model).
// Skipped unless DEEPSEEK_BOT_E2E_MODEL=1. Takes ~2 minutes.
const run = process.env.DEEPSEEK_BOT_E2E_MODEL === '1'

async function startBot() {
  const home = mkdtempSync(join(tmpdir(), 'bot-rem-'))
  const child: ChildProcess = spawn(process.execPath, ['src/main.ts', '--home', home, '--host', '127.0.0.1', '--port', '0', '--model', 'magpie/group/auto-deepseek-flash', '--base-url', 'http://127.0.0.1:3425/v1', '--api-key-env', 'DEEPSEEK_BOT_MODEL_KEY'], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, DEEPSEEK_BOT_MODEL_KEY: 'local', DEEPSEEK_BOT_DEBUG: '1' } })
  let out = ''
  const pairUrl = await new Promise<string>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`no pairing url:\n${out}`)), 90_000)
    child.stdout!.on('data', (d) => { out += d; const m = /(http:\/\/[^\s]+\/pair\?code=(\d{6}))/.exec(out); if (m) { clearTimeout(t); resolve(m[1]) } })
    child.stderr!.on('data', (d) => { out += d })
    child.on('exit', (c) => { clearTimeout(t); reject(new Error(`bot exited ${c}:\n${out}`)) })
  })
  for (let i = 0; i < 100 && !/listening to the assistant/.test(out); i++) await new Promise((r) => setTimeout(r, 200))
  return { home, origin: new URL(pairUrl).origin, code: new URL(pairUrl).searchParams.get('code')!, log: () => out, stop: () => new Promise<void>((r) => { child.once('exit', () => r()); child.kill('SIGTERM') }) }
}

async function until(fn: () => Promise<boolean>, ms: number, what: string) {
  const end = Date.now() + ms
  while (Date.now() < end) { if (await fn()) return; await new Promise((r) => setTimeout(r, 2000)) }
  throw new Error(`timed out waiting for ${what}`)
}

test('a reminder asked for in chat fires and the assistant answers it in the main thread', { skip: !run, timeout: 400_000 }, async () => {
  const bot = await startBot()
  try {
    const { token } = await (await fetch(`${bot.origin}/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: bot.code, name: 'e2e' }) })).json() as { token: string }
    const h = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
    await fetch(`${bot.origin}/settings`, { method: 'PUT', headers: h, body: JSON.stringify({ assistantName: 'Nori' }) })
    assert.equal((await fetch(`${bot.origin}/consent`, { method: 'PUT', headers: h, body: JSON.stringify({ ai: true, age: 'adult' }) })).status, 200) // the person agreed to the AI provider; without it /sessions/main is 403
    const { sessionId } = await (await fetch(`${bot.origin}/sessions/main`, { method: 'POST', headers: h })).json() as { sessionId: string }
    const at = new Date(Date.now() + 65_000).toISOString()
    await fetch(`${bot.origin}/api/session/prompt`, { method: 'POST', headers: h, body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: 'session/prompt', payload: { args: { request: { requestId: randomUUID(), sessionId, mode: 'queue', content: [{ type: 'text', text: `Create a one-time reminder named "Water" at exactly ${at} (ISO instant) with the instruction "Tell me to drink a glass of water, in one short line". Do not ask me anything; just create it and confirm in one line.` }] } } } }) })
    const getJson = async (path: string): Promise<unknown> => { const r = await fetch(bot.origin + path, { headers: h }); return r.json() }
    await until(async () => { const list = (await getJson('/schedules')) as unknown[]; return list.length > 0 }, 90_000, 'the reminder to be created')
    await until(async () => { const a = (await getJson('/activity')) as { kind: string; text: string }[]; return a.some((x) => x.kind === 'schedule' && /fired/i.test(x.text)) }, 150_000, 'the reminder to fire')
    const tasks = (await getJson('/schedules')) as { active: boolean; lastRunAt?: string }[]
    assert.equal(tasks[0].active, false); assert.ok(tasks[0].lastRunAt)
    // The assistant answered the injected reminder in the main thread.
    type ListEnv = { result: { value: { items: { sessionId: string; projections?: { values?: { turnOutline?: { response?: string }[] } } }[] } } }
    const turns = async () => {
      const r = await fetch(`${bot.origin}/api/session/list`, { method: 'POST', headers: h, body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: 'session/list', payload: { args: { _request: {} } } }) })
      const v = (await r.json()) as ListEnv
      const main = v.result.value.items.find((s) => s.sessionId === sessionId)
      return main?.projections?.values?.turnOutline?.length ?? 0
    }
    await until(async () => (await turns()) >= 2, 90_000, 'the assistant to answer the reminder')
    assert.match(readFileSync(join(bot.home, 'activity.json'), 'utf8'), /Reminder fired: Water/)
  } finally { if (process.env.E2E_LOG) console.log(bot.log()); await bot.stop() }
})
