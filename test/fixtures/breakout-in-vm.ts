// The breakout probes, run inside one VM (a throwaway Fly Machine) instead of
// Docker: starts the scripted model and the bot side by side, pairs, sends one
// message, and prints every probe's result as one JSON line prefixed
// BREAKOUT-RESULTS. The probes and the scripted model are the same ones
// test/containment.e2e.test.ts uses. Run as root from /opt/deepseek-bot:
//   node test/fixtures/breakout-in-vm.ts
import { spawn } from 'node:child_process'
import { startScriptedModel } from './scripted-model.ts'
import { BROWSER_SENTINEL, PROBES, SENTINEL } from './breakout-probes.ts'
import { writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const model = await startScriptedModel(PROBES.map((p) => p.call), '127.0.0.1')
const port = 3850
const bot = spawn(process.execPath, ['src/main.ts', '--host', '127.0.0.1', '--port', String(port), '--model', 'scripted/scripted', '--base-url', model.url, '--api-key-env', 'DEEPSEEK_BOT_MODEL_KEY'], {
  env: { ...process.env, DEEPSEEK_BOT_MODEL_KEY: `${SENTINEL}-model`, DEEPSEEK_BOT_HOST_SECRET: `${SENTINEL}-host`, DEEPSEEK_BOT_WORKSPACE_BYTES: '134217728' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let out = ''
bot.stdout!.on('data', (d) => { out += d }); bot.stderr!.on('data', (d) => { out += d })
let code = ''
for (let i = 0; i < 600 && !code; i++) { const m = /pair\?code=(\d{6})/.exec(out); if (m) code = m[1]; else await new Promise((r) => setTimeout(r, 300)) }
if (!code) { console.log('BREAKOUT-ERROR no pairing code'); console.log(out.slice(-3000)); process.exit(1) }
for (let i = 0; i < 200 && !/listening to the assistant/.test(out); i++) await new Promise((r) => setTimeout(r, 300))
const origin = `http://127.0.0.1:${port}`
writeFileSync('/data/dsh/browser-probe.txt', `${BROWSER_SENTINEL}\n`)
const { token } = await (await fetch(`${origin}/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, name: 'redteam' }) })).json() as { token: string }
const h = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
// [compliance] nothing reaches the model before the person (18+) agreed to its provider
const consent = await fetch(`${origin}/consent`, { method: 'PUT', headers: h, body: JSON.stringify({ age: 'adult', ai: true }) })
if (consent.status !== 200) { console.log(`BREAKOUT-ERROR consent ${consent.status} ${await consent.text()}`); process.exit(1) }
const t = await (await fetch(`${origin}/threads`, { method: 'POST', headers: h, body: JSON.stringify({ project: 'redteam' }) })).json() as { sessionId: string }
const sent = await fetch(`${origin}/threads/${t.sessionId}/messages`, { method: 'POST', headers: h, body: JSON.stringify({ text: 'go' }) })
if (sent.status !== 200) { console.log(`BREAKOUT-ERROR send ${sent.status} ${await sent.text()}`); process.exit(1) }
const end = Date.now() + 300_000
while (Date.now() < end && model.results.length < PROBES.length) {
  try {
    const asks = await (await fetch(`${origin}/approvals`, { headers: h })).json() as { eventId: string }[]
    for (const a of asks) await fetch(`${origin}/approvals/${a.eventId}`, { method: 'POST', headers: h, body: JSON.stringify({ outcome: 'rejected' }) })
  } catch { /* restarting */ }
  await new Promise((x) => setTimeout(x, 500))
}
const results: Record<string, string> = {}
PROBES.forEach((p, i) => { results[p.id] = model.results[i] ?? '(no result)' })
const first = model.requests.find((x) => Array.isArray((x as { tools?: unknown[] }).tools) && (x as { tools?: unknown[] }).tools!.length) as { tools?: { function?: { name?: string } }[] } | undefined
const tools = (first?.tools ?? []).map((x) => x.function?.name ?? '').filter(Boolean)
// one more message after the probes: the bot must still answer
const again = await fetch(`${origin}/threads/${t.sessionId}/messages`, { method: 'POST', headers: h, body: JSON.stringify({ text: 'still there?' }) }).then((r) => r.status).catch(() => 0)
let oom = ''
try { oom = execFileSync('dmesg', [], { encoding: 'utf8' }).split('\n').filter((l) => /Memory cgroup out of memory|oom-kill|Killed process/.test(l)).slice(-8).join('\n') } catch (e) { oom = `dmesg unavailable: ${(e as Error).message}` }
console.log('BREAKOUT-RESULTS ' + JSON.stringify({ results, tools, again, kernel: (await import('node:os')).release(), oom }))
bot.kill('SIGTERM'); await model.close()
setTimeout(() => process.exit(0), 2000)
