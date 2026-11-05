import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'

// Real dsh + real model, the way the owner met it on Android (2026-10-27): renaming in chat, step lines in the
// person's language, and the app's "working" state through a re-follow. Skipped unless DEEPSEEK_BOT_E2E_MODEL=1.
const run = process.env.DEEPSEEK_BOT_E2E_MODEL === '1'

export async function startBot(): Promise<{ home: string; origin: string; code: string; log: () => string; stop(): Promise<void> }> {
  const home = mkdtempSync(join(tmpdir(), 'bot-plain-'))
  const child: ChildProcess = spawn(process.execPath, ['src/main.ts', '--home', home, '--host', '127.0.0.1', '--port', '0', '--model', 'magpie/group/auto-deepseek-flash', '--base-url', 'http://127.0.0.1:3425/v1', '--api-key-env', 'DEEPSEEK_BOT_MODEL_KEY'], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, DEEPSEEK_BOT_MODEL_KEY: 'none' } })
  let out = ''
  const pairUrl = await new Promise<string>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`no pairing url:\n${out}`)), 90_000)
    child.stdout!.on('data', (d) => { out += d; const m = /(http:\/\/[^\s]+\/pair\?code=(\d{6}))/.exec(out); if (m) { clearTimeout(t); resolve(m[1]) } })
    child.stderr!.on('data', (d) => { out += d })
    child.on('exit', (c) => { clearTimeout(t); reject(new Error(`bot exited ${c}:\n${out}`)) })
  })
  for (let i = 0; i < 100 && !/listening to the assistant/.test(out); i++) await new Promise((r) => setTimeout(r, 200))
  return { home, origin: new URL(pairUrl).origin, code: new URL(pairUrl).searchParams.get('code')!, log: () => out, stop: () => new Promise((r) => { child.once('exit', () => r()); child.kill('SIGTERM') }) }
}

export async function until<T>(fn: () => T | Promise<T>, ms: number, what: string): Promise<NonNullable<T>> {
  const end = Date.now() + ms
  while (Date.now() < end) { const v = await fn(); if (v) return v as NonNullable<T>; await new Promise((r) => setTimeout(r, 1000)) }
  throw new Error(`timed out waiting for ${what}`)
}

/** Pair, name the assistant, tell the bot what an Android phone tells it, open the main thread and wait out the opening turn. */
export async function setUp(bot: { origin: string; code: string }, context: Record<string, string>) {
  const { token } = await (await fetch(`${bot.origin}/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: bot.code, name: 'e2e' }) })).json() as { token: string }
  const h = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
  await fetch(`${bot.origin}/consent`, { method: 'PUT', headers: h, body: JSON.stringify({ ai: true, age: 'adult' }) }) // the person agreed to the AI provider (required since 1a602a4)
  const api = (p: string, init: RequestInit = {}) => fetch(bot.origin + p, { ...init, headers: h })
  await api('/settings', { method: 'PUT', body: JSON.stringify({ assistantName: 'Whaile' }) })
  await api('/me/context', { method: 'PUT', body: JSON.stringify(context) })
  const { sessionId } = await (await api('/sessions/main', { method: 'POST' })).json() as { sessionId: string }
  const idle = async () => { const l = await (await api('/threads')).json() as { sessionId: string; running: boolean; blank: boolean }[]; const t = l.find((x) => x.sessionId === sessionId); return Boolean(t && !t.blank && !t.running) }
  await until(idle, 180_000, 'the opening turn to end')
  const say = async (text: string) => { assert.equal((await api(`/threads/${sessionId}/messages`, { method: 'POST', body: JSON.stringify({ text, timeZone: context.timeZone }) })).status, 200); await new Promise((r) => setTimeout(r, 1500)); await until(idle, 300_000, `the turn after "${text}" to end`) }
  return { token, api, sessionId, say }
}

type Step = { kind: string; id: string; name?: string; description?: string; command?: string; text?: string }
/** The thread as the app sees it: the snapshot a fresh follow on /events answers with. */
export async function threadRows(origin: string, token: string, sessionId: string, lang: 'zh' | 'en' = 'zh'): Promise<{ rows: Step[]; running: boolean }> {
  const ws = new WebSocket(`${origin.replace('http', 'ws')}/events`, ['bearer', token])
  try {
    return await new Promise((resolve, reject) => {
      ws.on('message', (m) => { const f = JSON.parse(m.toString()); if (f.type === 'snapshot') resolve({ rows: f.rows, running: f.running }) })
      ws.on('open', () => ws.send(JSON.stringify({ type: 'follow', sessionId, lang })))
      ws.on('error', reject)
      setTimeout(() => reject(new Error('no snapshot')), 20_000)
    })
  } finally { ws.close() }
}
/** Steps after the last `you` row whose text matches. */
const stepsAfter = (rows: Step[], you: RegExp) => { const i = rows.findLastIndex((r) => r.kind === 'you' && you.test(r.text ?? '')); return rows.slice(i + 1).filter((r) => r.kind === 'step') }

test('renaming in chat: "你叫大鲸鱼" renames through set_my_name, the app hears me-updated, and nothing touches configuration', { skip: !run, timeout: 600_000 }, async () => {
  const bot = await startBot()
  try {
    const s = await setUp(bot, { timeZone: 'UTC', locale: 'zh-CN' })
    const ws = new WebSocket(`${bot.origin.replace('http', 'ws')}/events`, ['bearer', s.token])
    const frames: { type: string; assistant?: { name: string } }[] = []
    ws.on('message', (m) => frames.push(JSON.parse(m.toString())))
    await new Promise<void>((r) => ws.on('open', () => r()))
    const started = Date.now()
    await s.say('你叫大鲸鱼')
    const seconds = Math.round((Date.now() - started) / 1000)
    const me = await (await s.api('/me')).json() as { assistant: { name: string } }
    const calls = stepsAfter((await threadRows(bot.origin, s.token, s.sessionId)).rows, /大鲸鱼/).map((r) => ({ name: String(r.name), args: `${r.command ?? ''} ${r.description ?? ''}` }))
    console.log(`[e2e] rename turn: ${seconds} s, steps ${JSON.stringify(calls)}, /me name ${me.assistant.name}`)
    assert.match(me.assistant.name, /大鲸鱼/)
    assert.ok(frames.some((f) => f.type === 'me-updated' && /大鲸鱼/.test(f.assistant?.name ?? '')), JSON.stringify(frames.map((f) => f.type)))
    assert.ok(calls.some((c) => c.name === 'mcp__bot__set_my_name'), JSON.stringify(calls))
    assert.ok(!calls.some((c) => /config\.json|AGENTS\.md|cordis|DSH_HOME|\/dsh\b/.test(c.args)), JSON.stringify(calls))
    assert.match(readFileSync(join(bot.home, 'dsh', 'AGENTS.md'), 'utf8'), /Your name is 大鲸鱼/)
    ws.close()
  } finally { await bot.stop() }
})

test('something that keeps failing: it stops after a couple of tries and says what is blocked, instead of digging for minutes', { skip: !run, timeout: 600_000 }, async () => {
  const bot = await startBot()
  try {
    const s = await setUp(bot, { timeZone: 'Europe/Lisbon', locale: 'zh-CN' })
    const started = Date.now()
    await s.say('我家路由器的管理页面在 http://127.0.0.1:9/ ，帮我看看现在有几台设备连着。')
    const seconds = Math.round((Date.now() - started) / 1000)
    const { rows } = await threadRows(bot.origin, s.token, s.sessionId)
    const steps = stepsAfter(rows, /路由器/)
    const reply = rows.filter((r) => r.kind === 'them').at(-1)?.text ?? ''
    console.log(`[e2e] failing-site turn: ${seconds} s, ${steps.length} steps ${JSON.stringify(steps.map((r) => [r.name, r.description ?? r.command]))}\n[e2e] reply: ${reply}`)
    // the owner's runaway: 39 steps over 5 minutes; before the rule this request took 26 steps / 177 s, after it 7–8 / ~40 s (2026-10-27)
    assert.ok(steps.length <= 10 && seconds <= 90, `${steps.length} steps in ${seconds} s`)
    const dug = steps.filter((r) => /config\.json|AGENTS\.md|cordis|\/dsh\/|\/opt\/deepseek-bot|node_modules|devices\.json|DEEPSEEK_BOT|DSH_HOME/i.test(`${r.command ?? ''} ${r.description ?? ''}`))
    assert.deepEqual(dug, [], 'dug in its own installation')
    assert.match(reply, /[\u4e00-\u9fff]/)
  } finally { await bot.stop() }
})

test('an app that re-follows while a command runs (no model attempt in flight) is told the turn is still working', { skip: !run, timeout: 600_000 }, async () => {
  const bot = await startBot()
  try {
    const s = await setUp(bot, { timeZone: 'Europe/Lisbon', locale: 'zh-CN' })
    assert.equal((await s.api(`/threads/${s.sessionId}/messages`, { method: 'POST', body: JSON.stringify({ text: '在终端里运行 sleep 40，等它结束后只回复「好了」。' }) })).status, 200)
    // wait for the bash step to show, then re-follow the way the app does after its socket reconnects
    await until(async () => stepsAfter((await threadRows(bot.origin, s.token, s.sessionId)).rows, /sleep 40/).some((r) => r.name === 'bash'), 120_000, 'the sleep step')
    await new Promise((r) => setTimeout(r, 5000))
    const during = await threadRows(bot.origin, s.token, s.sessionId)
    const listed = (await (await s.api('/threads')).json() as { sessionId: string; running: boolean }[]).find((t) => t.sessionId === s.sessionId)
    console.log(`[e2e] re-follow during sleep: snapshot running=${during.running}, harness running=${listed?.running}`)
    assert.equal(listed?.running, true, 'the harness says the turn is running')
    assert.equal(during.running, true, 'the re-follow snapshot says so too')
    await until(async () => !(await threadRows(bot.origin, s.token, s.sessionId)).running, 180_000, 'the turn to end')
  } finally { await bot.stop() }
})

test('step lines: a person writing Chinese sees every step described in Chinese, in their terms, with no paths or internals', { skip: !run, timeout: 600_000 }, async () => {
  const bot = await startBot()
  try {
    const s = await setUp(bot, { timeZone: 'Europe/Lisbon', locale: 'zh-CN' })
    await s.say('帮我看看你这台电脑：现在几点、磁盘还剩多少空间、装的是什么系统。')
    const steps = stepsAfter((await threadRows(bot.origin, s.token, s.sessionId)).rows, /磁盘/)
    const described = steps.filter((r) => r.description)
    console.log(`[e2e] steps ${JSON.stringify(steps.map((r) => [r.name, r.description]))}`)
    assert.ok(described.length >= 1, 'the turn ran at least one described step')
    for (const r of described) {
      assert.match(r.description!, /[一-鿿]/, `not Chinese: ${r.description}`)
      assert.doesNotMatch(r.description!, /\/[a-z]|\$[A-Z]|\benv\b|config|DSH|harness|AGENTS/i, `internals: ${r.description}`)
    }
  } finally { await bot.stop() }
})

test('time zone: an Android phone that reports UTC is a guess; the zone the person states wins and survives the next UTC report', { skip: !run, timeout: 600_000 }, async () => {
  const bot = await startBot()
  try {
    const s = await setUp(bot, { timeZone: 'UTC', locale: 'zh-CN' })
    const userMd = () => readFileSync(join(bot.home, 'workspace', 'USER.md'), 'utf8')
    const afterOpening = userMd()
    await s.say('我住在里斯本。')
    const st1 = await (await s.api('/me')).json()
    await s.api('/me/context', { method: 'PUT', body: JSON.stringify({ timeZone: 'UTC', locale: 'zh-CN' }) }) // the app reconnects
    const config = JSON.parse(readFileSync(join(bot.home, 'config.json'), 'utf8')) as { settings: { timeZone?: string; person?: { timeZone?: string; timeZoneGuessed?: boolean } } }
    console.log(`[e2e] USER.md after the opening:\n${afterOpening}\n[e2e] USER.md after "我住在里斯本":\n${userMd()}\n[e2e] settings ${JSON.stringify({ timeZone: config.settings.timeZone, person: config.settings.person })} ${st1 ? '' : ''}`)
    assert.doesNotMatch(afterOpening, /UTC/, 'the opening did not save UTC as where they live')
    assert.match(userMd(), /里斯本/)
    assert.doesNotMatch(userMd(), /Asia\//, 'the fact is in their words; the zone went to the settings')
    assert.equal(config.settings.person?.timeZone, 'Europe/Lisbon'); assert.equal(config.settings.person?.timeZoneGuessed, undefined)
  } finally { await bot.stop() }
})

test('language: an Android phone that sends no locale, a person who writes Chinese — ideas, activity and usage titles come out in Chinese', { skip: !run, timeout: 900_000 }, async () => {
  const bot = await startBot()
  try {
    const s = await setUp(bot, { timeZone: 'UTC' }) // what NSH on Android sent on 2026-10-27: no locale, UTC
    await s.say('你叫大鲸鱼')
    await s.say('记住：我每天早上喝燕麦奶拿铁，周末去爬山。')
    await new Promise((r) => setTimeout(r, 20_000)) // the memory reflection after the turn
    const ideas = await (await s.api('/ideas/refresh', { method: 'POST' })).json() as { title: string; body: string; action: string }[]
    const activity = await (await s.api('/activity')).json() as { kind: string; text: string }[]
    const usage = await (await s.api('/usage')).json() as { sessions: { sessionId: string; title?: string }[] }
    const memory = await (await s.api('/memory')).json() as { text: string }[]
    console.log(`[e2e] ideas ${JSON.stringify(ideas.map((i) => i.title))}\n[e2e] activity ${JSON.stringify(activity.map((a) => a.text))}\n[e2e] memory ${JSON.stringify(memory.map((m) => m.text))}\n[e2e] usage main title ${JSON.stringify(usage.sessions.find((x) => x.sessionId === s.sessionId)?.title)}`)
    const zh = /[一-鿿]/
    assert.ok(ideas.length > 0)
    for (const i of ideas) { assert.match(i.title, zh, i.title); assert.match(i.action, zh, i.action) }
    for (const a of activity) assert.match(a.text, zh, a.text)
    assert.equal(usage.sessions.find((x) => x.sessionId === s.sessionId)?.title, undefined)
    for (const m of memory.filter((x) => /燕麦|爬山|oat|hik/i.test(x.text))) assert.match(m.text, zh, m.text)
  } finally { await bot.stop() }
})
