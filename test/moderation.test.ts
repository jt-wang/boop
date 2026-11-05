// The content filter: an OpenAI-compatible moderation endpoint checks
// finished replies on their way to the phone and interfaces before they are built.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { openAiModerator, ReplyFilter, interfaceText, type Moderator } from '../src/moderation.ts'
import { createBotServer, type Settings } from '../src/server.ts'
import { MemoryDeviceStore } from '../src/devices.ts'
import { Compliance } from '../src/compliance.ts'
import { Ui } from '../src/ui.ts'

/** Flags any text containing BADWORD, like a real endpoint's `results[].flagged`. */
const fakeMod = (calls: string[] = []): Moderator => ({ name: 'TestFilter', async check(t) { calls.push(t); return { flagged: /BADWORD/.test(t), categories: /BADWORD/.test(t) ? ['harassment'] : [] } } })
const tick = () => new Promise((r) => setTimeout(r, 20))

test('openAiModerator sends {model, input} with the key and reads flagged and the categories that are true', async () => {
  const seen: { auth?: string; body: { model: string; input: string } }[] = []
  const srv = createServer((req, res) => { let s = ''; req.on('data', (c) => { s += c }); req.on('end', () => { const body = JSON.parse(s); seen.push({ auth: req.headers.authorization, body }); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ id: 'modr-1', model: 'omni-moderation-latest', results: [{ flagged: /kill/.test(body.input), categories: { violence: /kill/.test(body.input), sexual: false } }] })) }) })
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
  try {
    const m = openAiModerator({ key: 'sk-mod', url: `http://127.0.0.1:${(srv.address() as { port: number }).port}/v1/moderations` })
    assert.equal(m.name, 'OpenAI')
    assert.deepEqual(await m.check('how to kill a process'), { flagged: true, categories: ['violence'] })
    assert.deepEqual(await m.check('hello'), { flagged: false, categories: [] })
    assert.equal(seen[0].auth, 'Bearer sk-mod')
    assert.deepEqual(seen[0].body, { model: 'omni-moderation-latest', input: 'how to kill a process' })
  } finally { srv.close() }
})

test('ReplyFilter: a finished flagged reply is sent again hidden; streaming rows are not checked; a known verdict hides at once', async () => {
  const calls: string[] = []
  const f = new ReplyFilter(fakeMod(calls))
  const out: { type: string; rows?: { id: string; text?: string; filtered?: boolean }[] }[] = []
  const rows = [{ kind: 'you', id: 'u1', text: 'hi' }, { kind: 'them', id: 't1', text: 'fine' }, { kind: 'them', id: 't2', text: 'BADWORD here' }, { kind: 'them', id: 't3', text: 'BADWORD stream', streaming: true }]
  f.pass({ type: 'snapshot', sessionId: 's', rows }, (x) => out.push(x as never))
  await tick()
  assert.deepEqual(calls, ['fine', 'BADWORD here'])
  assert.equal(out.length, 2)
  assert.deepEqual(out[1], { type: 'rows', sessionId: 's', rows: [{ kind: 'them', id: 't2', text: '', filtered: true }] })
  out.length = 0
  f.pass({ type: 'snapshot', sessionId: 's', rows }, (x) => out.push(x as never))
  await tick()
  assert.equal(out.length, 1, 'no new check, no second frame')
  assert.equal(out[0].rows!.find((r) => r.id === 't2')!.filtered, true)
  assert.equal(calls.length, 2)
  // deltas and status frames pass untouched
  f.pass({ type: 'delta', sessionId: 's' }, (x) => out.push(x as never))
  assert.equal(out.at(-1)!.type, 'delta')
})

test('ReplyFilter lets a reply through when the filter is down', async () => {
  const f = new ReplyFilter({ name: 'x', async check() { throw new Error('503') } })
  const out: unknown[] = []
  f.pass({ type: 'rows', rows: [{ kind: 'them', id: 't', text: 'BADWORD' }] }, (x) => out.push(x))
  await tick()
  assert.equal(out.length, 1)
})

test('interfaceText reads the title, string literals and JSX text, not identifiers', () => {
  const t = interfaceText('Quiz', `import { Text } from 'nsh'\nconst q = "What is BADWORD?"\nfunction App() { return <Text class="text-foreground">Pick one</Text> }`)
  assert.match(t, /Quiz/)
  assert.match(t, /What is BADWORD\?/)
  assert.match(t, /Pick one/)
  assert.doesNotMatch(t, /^nsh$/m)
})

test('the thread a phone follows comes through the filter; GET /me names the filter', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bot-mod-'))
  const harness = { kind: 'fake', events: { on() {}, clientId: 'c' }, async createSession() { return { sessionId: 'main' } }, async listSessions() { return [] }, async prompt() {}, async answer() {}, async cancel() { return true }, async rpc() { return {} as never }, async close() {},
    async follow(_id: string, onFrame: (f: unknown) => void) { setTimeout(() => onFrame({ type: 'snapshot', header: {}, records: [{ type: 'event', event: { type: 'assistant/message', time: 1, data: { message: { role: 'assistant', content: [{ type: 'text', text: 'BADWORD reply' }] } } } }] }), 10); return () => {} } }
  let settings: Settings = { assistantName: 'Nori', mainSessionId: 'main', language: 'auto' }
  const store = { get: async () => ({ ...settings }), set: async (p: Partial<Settings>) => { settings = { ...settings, ...p }; return { ...settings } } }
  const devices = new MemoryDeviceStore(); const token = await devices.issue('phone')
  const compliance = await Compliance.open(root, { settings: store, model: { provider: 'deepseek-official', model: 'deepseek-flash' }, origin: () => 'x', moderator: fakeMod() })
  const bot = await createBotServer({ dsh: { origin: 'http://127.0.0.1:9', cookie: 'c=1' }, devices, harness: harness as never, watcher: { clientId: 'c', on() {} } as never, host: '127.0.0.1', port: 0, settings: store, compliance })
  try {
    const me = await (await fetch(`${bot.origin}/me`, { headers: { authorization: `Bearer ${token}` } })).json() as { ai: { filter: string | null } }
    assert.equal(me.ai.filter, 'TestFilter')
    const ws = new WebSocket(`${bot.origin.replace('http', 'ws')}/events`, ['bearer', token])
    const frames: { type: string; rows?: { kind: string; text: string; filtered?: boolean }[] }[] = []
    ws.on('message', (d) => frames.push(JSON.parse(d.toString())))
    await new Promise((r) => ws.on('open', r))
    ws.send(JSON.stringify({ type: 'follow', sessionId: 'main' }))
    for (let i = 0; i < 100 && !frames.some((f) => f.rows?.some((r) => r.filtered)); i++) await tick()
    const hidden = frames.flatMap((f) => f.rows ?? []).find((r) => r.filtered)
    assert.ok(hidden, JSON.stringify(frames))
    assert.equal(hidden!.text, '')
    ws.close()
  } finally { await bot.close() }
})

const NSH = process.env.NSH_BIN ?? join(homedir(), '.local', 'bin', 'nsh')
test('an interface the filter flags is not built; the assistant is told why', { skip: !existsSync(NSH) }, async () => {
  const ui = await Ui.open(mkdtempSync(join(tmpdir(), 'bot-mod-ui-')), { nsh: NSH, hosts: ['127.0.0.1'] })
  ui.moderate = async (t) => fakeMod().check(t)
  const src = `import { mount, Text, View } from 'nsh'\nfunction App() { return <View class="flex-1"><Text>BADWORD</Text></View> }\nmount(App)\n`
  const r = await ui.create({ title: 'Mean card', source: src })
  assert.equal(r.ok, false)
  assert.match((r as { errors: string }).errors, /content filter/)
  assert.equal(ui.list().length, 0)
})
