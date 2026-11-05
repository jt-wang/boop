import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Real bot (dsh + the local Magpie gateway as the cheap model): does POST /ideas/refresh
// come back with three usable ideas? Skipped unless DEEPSEEK_BOT_E2E_MODEL=1.
const run = process.env.DEEPSEEK_BOT_E2E_MODEL === '1'

async function startBot(): Promise<{ home: string; origin: string; code: string; stop(): Promise<void> }> {
  const home = mkdtempSync(join(tmpdir(), 'bot-ideas-'))
  const child: ChildProcess = spawn(process.execPath, ['src/main.ts', '--home', home, '--host', '127.0.0.1', '--port', '0', '--model', 'magpie/group/auto-deepseek-flash', '--base-url', 'http://127.0.0.1:3425/v1', '--api-key-env', 'DEEPSEEK_BOT_MODEL_KEY'], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, DEEPSEEK_BOT_MODEL_KEY: 'local' } })
  let out = ''
  const pairUrl = await new Promise<string>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`no pairing url:\n${out}`)), 90_000)
    child.stdout!.on('data', (d) => { out += d; const m = /(http:\/\/[^\s]+\/pair\?code=(\d{6}))/.exec(out); if (m) { clearTimeout(t); resolve(m[1]) } })
    child.stderr!.on('data', (d) => { out += d })
    child.on('exit', (c) => { clearTimeout(t); reject(new Error(`bot exited ${c}:\n${out}`)) })
  })
  return { home, origin: new URL(pairUrl).origin, code: new URL(pairUrl).searchParams.get('code')!, stop: () => new Promise((r) => { child.once('exit', () => r()); child.kill('SIGTERM') }) }
}

test('POST /ideas/refresh with the real model returns 3 ideas with titles and one-tap actions; dismiss hides one', { skip: !run, timeout: 240_000 }, async () => {
  const bot = await startBot()
  try {
    const { token } = await (await fetch(`${bot.origin}/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: bot.code, name: 'e2e' }) })).json() as { token: string }
    const h = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
    await fetch(`${bot.origin}/consent`, { method: 'PUT', headers: h, body: JSON.stringify({ ai: true, age: 'adult' }) }) // the person agreed to the AI provider (required since 1a602a4)
    await fetch(`${bot.origin}/settings`, { method: 'PUT', headers: h, body: JSON.stringify({ assistantName: 'Nori', timeZone: 'America/New_York' }) })
    // Some notes to work from (fake person).
    await fetch(`${bot.origin}/files/USER.md`, { method: 'PUT', headers: { ...h, 'content-type': 'text/plain' }, body: '# USER.md\n\n- 2026-10-20 Name is Kai, lives in Lisbon, replies in English\n- 2026-10-21 Prefers oat milk in coffee\n- 2026-10-22 Runs three mornings a week\n' })
    await fetch(`${bot.origin}/files/MEMORY.md`, { method: 'PUT', headers: { ...h, 'content-type': 'text/plain' }, body: '# MEMORY.md\n\n- 2026-10-23 Wants to run 10 km by January\n- 2026-10-25 Dentist check-up is overdue since September\n- 2026-10-26 Flying to Porto on 2026-11-14 for a friend\'s wedding\n' })

    const t0 = Date.now()
    const r = await fetch(`${bot.origin}/ideas/refresh`, { method: 'POST', headers: h })
    const raw = await r.text()
    assert.equal(r.status, 200, raw)
    const ideas = JSON.parse(raw) as { id: string; title: string; body: string; action: string; dismissed: boolean }[]
    console.log(`[ideas e2e] ${ideas.length} ideas in ${Math.round((Date.now() - t0) / 1000)}s:`, ideas.map((i) => `${i.title} → ${i.action}`))
    assert.equal(ideas.length, 3)
    for (const i of ideas) { assert.ok(i.id); assert.ok(i.title.trim().length > 0, 'title'); assert.ok(i.action.trim().length > 0, 'action'); assert.equal(i.dismissed, false) }
    assert.equal(new Set(ideas.map((i) => i.title)).size, 3, 'three different titles')

    const list = await (await fetch(`${bot.origin}/ideas`, { headers: h })).json() as { id: string }[]
    assert.deepEqual(list.map((i) => i.id), ideas.map((i) => i.id))
    assert.equal((await fetch(`${bot.origin}/ideas/${ideas[0].id}/dismiss`, { method: 'POST', headers: h })).status, 200)
    assert.equal(((await (await fetch(`${bot.origin}/ideas`, { headers: h })).json()) as unknown[]).length, 2)
    const activity = await (await fetch(`${bot.origin}/activity`, { headers: h })).json() as { kind: string; text: string }[]
    assert.ok(activity.some((a) => a.kind === 'ideas' && /3 new ideas/.test(a.text)), JSON.stringify(activity))
  } finally { await bot.stop() }
})
