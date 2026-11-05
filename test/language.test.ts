// Everything the bot writes or templates follows the person's language (2026-10-27: a Chinese-speaking owner saw
// "Set up a morning check-in", "3 new ideas: …", "Remembered: They named me 大鲸鱼" and "Whaile first-time app
// onboarding"). Order: the phone's locale, else what they write, else settings.language.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { LlmClient } from '../src/llm.ts'
import { Ideas } from '../src/ideas.ts'
import { Reflector } from '../src/reflect.ts'
import { Memory } from '../src/memory.ts'
import { Scheduler } from '../src/scheduler.ts'
import { Goals } from '../src/goals.ts'
import { startToolsServer } from '../src/tools.ts'
import { createBotServer, openingPrompt, type Settings } from '../src/server.ts'
import { MemoryDeviceStore } from '../src/devices.ts'
import { PushService } from '../src/push.ts'

async function fakeModel(answer: () => unknown) {
  const prompts: string[] = []
  const srv = createServer((req, res) => {
    let s = ''
    req.on('data', (c) => { s += c })
    req.on('end', () => {
      prompts.push((JSON.parse(s).messages as { content: string }[]).map((x) => x.content).join('\n'))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer()) } }] }))
    })
  })
  srv.listen(0, '127.0.0.1'); await once(srv, 'listening')
  const { port } = srv.address() as { port: number }
  return { llm: new LlmClient({ baseURL: `http://127.0.0.1:${port}/v1`, model: 'cheap' }), prompts, close: () => new Promise<void>((r) => { srv.closeAllConnections(); srv.close(() => r()) }) }
}

test('ideas: the model is told the person\'s language, and the activity line is in it', async () => {
  const m = await fakeModel(() => ({ ideas: [{ title: '设一个早间提醒', body: '每天早上看一眼。', action: '每天早上 8 点提醒我看今天的安排' }, { title: '定一个目标', body: '先定一个。', action: '帮我定一个这个月的目标' }] }))
  const activity: { kind: string; text: string }[] = []
  try {
    const ideas = await Ideas.open(join(mkdtempSync(join(tmpdir(), 'ideas-')), 'ideas.json'), {
      llm: m.llm,
      context: async () => ({ user: '- 2026-10-27 [preference] They named me 大鲸鱼', memory: '', goals: [], schedules: [], activity: [] }),
      settings: async () => ({ assistantName: '大鲸鱼', language: 'zh-CN', timeZone: 'Europe/Lisbon' }),
      onActivity: (e) => activity.push(e),
    })
    await ideas.refresh()
    assert.match(m.prompts[0], /Chinese \(China\), zh-CN/)
    assert.doesNotMatch(m.prompts[0], /language the person uses in their notes/)
    assert.match(activity[0].text, /^2 个新建议：设一个早间提醒；定一个目标/)
  } finally { await m.close() }
})

test('memory reflection: facts are asked for in the person\'s language, and the activity line is in it', async () => {
  const m = await fakeModel(() => ({ user: ['给助理起名叫大鲸鱼'], memory: [] }))
  const dir = mkdtempSync(join(tmpdir(), 'reflect-'))
  writeFileSync(join(dir, 'USER.md'), '# USER.md\n'); writeFileSync(join(dir, 'MEMORY.md'), '# MEMORY.md\n')
  const activity: { kind: string; text: string }[] = []
  try {
    const r = new Reflector({ llm: m.llm, memory: new Memory(dir), onActivity: (e) => activity.push(e), language: async () => 'zh-CN' })
    await r.reflect({ user: '你叫大鲸鱼，以后都这么叫你。', assistant: '好，我叫大鲸鱼了。以后就用这个名字。' })
    assert.match(m.prompts[0], /Write every item in Chinese \(China\), zh-CN/)
    assert.equal(activity[0].text, '记忆更新：给助理起名叫大鲸鱼')
  } finally { await m.close() }
})

test('tools: activity lines are in the person\'s language; remember asks for the fact in it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tools-'))
  writeFileSync(join(dir, 'USER.md'), '# USER.md\n'); writeFileSync(join(dir, 'MEMORY.md'), '# MEMORY.md\n')
  const acts: { kind: string; text: string }[] = []
  const srv = await startToolsServer({ memory: new Memory(dir), scheduler: await Scheduler.open(join(dir, 's.json'), { onDue: async () => {} }), goals: await Goals.open(join(dir, 'g.json')), notify: async () => {}, onActivity: (e) => acts.push(e), rename: async () => {}, language: async () => 'zh-CN' })
  try {
    const c = new Client({ name: 't', version: '0' })
    await c.connect(new StreamableHTTPClientTransport(new URL(srv.url), { requestInit: { headers: { authorization: `Bearer ${srv.secret}` } } }))
    const remember = (await c.listTools()).tools.find((t) => t.name === 'remember')!
    assert.match(remember.description ?? '', /in the person's language/)
    await c.callTool({ name: 'remember', arguments: { fact: '喜欢燕麦奶', kind: 'preference' } })
    await c.callTool({ name: 'set_my_name', arguments: { name: '大鲸鱼' } })
    await c.callTool({ name: 'goal_set', arguments: { title: '跑完 10 公里', plan: [] } })
    await c.callTool({ name: 'schedule_create', arguments: { name: '拉伸', instruction: '起来拉伸', when: { kind: 'once', at: new Date(Date.now() + 3600_000).toISOString() } } })
    assert.deepEqual(acts.map((a) => a.text.slice(0, 6)), ['记住了：喜欢', '改名为 大鲸', '新目标：跑完', '设好了提醒「'])
    await c.close()
  } finally { await srv.close() }
})

async function fakeDsh(sessions: { sessionId: string; title?: string }[]) {
  const posts: { url: string; body: unknown }[] = []
  const srv = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      posts.push({ url: req.url ?? '', body: JSON.parse(body || 'null') })
      const items = sessions.map((s) => ({ sessionId: s.sessionId, updatedAt: Date.now(), running: false, blank: false, projections: { values: { title: s.title ?? null } } }))
      const value = req.url === '/api/session/create' ? { sessionId: 'main' } : req.url === '/api/session/list' ? { items } : {}
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ result: { ok: true, value } }))
    })
  })
  srv.listen(0, '127.0.0.1'); await once(srv, 'listening')
  return { origin: `http://127.0.0.1:${(srv.address() as { port: number }).port}`, posts, close: () => srv.close() }
}

async function bot(initial: Partial<Settings>, sessions: { sessionId: string; title?: string }[] = []) {
  const dsh = await fakeDsh(sessions)
  const dir = mkdtempSync(join(tmpdir(), 'lang-')); const workspace = join(dir, 'workspace'); mkdirSync(workspace)
  let settings: Settings = { assistantName: '大鲸鱼', mainSessionId: null, language: 'auto', ...initial }
  const store = { get: async () => ({ ...settings }), set: async (p: Partial<Settings>) => { settings = { ...settings, ...p }; return { ...settings } } }
  const pushed: { title: string; body: string }[] = []
  const push = await PushService.open(join(dir, 'push.json'), { sender: async (_s, p) => { pushed.push(JSON.parse(p)) } })
  const devices = new MemoryDeviceStore(); const token = await devices.issue('phone')
  const b = await createBotServer({ dsh: { origin: dsh.origin, cookie: 'c=1' }, devices, push, workspace, host: '127.0.0.1', port: 0, appDir: join(process.cwd(), 'app'), settings: store })
  const api = (p: string, init: RequestInit = {}) => fetch(b.origin + p, { ...init, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } })
  return { dsh, b, api, store, pushed, close: async () => { await b.close(); dsh.close() } }
}

test('what the person writes sets their language when the phone has not said; the phone\'s locale wins', async () => {
  const s = await bot({ mainSessionId: 'main' })
  try {
    await s.api('/threads/main/messages', { method: 'POST', body: JSON.stringify({ text: '你叫大鲸鱼' }) })
    assert.equal((await s.store.get()).spokenLanguage, 'zh')
    await s.api('/threads/main/messages', { method: 'POST', body: JSON.stringify({ text: 'ok' }) })
    assert.equal((await s.store.get()).spokenLanguage, 'zh', 'too little to tell changes nothing')
  } finally { await s.close() }
})

test('the opening turn is asked for in the language the bot knows, not English by default', () => {
  assert.match(openingPrompt('大鲸鱼', {}, 'zh'), /Write in Chinese, zh/)
  assert.doesNotMatch(openingPrompt('大鲸鱼', {}, 'zh'), /otherwise English/)
  assert.match(openingPrompt('Nori', { locale: 'fr-FR' }, 'fr-FR'), /French \(France\), fr-FR/)
})

// The opening turn saves nothing: what it knows came from the phone, which says it again on every connect. Asked to
// save "what you know", the real model wrote 平时用中文（简体）交流 and 住在里斯本，时区是当地时间 on the iPhone, and
// 刚第一次打开应用，还没告诉我名字和平时忙什么 on Android, into the Memory list the person reads (QA pass, 2026-10-27).
test('the opening turn does not ask the assistant to save what the phone told it', () => {
  for (const p of [openingPrompt('Nori', { locale: 'zh-Hans-CN', timeZone: 'America/New_York' }, 'zh'), openingPrompt('Nori', {}, 'en')]) {
    assert.doesNotMatch(p, /remember tool|Save what you know/i)
    assert.match(p, /Save nothing/)
  }
})

test('the main thread carries no harness-made title (it was titled from the hidden English opening prompt); side chats keep theirs', async () => {
  const s = await bot({ mainSessionId: 'main' }, [{ sessionId: 'main', title: 'Whaile first-time app onboarding' }, { sessionId: 'side', title: '里斯本到波尔图的车次' }])
  try {
    const usage = await (await s.api('/usage')).json() as { sessions: { sessionId: string; title?: string }[] }
    assert.equal(usage.sessions.find((x) => x.sessionId === 'main')?.title, undefined)
    assert.equal(usage.sessions.find((x) => x.sessionId === 'side')?.title, '里斯本到波尔图的车次')
    const threads = await (await s.api('/threads')).json() as { sessionId: string; title?: string }[]
    assert.equal(threads.find((x) => x.sessionId === 'main')?.title, undefined)
  } finally { await s.close() }
})
