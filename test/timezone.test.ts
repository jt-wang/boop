// NSH on Android has no zone in Intl and reports 'UTC' (2026-10-27). A client that cannot know must not overwrite a
// better zone, and the assistant must not be told UTC is where the person lives.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBotServer, openingPrompt, type Settings } from '../src/server.ts'
import { MemoryDeviceStore } from '../src/devices.ts'
import { openHome } from '../src/home.ts'

async function boot(userMd = '# USER.md\n') {
  const posts: { url: string; body: { payload?: { args?: { request?: { clientTimeZone?: string; content?: { text: string }[] } } } } }[] = []
  const dsh = createServer((req, res) => {
    let b = ''
    req.on('data', (c) => { b += c })
    req.on('end', () => {
      posts.push({ url: req.url ?? '', body: JSON.parse(b || 'null') })
      const value = req.url === '/api/session/create' ? { sessionId: 'main' } : req.url === '/api/session/list' ? { items: [] } : {}
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ result: { ok: true, value } }))
    })
  })
  dsh.listen(0, '127.0.0.1'); await once(dsh, 'listening')
  const origin = `http://127.0.0.1:${(dsh.address() as { port: number }).port}`
  const dir = mkdtempSync(join(tmpdir(), 'tz-')); const workspace = join(dir, 'workspace'); mkdirSync(workspace)
  writeFileSync(join(workspace, 'USER.md'), userMd)
  let settings: Settings = { assistantName: 'Nori', mainSessionId: null, language: 'auto', timeZone: '' }
  const store = { get: async () => structuredClone(settings), set: async (p: Partial<Settings>) => { settings = { ...settings, ...p }; return structuredClone(settings) } }
  const devices = new MemoryDeviceStore(); const token = await devices.issue('android')
  const bot = await createBotServer({ dsh: { origin, cookie: 'c=1' }, devices, workspace, host: '127.0.0.1', port: 0, appDir: join(process.cwd(), 'app'), settings: store })
  const api = (p: string, body?: unknown, method = 'PUT') => fetch(bot.origin + p, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  return { api, store, posts, close: async () => { await bot.close(); dsh.close() } }
}

test('a phone that reports UTC does not overwrite a zone the bot already knows', async () => {
  const s = await boot()
  try {
    await s.api('/me/context', { timeZone: 'America/New_York', locale: 'fr-FR' })
    await s.api('/me/context', { timeZone: 'UTC', locale: 'zh-CN' })
    await s.api('/me/context', { timeZone: 'Etc/UTC' })
    const st = await s.store.get()
    assert.equal(st.person?.timeZone, 'America/New_York'); assert.equal(st.person?.timeZoneGuessed, undefined)
    assert.equal(st.timeZone, 'America/New_York')
    assert.equal(st.person?.locale, 'zh-CN', 'the rest of the context still updates')
  } finally { await s.close() }
})

test('UTC with nothing better known is kept as a guess: not the bot\'s zone, and the opening does not call it home', async () => {
  const s = await boot()
  try {
    await s.api('/me/context', { timeZone: 'UTC' })
    const st = await s.store.get()
    assert.equal(st.person?.timeZone, 'UTC'); assert.equal(st.person?.timeZoneGuessed, true)
    assert.equal(st.timeZone, '', 'a guess does not become the bot\'s zone')
    const opening = openingPrompt('Nori', st.person)
    assert.doesNotMatch(opening, /UTC \(so that is where they live/)
    assert.match(opening, /time zone is not known/)
    // a real zone later replaces the guess
    await s.api('/me/context', { timeZone: 'Europe/Berlin' })
    const after = await s.store.get()
    assert.equal(after.person?.timeZone, 'Europe/Berlin'); assert.equal(after.person?.timeZoneGuessed, undefined); assert.equal(after.timeZone, 'Europe/Berlin')
  } finally { await s.close() }
})

test('a zone the person stated (USER.md) wins over a UTC report', async () => {
  const s = await boot('# USER.md\n\n- 2026-10-27 [fact] Lives in Lisbon (Europe/Lisbon)\n')
  try {
    await s.api('/me/context', { timeZone: 'UTC' })
    const st = await s.store.get()
    assert.equal(st.person?.timeZone, 'Europe/Lisbon'); assert.equal(st.person?.timeZoneGuessed, undefined)
  } finally { await s.close() }
})

test('a message sent with UTC from such a phone reaches the assistant with the better zone', async () => {
  const s = await boot()
  try {
    await s.api('/me/context', { timeZone: 'America/New_York' })
    await s.api('/threads/main/messages', { text: '明天早上提醒我', timeZone: 'UTC' }, 'POST')
    const prompt = s.posts.find((p) => p.url === '/api/session/prompt')
    assert.equal(prompt?.body.payload?.args?.request?.clientTimeZone, 'America/New_York')
  } finally { await s.close() }
})

test('AGENTS.md says when the time zone is a guess, and does not say it is where they live', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tz-home-'))
  const h = await openHome(root, { model: { provider: 'deepseek-official', model: 'deepseek-flash' }, person: { timeZone: 'UTC', timeZoneGuessed: true } })
  const md = readFileSync(join(h.dshHome, 'AGENTS.md'), 'utf8')
  assert.match(md, /reported UTC[^\n]*could not tell/)
  assert.doesNotMatch(md, /UTC \(their phone's; this is where they live/)
  assert.match(md, /remember` where they live with its `timeZone`/)
})
