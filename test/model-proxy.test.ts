import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { startModelProxy } from '../src/model-proxy.ts'
import { createGuard, guardPolicy } from '../src/guard.ts'

async function upstream(handler: (req: import('node:http').IncomingMessage, body: string, res: import('node:http').ServerResponse) => void) {
  const srv = createServer((req, res) => {
    let body = ''
    req.on('data', (d) => { body += d })
    req.on('end', () => handler(req, body, res))
  })
  srv.listen(0, '127.0.0.1')
  await once(srv, 'listening')
  return { origin: `http://127.0.0.1:${(srv.address() as { port: number }).port}`, close: () => new Promise<void>((r) => srv.close(() => r())) }
}

test('the model proxy forwards the request path and body and swaps the surrogate for the real bearer', async () => {
  const seen: { url?: string; auth?: string; body: string } = { body: '' }
  const up = await upstream((req, body, res) => {
    seen.url = req.url; seen.auth = req.headers.authorization; seen.body = body
    res.writeHead(200, { 'content-type': 'text/event-stream', 'x-upstream': 'yes' })
    res.end('data: ok\n\n')
  })
  const p = await startModelProxy({ upstream: up.origin, apiKey: 'real-key', auth: 'bearer' })
  try {
    const r = await fetch(`${p.url}/v1/chat/completions?x=1`, { method: 'POST', headers: { authorization: 'Bearer surrogate', 'content-type': 'application/json' }, body: '{"model":"m"}' })
    assert.equal(r.status, 200)
    assert.equal(r.headers.get('x-upstream'), 'yes')
    assert.equal(await r.text(), 'data: ok\n\n')
    assert.equal(seen.url, '/v1/chat/completions?x=1')
    assert.equal(seen.auth, 'Bearer real-key')
    assert.equal(seen.body, '{"model":"m"}')
  } finally { await p.close(); await up.close() }
})

test('the model proxy can send the key as x-api-key (the native DeepSeek Messages adapter)', async () => {
  let auth = ''; let xkey = ''; let anthropic = ''
  const up = await upstream((req, _body, res) => { auth = String(req.headers.authorization ?? ''); xkey = String(req.headers['x-api-key'] ?? ''); anthropic = String(req.headers['anthropic-version'] ?? ''); res.writeHead(200).end('ok') })
  const p = await startModelProxy({ upstream: up.origin, apiKey: 'real-key', auth: 'x-api-key' })
  try {
    const r = await fetch(`${p.url}/anthropic/messages`, { method: 'POST', headers: { authorization: 'Bearer surrogate', 'x-api-key': 'surrogate', 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, body: '{}' })
    assert.equal(r.status, 200)
    assert.equal(auth, '')
    assert.equal(xkey, 'real-key')
    assert.equal(anthropic, '2023-06-01')
  } finally { await p.close(); await up.close() }
})

test('the upstream status and body come back unchanged', async () => {
  const up = await upstream((_req, _body, res) => { res.writeHead(429, { 'content-type': 'application/json' }); res.end('{"error":"slow down"}') })
  const p = await startModelProxy({ upstream: up.origin, apiKey: 'k', auth: 'bearer' })
  try {
    const r = await fetch(`${p.url}/v1/chat/completions`, { method: 'POST', body: '{}' })
    assert.equal(r.status, 429)
    assert.equal(await r.text(), '{"error":"slow down"}')
  } finally { await p.close(); await up.close() }
})

test('the proxy refuses an oversized request body instead of buffering it', async () => {
  const up = await upstream((_req, _body, res) => res.writeHead(200).end('should not reach'))
  const p = await startModelProxy({ upstream: up.origin, apiKey: 'k', auth: 'bearer', maxBytes: 32 })
  try {
    const r = await fetch(`${p.url}/v1/chat/completions`, { method: 'POST', body: 'x'.repeat(64) })
    assert.equal(r.status, 413)
  } finally { await p.close(); await up.close() }
})

test('a guarded proxy refuses a private upstream before the real key is sent', async () => {
  let reached = false
  const up = await upstream((_req, _body, res) => { reached = true; res.writeHead(200).end('ok') })
  const guard = createGuard(guardPolicy({}), { resolve: async () => ['127.0.0.1'] })
  const p = await startModelProxy({ upstream: up.origin, apiKey: 'real-key', auth: 'bearer', guard })
  try {
    const r = await fetch(`${p.url}/v1/chat/completions`, { method: 'POST', body: '{}' })
    assert.equal(r.status, 403)
    assert.match(await r.text(), /private|special/i)
    assert.equal(reached, false, 'the key never left the bot')
  } finally { await p.close(); await up.close() }
})

test('a guarded proxy refuses a model-provider redirect instead of following it', async () => {
  const up = await upstream((_req, _body, res) => { res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' }); res.end() })
  const guard = createGuard(guardPolicy({ DEEPSEEK_BOT_GUARD_ALLOW_PRIVATE: '1' }))
  const p = await startModelProxy({ upstream: up.origin, apiKey: 'real-key', auth: 'bearer', guard })
  try {
    const r = await fetch(`${p.url}/v1/chat/completions`, { method: 'POST', body: '{}' })
    assert.equal(r.status, 502)
    assert.match(await r.text(), /redirect/i)
  } finally { await p.close(); await up.close() }
})
