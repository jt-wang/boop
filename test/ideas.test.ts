import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LlmClient } from '../src/llm.ts'
import { Ideas, type IdeasContext } from '../src/ideas.ts'

async function fakeModel() {
  const prompts: string[] = []
  let answer: unknown = { ideas: [{ title: 'Book the dentist', body: 'You mentioned it last week.', action: 'Find me a dentist slot next Tuesday morning' }, { title: 'Plan the 10 km', body: 'Your goal has no run this week.', action: 'Plan my runs for this week' }, { title: 'Oat milk restock', body: 'Groceries are due.', action: 'Add oat milk to my shopping list' }] }
  const srv = createServer((req, res) => {
    let s = ''
    req.on('data', (c) => { s += c })
    req.on('end', () => {
      prompts.push((JSON.parse(s).messages as { content: string }[]).map((x) => x.content).join('\n'))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) } }] }))
    })
  })
  srv.listen(0, '127.0.0.1'); await once(srv, 'listening')
  const { port } = srv.address() as { port: number }
  return { llm: new LlmClient({ baseURL: `http://127.0.0.1:${port}/v1`, model: 'cheap' }), prompts, setAnswer: (a: unknown) => { answer = a }, close: () => new Promise<void>((r) => { srv.closeAllConnections(); srv.close(() => r()) }) }
}

const context = async (): Promise<IdeasContext> => ({
  user: '- 2026-10-20 Lives in Lisbon\n- 2026-10-21 Prefers oat milk',
  memory: '- 2026-10-22 Dentist appointment is overdue',
  goals: [{ title: 'Run 10 km by January', status: 'active', plan: ['3 runs a week'], notes: [{ at: '2026-10-25T00:00:00Z', text: 'ran 4 km' }] }],
  schedules: [{ name: 'Stretch', nextRunAt: '2026-10-28T00:00:00Z', active: true }],
  activity: [{ at: '2026-10-26T09:00:00Z', kind: 'memory', text: 'Remembered: prefers oat milk' }],
})

async function boot(m: Awaited<ReturnType<typeof fakeModel>>, extra: { now?: () => number; settings?: () => Promise<{ assistantName: string; morningBrief?: boolean; briefHour?: number; timeZone?: string }>; path?: string; context?: () => Promise<IdeasContext> } = {}) {
  const pushed: { title: string; body: string; tag?: string }[] = []
  const activity: { kind: string; text: string }[] = []
  const path = extra.path ?? join(mkdtempSync(join(tmpdir(), 'ideas-')), 'ideas.json')
  const ideas = await Ideas.open(path, {
    llm: m.llm, context: extra.context ?? context,
    settings: extra.settings ?? (async () => ({ assistantName: 'Nori', morningBrief: false, briefHour: 8, timeZone: 'America/New_York' })),
    notify: async (n) => { pushed.push(n) },
    onActivity: (e) => activity.push(e),
    now: extra.now,
  })
  return { ideas, pushed, activity, path }
}

test('refresh asks the cheap model with the person\'s context and stores 3 ideas; list is newest first; a later refresh replaces the undismissed ones', async () => {
  const m = await fakeModel()
  try {
    const { ideas, activity } = await boot(m)
    assert.deepEqual(ideas.list(), [])
    const out = await ideas.refresh()
    assert.equal(out.length, 3)
    for (const i of out) { assert.ok(i.id); assert.ok(i.title); assert.ok(i.action); assert.equal(i.dismissed, false); assert.ok(Date.parse(i.createdAt)) }
    assert.deepEqual(ideas.list().map((i) => i.title), ['Book the dentist', 'Plan the 10 km', 'Oat milk restock'])
    const sent = m.prompts[0]
    for (const needle of ['Lives in Lisbon', 'Dentist appointment is overdue', 'Run 10 km by January', 'ran 4 km', 'Stretch', 'Remembered: prefers oat milk', 'Nori']) assert.match(sent, new RegExp(needle))
    assert.equal(activity.length, 1); assert.match(activity[0].text, /3 new ideas/)
    m.setAnswer({ ideas: [{ title: 'Only one', body: '', action: 'Do the one thing' }, { title: '', body: 'no title', action: 'x' }, { body: 'no action', title: 'Nope' }] })
    const again = await ideas.refresh()
    assert.deepEqual(again.map((i) => i.title), ['Only one'])
    assert.deepEqual(ideas.list().map((i) => i.title), ['Only one'], 'old undismissed ideas are gone')
  } finally { await m.close() }
})

test('dismiss hides an idea for good, also across a refresh and a reopen; more than 3 ideas are trimmed', async () => {
  const m = await fakeModel()
  try {
    const { ideas, path } = await boot(m)
    const [a] = await ideas.refresh()
    assert.equal(await ideas.dismiss(a.id), true)
    assert.equal(await ideas.dismiss('nope'), false)
    assert.deepEqual(ideas.list().map((i) => i.title), ['Plan the 10 km', 'Oat milk restock'])
    m.setAnswer({ ideas: [1, 2, 3, 4, 5].map((n) => ({ title: `T${n}`, body: `B${n}`, action: `A${n}` })) })
    assert.equal((await ideas.refresh()).length, 3)
    assert.deepEqual(ideas.list().map((i) => i.title), ['T1', 'T2', 'T3'])
    const reopened = await boot(m, { path })
    assert.deepEqual(reopened.ideas.list().map((i) => i.title), ['T1', 'T2', 'T3'])
  } finally { await m.close() }
})

test('tick generates once a day, remembers the last run across a restart, and does nothing in between', async () => {
  const m = await fakeModel()
  try {
    let t = Date.UTC(2026, 9, 27, 16, 0) // 12:00 New York
    const first = await boot(m, { now: () => t })
    assert.deepEqual(await first.ideas.tick(), { refreshed: true, briefed: false })
    assert.equal(m.prompts.length, 1)
    t += 6 * 3600_000
    assert.deepEqual(await first.ideas.tick(), { refreshed: false, briefed: false })
    const second = await boot(m, { now: () => t, path: first.path })
    assert.deepEqual(await second.ideas.tick(), { refreshed: false, briefed: false }, 'lastRunAt survived the restart')
    t += 19 * 3600_000
    assert.deepEqual(await second.ideas.tick(), { refreshed: true, briefed: false })
    assert.equal(m.prompts.length, 2)
  } finally { await m.close() }
})

// Discover offered "Choose a first goal to track — nothing is being tracked yet" under the goal the person had just
// set: the ideas were made at the start of the session and kept for a day (QA, Android and iOS, 2026-10-30).
test('tick refreshes when goals, memory or reminders changed, at most every 10 minutes; recent activity alone does not', async () => {
  const m = await fakeModel()
  try {
    let t = Date.UTC(2026, 9, 27, 3, 0)
    let ctx = { ...(await context()), goals: [] as unknown[] }
    const b = await boot(m, { now: () => t, context: async () => ctx })
    assert.deepEqual(await b.ideas.tick(), { refreshed: true, briefed: false })
    ctx = { ...ctx, activity: [{ at: '2026-10-27T03:01:00Z', kind: 'memory', text: 'Remembered: x' }] }
    t += 11 * 60_000
    assert.deepEqual(await b.ideas.tick(), { refreshed: false, briefed: false }, 'activity alone')
    ctx = { ...ctx, goals: [{ title: 'Run 10 km in three months', status: 'active' }] }
    t += 60_000
    assert.deepEqual(await b.ideas.tick(), { refreshed: true, briefed: false }, 'a new goal')
    assert.match(m.prompts.at(-1)!, /Run 10 km in three months/)
    ctx = { ...ctx, memory: ctx.memory + '\n- 2026-10-27 Picked Sintra' }
    t += 5 * 60_000
    assert.deepEqual(await b.ideas.tick(), { refreshed: false, briefed: false }, 'within 10 minutes of the last run')
    t += 6 * 60_000
    assert.deepEqual(await b.ideas.tick(), { refreshed: true, briefed: false })
    t += 30 * 60_000
    assert.deepEqual(await b.ideas.tick(), { refreshed: false, briefed: false }, 'nothing changed since')
  } finally { await m.close() }
})

test('morning brief: one push per local day at or after briefHour, only when opted in; its body is the first idea\'s title', async () => {
  const m = await fakeModel()
  try {
    let t = Date.UTC(2026, 9, 28, 11, 30) // 07:30 New York, Oct 28
    let on = true
    const s = await boot(m, { now: () => t, settings: async () => ({ assistantName: 'Nori', morningBrief: on, briefHour: 8, timeZone: 'America/New_York' }) })
    await s.ideas.tick() // first ever run generates, but it is before 08:00 → no brief
    assert.equal(s.pushed.length, 0)
    t += 40 * 60_000 // 08:10 New York
    assert.deepEqual(await s.ideas.tick(), { refreshed: true, briefed: true })
    assert.equal(s.pushed.length, 1)
    assert.equal(s.pushed[0].title, 'Nori'); assert.equal(s.pushed[0].body, 'Book the dentist'); assert.equal(s.pushed[0].tag, 'brief')
    t += 3 * 3600_000 // 11:10 same day
    assert.deepEqual(await s.ideas.tick(), { refreshed: false, briefed: false })
    assert.equal(s.pushed.length, 1, 'no second brief the same day')
    t += 24 * 3600_000 // 11:10 next day, but opted out meanwhile
    on = false
    const r = await s.ideas.tick()
    assert.equal(r.briefed, false); assert.equal(s.pushed.length, 1)
  } finally { await m.close() }
})

// --- HTTP routes: GET /ideas, POST /ideas/refresh, POST /ideas/:id/dismiss (device-authenticated) ---
import { createBotServer } from '../src/server.ts'
import { MemoryDeviceStore } from '../src/devices.ts'

test('routes: /ideas needs a device; refresh returns the fresh list; dismiss hides one; unknown id → 404', async () => {
  const m = await fakeModel()
  const { ideas } = await boot(m)
  const devices = new MemoryDeviceStore()
  const bot = await createBotServer({ dsh: { origin: 'http://127.0.0.1:9', cookie: 'c=1' }, devices, host: '127.0.0.1', port: 0, ideas })
  try {
    assert.equal((await fetch(`${bot.origin}/ideas`)).status, 401)
    const token = await devices.issue('tester')
    const api = (path: string, init: RequestInit = {}) => fetch(bot.origin + path, { ...init, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } })
    assert.deepEqual(await (await api('/ideas')).json(), [])
    const fresh = await (await api('/ideas/refresh', { method: 'POST' })).json() as { id: string; title: string; action: string }[]
    assert.equal(fresh.length, 3); assert.equal(fresh[0].title, 'Book the dentist')
    assert.equal(((await (await api('/ideas')).json()) as unknown[]).length, 3)
    assert.deepEqual(await (await api(`/ideas/${fresh[1].id}/dismiss`, { method: 'POST' })).json(), { ok: true })
    assert.deepEqual(((await (await api('/ideas')).json()) as { title: string }[]).map((i) => i.title), ['Book the dentist', 'Oat milk restock'])
    assert.equal((await api('/ideas/nope/dismiss', { method: 'POST' })).status, 404)
  } finally { await bot.close(); await m.close() }
})

test('routes: PUT /settings accepts the brief fields (morningBrief, briefHour 0–23, timeZone) and ignores junk', async () => {
  const devices = new MemoryDeviceStore()
  let settings: Record<string, unknown> = { assistantName: 'Nori', mainSessionId: null, language: 'auto' }
  const bot = await createBotServer({ dsh: { origin: 'http://127.0.0.1:9', cookie: 'c=1' }, devices, host: '127.0.0.1', port: 0, settings: { get: async () => settings as never, set: async (p) => { settings = { ...settings, ...p }; return settings as never } } })
  try {
    const token = await devices.issue('tester')
    const put = (body: unknown) => fetch(`${bot.origin}/settings`, { method: 'PUT', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const r = await (await put({ morningBrief: true, briefHour: 7, timeZone: 'America/New_York', bogus: 1 })).json() as Record<string, unknown>
    assert.equal(r.morningBrief, true); assert.equal(r.briefHour, 7); assert.equal(r.timeZone, 'America/New_York'); assert.equal('bogus' in r, false)
    const bad = await (await put({ briefHour: 99, timeZone: 'Not/AZone' })).json() as Record<string, unknown>
    assert.equal(bad.briefHour, 7, 'out-of-range hour ignored'); assert.equal(bad.timeZone, 'America/New_York', 'unknown zone ignored')
  } finally { await bot.close() }
})

// The person never sees how the notes are kept: Discover showed ideas like "USER.md is still an unfilled template"
// and "Fill in your basics … time zone" (QA pass, 2026-10-27, iOS; the real model did it in 4 of 12 ideas on empty
// notes). The prompt names no files, sends a file's unfilled placeholder as nothing, and says what not to propose.
test('the ideas prompt names no files, sends empty notes as empty, and rules out files and what the phone tells', async () => {
  const m = await fakeModel()
  try {
    const ideas = await Ideas.open(join(mkdtempSync(join(tmpdir(), 'ideas-')), 'ideas.json'), {
      llm: m.llm,
      context: async () => ({ user: '# USER.md — who you work for\n\n(Fill this in as you learn: name, time zone, language.)', memory: '# MEMORY.md — long-term memory\n\n(One fact per line.)\n- 2026-10-27 Plans a weekend in Sintra', goals: [], schedules: [], activity: [] }),
      settings: async () => ({ assistantName: 'Momo', timeZone: 'America/New_York' }),
    })
    await ideas.refresh()
    const sent = m.prompts[0]
    assert.doesNotMatch(sent, /USER\.md|MEMORY\.md|Fill this in|One fact per line/)
    assert.match(sent, /Plans a weekend in Sintra/)
    assert.match(sent, /never mention files/i)
    assert.match(sent, /time zone or language/i)
  } finally { await m.close() }
})

test('changing the language does not rewrite ideas already written: they are the assistant\'s; the next run is in the new language', async () => {
  const m = await fakeModel()
  try {
    let language = 'ru'
    let t = Date.UTC(2026, 9, 27, 3, 0)
    const { ideas } = await boot(m, { now: () => t, settings: async () => ({ assistantName: 'Nori', language }) })
    assert.deepEqual(await ideas.tick(), { refreshed: true, briefed: false })
    language = 'ko'
    assert.deepEqual(await ideas.tick(), { refreshed: false, briefed: false })
    t += 86_400_000
    assert.deepEqual(await ideas.tick(), { refreshed: true, briefed: false })
    assert.match(m.prompts.at(-1)!, /Korean|한국어/)
  } finally { await m.close() }
})
