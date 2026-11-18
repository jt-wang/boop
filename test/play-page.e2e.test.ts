// A module on the browser's play page, in a real browser, on the web build in app/. NSH 0.4.0 runs web code as ordinary
// JavaScript in the page, so what keeps a module away from the device token is the page having no origin of its own.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { Ui } from '../src/ui.ts'
import { createBotServer } from '../src/server.ts'
import { MemoryDeviceStore } from '../src/devices.ts'

const NSH = process.env.NSH_BIN ?? join(homedir(), '.local', 'bin', 'nsh')
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const skip = !existsSync(NSH) || !existsSync(CHROME) || !existsSync('app/index.html')

// Tries everything a module should not reach, says what it found, and posts that as its result.
const SPY = `import { host, mount, signal, Text, View } from 'nsh'
function App() {
  const shown = signal('…')
  const tryIt = (f: () => unknown) => { try { return String(f()) } catch (e: any) { return 'refused ' + e.name } }
  const run = async () => {
    const p = await host.call<{ origin: string; moduleId: string; token: string }>('launch.params') as any
    const g = globalThis as any // the type check refuses these names, and a cast is all it takes to get past it
    const found = {
      origin: g.origin,
      own: tryIt(() => g.localStorage.getItem('token')),
      parent: tryIt(() => g.parent.localStorage.getItem('token')),
      top: tryIt(() => g.top.localStorage.getItem('token')),
      cookie: tryIt(() => g.document.cookie),
    }
    shown.set(JSON.stringify(found))
    await fetch(p.origin + '/ui/' + p.moduleId + '/result', { method: 'POST', headers: { authorization: 'Bearer ' + p.token, 'content-type': 'application/json' }, body: JSON.stringify({ text: JSON.stringify(found) }) })
  }
  run()
  return <View class="flex-1 bg-background p-4"><Text class="text-foreground">Module drawn</Text><Text testID="found">{shown()}</Text></View>
}
mount(App)
`

test('a module draws on the play page, cannot reach what the browser keeps for the bot, and its result arrives', { skip }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'bot-play-'))
  const ui = await Ui.open(root, { nsh: NSH, hosts: ['127.0.0.1'] })
  const made = await ui.create({ title: 'Spy', source: SPY })
  assert.ok(made.ok, made.ok ? '' : made.errors)
  const prompts: { sessionId: string; text: string }[] = []
  const harness = { kind: 'fake', events: { on() {}, clientId: 'c' }, async createSession() { return { sessionId: 'p1' } }, async listSessions() { return [] }, async prompt(sessionId: string, text: string) { prompts.push({ sessionId, text }) }, async answer() {}, async cancel() {}, async history() { return [] }, async sessionState() { return { running: false } } }
  const devices = new MemoryDeviceStore()
  const bot = await createBotServer({ dsh: { origin: 'http://127.0.0.1:9', cookie: 'c=1' }, devices, harness: harness as never, watcher: { clientId: 'c', on() {} } as never, host: '127.0.0.1', port: 0, workspace: root, ui, appDir: join(import.meta.dirname, '..', 'app') } as never)
  const browser = await chromium.launch({ executablePath: CHROME, headless: true })
  try {
    const token = await devices.issue('phone')
    const { url } = await (await fetch(`${bot.origin}/ui/${made.module.id}/play`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ session: 'side-1' }) })).json() as { url: string }
    const page = await browser.newPage({ viewport: { width: 390, height: 780 } })
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
    // what a signed-in browser holds for this bot, at the bot's own origin
    await page.goto(`${bot.origin}/manifest.webmanifest`)
    await page.evaluate((t) => localStorage.setItem('token', t), token)
    await page.goto(`${bot.origin}${url}`)
    await page.waitForFunction(() => document.body.innerText.includes('Module drawn'), undefined, { timeout: 30_000 }).catch((e) => { throw new Error(`the module did not draw: ${e.message} | ${errors.join('; ')}`) })
    for (let i = 0; i < 100 && !prompts.length; i++) await new Promise((r) => setTimeout(r, 100))
    assert.equal(prompts.length, 1, `the result reached the thread; page errors: ${errors.join('; ')}`)
    assert.equal(prompts[0].sessionId, 'side-1')
    const found = JSON.parse(/\{.*\}/.exec(prompts[0].text)![0])
    assert.equal(found.origin, 'null', 'no origin of its own')
    for (const k of ['own', 'parent', 'top']) { assert.match(found[k], /^refused/, k); assert.ok(!String(found[k]).includes(token), k) }
    assert.ok(!prompts[0].text.includes(token))
  } finally { await browser.close(); await bot.close(); rmSync(root, { recursive: true, force: true }) }
})
