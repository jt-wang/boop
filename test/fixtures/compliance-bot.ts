// A stand-in bot for ios/DeepSeekBotUITests/ComplianceTests.swift:
// the real bot server with the compliance layer and a real signed interface, a fake harness whose thread holds one
// question and one reply. Nothing reaches a model.
//   node test/fixtures/compliance-bot.ts [port]   → prints `pair <code>` and `module <id>` when ready
// The interface asks for the clipboard: its button writes "granted-ok" and reads it back, so the screen shows
// whether the shell granted the capability (allowed) or refused it (not allowed).
import { mkdtempSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { createBotServer, type Settings } from '../../src/server.ts'
import { MemoryDeviceStore } from '../../src/devices.ts'
import { Pairing } from '../../src/pairing.ts'
import { Ui } from '../../src/ui.ts'
import { Compliance } from '../../src/compliance.ts'

const port = Number(process.argv[2] ?? 3895)
const root = mkdtempSync(join(tmpdir(), 'compliance-bot-'))
const SOURCE = `import { Clipboard, host, mount, signal, Text, View } from 'nsh'
function App() {
  const seen = signal('not tried')
  const tryIt = async () => {
    try { await Clipboard.writeText('granted-ok') } catch {}
    let got = ''
    try { got = await Clipboard.readText() } catch {}
    seen.set(got === 'granted-ok' ? 'clipboard: allowed' : 'clipboard: refused')
  }
  return (
    <View class="flex-1 bg-background p-4 gap-4">
      <Text class="text-foreground text-[17px] font-semibold">Clipboard check</Text>
      <View role="button" testID="try-clipboard" onPress={tryIt} class="rounded-[12px] bg-primary py-3 items-center"><Text class="text-primary-foreground font-semibold">Try the clipboard</Text></View>
      <Text testID="clipboard-result" class="text-foreground text-[17px]">{seen()}</Text>
      <View role="button" onPress={() => { host.call('ui.close').catch(() => {}) }} class="py-3 items-center"><Text class="text-foreground">Close</Text></View>
    </View>
  )
}
mount(App)
`

const at = Date.now()
const rec = (type: string, data: Record<string, unknown>, i: number) => ({ type: 'event', event: { type, time: at + i, data } })
const harness = {
  kind: 'fake', events: { on() {}, clientId: 'c' },
  async createSession() { return { sessionId: 'main' } },
  async listSessions() { return [{ sessionId: 'main', updatedAt: at, running: false, blank: false }] },
  async prompt() {}, async answer() {}, async cancel() { return true }, async rpc() { return {} as never }, async close() {},
  async follow(_id: string, onFrame: (f: unknown) => void) {
    setTimeout(() => onFrame({ type: 'snapshot', header: { cwd: root }, records: [
      rec('user/message', { id: 'u1', content: [{ type: 'text', text: 'Write me a short poem about rain.' }], source: { kind: 'user' } }, 0),
      rec('assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text: 'Rain taps the window, soft and slow; the street lights blur, the gutters flow.' }] } }, 1),
    ], projections: { values: { title: 'Rain' } } }), 50)
    return () => {}
  },
}

let settings: Settings = { assistantName: '', mainSessionId: 'main', language: 'auto' }
const store = { get: async () => ({ ...settings }), set: async (p: Partial<Settings>) => { settings = { ...settings, ...p }; return { ...settings } } }
const devices = new MemoryDeviceStore()
const pairing = new Pairing(devices)
const ui = await Ui.open(root, { nsh: process.env.NSH_BIN ?? join(homedir(), '.local', 'bin', 'nsh'), hosts: ['127.0.0.1', 'localhost', '10.0.2.2'] })
const made = await ui.create({ title: 'Clipboard check', source: SOURCE, permissions: ['clipboard'] })
if (!made.ok) { console.error(made.errors); process.exit(1) }
const compliance = await Compliance.open(root, { settings: store, model: { provider: 'siliconflow', model: 'deepseek-ai/DeepSeek-V4.1-Flash', baseURL: 'https://api.siliconflow.cn/v1' }, origin: () => `http://127.0.0.1:${port}` })
const bot = await createBotServer({ dsh: { origin: 'http://127.0.0.1:9', cookie: 'c=1' }, devices, pairing, harness: harness as never, watcher: { clientId: 'c', on() {} } as never, host: '127.0.0.1', port, settings: store, ui, compliance,
  // the rest of what the app reads, empty (the app's Discover tab fetches them at once)
  ideas: { list: () => [], refresh: async () => [], dismiss: async () => false }, memory: { items: async () => [], forgetById: async () => null } as never,
  scheduler: { list: () => [], remove: async () => false, update: async () => undefined }, goals: { list: () => [], update: async () => undefined, remove: async () => false }, activity: () => [],
  appDir: join(import.meta.dirname, '..', '..', 'app') })
console.log(`[fixture] bot ${bot.origin}`)
console.log(`pair ${pairing.create(60 * 60_000)}`)
console.log(`module ${made.module.id}`)
