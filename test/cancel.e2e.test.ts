import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { WebSocketServer } from 'ws'
import { createBotServer } from '../src/server.ts'
import { MemoryDeviceStore } from '../src/devices.ts'
import { EventWatcher } from '../src/events.ts'
import { openHome } from '../src/home.ts'
import { startDshWeb } from '../src/dsh.ts'

// Unit part (always runs): the bot route calls DSH `session/cancel` with `{request:{sessionId}}`.
async function fakeDsh(reply: (method: string) => { ok: true; value: unknown } | { ok: false; error: { code: string; message: string } }) {
  const posts: { url: string; body: { payload: { args: unknown } } }[] = []
  const srv = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      posts.push({ url: req.url ?? '', body: JSON.parse(body || 'null') })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'server-response', rpcId: 'r', result: reply(req.url ?? '') }))
    })
  })
  const wss = new WebSocketServer({ server: srv, path: '/api/remote.mux' })
  wss.on('connection', (ws) => ws.on('message', (m) => { const f = JSON.parse(m.toString()); if (f.type === 'open' && f.endpoint === '$events') ws.send(JSON.stringify({ type: 'item', streamId: f.streamId, value: { type: 'ready', clientId: 'client-A' } })) }))
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
  return { origin: `http://127.0.0.1:${(srv.address() as { port: number }).port}`, posts, close: () => { wss.close(); srv.close() } }
}

async function bootBot(dshOrigin: string) {
  const devices = new MemoryDeviceStore()
  const watcher = new EventWatcher({ origin: dshOrigin, cookie: 'c=1' })
  const bot = await createBotServer({ dsh: { origin: dshOrigin, cookie: 'c=1' }, devices, watcher, host: '127.0.0.1', port: 0, appDir: join(process.cwd(), 'app') })
  watcher.start()
  const token = await devices.issue('tester')
  return { bot, token, close: async () => { await watcher.stop(); await bot.close() } }
}

test('POST /sessions/:id/cancel needs a device and forwards session/cancel with {request:{sessionId}}', async () => {
  const dsh = await fakeDsh(() => ({ ok: true, value: { accepted: true } }))
  const s = await bootBot(dsh.origin)
  try {
    assert.equal((await fetch(`${s.bot.origin}/sessions/s-1/cancel`, { method: 'POST' })).status, 401)
    const r = await fetch(`${s.bot.origin}/sessions/s-1/cancel`, { method: 'POST', headers: { authorization: `Bearer ${s.token}` } })
    assert.equal(r.status, 200)
    assert.deepEqual(await r.json(), { ok: true })
    const post = dsh.posts.find((p) => p.url === '/api/session/cancel')
    assert.ok(post, 'session/cancel reached dsh')
    assert.deepEqual(post!.body.payload.args, { request: { sessionId: 's-1' } })
    assert.equal(dsh.posts.filter((p) => p.url === '/api/session/cancel').length, 1, 'the unauthenticated call never reached dsh')
  } finally { await s.close(); dsh.close() }
})

test('POST /sessions/:id/cancel answers 404 when the session does not exist', async () => {
  const dsh = await fakeDsh(() => ({ ok: false, error: { code: 'session/not-found', message: 'session "nope" not found' } }))
  const s = await bootBot(dsh.origin)
  try {
    const r = await fetch(`${s.bot.origin}/sessions/nope/cancel`, { method: 'POST', headers: { authorization: `Bearer ${s.token}` } })
    assert.equal(r.status, 404)
    assert.deepEqual(await r.json(), { error: 'no such session' })
  } finally { await s.close(); dsh.close() }
})

// Real dsh + real model (local Magpie gateway). Skipped unless DEEPSEEK_BOT_E2E_MODEL=1.
const run = process.env.DEEPSEEK_BOT_E2E_MODEL === '1'

test('a long task stops within 10 s of POST /sessions/:id/cancel and the session goes idle', { skip: !run, timeout: 300_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'bot-cancel-e2e-'))
  const home = await openHome(root, { model: { provider: 'magpie', model: 'group/auto-deepseek-flash', baseURL: 'http://127.0.0.1:3425/v1', apiKeyEnv: 'DEEPSEEK_BOT_MODEL_KEY' }, browser: false })
  const dsh = await startDshWeb({ dshHome: home.dshHome, env: { ...process.env, DEEPSEEK_BOT_MODEL_KEY: 'local' }, timeoutMs: 120_000 })
  const devices = new MemoryDeviceStore()
  const watcher = new EventWatcher({ origin: dsh.origin, cookie: dsh.cookie })
  const status: { at: number; sessionId: string; running: boolean }[] = []
  const bot = await createBotServer({ dsh: { origin: dsh.origin, cookie: dsh.cookie }, devices, watcher, host: '127.0.0.1', port: 0, appDir: join(process.cwd(), 'app'), workspace: home.workspace })
  const token = await devices.issue('e2e')
  const h = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
  // Approvals (the sandbox may ask about bash) are allowed at once so they cannot stall the turn.
  watcher.on('event', (e) => {
    if (e.type === 'status') status.push({ at: Date.now(), sessionId: e.sessionId, running: e.running })
    if (e.type === 'approval') fetch(`${bot.origin}/approvals/${encodeURIComponent(e.eventId)}`, { method: 'POST', headers: h, body: JSON.stringify({ outcome: 'allowed-once' }) }).catch(() => {})
  })
  watcher.start()
  const until = async (fn: () => boolean, ms: number, what: string) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return; await new Promise((r) => setTimeout(r, 100)) } throw new Error(`timed out waiting for ${what}; status events: ${JSON.stringify(status)}`) }
  try {
    await until(() => Boolean(watcher.clientId), 20_000, 'the watcher to attach')
    const { sessionId } = await (await fetch(`${bot.origin}/api/session/create`, { method: 'POST', headers: h, body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: 'session/create', payload: { args: { request: { cwd: home.workspace } } } }) })).json().then((v) => (v as { result: { value: { sessionId: string } } }).result.value)
    const prompt = await fetch(`${bot.origin}/api/session/prompt`, { method: 'POST', headers: h, body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: 'session/prompt', payload: { args: { request: { requestId: randomUUID(), sessionId, mode: 'queue', content: [{ type: 'text', text: 'Use the bash tool once: run a single shell loop that counts slowly from 1 to 100, printing each number and sleeping 1 second between numbers (for i in $(seq 1 100); do echo $i; sleep 1; done). Do not shorten it. When it finishes, reply "done".' }] } } } }) })
    assert.equal(prompt.status, 200)
    await until(() => status.some((s) => s.sessionId === sessionId && s.running), 60_000, 'the session to start running')
    // Give the model time to reach the bash call, then stop it.
    await new Promise((r) => setTimeout(r, 3_000))
    const t0 = Date.now()
    const r = await fetch(`${bot.origin}/sessions/${sessionId}/cancel`, { method: 'POST', headers: h })
    assert.equal(r.status, 200, await r.text())
    await until(() => status.some((s) => s.sessionId === sessionId && !s.running && s.at >= t0), 10_000, 'the session to go idle after cancel')
    const idle = status.find((s) => s.sessionId === sessionId && !s.running && s.at >= t0)!
    console.log(`[cancel e2e] cancel → idle in ${idle.at - t0} ms; status events: ${JSON.stringify(status.map((s) => ({ running: s.running, dt: s.at - t0 })))}`)
    assert.ok(idle.at - t0 < 10_000)
  } finally { await watcher.stop(); await bot.close(); await dsh.stop() }
})
