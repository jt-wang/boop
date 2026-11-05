// The Android shell against a real bot, hosted-style: a module the assistant builds opens in the app (not the
// browser), is used, and its answer shows in the thread. The bot runs here behind an HTTPS tunnel (Android's path
// to a hosted computer), so the app's events socket is wss:// and only opens with the TLS-fixed libnsh.so.
// The interface runs inside the thread (InlineModule.java); 全屏 opens the same package full screen.
// The model is scripted (test/fixtures/scripted-model.ts): its one tool call writes the tip calculator with `ui`.
//
//   node scripts/android-module-e2e.ts <adb serial> [shots dir]
//   ANDROID_E2E_HTTP=1: plain http instead (the emulator reaches this Mac at 10.0.2.2), a LAN bot's path; it stops at
//   the module card, since a module may only fetch the bot's own addresses and 10.0.2.2 is not one.
//
// Installs nothing: install the build first (`adb -s <serial> install -r "android/build/boop.apk"`). Clears
// the app's data, opens a deepseekbot://pair link, taps Connect, and drives it with uiautomator (NSH exposes testIDs
// as resource-ids). Language and scheme are the device's: set them first (docs/android.md).
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'
import { startScriptedModel } from '../test/fixtures/scripted-model.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const [serial, shots] = process.argv.slice(2)
const HTTP = process.env.ANDROID_E2E_HTTP === '1'
if (!serial) { console.error('usage: node scripts/android-module-e2e.ts <adb serial> [shots dir]'); process.exit(2) }
const ADB = process.env.ADB ?? join(homedir(), 'Library/Android/sdk/platform-tools/adb')
const sh = (cmd: string) => execFileSync(ADB, ['-s', serial, 'shell', cmd], { encoding: 'utf8', maxBuffer: 16 << 20 })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
// One retry: a kept-alive socket the bot already closed answers ECONNRESET once.
const fetch = (u: string, init?: RequestInit) => globalThis.fetch(u, init).catch(() => globalThis.fetch(u, init))
const log = (s: string) => console.log(`[e2e] ${s}`)
const fail = (s: string): never => { throw new Error(s) }
if (shots) mkdirSync(shots, { recursive: true })
const shot = (name: string) => { if (shots) writeFileSync(join(shots, `${name}.png`), execFileSync(ADB, ['-s', serial, 'exec-out', 'screencap', '-p'], { maxBuffer: 64 << 20 })) }

type Node = { text: string; id: string; desc: string; pkg: string; b: number[] }
function nodes(): Node[] {
  for (let i = 0; i < 3; i++) {
    sh('uiautomator dump /sdcard/e2e.xml >/dev/null 2>&1 || true')
    const x = sh('cat /sdcard/e2e.xml')
    if (!x.includes('<hierarchy')) continue
    return [...x.matchAll(/<node [^>]*>/g)].map((m) => {
      const g = (k: string) => (new RegExp(`${k}="([^"]*)"`).exec(m[0]) ?? [, ''])[1]!
      return { text: g('text'), id: g('resource-id'), desc: g('content-desc'), pkg: g('package'), b: (g('bounds').match(/\d+/g) ?? []).map(Number) }
    })
  }
  return []
}
async function wait(match: (n: Node) => boolean, what: string, ms = 30_000): Promise<Node> {
  const end = Date.now() + ms
  while (Date.now() < end) { const n = nodes().find(match); if (n) return n; await sleep(1000) }
  return fail(`never on screen: ${what}`)
}
const tap = (n: Node) => sh(`input tap ${(n.b[0]! + n.b[2]!) >> 1} ${(n.b[1]! + n.b[3]!) >> 1}`)

// The tip calculator ModuleOpenTest signs, as the assistant would write it.
const TIP = readFileSync(join(ROOT, 'android/app/src/androidTest/module/App.tsx'), 'utf8').split('\n').filter((l) => !l.startsWith('//')).join('\n')
const model = await startScriptedModel([{ name: 'mcp__bot__ui', arguments: { title: '小费计算器', source: TIP } }])
const home = mkdtempSync(join(tmpdir(), 'bot-android-e2e-'))
const secret = randomBytes(24).toString('hex')
const port = await new Promise<number>((r) => { const s = createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => r(p)) }) })
const local = `http://127.0.0.1:${port}`
const bot = spawn(process.execPath, ['src/main.ts', '--home', home, '--host', '127.0.0.1', '--port', String(port), '--model', 'scripted/scripted', '--base-url', model.url, '--api-key-env', 'DEEPSEEK_BOT_MODEL_KEY', ...(HTTP ? [] : ['--tunnel'])], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, DEEPSEEK_BOT_MODEL_KEY: 'local', DEEPSEEK_BOT_HOST_SECRET: secret } })
let out = ''
bot.stdout!.on('data', (d) => { out += d }); bot.stderr!.on('data', (d) => { out += d })
let ok = false
try {
  const end = Date.now() + 120_000
  while (Date.now() < end && !((HTTP || /tunnel https:\/\//.test(out)) && /pairing code: \d{6}/.test(out) && /listening to the assistant/.test(out))) await sleep(300)
  const origin = HTTP ? `http://10.0.2.2:${port}` : /\[bot\] tunnel (https:\/\/\S+)/.exec(out)?.[1] ?? fail(`no tunnel:\n${out}`)
  const code = /pairing code: (\d{6})/.exec(out)![1]
  log(`bot ${origin} (local ${local})`)
  // A new quick-tunnel name takes a few seconds to resolve and route: wait until it answers from here.
  for (let i = 0; i < 60 && !HTTP; i++) { try { if ((await fetch(`${origin}/health`)).ok) break } catch {} await sleep(1000) }
  sh(`ping -c 1 -W 5 ${new URL(origin).hostname} >/dev/null 2>&1 || true`)
  // A device of the driver's own (the host secret), to talk in the thread and know when a turn is done.
  const { token } = await (await fetch(`${local}/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostSecret: secret, name: 'e2e-driver' }) })).json() as { token: string }
  const h = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
  await fetch(`${local}/settings`, { method: 'PUT', headers: h, body: JSON.stringify({ assistantName: '小诺' }) })
  for (let i = 0; i < 20; i++) { await sleep(1000); const t = await (await fetch(`${local}/threads`, { headers: h })).json() as { running: boolean }[]; if (Array.isArray(t) && !t.some((x) => x.running)) break }

  sh('pm clear io.jingtao.boop')
  sh('pm grant io.jingtao.boop android.permission.POST_NOTIFICATIONS')
  sh('logcat -c')
  const pair = `${origin}/pair?code=${code}`
  sh(`am start -W -a android.intent.action.VIEW -d '${`deepseekbot://pair?url=${encodeURIComponent(pair)}`}'`)
  // The first-run steps in the order the app shows them: age, Connect, the AI provider consent; then the chat.
  const steps = ['age-adult', 'connect', 'consent-agree']
  for (const end = Date.now() + 90_000; ;) {
    if (Date.now() > end) fail('never on screen: the chat after connecting')
    const all = nodes()
    if (all.some((n) => n.id === 'composer')) break
    const step = all.find((n) => steps.includes(n.id))
    if (step) { log(`first run: ${step.id}`); tap(step) }
    await sleep(1000)
  }
  log(`paired over ${HTTP ? 'http' : 'HTTPS'}; chat open`)

  const { mainSessionId } = await (await fetch(`${local}/me`, { headers: h })).json() as { mainSessionId: string }
  await fetch(`${local}/threads/${mainSessionId}/messages`, { method: 'POST', headers: h, body: JSON.stringify({ text: '做一个小费计算器给我，账单 42 欧元。' }) })
  // The card arrives over the events socket (wss through the tunnel): the app does not poll.
  if (HTTP) {
    const open = await wait((n) => (n.id.startsWith('open-') || n.id.startsWith('module-inline-')) && n.pkg === 'io.jingtao.boop', 'the module in the thread', 120_000)
    await sleep(1500); shot('android-http-module-card')
    log(`module row: ${open.id}`)
    ok = true; log('passed (http: paired, thread live over ws://)'); bot.kill('SIGTERM'); await model.close(); process.exit(0)
  }
  // The interface runs where the card is: its buttons are on screen together with the composer, nothing opened.
  const box = await wait((n) => n.id.startsWith('module-inline-') && n.pkg === 'io.jingtao.boop', 'the interface inside the thread', 120_000)
  const twenty = await wait((n) => n.text === '20%', 'the interface drawn inside the thread', 30_000)
  const all = nodes()
  if (!all.some((n) => n.id === 'composer')) fail('the composer is not on screen with the interface: it opened over the thread')
  const top = sh('dumpsys activity activities | grep -m1 topResumedActivity')
  if (!top.includes('io.jingtao.boop/')) fail(`the interface is not in the app: ${top.trim()}`)
  // As tall as what it draws: the button at its bottom is inside the box, not cut off at the 160 dp placeholder.
  const use = await wait((n) => n.text === 'Use this', 'Use this inside the thread')
  if (use.b[3]! > box.b[3]! + 2) fail(`Use this (${use.b}) is below the interface's box (${box.b}): it did not take its own height`)
  await sleep(800); shot('android-module-inline')
  log(`inline: box ${box.b}, ${top.trim()}`)
  tap(twenty); await sleep(600)
  tap(await wait((n) => n.text === 'Use this', 'Use this'))
  const answered = await wait((n) => n.text.includes('Tip €8.40 (20%)'), 'the answer in the thread', 60_000)
  await sleep(2500); shot('android-module-answered')
  log(`thread: "${answered.text}"`)
  // The thread changed around it (the answer, the reply): the interface still shows what the person chose.
  await wait((n) => n.text === '€8.40', 'the interface keeping 20% after the thread changed', 10_000)
  // Full screen is one tap away and back returns to the thread.
  tap(await wait((n) => n.id.startsWith('expand-'), '全屏 / Full screen'))
  await wait((n) => n.text === '20%' && !nodes().some((m) => m.id === 'composer'), 'the interface full screen', 30_000)
  await sleep(800); shot('android-module-full')
  sh('input keyevent 4')
  await wait((n) => n.id === 'composer', 'the thread again after back', 15_000)
  const logcat = execFileSync(ADB, ['-s', serial, 'logcat', '-d', '-s', 'ui:*', 'nsh:*'], { encoding: 'utf8', maxBuffer: 16 << 20 })
  const inline = /inline dev\.deepseekbot\.ui\.\S+ shown, download \d+ ms/.exec(logcat)?.[0] ?? fail('no "inline … shown" line from the shell')
  const opened = /ui\.open dev\.deepseekbot\.ui\.\S+ build \d+ — download \d+ ms, verified\+shown \d+ ms/.exec(logcat)?.[0]
  log(`shell: ${inline}; ${opened ?? 'no ui.open line'}`)
  if (/CryptoProvider/.test(logcat)) fail('rustls had no crypto provider (the stock libnsh.so)')
  ok = true
} finally {
  bot.kill('SIGTERM'); await model.close()
  await sleep(1000); rmSync(home, { recursive: true, force: true })
  if (!ok) { shot('android-module-failed'); console.log(out.split('\n').slice(-40).join('\n')) }
  if (!ok) console.log(execFileSync(ADB, ['-s', serial, 'logcat', '-d', '-t', '60', '-s', 'ui:*', 'nsh:*', 'NshNet:*', 'AndroidRuntime:*'], { encoding: 'utf8' }))
}
log('passed')
process.exit(0)
