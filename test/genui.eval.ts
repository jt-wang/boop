import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ThreadView } from './threadview.ts'

// How often does the assistant answer an ordinary ask with an interface (a
// `show` card or a `ui` module) instead of prose?
// Fifteen consumer asks, Chinese and English, each on a fresh thread; for each
// one: did a card/module row appear, which kind, seconds to idle, text length.
// Prints a table and the rate.
//
//   DEEPSEEK_BOT_E2E_MODEL=1 node --test test/genui.eval.ts
//   DEEPSEEK_BOT_GENUI_OUT=/path/results.json   also write the per-ask results
//   DEEPSEEK_BOT_GENUI_CONCURRENCY=1            threads in flight at once (default 1, so seconds are not
//                                               slowed by other turns; 3 at once also works)
//   DEEPSEEK_BOT_GENUI_MIN=0.75                 fail below this rate (default: never)
//   DEEPSEEK_BOT_GENUI_ONLY=tip,quiz            run a subset
//
// Not a pass/fail gate by default: the model is stochastic and the point is the
// number, not a green tick. The one hard assertion is that every ask got a reply.
const run = process.env.DEEPSEEK_BOT_E2E_MODEL === '1'
const MODEL = process.env.DEEPSEEK_BOT_GENUI_MODEL ?? 'magpie/group/auto-deepseek-flash'
const BASE_URL = process.env.DEEPSEEK_BOT_GENUI_BASE_URL ?? 'http://127.0.0.1:3425/v1'

export const ASKS: { id: string; text: string; want: string }[] = [
  { id: 'lisbon-porto', text: '帮我比较里斯本到波尔图的三种去法', want: 'table' },
  { id: 'week-plan', text: 'plan my week: gym Mon/Wed/Fri, dentist Thu 3pm, call mom', want: 'table/progress/module' },
  { id: 'laptops', text: 'which of these three laptops should I buy: MacBook Air M3 13" (€164,800, 1.24 kg, 18 h battery), ThinkPad X1 Carbon Gen 12 (€219,000, 1.12 kg, 12 h), Dell XPS 13 (€189,000, 1.19 kg, 14 h)? I mostly write and travel.', want: 'table + choices' },
  { id: 'packing', text: 'set up a packing list for a 3-day trip to Norway in November', want: 'checklist' },
  { id: 'bill-split', text: 'split this dinner bill among four people, I paid: €18,400 total, Ken had two extra beers (€1,200)', want: 'summary/table' },
  { id: 'water', text: 'remind me every weekday at 8 to drink water', want: 'confirm' },
  { id: 'cook', text: 'what should I cook tonight with eggs, tomatoes, rice', want: 'choices/module' },
  { id: 'running', text: 'track my running this week — I did 5 km Monday and 7 km today', want: 'progress/summary/module' },
  { id: 'convert', text: 'convert 180 USD to GBP and EUR', want: 'summary/table' },
  { id: 'email-tone', text: 'draft a reply to this email and let me pick the tone: "Hi, we noticed your invoice #4471 is 20 days overdue. Please advise on payment timing. — Dana"', want: 'choices' },
  { id: 'tip', text: '帮我算小费，账单 €8,600，想试几个比例', want: 'module' },
  { id: 'quiz', text: 'give me a 5-question quiz on world capitals', want: 'module/choices' },
  // 2026-11-02: the owner's own asks, where the per-kind mapping made a trip plan a plain table
  { id: 'evora', text: '下个月我们三个人去埃武拉两天一夜，每人预算三百欧元，帮我排个行程', want: 'module' },
  { id: 'price', text: 'AirPods Pro 3 在葡萄牙哪里买最便宜？帮我比一下', want: 'table + choices' },
  { id: 'study', text: '帮我做一个四周的日语 N3 备考计划，每天能学一小时', want: 'module/progress' },
]

export type AskResult = { id: string; sessionId: string; text: string; ui: boolean; kinds: string[]; seconds: number; timedOut: boolean; waitingOn: string[]; textLength: number; replied: boolean; uiErrors: number; rows: string[]; notices: string[]; cards: unknown[]; reply: string }

async function startBot() {
  const home = mkdtempSync(join(tmpdir(), 'bot-genui-'))
  const child: ChildProcess = spawn(process.execPath, ['src/main.ts', '--home', home, '--host', '127.0.0.1', '--port', '0', '--model', MODEL, '--base-url', BASE_URL, '--api-key-env', 'DEEPSEEK_BOT_MODEL_KEY'], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, DEEPSEEK_BOT_MODEL_KEY: process.env.DEEPSEEK_BOT_MODEL_KEY ?? 'local' } })
  let out = ''
  const pairUrl = await new Promise<string>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`no pairing url:\n${out}`)), 90_000)
    child.stdout!.on('data', (d) => { out += d; const m = /(http:\/\/[^\s]+\/pair\?code=(\d{6}))/.exec(out); if (m) { clearTimeout(t); resolve(m[1]) } })
    child.stderr!.on('data', (d) => { out += d })
    child.on('exit', (c) => { clearTimeout(t); reject(new Error(`bot exited ${c}:\n${out}`)) })
  })
  for (let i = 0; i < 100 && !/listening to the assistant/.test(out); i++) await new Promise((r) => setTimeout(r, 200))
  const u = new URL(pairUrl); u.hostname = '127.0.0.1'
  // stop also deletes the bot home (sessions, signed modules): repeated runs must not fill the disk
  // DEEPSEEK_BOT_GENUI_KEEP=1 keeps it (session files to look into), and the bot log next to it
  const keep = process.env.DEEPSEEK_BOT_GENUI_KEEP === '1'
  return { home, origin: u.origin, code: u.searchParams.get('code')!, log: () => out, stop: () => new Promise<void>((r) => { child.once('exit', () => { if (keep) { writeFileSync(join(home, 'bot.log'), out); console.log(`[eval] kept ${home}`) } else rmSync(home, { recursive: true, force: true }); r() }); child.kill('SIGTERM') }) }
}

/** One ask on a fresh thread: follow it over /events, send, wait for the turn to end, measure. */
async function askOnce(origin: string, h: Record<string, string>, ask: { id: string; text: string }, timeoutMs: number): Promise<AskResult> {
  const t = await (await fetch(`${origin}/threads`, { method: 'POST', headers: h, body: '{}' })).json() as { sessionId: string }
  const { WebSocket } = await import('ws')
  const ws = new WebSocket(`${origin.replace('http', 'ws')}/events`, ['bearer', h.authorization.slice('Bearer '.length)])
  // this thread only, as the app shows it: other sessions' status frames on the same socket are ignored
  const view = new ThreadView(t.sessionId)
  ws.on('message', (m) => view.apply(JSON.parse(m.toString())))
  await new Promise<void>((r) => ws.on('open', () => r()))
  ws.send(JSON.stringify({ type: 'follow', sessionId: t.sessionId }))
  const t0 = Date.now()
  const r = await fetch(`${origin}/threads/${t.sessionId}/messages`, { method: 'POST', headers: h, body: JSON.stringify({ text: ask.text, timeZone: 'America/New_York' }) })
  assert.equal(r.status, 200, `${ask.id}: POST message`)
  const end = t0 + timeoutMs
  // a question the assistant asks (ask_user_question) is a card the app shows and the turn waits on
  // it: that is the answer to this ask, so stop there (before 2026-11-01 water waited out 300 s and counted as no reply)
  const asked = async () => ((await (await fetch(`${origin}/asks`, { headers: h })).json()) as { kind?: string; sessionId?: string }[]).some((a) => a.sessionId === t.sessionId && a.kind === 'question')
  let lastAsk = 0, question = false
  while (Date.now() < end && !view.turnOver()) {
    if (Date.now() - lastAsk > 2000) { lastAsk = Date.now(); if ((question = await asked())) break }
    await new Promise((x) => setTimeout(x, 250))
  }
  const seconds = Math.round((Date.now() - t0) / 100) / 10
  // a turn still running at the timeout: is it waiting on the person (a question or an approval the thread does not show as a row)?
  const pending = view.turnOver() || question ? [] : ((await (await fetch(`${origin}/asks`, { headers: h })).json()) as { kind?: string; sessionId?: string; request?: Record<string, unknown> }[]).filter((a) => a.sessionId === t.sessionId)
  if (pending.length) console.log(`[eval] ${ask.id}: waiting on ${JSON.stringify(pending).slice(0, 600)}`)
  ws.close()
  const all = view.rows()
  // a table the person picks a row from is labelled table+pick: compare and choose in one card
  const kinds = all.flatMap((row) => row.kind === 'card' ? [row.card?.kind === 'table' && row.card.pick ? 'table+pick' : row.card?.kind ?? 'card'] : row.kind === 'module' ? ['module'] : [])
  if (question) kinds.push('question')
  const them = all.filter((row) => row.kind === 'them').map((row) => row.text ?? '')
  // a ui call that did not build (a built one answers "Shown. module=…"; every ui step counted before 2026-11-01)
  const failedUi = all.filter((row) => row.kind === 'step' && row.name === 'mcp__bot__ui' && !String(row.output ?? '').startsWith('Shown.'))
  const uiErrors = failedUi.length
  for (const row of failedUi) console.log(`ui error (${ask.id}): ${String(row.output ?? '').slice(0, 4000)}`)
  const notices = all.filter((row) => row.kind === 'notice').map((row) => row.text ?? '')
  return { id: ask.id, sessionId: t.sessionId, text: ask.text, ui: kinds.length > 0, kinds, seconds, timedOut: !view.turnOver() && !question, waitingOn: pending.map((a) => a.kind ?? '?'), textLength: them.join('').length, replied: them.some((x) => x.trim()) || kinds.length > 0, uiErrors, rows: all.map((row) => row.kind === 'step' ? `step:${row.name}` : row.kind), notices, cards: all.filter((row) => row.kind === 'card').map((row) => row.card), reply: them.join('\n') }
}

export function table(results: AskResult[]) {
  const pad = (s: string, n: number) => s + ' '.repeat(Math.max(0, n - [...s].length))
  const lines = ['| ask | interface | kinds | s | text chars |', '|---|---|---|---|---|']
  for (const r of results) lines.push(`| ${pad(r.id, 12)} | ${r.ui ? 'yes' : 'no '} | ${r.kinds.join(', ') || '—'}${r.uiErrors ? ` (+${r.uiErrors} ui compile error${r.uiErrors > 1 ? 's' : ''})` : ''} | ${r.seconds}${r.timedOut ? ' (turn still running at the timeout)' : ''} | ${r.textLength} |`)
  const rate = results.filter((r) => r.ui).length / results.length
  lines.push(`rate: ${results.filter((r) => r.ui).length}/${results.length} = ${(rate * 100).toFixed(0)}%`)
  return { text: lines.join('\n'), rate }
}

test('genui eval: how often an ordinary ask comes back as an interface', { skip: !run, timeout: 1_800_000 }, async () => {
  const bot = await startBot()
  try {
    const { token } = await (await fetch(`${bot.origin}/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: bot.code, name: 'eval' }) })).json() as { token: string }
    const h = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
    await fetch(`${bot.origin}/settings`, { method: 'PUT', headers: h, body: JSON.stringify({ assistantName: 'Nori' }) })
    assert.equal((await fetch(`${bot.origin}/consent`, { method: 'PUT', headers: h, body: JSON.stringify({ ai: true, age: 'adult' }) })).status, 200) // the person agreed to the AI provider (since 1a602a4)
    const concurrency = Math.max(1, Number(process.env.DEEPSEEK_BOT_GENUI_CONCURRENCY ?? 1))
    const only = process.env.DEEPSEEK_BOT_GENUI_ONLY?.split(',').filter(Boolean)
    const queue = ASKS.filter((a) => !only?.length || only.includes(a.id))
    const results: AskResult[] = []
    await Promise.all(Array.from({ length: concurrency }, async () => {
      for (let a = queue.shift(); a; a = queue.shift()) {
        const r = await askOnce(bot.origin, h, a, 600_000)
        console.log(`[eval] ${r.id}: ${r.ui ? 'interface ' + r.kinds.join(',') : 'text only'} in ${r.seconds} s (${r.textLength} chars) rows=${r.rows.join(' ')}${r.notices.length ? ' notices=' + JSON.stringify(r.notices) : ''}`)
        results.push(r)
      }
    }))
    results.sort((a, b) => ASKS.findIndex((x) => x.id === a.id) - ASKS.findIndex((x) => x.id === b.id))
    const { text, rate } = table(results)
    console.log(`\n[eval] model ${MODEL}, ${new Date().toISOString().slice(0, 10)}\n${text}\n`)
    if (process.env.DEEPSEEK_BOT_GENUI_OUT) writeFileSync(process.env.DEEPSEEK_BOT_GENUI_OUT, JSON.stringify({ date: new Date().toISOString(), model: MODEL, rate, results }, null, 2))
    const silent = results.filter((r) => !r.replied).map((r) => r.id)
    assert.deepEqual(silent, [], `every ask gets a reply (none from: ${silent.join(', ')})\n${bot.log().slice(-2000)}`)
    const min = Number(process.env.DEEPSEEK_BOT_GENUI_MIN ?? 0)
    assert.ok(rate >= min, `interface rate ${(rate * 100).toFixed(0)}% below ${min * 100}%`)
  } finally { await bot.stop() }
})
