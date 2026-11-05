import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { LlmClient, llmOptionsFor } from '../src/llm.ts'
import { createGuard, guardPolicy } from '../src/guard.ts'

// A fake OpenAI-compatible endpoint: records every request, answers from a queue.
async function fakeModel(answer: (body: Record<string, unknown>, n: number) => { status?: number; body?: unknown; hang?: boolean }) {
  const seen: { path: string; headers: Record<string, string | string[] | undefined>; body: Record<string, unknown> }[] = []
  const srv: Server = createServer((req, res) => {
    let s = ''
    req.on('data', (c) => { s += c })
    req.on('end', () => {
      const body = JSON.parse(s || '{}')
      seen.push({ path: req.url ?? '', headers: req.headers, body })
      const a = answer(body, seen.length)
      if (a.hang) return
      res.writeHead(a.status ?? 200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(a.body ?? { choices: [{ message: { role: 'assistant', content: 'ok' } }] }))
    })
  })
  srv.listen(0, '127.0.0.1'); await once(srv, 'listening')
  const { port } = srv.address() as { port: number }
  return { baseURL: `http://127.0.0.1:${port}/v1`, seen, close: () => new Promise<void>((r) => { srv.closeAllConnections(); srv.close(() => r()) }) }
}

test('llmOptionsFor: deepseek-official → api.deepseek.com with DEEPSEEK_API_KEY; custom providers keep their base URL and key env; cheapModel overrides the model', () => {
  const official = llmOptionsFor({ provider: 'deepseek-official', model: 'deepseek-flash' })
  assert.equal(official.baseURL, 'https://api.deepseek.com/v1'); assert.equal(official.apiKeyEnv, 'DEEPSEEK_API_KEY'); assert.equal(official.model, 'deepseek-flash')
  const custom = llmOptionsFor({ provider: 'magpie', model: 'group/auto-deepseek-flash', baseURL: 'http://127.0.0.1:3425/v1/', apiKeyEnv: 'DEEPSEEK_BOT_MODEL_KEY' }, 'group/cheap')
  assert.equal(custom.baseURL, 'http://127.0.0.1:3425/v1'); assert.equal(custom.apiKeyEnv, 'DEEPSEEK_BOT_MODEL_KEY'); assert.equal(custom.model, 'group/cheap')
})

test('chat posts to /chat/completions with the model, messages, bearer key from the env var and JSON mode when asked; returns the content', async () => {
  const m = await fakeModel(() => ({ body: { choices: [{ message: { role: 'assistant', content: '{"a":1}' } }] } }))
  process.env.LLM_TEST_KEY = 'sk-test-123'
  try {
    const llm = new LlmClient({ baseURL: m.baseURL, apiKeyEnv: 'LLM_TEST_KEY', model: 'cheap-1' })
    const out = await llm.chat([{ role: 'system', content: 'be brief' }, { role: 'user', content: 'hi' }], { json: true })
    assert.equal(out, '{"a":1}')
    assert.equal(m.seen.length, 1)
    assert.equal(m.seen[0].path, '/v1/chat/completions')
    assert.equal(m.seen[0].headers.authorization, 'Bearer sk-test-123')
    assert.equal(m.seen[0].body.model, 'cheap-1')
    assert.deepEqual(m.seen[0].body.messages, [{ role: 'system', content: 'be brief' }, { role: 'user', content: 'hi' }])
    assert.deepEqual(m.seen[0].body.response_format, { type: 'json_object' })
    assert.equal(m.seen[0].body.stream, false)
    // without json: no response_format at all
    await llm.chat([{ role: 'user', content: 'hi' }])
    assert.equal('response_format' in m.seen[1].body, false)
  } finally { delete process.env.LLM_TEST_KEY; await m.close() }
})

test('no key in the env var: no authorization header (local gateways), the call still goes out', async () => {
  const m = await fakeModel(() => ({}))
  try {
    const llm = new LlmClient({ baseURL: m.baseURL, apiKeyEnv: 'LLM_TEST_MISSING_KEY', model: 'x' })
    assert.equal(await llm.chat([{ role: 'user', content: 'hi' }]), 'ok')
    assert.equal(m.seen[0].headers.authorization, undefined)
  } finally { await m.close() }
})

test('json() parses the answer, also when the model wraps it in a code fence; a 400 on JSON mode is retried once without response_format', async () => {
  const m = await fakeModel((body, n) => {
    if (body.response_format) return { status: 400, body: { error: { message: 'response_format not supported' } } }
    return { body: { choices: [{ message: { content: '```json\n{"ideas":[{"title":"t' + n + '"}]}\n```' } }] } }
  })
  try {
    const llm = new LlmClient({ baseURL: m.baseURL, model: 'x' })
    const v = await llm.json<{ ideas: { title: string }[] }>([{ role: 'user', content: 'go' }])
    assert.equal(v.ideas[0].title, 't2')
    assert.equal(m.seen.length, 2)
    assert.equal('response_format' in m.seen[1].body, false)
  } finally { await m.close() }
})

test('errors: a non-2xx answer throws with the status; a silent server times out', async () => {
  // 404: a refusal a new try would not change (a 5xx is tried again, below)
  const m = await fakeModel((_b, n) => (n === 1 ? { status: 404, body: { error: 'no such model' } } : { hang: true }))
  try {
    const llm = new LlmClient({ baseURL: m.baseURL, model: 'x', timeoutMs: 300 })
    await assert.rejects(llm.chat([{ role: 'user', content: 'a' }]), /404/)
    const t0 = Date.now()
    await assert.rejects(llm.chat([{ role: 'user', content: 'b' }]), /timed out|abort/i)
    assert.ok(Date.now() - t0 < 2000, 'gave up quickly')
  } finally { await m.close() }
})

test('a guarded background call refuses a private base URL before the key is sent', async () => {
  process.env.LLM_TEST_GUARD_KEY = 'sk-guard-secret'
  try {
    const llm = new LlmClient({
      baseURL: 'http://169.254.169.254/v1', apiKeyEnv: 'LLM_TEST_GUARD_KEY', model: 'x',
      guard: createGuard(guardPolicy({})),
    })
    await assert.rejects(llm.chat([{ role: 'user', content: 'hi' }]), /private|special/)
  } finally { delete process.env.LLM_TEST_GUARD_KEY }
})

// A model call that failed for a moment (408, 429, 5xx, a dropped connection) is tried again, as DeepSeek's
// dsh-superagent prototype retries a turn (15, 30, 60 s there); a refusal that will not change (401, 404) is not.
// An answer that is not the JSON asked for is asked for once more. (test/ideas.e2e, 2026-11-01: one refresh of three
// in a busy run came back "the model did not answer".)
test('a model call that failed for a moment is tried again; one refused for good is not', async () => {
  const { LlmClient } = await import('../src/llm.ts')
  const answers: (number | 'drop' | string)[] = [503, 'drop', '{"ok":true}']
  let calls = 0
  const fetch = (async () => {
    calls++
    const a = answers.shift()
    if (a === 'drop') throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } })
    if (typeof a === 'number') return new Response('busy', { status: a })
    return new Response(JSON.stringify({ choices: [{ message: { content: a } }] }), { status: 200 })
  }) as typeof globalThis.fetch
  const llm = new LlmClient({ baseURL: 'http://x/v1', model: 'm', fetch, retryDelaysMs: [1, 1, 1] })
  assert.deepEqual(await llm.json([{ role: 'user', content: 'q' }]), { ok: true })
  assert.equal(calls, 3)
  let refused = 0
  const no = new LlmClient({ baseURL: 'http://x/v1', model: 'm', retryDelaysMs: [1, 1, 1], fetch: (async () => { refused++; return new Response('no', { status: 401 }) }) as typeof globalThis.fetch })
  await assert.rejects(no.chat([{ role: 'user', content: 'q' }]), /401/)
  assert.equal(refused, 1)
})

test('an answer that is not the JSON asked for is asked for once more', async () => {
  const { LlmClient } = await import('../src/llm.ts')
  const answers = ['Here are three ideas: …', '[{"title":"a"}]']
  const fetch = (async () => new Response(JSON.stringify({ choices: [{ message: { content: answers.shift() } }] }), { status: 200 })) as typeof globalThis.fetch
  const llm = new LlmClient({ baseURL: 'http://x/v1', model: 'm', fetch, retryDelaysMs: [1] })
  assert.deepEqual(await llm.json([{ role: 'user', content: 'q' }]), [{ title: 'a' }])
})
