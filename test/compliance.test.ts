// Store obligations on the bot's side: the AI-provider consent gate, reports on replies and
// interfaces, and the person's index of interfaces with hide and per-interface permissions. No nsh CLI and no
// harness are needed: modules are seeded into the Ui's index, the harness records prompts.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBotServer, type Settings } from '../src/server.ts'
import { MemoryDeviceStore } from '../src/devices.ts'
import { Ui } from '../src/ui.ts'
import { Compliance, aiProvider, moduleLink } from '../src/compliance.ts'

const HOST_SECRET = 'host-secret-0123456789abcdef'

async function boot(o: { settings?: Partial<Settings>; relay?: string; publicUrl?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'bot-compliance-'))
  mkdirSync(join(root, 'ui'), { recursive: true })
  const now = Date.UTC(2026, 9, 27)
  writeFileSync(join(root, 'ui', 'modules.json'), JSON.stringify([
    { id: 'm0000000001', title: 'Tip calculator', token: 'tok-1-abcdefghijklmnopqrstuvw', at: now - 2000 },
    { id: 'm0000000002', title: 'Packing list', token: 'tok-2-abcdefghijklmnopqrstuvw', at: now - 1000, permissions: ['openUrl', 'clipboard'] },
  ]))
  mkdirSync(join(root, 'ui', 'm0000000002'), { recursive: true })
  writeFileSync(join(root, 'ui', 'm0000000002', 'App.tsx'), 'export default "packing list source"')
  const ui = await Ui.open(root, { nsh: join(root, 'no-nsh') })
  const prompts: { sessionId: string; text: string }[] = []
  const harness = { kind: 'fake', events: { on() {}, clientId: 'c' }, async createSession() { return { sessionId: 'main' } }, async listSessions() { return [{ sessionId: 'main', updatedAt: 1, running: false, blank: false }] }, async prompt(sessionId: string, text: string) { prompts.push({ sessionId, text }) }, async answer() {}, async cancel() { return true }, async rpc() { return {} as never }, async close() {}, async follow() { return () => {} } }
  let settings: Settings = { assistantName: 'Nori', mainSessionId: 'main', language: 'auto', ...o.settings }
  const settingsStore = { get: async () => ({ ...settings }), set: async (p: Partial<Settings>) => { settings = { ...settings, ...p }; return { ...settings } } }
  const devices = new MemoryDeviceStore()
  const token = await devices.issue('phone')
  const compliance = await Compliance.open(root, {
    settings: settingsStore,
    model: { provider: 'siliconflow', model: 'deepseek-ai/DeepSeek-V4.1-Flash', baseURL: 'https://api.siliconflow.cn/v1' },
    relay: o.relay ? { url: o.relay, secret: HOST_SECRET } : undefined,
    publicUrl: o.publicUrl,
    origin: () => 'http://192.168.1.20:3850',
  })
  const bot = await createBotServer({ dsh: { origin: 'http://127.0.0.1:9', cookie: 'c=1' }, devices, harness: harness as never, watcher: { clientId: 'c', on() {} } as never, host: '127.0.0.1', port: 0, settings: settingsStore, ui, compliance, hostSecret: HOST_SECRET, ideas: { list: () => [], refresh: async () => [], dismiss: async () => true } })
  const call = async (method: string, path: string, body?: unknown, auth = `Bearer ${token}`) => {
    const r = await fetch(`${bot.origin}${path}`, { method, headers: { authorization: auth, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    const text = await r.text()
    let json: unknown = text; try { json = JSON.parse(text) } catch {}
    return { status: r.status, body: json as Record<string, unknown> & unknown[] }
  }
  return { bot, root, call, prompts, settingsStore, ui, close: () => bot.close() }
}

test('aiProvider names the model and the company that runs it, from the configured address', () => {
  assert.deepEqual(aiProvider({ provider: 'siliconflow', model: 'deepseek-ai/DeepSeek-V4.1-Flash', baseURL: 'https://api.siliconflow.cn/v1' }), { key: 'api.siliconflow.cn|deepseek-ai/DeepSeek-V4.1-Flash', model: 'DeepSeek V4.1 Flash', company: 'SiliconFlow', policyUrl: 'https://docs.siliconflow.cn/docs/legals/privacy-policy' })
  assert.deepEqual(aiProvider({ provider: 'deepseek-official', model: 'deepseek-flash' }), { key: 'api.deepseek.com|deepseek-flash', model: 'DeepSeek Flash', company: 'DeepSeek', policyUrl: 'https://cdn.deepseek.com/policies/en-US/deepseek-privacy-policy.html' })
  // an address on the computer itself or its network is no name a person knows: the provider they configured is
  // (QA 2026-10-28 #3: the disclosure said "127.0.0.1 runs Auto DeepSeek Flash … Your messages go to 127.0.0.1")
  const other = aiProvider({ provider: 'magpie', model: 'group/auto', baseURL: 'http://127.0.0.1:8080/v1' })
  assert.equal(other.company, 'magpie')
  assert.equal(aiProvider({ provider: 'ollama', model: 'qwen3', baseURL: 'http://192.168.1.20:11434/v1' }).company, 'ollama')
  assert.equal(aiProvider({ provider: 'custom', model: 'm', baseURL: 'https://llm.example.com/v1' }).company, 'llm.example.com')
})

test('GET /me says which provider messages go to and whether the person agreed; nothing goes to the model before they do', async () => {
  const b = await boot()
  try {
    const me = await b.call('GET', '/me')
    assert.deepEqual((me.body as { ai: unknown }).ai, { model: 'DeepSeek V4.1 Flash', company: 'SiliconFlow', policyUrl: 'https://docs.siliconflow.cn/docs/legals/privacy-policy', filter: null, consent: null })
    assert.equal((me.body as { age: unknown }).age, null)
    // every way a message reaches the model is closed
    for (const [method, path, body] of [['POST', '/threads/main/messages', { text: 'hi' }], ['POST', '/sessions/main', {}], ['POST', '/api/session/prompt', {}], ['POST', '/ideas/refresh', {}]] as const) {
      const r = await b.call(method, path, body)
      assert.equal(r.status, 403, `${path} ${JSON.stringify(r.body)}`)
      assert.equal((r.body as { error: string }).error, 'ai-consent')
    }
    assert.equal(b.prompts.length, 0)
  } finally { await b.close() }
})

test('PUT /consent: an adult who agrees can send; withdrawing closes it again; a provider change asks again', async () => {
  const b = await boot()
  try {
    const r = await b.call('PUT', '/consent', { age: 'adult', ai: true })
    assert.equal(r.status, 200)
    assert.equal((r.body as { age: string }).age, 'adult')
    assert.match(String((r.body as { ai: { consent: { at: string } } }).ai.consent.at), /^\d{4}-/)
    assert.equal((await b.call('POST', '/threads/main/messages', { text: 'hi' })).status, 200)
    assert.deepEqual(b.prompts.map((p) => p.text), ['hi'])
    // withdraw (Settings → AI provider → Stop sharing)
    assert.equal((await b.call('PUT', '/consent', { ai: false })).status, 200)
    assert.equal((await b.call('POST', '/threads/main/messages', { text: 'again' })).status, 403)
    // agreed to another provider: not this one
    await b.settingsStore.set({ aiConsent: { provider: 'api.deepseek.com|deepseek-flash', at: new Date().toISOString() } })
    assert.equal(((await b.call('GET', '/me')).body as { ai: { consent: unknown } }).ai.consent, null)
    assert.equal((await b.call('POST', '/threads/main/messages', { text: 'x' })).status, 403)
  } finally { await b.close() }
})

test('someone who says they are under 18 cannot send even after agreeing; bad values are refused', async () => {
  const b = await boot()
  try {
    assert.equal((await b.call('PUT', '/consent', { age: 'child' })).status, 400)
    await b.call('PUT', '/consent', { age: 'minor', ai: true })
    const r = await b.call('POST', '/threads/main/messages', { text: 'hi' })
    assert.equal(r.status, 403)
    assert.equal((r.body as { error: string }).error, 'age')
    assert.equal(b.prompts.length, 0)
  } finally { await b.close() }
})

test('a module result is the person\'s message too: refused without consent', async () => {
  const b = await boot()
  try {
    const r = await fetch(`${b.bot.origin}/ui/m0000000001/result`, { method: 'POST', headers: { authorization: 'Bearer tok-1-abcdefghijklmnopqrstuvw', 'content-type': 'application/json' }, body: JSON.stringify({ text: '15%' }) })
    assert.equal(r.status, 403)
    assert.equal(b.prompts.length, 0)
  } finally { await b.close() }
})

test('POST /reports keeps a report of a reply with its words; GET /reports lists it; a bad reason is refused', async () => {
  const b = await boot({ settings: { aiConsent: null } })
  try {
    assert.equal((await b.call('POST', '/reports', { kind: 'reply', reason: 'rude' })).status, 400)
    assert.equal((await b.call('POST', '/reports', { kind: 'reply', reason: 'harmful', sessionId: 'main', rowId: 'r1', excerpt: 'x'.repeat(5000), note: 'not ok' }, 'Bearer nope')).status, 401)
    const r = await b.call('POST', '/reports', { kind: 'reply', reason: 'harmful', sessionId: 'main', rowId: 'r1', excerpt: 'x'.repeat(5000), note: 'not ok' })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal((r.body as { forwarded: boolean }).forwarded, false)
    const list = (await b.call('GET', '/reports')).body as unknown as { id: string; kind: string; reason: string; excerpt: string; status: string }[]
    assert.equal(list.length, 1)
    assert.equal(list[0].reason, 'harmful')
    assert.equal(list[0].excerpt.length, 4000, 'the reported words are kept, capped')
    assert.equal(list[0].status, 'sent')
  } finally { await b.close() }
})

test('a hosted bot forwards the report to its host with the interface\'s title and source; reporting an interface can hide it', async () => {
  const got: { auth?: string; body: Record<string, unknown> }[] = []
  const relay = createServer((req, res) => { let s = ''; req.on('data', (c) => { s += c }); req.on('end', () => { got.push({ auth: req.headers.authorization, body: JSON.parse(s) }); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true,"id":"h1"}') }) })
  await new Promise<void>((r) => relay.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${(relay.address() as { port: number }).port}`
  const b = await boot({ relay: url, publicUrl: 'https://host.example/s/sb-abc123' })
  try {
    const r = await b.call('POST', '/reports', { kind: 'interface', reason: 'sexual', moduleId: 'm0000000002', hide: true })
    assert.equal(r.status, 200)
    assert.equal((r.body as { forwarded: boolean }).forwarded, true)
    assert.equal(got.length, 1)
    assert.equal(got[0].auth, `Bearer ${HOST_SECRET}`)
    assert.equal(got[0].body.sandbox, 'sb-abc123')
    assert.equal(got[0].body.moduleTitle, 'Packing list')
    assert.equal(got[0].body.moduleSource, 'export default "packing list source"')
    assert.equal(got[0].body.kind, 'interface')
    assert.equal(b.ui.module('m0000000002')!.hidden, true)
  } finally { await b.close(); relay.close() }
})

test('GET /ui lists the person\'s interfaces newest first with a link to each; hide and unhide; a hidden one does not open', async () => {
  const b = await boot({ publicUrl: 'https://host.example/s/sb-abc123', settings: { aiConsent: null } })
  try {
    const list = (await b.call('GET', '/ui')).body as unknown as { id: string; title: string; link: string; hidden: boolean; permissions: string[]; grants: string[] }[]
    assert.deepEqual(list.map((m) => m.id), ['m0000000002', 'm0000000001'])
    assert.equal(list[0].link, 'https://host.example/open/sb-abc123/ui/m0000000002')
    assert.deepEqual(list[0].permissions, ['openUrl', 'clipboard'])
    assert.deepEqual(list[0].grants, [])
    assert.equal((await b.call('PATCH', '/ui/m0000000001', { hidden: true })).status, 200)
    for (const p of ['/ui/m0000000001.nshpkg', '/ui/m0000000001/meta', '/ui/m0000000001/bundle.nshc']) assert.equal((await b.call('GET', p)).status, 410, p)
    assert.equal((await b.call('POST', '/ui/m0000000001/play', {})).status, 410)
    assert.equal((await b.call('PATCH', '/ui/m0000000001', { hidden: false })).status, 200)
    assert.equal((await b.call('GET', '/ui/m0000000001/meta')).status, 200)
  } finally { await b.close() }
})

test('per-interface permissions: only what the interface asked for can be granted; meta carries both; revoking works', async () => {
  const b = await boot()
  try {
    assert.equal((await b.call('PATCH', '/ui/m0000000002', { grants: ['picker'] })).status, 400, 'not asked for')
    assert.equal((await b.call('PATCH', '/ui/m0000000002', { grants: ['openUrl'] })).status, 200)
    const meta = (await b.call('GET', '/ui/m0000000002/meta')).body as { permissions: string[]; grants: string[] }
    assert.deepEqual(meta.permissions, ['openUrl', 'clipboard'])
    assert.deepEqual(meta.grants, ['openUrl'])
    await b.call('PATCH', '/ui/m0000000002', { grants: [] })
    assert.deepEqual(((await b.call('GET', '/ui/m0000000002/meta')).body as { grants: string[] }).grants, [])
  } finally { await b.close() }
})

test('the host can block an interface with its secret; the person cannot unhide a blocked one', async () => {
  const b = await boot()
  try {
    assert.equal((await b.call('POST', '/ui/m0000000001/block', {}, 'Bearer wrong')).status, 401)
    assert.equal((await b.call('POST', '/ui/m0000000001/block', {}, `Bearer ${HOST_SECRET}`)).status, 200)
    const m = ((await b.call('GET', '/ui')).body as unknown as { id: string; blocked: boolean; hidden: boolean }[]).find((x) => x.id === 'm0000000001')!
    assert.equal(m.blocked, true)
    assert.equal((await b.call('PATCH', '/ui/m0000000001', { hidden: false })).status, 403)
    assert.equal((await b.call('GET', '/ui/m0000000001/meta')).status, 410)
  } finally { await b.close() }
})

test('the bot\'s own background calls to the model (memory, ideas) wait for the same consent', async () => {
  const { gateLlm } = await import('../src/compliance.ts')
  const sent: string[] = []
  let why: null | 'ai-consent' = 'ai-consent'
  const llm = gateLlm({ async chat(m: string) { sent.push(m); return '{}' }, async json(this: { chat(m: string): Promise<string> }, m: string) { return JSON.parse(await this.chat(m)) } }, async () => why)
  await assert.rejects(llm.chat('a'), /ai-consent/)
  await assert.rejects(llm.json('b'), /ai-consent/)
  why = null
  assert.equal(await llm.chat('c'), '{}')
  assert.deepEqual(sent, ['c'])
})

test('a link for a self-paired computer uses the app\'s own scheme with the computer\'s address', () => {
  assert.equal(moduleLink({ id: 'm1', publicUrl: undefined, origin: 'http://192.168.1.20:3850' }), 'deepseekbot://ui/m1?origin=http%3A%2F%2F192.168.1.20%3A3850')
  assert.equal(moduleLink({ id: 'm1', publicUrl: 'https://h.example/s/sb-1', origin: 'x' }), 'https://h.example/open/sb-1/ui/m1')
})

test('a computer the person runs serves the privacy policy and terms too, naming its provider', async () => {
  const b = await boot()
  try {
    const r = await fetch(`${b.bot.origin}/privacy`)
    assert.equal(r.status, 200)
    const html = await r.text()
    assert.match(html, /SiliconFlow/)
    assert.match(html, /DeepSeek V4\.1 Flash/)
    assert.match(await (await fetch(`${b.bot.origin}/terms?lang=zh`)).text(), /使用条款/)
  } finally { await b.close() }
})
