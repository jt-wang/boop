import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

// Real dsh + real model: a file the assistant writes shows up in the Library.
// Skipped unless DEEPSEEK_BOT_E2E_MODEL=1 (needs the local model gateway).
const run = process.env.DEEPSEEK_BOT_E2E_MODEL === '1'

async function startBot(): Promise<{ home: string; origin: string; code: string; stop(): Promise<void> }> {
  const home = mkdtempSync(join(tmpdir(), 'bot-library-'))
  const child: ChildProcess = spawn(process.execPath, ['src/main.ts', '--home', home, '--host', '127.0.0.1', '--port', '0', '--model', 'magpie/group/auto-deepseek-flash', '--base-url', 'http://127.0.0.1:3425/v1', '--api-key-env', 'DEEPSEEK_BOT_MODEL_KEY'], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, DEEPSEEK_BOT_MODEL_KEY: 'local' } })
  let out = ''
  const pairUrl = await new Promise<string>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`no pairing url:\n${out}`)), 90_000)
    child.stdout!.on('data', (d) => { out += d; const m = /(http:\/\/[^\s]+\/pair\?code=(\d{6}))/.exec(out); if (m) { clearTimeout(t); resolve(m[1]) } })
    child.stderr!.on('data', (d) => { out += d })
    child.on('exit', (c) => { clearTimeout(t); reject(new Error(`bot exited ${c}:\n${out}`)) })
  })
  for (let i = 0; i < 100 && !/listening to the assistant/.test(out); i++) await new Promise((r) => setTimeout(r, 200))
  return { home, origin: new URL(pairUrl).origin, code: new URL(pairUrl).searchParams.get('code')!, stop: () => new Promise((r) => { child.once('exit', () => r()); child.kill('SIGTERM') }) }
}

async function ask(origin: string, token: string, sessionId: string, text: string) {
  const r = await fetch(`${origin}/api/session/prompt`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: 'session/prompt', payload: { args: { request: { requestId: randomUUID(), sessionId, mode: 'queue', content: [{ type: 'text', text }] } } } }) })
  assert.equal(r.status, 200)
}

/** Poll `fn` once a second; approve any approval card on the way (writing in the workspace may ask). */
async function until(origin: string, h: Record<string, string>, fn: () => Promise<boolean>, ms: number, what: string) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await fn()) return
    const asks = await (await fetch(`${origin}/asks`, { headers: h })).json() as { kind: string; eventId: string }[]
    for (const a of asks) if (a.kind === 'approval') await fetch(`${origin}/approvals/${encodeURIComponent(a.eventId)}`, { method: 'POST', headers: h, body: JSON.stringify({ outcome: 'allowed-once' }) })
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error(`timed out waiting for ${what}`)
}

type Entry = { path: string; size: number; mtime: number; kind: string; description?: string }

test('a file the assistant writes is listed by GET /library and readable by GET /library/file', { skip: !run, timeout: 300_000 }, async () => {
  const bot = await startBot()
  try {
    const { token } = await (await fetch(`${bot.origin}/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: bot.code, name: 'e2e' }) })).json() as { token: string }
    const h = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
    await fetch(`${bot.origin}/consent`, { method: 'PUT', headers: h, body: JSON.stringify({ ai: true, age: 'adult' }) }) // the person agreed to the AI provider (required since 1a602a4)
    await fetch(`${bot.origin}/settings`, { method: 'PUT', headers: h, body: JSON.stringify({ assistantName: 'Nori' }) })
    const { sessionId } = await (await fetch(`${bot.origin}/sessions/main`, { method: 'POST', headers: h })).json() as { sessionId: string }

    const before = await (await fetch(`${bot.origin}/library`, { headers: h })).json() as Entry[]
    assert.deepEqual(before, [], 'a fresh workspace lists nothing (memory files are hidden)')

    await ask(bot.origin, token, sessionId, 'Write a file called notes/hello.md (relative to your working directory) containing a haiku about autumn. Then reply with just OK.')
    const list = () => fetch(`${bot.origin}/library`, { headers: h }).then((r) => r.json() as Promise<Entry[]>)
    await until(bot.origin, h, async () => (await list()).some((e) => e.path === 'notes/hello.md'), 150_000, 'notes/hello.md in /library')
    const entry = (await list()).find((e) => e.path === 'notes/hello.md')!
    assert.equal(entry.kind, 'text'); assert.ok(entry.size > 0); assert.ok(entry.mtime > Date.now() - 10 * 60_000)

    const file = await fetch(`${bot.origin}/library/file?path=${encodeURIComponent('notes/hello.md')}`, { headers: h })
    assert.equal(file.status, 200)
    assert.equal(file.headers.get('content-type'), 'text/markdown; charset=utf-8')
    const text = await file.text()
    assert.ok(text.trim().split('\n').length >= 3, `looks like a haiku:\n${text}`)

    // The `present` tool: its description should reach the Library through the session journal.
    await ask(bot.origin, token, sessionId, 'Now call the present tool on notes/hello.md with the description "Autumn haiku". Reply with just OK.')
    await until(bot.origin, h, async () => Boolean((await list()).find((e) => e.path === 'notes/hello.md')?.description), 120_000, 'a description from present')
    assert.match((await list()).find((e) => e.path === 'notes/hello.md')!.description!, /autumn/i)

    const del = await fetch(`${bot.origin}/library/file?path=${encodeURIComponent('notes/hello.md')}`, { method: 'DELETE', headers: h })
    assert.equal(del.status, 200)
    assert.equal((await list()).some((e) => e.path === 'notes/hello.md'), false)
  } finally { await bot.stop() }
})
