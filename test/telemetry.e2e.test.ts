import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dshSpawnEnv, startDshWeb } from '../src/dsh.ts'
import { rpc } from '../src/dshclient.ts'

// DSH 0.2.0-rc.2 uploads the session log after a person gives feedback, to dsh-otel-collector.deepseeksvc.com, with the
// home's anonymous id (dsh-base/cordis.patch.yml: `mode: process.env.DSH_TELEMETRY_MODE || 'FEEDBACK_ONLY'`). Boop never
// offers that upload. The real child, the collector replaced by a local server through DSH_TELEMETRY_OTLP_URL.
const SKIP = process.env.DEEPSEEK_BOT_SKIP_E2E === '1'

test('the harness always gets DSH_TELEMETRY_MODE=DISABLED, whatever the environment says', () => {
  assert.equal(dshSpawnEnv({ dshHome: '/h', env: { PATH: '/bin' } }).DSH_TELEMETRY_MODE, 'DISABLED')
  assert.equal(dshSpawnEnv({ dshHome: '/h', env: { DSH_TELEMETRY_MODE: 'FEEDBACK_ONLY' }, allowedEnv: ['DSH_TELEMETRY_MODE'] }).DSH_TELEMETRY_MODE, 'DISABLED')
})

async function collector() {
  const posts: string[] = []
  const server: Server = createServer((req, res) => { req.resume(); req.on('end', () => { posts.push(req.url ?? ''); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}') }) })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const a = server.address() as { port: number }
  return { posts, url: `http://127.0.0.1:${a.port}/v1/logs`, close: () => new Promise((r) => server.close(r)) }
}

async function feedbackRun(patchFor: (url: string) => string) {
  const c = await collector()
  const home = mkdtempSync(join(tmpdir(), 'dsh-telemetry-'))
  const patch = patchFor(c.url)
  if (patch) { mkdirSync(join(home, 'profiles', 'web'), { recursive: true }); writeFileSync(join(home, 'profiles', 'web', 'cordis.patch.yml'), patch) }
  const dsh = await startDshWeb({ dshHome: home, env: { PATH: process.env.PATH, HOME: home, DSH_TELEMETRY_OTLP_URL: c.url }, allowedEnv: ['DSH_TELEMETRY_OTLP_URL'] })
  try {
    const { sessionId } = await rpc<{ sessionId: string }>(dsh, 'session/create', { request: {} })
    const r = await rpc<unknown>(dsh, 'sessionFeedback/record', { request: { sessionId, text: 'a test remark', category: 'other' } })
    assert.deepEqual(r, { ok: true, value: { recorded: true } })
    // the processor sends every 10 s (scheduledDelayMillis); the stop below drains what is left
    await new Promise((res) => setTimeout(res, 12_000))
  } finally { await dsh.stop(); await c.close() }
  return c.posts
}

test('the instrument: with the upload on, feedback reaches the collector', { skip: SKIP, timeout: 120_000 }, async () => {
  const posts = await feedbackRun((url) => `- id: session-telemetry-otel\n  config:\n    mode: FEEDBACK_ONLY\n    shutdownTimeoutMillis: 3000\n    maxRequestBytes: 4000000\n    exporter:\n      url: ${url}\n      timeoutMillis: 1000\n    processor:\n      scheduledDelayMillis: 1000\n      exportTimeoutMillis: 1500\n`)
  assert.ok(posts.length > 0, 'a run with the upload on has to post, or the test below proves nothing')
})

test('Boop as it starts DSH: feedback is recorded and nothing is uploaded', { skip: SKIP, timeout: 120_000 }, async () => {
  assert.deepEqual(await feedbackRun(() => ''), [])
})
