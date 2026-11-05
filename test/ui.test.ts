import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { Tiles } from '../src/tiles.ts'
import { Ui, moduleHosts, importProblem, moduleAnswerPrompt, parseModuleAnswer, resultText, withSizeReport } from '../src/ui.ts'
import { startToolsServer } from '../src/tools.ts'
import { Memory } from '../src/memory.ts'
import { Scheduler } from '../src/scheduler.ts'
import { Goals } from '../src/goals.ts'
import { createBotServer } from '../src/server.ts'
import { MemoryDeviceStore } from '../src/devices.ts'
import { emptyThread, foldEvent, INJECT, type Row } from '../src/fold.ts'

// Generative UI, second layer: the assistant writes a whole NSH TSX module;
// the bot type-checks, compiles and signs it into a .nshpkg the phone verifies
// against the bot's root key and runs in a sheet. The module posts its result
// to POST /ui/:id/result with a one-time token; that becomes the person's next
// message. Needs the nsh CLI (~/.local/bin/nsh, 0.3.0 measured 2026-10-27).
const NSH = process.env.NSH_BIN ?? join(homedir(), '.local', 'bin', 'nsh')
const haveNsh = existsSync(NSH)

const TIP = `import { host, mount, signal, Text, View } from 'nsh'
const BILL = 42
function App() {
  const pct = signal(15)
  const tip = () => Math.round(BILL * pct()) / 100
  const send = async () => {
    const p = await host.call<{ origin: string; moduleId: string; token: string }>('launch.params')
    await fetch(\`\${p.origin}/ui/\${p.moduleId}/result\`, { method: 'POST', headers: { authorization: \`Bearer \${p.token}\`, 'content-type': 'application/json' }, body: JSON.stringify({ value: { tip: tip(), pct: pct() }, text: \`Tip €\${tip().toFixed(2)} (\${pct()}%)\` }) })
    host.call('ui.close').catch(() => {})
  }
  return (
    <View class="flex-1 bg-background p-4 gap-4">
      <Text class="text-foreground text-[17px] font-semibold">Bill €{BILL.toFixed(2)}</Text>
      <View class="flex-row gap-2">{[10, 15, 20].map((v) => (
        <View role="button" onPress={() => pct.set(v)} class={\`flex-1 items-center rounded-[10px] py-3 \${pct() === v ? 'bg-primary' : 'bg-card'}\`}><Text class={pct() === v ? 'text-primary-foreground font-semibold' : 'text-foreground'}>{v}%</Text></View>
      ))}</View>
      <Text class="text-foreground text-[34px] font-bold">€{tip().toFixed(2)}</Text>
      <View role="button" onPress={send} class="rounded-[12px] bg-primary py-3 items-center"><Text class="text-primary-foreground font-semibold">Use this</Text></View>
    </View>
  )
}
mount(App)
`
const TYPE_BROKEN = `import { mount, signal, Text, View } from 'nsh'
function App() { const n = signal(0); const bad: number = 'x'; return <View class="flex-1"><Text>{n()}{bad}</Text></View> }
mount(App)
`
const NAME_BROKEN = `import { mount, Text, View } from 'nsh'
function App() { return <View class="flex-1"><Text>hi</Text><Foo /></View> }
mount(App)
`

const openUi = async () => { const root = mkdtempSync(join(tmpdir(), 'bot-ui-')); return { root, ui: await Ui.open(root, { nsh: NSH, hosts: ['127.0.0.1'] }) } }

test('open creates a root key and a release key certified for dev.deepseekbot.ui.*; secrets are 0600; a second open keeps them', { skip: !haveNsh }, async () => {
  const { root, ui } = await openUi()
  const keys = join(root, 'keys')
  for (const f of ['root.secret', 'root.pub', 'release.secret', 'release.pub', 'release.cert']) assert.ok(existsSync(join(keys, f)), f)
  for (const f of ['root.secret', 'release.secret']) assert.equal(statSync(join(keys, f)).mode & 0o777, 0o600, `${f} mode`)
  assert.equal(statSync(keys).mode & 0o777, 0o700)
  assert.equal(ui.rootPublicKey, readFileSync(join(keys, 'root.pub'), 'utf8').trim())
  assert.match(ui.rootPublicKey, /^[A-Za-z0-9+/]{43}=$/)
  const cert = JSON.parse(readFileSync(join(keys, 'release.cert'), 'utf8')) as { body: string }
  assert.deepEqual(JSON.parse(Buffer.from(cert.body, 'base64').toString()).apps, ['dev.deepseekbot.ui.*'])
  assert.ok(ui.timings.keygenMs !== undefined && ui.timings.keygenMs >= 0)
  const again = await Ui.open(root, { nsh: NSH, hosts: ['127.0.0.1'] })
  assert.equal(again.rootPublicKey, ui.rootPublicKey)
  assert.equal(again.timings.keygenMs, undefined, 'no keygen the second time')
})

// In the container the bot is root and compiles modules as the cell user (runAs). The keys
// directory is root's and 0700, so the keys must be made as root: on 2026-10-28 a fresh Fly
// volume crashed the bot at boot (`chmod … keys/root.secret ENOENT`) because keygen ran as
// uid 1000 and failed. A uid this process cannot switch to stands in for "not root's".
test('open as root with runAs: the keys are made by root, not by the cell user', { skip: !haveNsh }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'bot-ui-'))
  const ui = await Ui.open(root, { nsh: NSH, hosts: ['127.0.0.1'], runAs: { uid: 4242, gid: 4242 }, getuid: () => 0 })
  for (const f of ['root.secret', 'root.pub', 'release.secret', 'release.pub', 'release.cert']) assert.ok(existsSync(join(root, 'keys', f)), f)
  assert.match(ui.rootPublicKey, /^[A-Za-z0-9+/]{43}=$/)
})

test('create: a good module is checked, published and verifies against the root; the source is kept; the bundle for the web exists', { skip: !haveNsh }, async () => {
  const { root, ui } = await openUi()
  const r = await ui.create({ title: 'Tip calculator', source: TIP })
  assert.ok(r.ok, JSON.stringify(r))
  const m = r.module
  assert.match(m.id, /^m[0-9a-f]{10}$/)
  assert.equal(m.title, 'Tip calculator')
  assert.match(m.token, /^[\w-]{32}$/)
  assert.ok(r.size > 1000 && r.size < 100_000, `size ${r.size}`)
  assert.equal(ui.packagePath(m.id), join(root, 'ui', m.id, `${m.id}.nshpkg`))
  const out = execFileSync(NSH, ['verify', ui.packagePath(m.id), '--root', join(root, 'keys', 'root.pub')], { encoding: 'utf8' })
  assert.match(out, new RegExp(`valid: dev\\.deepseekbot\\.ui\\.${m.id} `))
  assert.equal(readFileSync(ui.sourcePath(m.id), 'utf8'), TIP)
  assert.ok(existsSync(ui.bundlePath(m.id, 'bundle.js')))
  assert.ok(existsSync(ui.bundlePath(m.id, 'bundle.nshc')))
  const nsh = JSON.parse(readFileSync(join(root, 'ui', m.id, 'nsh.json'), 'utf8'))
  assert.deepEqual(nsh.capabilities, { network: { hosts: ['127.0.0.1'] }, host: ['launch.params', 'ui.close', 'ui.size'] }, 'the bot only, and only the host functions it needs (4.7.2)')
  // what was built reports its height inside the thread; the source kept is the assistant's own
  assert.match(readFileSync(join(root, 'ui', m.id, 'App.tsx'), 'utf8'), /'ui\.size'/)
  assert.equal(nsh.name, 'Tip calculator')
  // a wrong root refuses the package
  assert.throws(() => execFileSync(NSH, ['verify', ui.packagePath(m.id), '--root', join(root, 'keys', 'release.pub')], { encoding: 'utf8', stdio: 'pipe' }))
  // the module is remembered across a restart
  const again = await Ui.open(root, { nsh: NSH, hosts: ['127.0.0.1'] })
  assert.equal(again.module(m.id)?.token, m.token)
})

// Inside the thread (the Android shell's InlineModule, 2026-11-02) a module is as tall as what it draws. It cannot know
// that it runs there, and the assistant should not have to write for it: the build mounts its root inside a view that
// measures it and tells the shell (`ui.size`) when the app says `inline`. Full screen it mounts as written.
test('withSizeReport: mount from nsh goes through a measuring root; the lines stay where they were; other sources are left alone', () => {
  const out = withSizeReport(TIP)
  const lines = TIP.split('\n')
  assert.equal(out.split('\n')[0], "import { host, mount as __nshMount, signal, Text, View } from 'nsh'")
  assert.deepEqual(out.split('\n').slice(1, lines.length), lines.slice(1), 'errors from the check still point at the assistant\'s lines')
  assert.match(out, /function mount\(/)
  assert.match(out, /'ui\.size'/)
  assert.match(out, /inline/)
  assert.equal(withSizeReport('import { mount, View } from "nsh"\nmount(App)').split('\n')[0], 'import { mount as __nshMount, View } from "nsh"')
  for (const src of ['import { render } from "other"\nrender()', 'import { mount as m, View } from "nsh"\nm(App)', 'import * as N from "nsh"\nN.mount(App)']) assert.equal(withSizeReport(src), src)
})

// The model writes React's `key` on list items (test/genui.eval packing, 2026-11-01: "Property 'key' does not exist
// on type 'ViewProps'", then a second ui call). NSH ignores it at runtime (it warns "unsupported prop `key`", the
// list renders and updates, measured with nsh 0.3.0); the check accepts it, and still refuses a prop that is wrong.
test('create: a list with React-style key props builds; an unknown prop still does not', { skip: !haveNsh }, async () => {
  const { ui } = await openUi()
  const keyed = TIP.replace('<View role="button" onPress={() => pct.set(v)}', '<View key={v} role="button" onPress={() => pct.set(v)}')
  assert.notEqual(keyed, TIP)
  const r = await ui.create({ title: 'Keyed', source: keyed })
  assert.ok(r.ok, JSON.stringify(r))
  const bad = await ui.create({ title: 'Bad', source: TIP.replace('<View role="button" onPress={() => pct.set(v)}', '<View bogus={v} role="button" onPress={() => pct.set(v)}') })
  assert.equal(bad.ok, false)
  assert.match((bad as { errors: string }).errors, /bogus/)
})

// Interfaces are short throwaway code; TypeScript's strict mode turned working JavaScript into a second ui call
// (test/genui.eval packing, 2026-11-01: \`signal({ items: [] })\` typed never[], "\`{}\` has no index signature").
// The check is there to catch misuse of NSH's API, which it still does.
const LOOSE = `import { mount, signal, Text, View } from 'nsh'
const state = signal({ items: [], counts: {} })
function App() {
  const add = (n: string) => { const s = state(); state.set({ items: s.items.concat([{ n, group: 'a' }]), counts: { ...s.counts, [n]: (s.counts[n] ?? 0) + 1 } }) }
  return <View class="flex-1 p-4">{state().items.map((i) => <Text>{i.n}</Text>)}<View role="button" onPress={() => add('x')}><Text>Add</Text></View></View>
}
mount(App)
`
test('create: loose model-style typing builds; misuse of the NSH API still does not', { skip: !haveNsh }, async () => {
  const { ui } = await openUi()
  const r = await ui.create({ title: 'Loose', source: LOOSE })
  assert.ok(r.ok, JSON.stringify(r))
  const bad = await ui.create({ title: 'Bad', source: LOOSE.replace('<Text>Add</Text>', '<Text size={3}>Add</Text>') })
  assert.equal(bad.ok, false)
})

// nsh downloads its TypeScript compiler into its cache, and HOME is the module's own folder, so every interface
// downloaded 26 MB again and kept it next to the module (Library/Caches/nsh/typescript-7.0.2-*, three quiz runs
// 2026-11-01). One cache for all modules: the compiler comes down once.
test('create: modules share one compiler cache; none keeps a copy in its own folder', { skip: !haveNsh || Boolean(process.env.NSH_TSC) }, async () => {
  const { root, ui } = await openUi()
  const a = await ui.create({ title: 'One', source: TIP }); assert.ok(a.ok, JSON.stringify(a))
  const t0 = Date.now()
  const b = await ui.create({ title: 'Two', source: TIP }); assert.ok(b.ok, JSON.stringify(b))
  for (const r of [a, b]) assert.equal(existsSync(join(root, 'ui', r.module.id, 'Library')), false, `${r.module.id} keeps its own cache`)
  assert.ok(existsSync(join(root, 'ui', '.cache')), 'the shared cache')
  assert.ok(Date.now() - t0 < 30_000)
})

test('create with permissions: the package declares only what was asked (https links, the clipboard), nothing is granted yet; unknown ones are dropped', { skip: !haveNsh }, async () => {
  const { root, ui } = await openUi()
  const r = await ui.create({ title: 'Links', source: TIP, permissions: ['openUrl', 'clipboard', 'camera' as never] })
  assert.ok(r.ok, JSON.stringify(r))
  assert.deepEqual(r.module.permissions, ['openUrl', 'clipboard'])
  assert.equal(r.module.grants, undefined)
  const nsh = JSON.parse(readFileSync(join(root, 'ui', r.module.id, 'nsh.json'), 'utf8'))
  assert.deepEqual(nsh.capabilities, { network: { hosts: ['127.0.0.1'] }, host: ['launch.params', 'ui.close', 'ui.size'], openUrl: { schemes: ['https'] }, clipboard: true })
  const out = execFileSync(NSH, ['verify', ui.packagePath(r.module.id), '--root', join(root, 'keys', 'root.pub')], { encoding: 'utf8' })
  assert.match(out, /valid/)
})

test('create: a type error and an unknown component come back as errors the assistant can fix', { skip: !haveNsh }, async () => {
  const { ui } = await openUi()
  const t = await ui.create({ title: 'Broken', source: TYPE_BROKEN })
  assert.equal(t.ok, false)
  assert.match((t as { errors: string }).errors, /TS2322/)
  const n = await ui.create({ title: 'Broken', source: NAME_BROKEN })
  assert.equal(n.ok, false)
  assert.match((n as { errors: string }).errors, /TS2304: Cannot find name 'Foo'/) // the type check sees it before the bundler's "<Foo> names nothing in scope"

  assert.equal(ui.list().length, 0, 'a failed module is not kept')
})

test('the module marker round-trips; resultText prefers the module\'s words, else the value as "key: value"', () => {
  const p = moduleAnswerPrompt('m0123456789', 'Tip €6.30 (15%)')
  assert.ok(p.startsWith(INJECT))
  assert.deepEqual(parseModuleAnswer(p), { moduleId: 'm0123456789', text: 'Tip €6.30 (15%)' })
  assert.equal(parseModuleAnswer(`${INJECT}card c1\nFri`), null)
  assert.equal(resultText({ value: { tip: 6.3 }, text: 'Tip €6.30' }), 'Tip €6.30')
  assert.equal(resultText({ value: { tip: 6.3, pct: 15 } }), 'tip: 6.3, pct: 15')
  assert.equal(resultText({ value: 'yes' }), 'yes')
  assert.equal(resultText({}), '(no value)')
})

test('fold: a ui call is a step while it builds; "Shown. module=…" turns it into a module row; the marker message marks it answered', () => {
  const s = emptyThread()
  foldEvent(s, { type: 'assistant/message', time: 2, data: { message: { role: 'assistant', content: [
    { type: 'text', text: 'Here you go.' },
    { type: 'tool-call', id: 'call7', name: 'mcp__bot__ui', arguments: JSON.stringify({ title: 'Tip calculator', source: TIP }) },
  ] } } })
  assert.deepEqual(s.rows.map((r) => r.kind), ['them', 'step'])
  assert.equal(s.statusText, 'Building an interface…')
  foldEvent(s, { type: 'tool/result', data: { message: { toolCallId: 'call7', content: [{ type: 'text', text: 'Shown. module=m0123456789 — it opens on their phone; their result arrives as their next message.' }] } } })
  assert.deepEqual(s.rows.map((r) => r.kind), ['them', 'module'])
  const row = s.rows[1] as Extract<Row, { kind: 'module' }>
  assert.equal(row.id, 'call7'); assert.equal(row.moduleId, 'm0123456789'); assert.equal(row.title, 'Tip calculator'); assert.equal(row.url, '/ui/m0123456789.nshpkg'); assert.equal(row.answer, undefined)
  foldEvent(s, { type: 'user/message', time: 3, data: { id: 'u2', content: [{ type: 'text', text: moduleAnswerPrompt('m0123456789', 'Tip €6.30 (15%)') }], source: { kind: 'user' } } })
  assert.deepEqual(s.rows.map((r) => r.kind), ['them', 'module', 'you'])
  assert.equal((s.rows[1] as Extract<Row, { kind: 'module' }>).answer, 'Tip €6.30 (15%)')
  assert.equal((s.rows[2] as Extract<Row, { kind: 'you' }>).text, 'Tip €6.30 (15%)')
})

test('fold: a ui call that failed to compile stays a step with the errors as its output', () => {
  const s = emptyThread()
  foldEvent(s, { type: 'assistant/message', time: 2, data: { message: { role: 'assistant', content: [{ type: 'tool-call', id: 'call8', name: 'mcp__bot__ui', arguments: JSON.stringify({ title: 'Broken', source: 'x' }) }] } } })
  foldEvent(s, { type: 'tool/result', data: { message: { toolCallId: 'call8', content: [{ type: 'text', text: 'Compile errors — fix the source and call ui again:\nApp.tsx(4,9): error TS2322' }] } } })
  assert.deepEqual(s.rows.map((r) => r.kind), ['step'])
  assert.match((s.rows[0] as Extract<Row, { kind: 'step' }>).output ?? '', /TS2322/)
})

test('fold: a module built during a quiet turn (reminder) still shows', () => {
  const s = emptyThread()
  foldEvent(s, { type: 'user/message', time: 1, data: { id: 'i1', content: [{ type: 'text', text: `${INJECT}[Reminder] weigh in` }], source: { kind: 'user' } } })
  foldEvent(s, { type: 'assistant/message', time: 2, data: { message: { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'mcp__bot__ui', arguments: JSON.stringify({ title: 'Weight', source: 'x' }) }] } } })
  assert.equal(s.rows.length, 0)
  foldEvent(s, { type: 'tool/result', data: { message: { toolCallId: 'c1', content: [{ type: 'text', text: 'Shown. module=mabcdef0123' }] } } })
  assert.deepEqual(s.rows.map((r) => r.kind), ['module'])
})

test('the ui tool over MCP: compile errors come back to the assistant (the fix loop); a good module answers Shown with its id', { skip: !haveNsh }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tools-ui-'))
  writeFileSync(join(dir, 'USER.md'), '# USER.md\n'); writeFileSync(join(dir, 'MEMORY.md'), '# MEMORY.md\n')
  const ui = await Ui.open(join(dir, 'home'), { nsh: NSH, hosts: ['127.0.0.1'] })
  const srv = await startToolsServer({ memory: new Memory(dir), scheduler: await Scheduler.open(join(dir, 's.json'), { onDue: async () => {} }), goals: await Goals.open(join(dir, 'g.json')), notify: async () => {}, ui })
  try {
    const c = new Client({ name: 'test', version: '0' })
    await c.connect(new StreamableHTTPClientTransport(new URL(srv.url), { requestInit: { headers: { authorization: `Bearer ${srv.secret}` } } }))
    const textOf = (r: unknown) => ((r as { content: { type: string; text?: string }[] }).content).filter((x) => x.type === 'text').map((x) => x.text).join('')
    const bad = textOf(await c.callTool({ name: 'ui', arguments: { title: 'Broken', source: TYPE_BROKEN } }))
    assert.match(bad, /Compile errors/); assert.match(bad, /TS2322/); assert.match(bad, /call ui again/)
    const good = textOf(await c.callTool({ name: 'ui', arguments: { title: 'Tip calculator', source: TIP } }))
    assert.match(good, /^Shown\. module=m[0-9a-f]{10} /)
    assert.match(good, /next message/)
    assert.equal(ui.list().length, 1)
  } finally { await srv.close() }
})

test('the ui tool without nsh on this computer says so instead of failing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tools-noui-'))
  writeFileSync(join(dir, 'USER.md'), '# USER.md\n'); writeFileSync(join(dir, 'MEMORY.md'), '# MEMORY.md\n')
  const ui = await Ui.open(join(dir, 'home'), { nsh: join(dir, 'no-such-nsh'), hosts: ['127.0.0.1'] })
  assert.equal(ui.available, false)
  assert.equal(ui.rootPublicKey, '')
  const srv = await startToolsServer({ memory: new Memory(dir), scheduler: await Scheduler.open(join(dir, 's.json'), { onDue: async () => {} }), goals: await Goals.open(join(dir, 'g.json')), notify: async () => {}, ui })
  try {
    const c = new Client({ name: 'test', version: '0' })
    await c.connect(new StreamableHTTPClientTransport(new URL(srv.url), { requestInit: { headers: { authorization: `Bearer ${srv.secret}` } } }))
    const r = await c.callTool({ name: 'ui', arguments: { title: 'x', source: TIP } })
    assert.match(((r as { content: { text?: string }[] }).content[0].text ?? ''), /not available on this computer.*show/)
  } finally { await srv.close() }
})

test('routes: /me carries the root key; the package, bundle, source and meta need the device; the result needs the module token, once, and lands in the bound thread', { skip: !haveNsh }, async () => {
  const { root, ui } = await openUi()
  const made = await ui.create({ title: 'Tip calculator', source: TIP })
  assert.ok(made.ok); const m = made.module
  const prompts: { sessionId: string; text: string }[] = []
  const harness = { kind: 'fake', events: { on() {}, clientId: 'c' }, async createSession() { return { sessionId: 'p1' } }, async listSessions() { return [] }, async prompt(sessionId: string, text: string) { prompts.push({ sessionId, text }) }, async answer() {}, async cancel() { return true }, async rpc() { return {} as never }, async close() {}, async follow() { return () => {} } }
  const devices = new MemoryDeviceStore()
  let settings = { assistantName: 'Nori', mainSessionId: 'main-1' as string | null, language: 'en' }
  const bot = await createBotServer({ dsh: { origin: 'http://127.0.0.1:9', cookie: 'c=1' }, devices, harness: harness as never, host: '127.0.0.1', port: 0, workspace: root, ui, settings: { get: async () => ({ ...settings }), set: async (p) => { settings = { ...settings, ...p } as typeof settings; return { ...settings } } } })
  try {
    const token = await devices.issue('phone')
    const auth = { authorization: `Bearer ${token}` }
    const me = await (await fetch(`${bot.origin}/me`, { headers: auth })).json() as { uiRootPublicKey: string }
    assert.equal(me.uiRootPublicKey, ui.rootPublicKey)
    assert.equal((await fetch(`${bot.origin}/ui/${m.id}.nshpkg`)).status, 401)
    const pkg = await fetch(`${bot.origin}/ui/${m.id}.nshpkg?session=side-7`, { headers: auth })
    assert.equal(pkg.status, 200); assert.equal(pkg.headers.get('content-type'), 'application/octet-stream')
    assert.equal((await pkg.arrayBuffer()).byteLength, statSync(ui.packagePath(m.id)).size)
    const bundle = await fetch(`${bot.origin}/ui/${m.id}/bundle.js`, { headers: auth })
    assert.equal(bundle.status, 200); assert.match(await bundle.text(), /launch\.params/)
    assert.equal((await fetch(`${bot.origin}/ui/${m.id}/bundle.nshc`, { headers: auth })).status, 200)
    const src = await fetch(`${bot.origin}/ui/${m.id}/source`, { headers: auth })
    assert.equal(src.status, 200); assert.equal(await src.text(), TIP)
    const meta = await (await fetch(`${bot.origin}/ui/${m.id}/meta`, { headers: auth })).json() as { token: string; title: string; answered: boolean }
    assert.equal(meta.token, m.token); assert.equal(meta.title, 'Tip calculator'); assert.equal(meta.answered, false)
    assert.equal((await fetch(`${bot.origin}/ui/nope.nshpkg`, { headers: auth })).status, 404)
    // the module posts its result with its own token (never the device's)
    const post = (t: string, body: unknown) => fetch(`${bot.origin}/ui/${m.id}/result`, { method: 'POST', headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    assert.equal((await post(token, { value: 1 })).status, 401)
    assert.equal((await post('wrong', { value: 1 })).status, 401)
    const ok = await post(m.token, { value: { tip: 6.3 }, text: 'Tip €6.30 (15%)' })
    assert.equal(ok.status, 200)
    assert.deepEqual(prompts, [{ sessionId: 'side-7', text: moduleAnswerPrompt(m.id, 'Tip €6.30 (15%)') }])
    assert.equal((await post(m.token, { value: 2 })).status, 409, 'one result per module')
    assert.equal(((await (await fetch(`${bot.origin}/ui/${m.id}/meta`, { headers: auth })).json()) as { answered: boolean }).answered, true)
    // a module never downloaded with a session goes to the main thread
    const other = await ui.create({ title: 'Other', source: TIP }); assert.ok(other.ok)
    assert.equal((await fetch(`${bot.origin}/ui/${other.module.id}/result`, { method: 'POST', headers: { authorization: `Bearer ${other.module.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ value: { a: 1 } }) })).status, 200)
    assert.equal(prompts.at(-1)?.sessionId, 'main-1'); assert.equal(prompts.at(-1)?.text, moduleAnswerPrompt(other.module.id, 'a: 1'))
  } finally { await bot.close() }
})

// A phone app with no native shell (the Android APK NSH packages) cannot run a signed package itself, so Open showed
// 「请在手机 App 里打开。」 there (the owner, 2026-10-27). It asks the bot for a play page instead: POST /ui/:id/play (the
// device) gives a one-time address; that page, opened in the phone's browser, runs the module's bundle with the
// module's own result token, and never sees the device's token.
test('play page: a one-time address from the device; the page runs the bundle with the module token, once; bound to the thread', { skip: !haveNsh }, async () => {
  const { root, ui } = await openUi()
  const made = await ui.create({ title: 'INTC / HOOD 日线图', source: TIP })
  assert.ok(made.ok); const m = made.module
  const prompts: { sessionId: string; text: string }[] = []
  const harness = { kind: 'fake', events: { on() {}, clientId: 'c' }, async createSession() { return { sessionId: 'p1' } }, async listSessions() { return [] }, async prompt(sessionId: string, text: string) { prompts.push({ sessionId, text }) }, async answer() {}, async cancel() { return true }, async rpc() { return {} as never }, async close() {}, async follow() { return () => {} } }
  const devices = new MemoryDeviceStore()
  const appDir = mkdtempSync(join(tmpdir(), 'app-'))
  for (const f of ['nsh.0a1b2c3d4e.js', 'nsh.0a1b2c3d4e.wasm', 'harden.0a1b2c3d4e.nshc', 'host.0a1b2c3d4e.js']) writeFileSync(join(appDir, f), '')
  const bot = await createBotServer({ dsh: { origin: 'http://127.0.0.1:9', cookie: 'c=1' }, devices, harness: harness as never, host: '127.0.0.1', port: 0, workspace: root, ui, appDir, settings: { get: async () => ({ assistantName: 'Nori', mainSessionId: 'main-1', language: 'zh' }), set: async (p) => p as never } })
  try {
    const token = await devices.issue('phone')
    const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
    assert.equal((await fetch(`${bot.origin}/ui/${m.id}/play`, { method: 'POST' })).status, 401)
    const { url } = await (await fetch(`${bot.origin}/ui/${m.id}/play`, { method: 'POST', headers: auth, body: JSON.stringify({ session: 'side-9' }) })).json() as { url: string }
    assert.match(url, new RegExp(`^/ui/${m.id}/play\\?ticket=[\\w-]{20,}$`))
    assert.equal((await fetch(`${bot.origin}/ui/${m.id}/play`)).status, 401)
    assert.equal((await fetch(`${bot.origin}/ui/${m.id}/play?ticket=nope`)).status, 401)
    const page = await fetch(`${bot.origin}${url}`, { headers: { 'accept-language': 'zh-CN,zh;q=0.9' } })
    assert.equal(page.status, 200); assert.match(page.headers.get('content-type') ?? '', /text\/html/)
    const html = await page.text()
    assert.ok(html.includes(m.token), 'the module token, for its result')
    assert.ok(!html.includes(token), 'never the device token')
    assert.ok(html.includes(readFileSync(ui.bundlePath(m.id, 'bundle.nshc')).toString('base64')), 'the bundle, inline')
    assert.match(html, /"host\.0a1b2c3d4e\.js"/); assert.match(html, /"nsh\.0a1b2c3d4e\.wasm"/); assert.match(html, /"harden\.0a1b2c3d4e\.nshc"/)
    assert.match(html, /lang="zh-CN"/); assert.match(html, /INTC \/ HOOD 日线图/)
    assert.match(html, /完成/); assert.match(html, /CanvasText/) // the sheet's Done in the person's language, black or white, never blue
    assert.match(html, /正在打开…/); assert.match(html, /html\[data-app\] \.ui-sheet>div:first-child\{display:none!important\}/) // inside the app's sheet the app draws the bar
    assert.match(html, /postMessage\?\.\('closed'\)/) // and hears when the module closed
    assert.match(html, /q\.get\('scheme'\)/) // the app's light or dark, which an Android web view does not pass on
    assert.equal((await fetch(`${bot.origin}${url}`)).status, 401, 'once')
    // the runtime files need the module token; they never become an unauthenticated tenant path
    assert.equal((await fetch(`${bot.origin}/ui/${m.id}/runtime/nsh.0a1b2c3d4e.js`)).status, 401)
    assert.equal((await fetch(`${bot.origin}/ui/${m.id}/runtime/nsh.0a1b2c3d4e.js?token=nope`)).status, 401)
    assert.equal((await fetch(`${bot.origin}/ui/${m.id}/runtime/nsh.0a1b2c3d4e.js?token=${encodeURIComponent(m.token)}`)).status, 200)
    // an unknown module is indistinguishable from a wrong token
    assert.equal((await fetch(`${bot.origin}/ui/nope/result`, { method: 'POST', headers: { authorization: 'Bearer nope', 'content-type': 'application/json' }, body: '{}' })).status, 401)
    // the session it was opened from gets the result
    assert.equal((await fetch(`${bot.origin}/ui/${m.id}/result`, { method: 'POST', headers: { authorization: `Bearer ${m.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ text: 'ok' }) })).status, 200)
    assert.equal(prompts.at(-1)?.sessionId, 'side-9')
    // a ticket is for its own module
    const other = await ui.create({ title: 'Other', source: TIP }); assert.ok(other.ok)
    const t2 = await (await fetch(`${bot.origin}/ui/${m.id}/play`, { method: 'POST', headers: auth, body: '{}' })).json() as { url: string }
    assert.equal((await fetch(`${bot.origin}${t2.url.replace(m.id, other.module.id)}`)).status, 401)
  } finally { await bot.close() }
})

// The owner's APK talks to a computer the host runs: everything goes through `<host>/s/<id>/`, and the host lets a
// request in only with the account's or the phone's token. The browser that opens the play page carries neither, the
// page's runtime files must come from that same computer (not from the host's root), and the module posts its result
// with its own token. Each of the three was refused by the host or went to the wrong place.
test('hosted: the play page, its runtime and the module\'s result reach the computer through the host', { skip: !haveNsh }, async () => {
  const { createHostServer } = await import('../src/host/server.ts')
  const { root, ui } = await openUi()
  const made = await ui.create({ title: 'INTC / HOOD 日线图', source: TIP })
  assert.ok(made.ok); const m = made.module
  const prompts: { sessionId: string; text: string }[] = []
  const harness = { kind: 'fake', events: { on() {}, clientId: 'c' }, async createSession() { return { sessionId: 'p1' } }, async listSessions() { return [] }, async prompt(sessionId: string, text: string) { prompts.push({ sessionId, text }) }, async answer() {}, async cancel() { return true }, async rpc() { return {} as never }, async close() {}, async follow() { return () => {} } }
  const appDir = mkdtempSync(join(tmpdir(), 'app-'))
  const runtime: Record<string, string> = { 'nsh.0a1b2c3d4e.js': 'export const js = 1', 'nsh.0a1b2c3d4e.wasm': 'wasm-bytes', 'harden.0a1b2c3d4e.nshc': 'harden-bytes', 'host.0a1b2c3d4e.js': 'export const host = 1' }
  for (const [f, body] of Object.entries(runtime)) writeFileSync(join(appDir, f), body)
  writeFileSync(join(appDir, 'index.html'), '<!doctype html>')
  const secret = 'host-secret-0123456789abcdef'
  const bot = await createBotServer({ dsh: { origin: 'http://127.0.0.1:9', cookie: 'c=1' }, devices: new MemoryDeviceStore(), harness: harness as never, watcher: { clientId: 'c', on() {} } as never, host: '127.0.0.1', port: 0, workspace: root, ui, appDir, hostSecret: secret, tiles: new Tiles(mkdtempSync(join(tmpdir(), 'tiles-')), async () => new Response('png')), settings: { get: async () => ({ assistantName: 'Nori', mainSessionId: 'main-1', language: 'zh' }), set: async (p) => p as never } })
  let state: 'running' | 'missing' = 'missing'
  const provider = { kind: 'one', async create(id: string) { state = 'running'; return { id, origin: bot.origin } }, async get(id: string) { return state === 'missing' ? null : { id, origin: bot.origin } }, async start() {}, async stop() {}, async remove() {}, async status() { return state } }
  const host = await createHostServer({ provider, image: 'x', accountsPath: join(mkdtempSync(join(tmpdir(), 'host-')), 'accounts.json'), hostSecret: secret, sandboxEnv: {}, devSignIn: true, host: '127.0.0.1', port: 0 })
  try {
    const { accountToken } = await (await fetch(`${host.origin}/host/sign-in`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'a@example.com' }) })).json() as { accountToken: string }
    const sb = await (await fetch(`${host.origin}/host/sandbox`, { method: 'POST', headers: { authorization: `Bearer ${accountToken}` } })).json() as { state: string; origin: string; token: string }
    assert.equal(sb.state, 'ready', JSON.stringify(sb))
    // the app asks with the phone's token, as it does for every request
    const { url } = await (await fetch(`${sb.origin}/ui/${m.id}/play`, { method: 'POST', headers: { authorization: `Bearer ${sb.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ session: 'side-9' }) })).json() as { url: string }
    // the page itself: opened with no token at all
    const pageUrl = `${sb.origin}${url}`
    const page = await fetch(pageUrl)
    assert.equal(page.status, 200, 'the host lets the one-time page through')
    const html = await page.text()
    assert.ok(!html.includes(sb.token), 'never the phone token')
    // its runtime from the same computer, relative to the page; nothing from the host's root
    assert.doesNotMatch(html, /["'`]\/(nsh|harden|host)\.[0-9a-f]+\./, 'no root-absolute runtime paths')
    assert.ok(html.includes("new URL('../../', location.href)"), 'the page finds its runtime and its computer from its own address')
    const base = new URL('../../', pageUrl)
    assert.equal(base.href, `${sb.origin}/`)
    const runtimeUrl = (f: string) => `${sb.origin}/ui/${m.id}/runtime/${f}?token=${encodeURIComponent(m.token)}`
    for (const [f, body] of Object.entries(runtime)) {
      const r = await fetch(runtimeUrl(f))
      assert.equal(r.status, 200, f); assert.equal(await r.text(), body)
    }
    assert.equal((await fetch(`${sb.origin}/ui/${m.id}/runtime/nsh.0a1b2c3d4e.js`)).status, 401, 'the runtime needs the module token')
    assert.equal((await fetch(`${sb.origin}/nsh.0a1b2c3d4e.js`)).status, 401, 'the old root-runtime opening is closed')
    assert.equal((await fetch(pageUrl)).status, 401, 'the play ticket is one-time')
    assert.equal((await fetch(`${sb.origin}/me`)).status, 401, 'the rest still needs a token')
    assert.equal((await fetch(`${sb.origin}/index.html`)).status, 401, 'only the module resources pass')
    // a valid sandbox id with a bad module token is the same 401 as an unknown sandbox id
    assert.equal((await fetch(`${sb.origin}/ui/${m.id}/runtime/nsh.0a1b2c3d4e.js?token=nope`)).status, 401)
    const unknown = await fetch(`${host.origin}/s/nope-nope/ui/${m.id}/runtime/nsh.0a1b2c3d4e.js?token=${encodeURIComponent(m.token)}`)
    assert.equal(unknown.status, 401)
    // a map's tiles through the host: the canvas sends no header, so the module token is in the address (measured 2026-11-02: without this the host answered 401 and hosted maps stayed empty)
    const tile = `${sb.origin}/ui/${m.id}/tiles/5/1/2.png`
    assert.equal((await fetch(tile)).status, 401, 'no token, no tile')
    assert.equal((await fetch(`${tile}?token=nope`)).status, 401)
    assert.equal((await fetch(`${tile}?token=${encodeURIComponent(m.token)}`)).status, 200)
    // the module's result, with its own token
    const other = await ui.create({ title: 'Other', source: TIP }); assert.ok(other.ok)
    assert.equal((await fetch(`${sb.origin}/ui/${m.id}/result`, { method: 'POST', headers: { authorization: `Bearer ${other.module.token}`, 'content-type': 'application/json' }, body: '{}' })).status, 401, 'another module token cannot answer this one')
    assert.equal((await fetch(`${sb.origin}/ui/nope/result`, { method: 'POST', headers: { authorization: 'Bearer nope-nope-nope-nope', 'content-type': 'application/json' }, body: '{}' })).status, 401, 'unknown module and bad token look the same')
    const res = await fetch(`${sb.origin}/ui/${m.id}/result`, { method: 'POST', headers: { authorization: `Bearer ${m.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ text: '看过了' }) })
    assert.equal(res.status, 200, 'the host lets the module\'s result through; the bot checks its token')
    assert.deepEqual(prompts.at(-1), { sessionId: 'side-9', text: moduleAnswerPrompt(m.id, '看过了') })
    assert.equal((await fetch(`${sb.origin}/ui/${m.id}/result`, { method: 'POST', headers: { authorization: 'Bearer nope-nope-nope-nope', 'content-type': 'application/json' }, body: '{}' })).status, 401, 'a wrong token: the bot answers')
  } finally { await host.close(); await bot.close() }
})

test("a module's nsh.json carries the app's theme tokens so it does not fall back to NSH's defaults", async () => {
  const { readFileSync } = await import('node:fs')
  const nshJson = JSON.parse(readFileSync('mobile/nsh.json', 'utf8')) as { theme: { cssVars: { light: { primary: string } } } }
  const { MODULE_THEME_FOR_TEST } = await import('../src/ui.ts')
  assert.equal(MODULE_THEME_FOR_TEST.cssVars.light.primary, nshJson.theme.cssVars.light.primary)
})

test('a ui module cannot import a bot file: only the nsh runtime is allowed', async () => {
  const { root, ui } = await openUi()
  const secret = join(root, 'connector-secrets.json')
  writeFileSync(secret, JSON.stringify({ token: 'SENTINEL-should-not-be-bundled' }))
  const source = `import { mount, Text, View } from 'nsh'
import data from '${secret}'
function App() { return <View class="flex-1"><Text>{JSON.stringify(data)}</Text></View> }
mount(App)
`
  const r = await ui.create({ title: 'leak', source })
  assert.equal(r.ok, false, 'the compiler must not read a bot file')
  assert.match(r.errors, /only import from "nsh"/)
})

test('the ui import guard refuses comments, template literals and re-exports too', () => {
  const secret = '/data/connector-secrets.json'
  for (const source of [
    `import data from '${secret}'`,
    `import(/* comment */ '${secret}')`,
    `import(\`${secret}\`)`,
    `const fs = require('${secret}')`,
    `export { token } from '${secret}'`,
    `import { mount } from 'nsh'\nimport(// line\n'${secret}')`,
  ]) assert.match(String(importProblem(source)), /only import from "nsh"/, source)
  assert.equal(importProblem(`import { mount, Text } from 'nsh'\nimport type { X } from "nsh"\nconst n = 1`), null)
})

test('the ui compiler does not inherit the bot environment (no model key in a child)', { skip: !haveNsh }, async () => {
  const { writeFileSync, chmodSync, mkdtempSync } = await import('node:fs')
  const dir = mkdtempSync(join(tmpdir(), 'nsh-env-'))
  const out = join(dir, 'env.txt')
  const fake = join(dir, 'nsh-fake')
  writeFileSync(fake, `#!/bin/sh\nenv > '${out}'\nexit 1\n`)
  chmodSync(fake, 0o755)
  process.env.UI_ENV_SENTINEL = 'SENTINEL-should-not-reach-the-compiler'
  try {
    const { ui } = await openUi()
    Object.assign(ui, { nsh: fake })
    const r = await ui.create({ title: 'x', source: `import { mount } from 'nsh'\nmount(() => null)` })
    assert.equal(r.ok, false)
    assert.doesNotMatch(readFileSync(out, 'utf8'), /UI_ENV_SENTINEL/)
  } finally { delete process.env.UI_ENV_SENTINEL }
})

// On the hosted computer `nsh check` tried to download TypeScript 7
// from registry.npmjs.org on every build and was refused. The image ships it and names it in
// NSH_TSC; the compiler's minimal environment has to carry that one name through.
test('the ui compiler gets the TypeScript the image ships (NSH_TSC), and still nothing else of the bot environment', { skip: !haveNsh }, async () => {
  const { writeFileSync, chmodSync, mkdtempSync } = await import('node:fs')
  const dir = mkdtempSync(join(tmpdir(), 'nsh-tsc-'))
  const out = join(dir, 'env.txt')
  const fake = join(dir, 'nsh-fake')
  writeFileSync(fake, `#!/bin/sh\nenv > '${out}'\nexit 1\n`)
  chmodSync(fake, 0o755)
  const before = process.env.NSH_TSC
  process.env.NSH_TSC = '/opt/typescript/lib/tsc'
  process.env.UI_ENV_SENTINEL = 'SENTINEL-should-not-reach-the-compiler'
  try {
    const { ui } = await openUi()
    Object.assign(ui, { nsh: fake })
    await ui.create({ title: 'x', source: `import { mount } from 'nsh'\nmount(() => null)` })
    const env = readFileSync(out, 'utf8')
    assert.match(env, /^NSH_TSC=\/opt\/typescript\/lib\/tsc$/m)
    assert.doesNotMatch(env, /UI_ENV_SENTINEL/)
  } finally {
    if (before === undefined) delete process.env.NSH_TSC; else process.env.NSH_TSC = before
    delete process.env.UI_ENV_SENTINEL
  }
})

// Measured 2026-11-02 on Fly with the Android app: every tile refused ("a canvas image … is not granted: add
// `example-sandbox.fly.dev` to capabilities.network"), because the module declared only the sandbox's own addresses.
test('a module on a hosted computer may reach the address the phone uses, the host in front of it', () => {
  const hosts = moduleHosts({ publicOrigin: 'http://[fdaa::2]:3850', publicUrl: 'https://boop.example.com/s/pool-abc', bindHost: '::' })
  assert.ok(hosts.includes('boop.example.com'), hosts.join())
  assert.deepEqual(moduleHosts({ publicOrigin: 'http://192.168.1.5:3850', bindHost: '0.0.0.0' }), ['192.168.1.5', '127.0.0.1', 'localhost'])
  assert.deepEqual(moduleHosts({ publicOrigin: 'http://127.0.0.1:3850', bindHost: '10.0.0.7' }), ['127.0.0.1', 'localhost', '10.0.0.7'])
})

// Maps: the module kit's MapView (src/module-kit/map.tsx), imported as './map'; nothing else beside the module is.
test('a module may import MapView from ./map, and it builds; other relative imports are still refused', { skip: !haveNsh }, async () => {
  const kit = readFileSync(new URL('../src/module-kit/map.tsx', import.meta.url), 'utf8')
  assert.match(kit, /\/ui\/\$\{[^}]+\}\/tiles\/\$\{z\}/, 'tiles from the module route, which the host lets through with the module token')
  assert.match(kit, /\?token=/)
  assert.equal(importProblem(`import { mount, View } from 'nsh'\nimport { MapView } from './map'\nmount(() => <View />)`), null)
  assert.equal(importProblem(`import { MapView } from "./map.tsx"`), null)
  for (const s of [`import x from './mapx'`, `import x from './map/../secret'`, `import x from '../map'`]) assert.match(String(importProblem(s)), /only import/, s)
  const { ui } = await openUi()
  const source = `import { mount, Text, View } from 'nsh'
import { MapView } from './map'
const stops = [{ name: '罗西奥站', lat: 38.7145, lng: -9.1405 }, { name: '贝伦塔', lat: 38.6916, lng: -9.2160 }, { name: '热罗尼莫斯修道院', lat: 38.6979, lng: -9.2068 }]
function App() {
  return <View class="flex-1 bg-background p-4 gap-3"><MapView places={stops} route height={200} /><Text class="text-foreground">{stops.length} stops</Text></View>
}
mount(App)`
  const r = await ui.create({ title: 'Evora', source })
  assert.ok(r.ok, r.ok ? '' : r.errors)
})
