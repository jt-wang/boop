// Notifications on the iOS simulator through the whole chain the hosted app uses, with Apple played by a stand-in
// that hands each request's payload to the simulator (`xcrun simctl push`):
//
//   bot (src/main.ts, scripted model) → host POST /host/push → ApnsSender (HTTP/2, JWT) → stand-in APNs → simctl push
//
// The scripted model plays the opening line, a question card, the line after it is answered, and two side-thread
// turns. ios/DeepSeekBotUITests/PushTapTests.swift drives the app against it. Each APNs request is appended to
// <home>.apns.jsonl (headers and payload) for the run's review.
// Usage: node scripts/push-sim.ts <home> <port> <simulator udid> <zh|en>
// Writes <home>.secret (the host secret the UI test pairs a driver device with) and <home>.code (the app's pairing code).
import { spawn, execFileSync } from 'node:child_process'
import { appendFileSync, writeFileSync } from 'node:fs'
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import http2 from 'node:http2'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { startScriptedModel } from '../test/fixtures/scripted-model.ts'
import { createHostServer } from '../src/host/server.ts'
import { ApnsSender } from '../src/push-apns.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const [home, port, udid, lang] = process.argv.slice(2)
if (!home || !port || !udid) { console.error('usage: node scripts/push-sim.ts <home> <port> <udid> <zh|en>'); process.exit(2) }
const zh = lang === 'zh'
const L = (z: string, e: string) => (zh ? z : e)

const model = await startScriptedModel([
  { text: L('你好，我在。', 'Hi, I am here.') },
  { name: 'ask_user_question', arguments: { questions: [{ id: 'seat', question: L('座位要靠窗还是靠过道？', 'Window or aisle?'), options: [{ label: L('靠窗', 'Window') }, { label: L('靠过道', 'Aisle') }] }] } },
  { text: L('好的，订了靠窗的位置。', 'Done: a window seat.') },
  { text: L('行李清单整理好了，一共 12 样。', 'The packing list is ready: 12 items.') },
  { text: L('酒店订好了，入住时间下午 3 点。', 'The hotel is booked; check-in is at 3 pm.') },
])

// Apple, played by an HTTP/2 server: the request ApnsSender sends is what reaches the simulator.
const apple = http2.createServer((req, res) => {
  const parts: Buffer[] = []
  req.on('data', (c) => parts.push(Buffer.from(c)))
  req.on('end', () => {
    const body = Buffer.concat(parts).toString()
    const file = join(tmpdir(), `push-${Date.now()}.apns`)
    writeFileSync(file, body)
    appendFileSync(`${home}.apns.jsonl`, JSON.stringify({ at: new Date().toISOString(), headers: { path: req.headers[':path'], topic: req.headers['apns-topic'], type: req.headers['apns-push-type'], collapse: req.headers['apns-collapse-id'] }, payload: JSON.parse(body) }) + '\n')
    try { execFileSync('xcrun', ['simctl', 'push', udid, String(req.headers['apns-topic']), file]); res.writeHead(200).end() }
    catch (e) { console.error('[push-sim] simctl push failed', (e as Error).message); res.writeHead(500).end('{"reason":"simctl"}') }
  })
})
await new Promise<void>((r) => apple.listen(0, '127.0.0.1', () => r()))
const appleOrigin = `http://127.0.0.1:${(apple.address() as { port: number }).port}`

const secret = randomBytes(24).toString('hex'); writeFileSync(`${home}.secret`, secret, { mode: 0o600 })
const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
const provider = { kind: 'none', async create() { throw new Error('not used') }, async get() { return null }, async start() {}, async stop() {}, async remove() {}, async status() { return 'missing' as const } }
const host = await createHostServer({
  provider: provider as never, image: 'none', accountsPath: `${home}.accounts.json`, hostSecret: secret, sandboxEnv: {}, host: '127.0.0.1', port: 0,
  apns: new ApnsSender({ keyId: 'SIMKEY0001', teamId: 'ABCDE12345', keyPath: '-', bundleId: 'io.jingtao.boop', sandbox: true }, privateKey.export({ type: 'pkcs8', format: 'pem' }) as string, { origin: appleOrigin }),
})
console.log(`[push-sim] stand-in APNs ${appleOrigin}, host relay ${host.origin}, model ${model.url}`)

const child = spawn(process.execPath, ['src/main.ts', '--home', home, '--host', '127.0.0.1', '--port', port, '--model', 'scripted/scripted', '--base-url', model.url, '--api-key-env', 'DEEPSEEK_BOT_MODEL_KEY'], {
  cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'],
  env: { ...process.env, DEEPSEEK_BOT_MODEL_KEY: 'local', DEEPSEEK_BOT_PUSH_RELAY: host.origin, DEEPSEEK_BOT_HOST_SECRET: secret },
})
let out = ''
child.stdout!.on('data', (d) => {
  process.stdout.write(d); out += d
  const m = /\/pair\?code=(\d{6})/.exec(out); if (m) writeFileSync(`${home}.code`, m[1])
})
const stop = () => { child.kill('SIGTERM'); host.close().then(() => apple.close()).then(() => model.close()).finally(() => process.exit(0)) }
process.on('SIGTERM', stop); process.on('SIGINT', stop)
child.on('exit', (c) => { console.log(`[push-sim] bot exited ${c}`); process.exit(c ?? 0) })
