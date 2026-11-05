import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ThreadView } from './threadview.ts'

// Generative UI with the real model: asked for a comparison and a preference,
// the assistant uses `show` (a table with pick, or a table then a choices card) instead of prose,
// and reads the tap back. Skipped unless DEEPSEEK_BOT_E2E_MODEL=1.
const run = process.env.DEEPSEEK_BOT_E2E_MODEL === '1'

async function startBot() {
  const home = mkdtempSync(join(tmpdir(), 'bot-cards-'))
  const child: ChildProcess = spawn(process.execPath, ['src/main.ts', '--home', home, '--host', '127.0.0.1', '--port', '0', '--model', 'magpie/group/auto-deepseek-flash', '--base-url', 'http://127.0.0.1:3425/v1', '--api-key-env', 'DEEPSEEK_BOT_MODEL_KEY'], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, DEEPSEEK_BOT_MODEL_KEY: 'local' } })
  let out = ''
  const pairUrl = await new Promise<string>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`no pairing url:\n${out}`)), 90_000)
    child.stdout!.on('data', (d) => { out += d; const m = /(http:\/\/[^\s]+\/pair\?code=(\d{6}))/.exec(out); if (m) { clearTimeout(t); resolve(m[1]) } })
    child.stderr!.on('data', (d) => { out += d })
    child.on('exit', (c) => { clearTimeout(t); reject(new Error(`bot exited ${c}:\n${out}`)) })
  })
  for (let i = 0; i < 100 && !/listening to the assistant/.test(out); i++) await new Promise((r) => setTimeout(r, 200))
  return { home, origin: new URL(pairUrl).origin, code: new URL(pairUrl).searchParams.get('code')!, stop: () => new Promise<void>((r) => { child.once('exit', () => { rmSync(home, { recursive: true, force: true }); r() }); child.kill('SIGTERM') }) }
}

test('the assistant answers a comparison and a preference with cards (a table to pick from, or a table and choices), then reads the tap', { skip: !run, timeout: 400_000 }, async () => {
  const bot = await startBot()
  try {
    const { token } = await (await fetch(`${bot.origin}/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: bot.code, name: 'e2e' }) })).json() as { token: string }
    const h = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
    await fetch(`${bot.origin}/consent`, { method: 'PUT', headers: h, body: JSON.stringify({ ai: true, age: 'adult' }) }) // the person agreed to the AI provider (required since 1a602a4)
    await fetch(`${bot.origin}/settings`, { method: 'PUT', headers: h, body: JSON.stringify({ assistantName: 'Nori' }) })
    const t = await (await fetch(`${bot.origin}/threads`, { method: 'POST', headers: h, body: '{}' })).json() as { sessionId: string }
    const { WebSocket } = await import('ws')
    const ws = new WebSocket(`${bot.origin.replace('http', 'ws')}/events`, ['bearer', token])
    // this thread only (other sessions' status frames share the socket), applied the way the app applies frames
    const view = new ThreadView(t.sessionId)
    ws.on('message', (m) => view.apply(JSON.parse(m.toString())))
    await new Promise<void>((r) => ws.on('open', () => r()))
    ws.send(JSON.stringify({ type: 'follow', sessionId: t.sessionId }))
    const waitTurn = async (ms: number) => { const end = Date.now() + ms; while (Date.now() < end && !view.turnOver()) await new Promise((x) => setTimeout(x, 250)); assert.ok(view.turnOver(), `the turn ended within ${ms / 1000} s`) }

    const r1 = await fetch(`${bot.origin}/threads/${t.sessionId}/messages`, { method: 'POST', headers: h, body: JSON.stringify({ text: 'Three ways to get from Lisbon to Porto: train, bus, rental car. Compare typical duration and typical price. Do not browse the web; use what you know and mark it as approximate. Then ask me which one I prefer, and when I pick, name the option I picked in your reply.' }) })
    assert.equal(r1.status, 200)
    await waitTurn(180_000)
    const cards = view.rows().filter((r) => r.kind === 'card')
    assert.ok(cards.some((c) => c.card?.kind === 'table'), `a table card: ${JSON.stringify(view.rows().map((r) => [r.kind, r.card?.kind]))}`)
    // the preference is a choices card, or the table itself with pick (one card for compare + choose)
    const choice = cards.find((c) => c.card?.kind === 'choices') ?? cards.find((c) => c.card?.kind === 'table' && c.card.pick)
    assert.ok(choice, `a choices card or a table with pick: ${JSON.stringify(cards.map((c) => [c.card?.kind, c.card?.pick]))}`)
    const pick = choice!.card!.kind === 'choices' ? choice!.card!.options![0].label : choice!.card!.rows![0][0]
    console.log(`[e2e] ${choice!.card!.kind}${choice!.card!.pick ? '+pick' : ''} "${choice!.card!.title}"; tapping "${pick}"`)
    view.nextTurn()
    const r2 = await fetch(`${bot.origin}/threads/${t.sessionId}/messages`, { method: 'POST', headers: h, body: JSON.stringify({ text: pick, cardId: choice!.id }) })
    assert.equal(r2.status, 200)
    await waitTurn(120_000)
    ws.close()
    const after = view.rows()
    assert.equal(after.find((r) => r.id === choice!.id)?.answer, pick, 'the card shows the answer')
    const tap = after.findIndex((r) => r.kind === 'you' && r.text === pick)
    assert.ok(tap >= 0, 'the tap shows as the person')
    // the reply to the tap: what the assistant said after it. The prompt asks it to name the pick, so reading
    // the tap is checkable (2026-10-27 without that: "Good pick — it's the one that doesn't need a car", right but unnamed)
    const reply = after.slice(tap + 1).filter((r) => r.kind === 'them').map((r) => r.text ?? '').join('\n')
    console.log(`[e2e] reply after the tap: ${reply.slice(0, 200)}`)
    assert.ok(reply.toLowerCase().includes(pick.toLowerCase().split(' ')[0]), `the reply acknowledges "${pick}": ${reply.slice(-300)}`)
  } finally { await bot.stop() }
})
