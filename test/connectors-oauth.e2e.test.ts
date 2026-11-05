import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { startFakeOAuth } from './fixtures/fake-oauth.ts'

// One-tap connectors with the real model and a real DSH: a fake OAuth 2.1 + MCP
// service (test/fixtures/fake-oauth.ts) offered as a one-tap service through
// DEEPSEEK_BOT_ONE_TAP_EXTRA. Case 1: "connect my Acme Pages" → the assistant shows
// a `connect` card. Case 2: Connect → the service's sign-in (the fake approves at
// once) → callback → connected with no restart → "search my pages" → the assistant
// calls mcp__acme-pages__search_pages through the bot's proxy, the fake sees the
// bearer it issued, and the reply names the page.
// Skipped unless DEEPSEEK_BOT_E2E_MODEL=1 (model via the local Magpie gateway).
const run = process.env.DEEPSEEK_BOT_E2E_MODEL === '1'
const TITLE = 'Quarterly Garden Plan 7Q4'
const SERVICE = 'acme-pages'

type Frow = { kind: string; id: string; text?: string; name?: string; output?: string; card?: { kind: string; service?: string; title?: string } }
type Frame = { type: string; rows?: Frow[]; running?: boolean }

let fake: Awaited<ReturnType<typeof startFakeOAuth>>
let home = ''
let child: ChildProcess | undefined
let out = ''
let origin = ''
let h: Record<string, string> = {}
let token = ''

before(async () => {
  if (!run) return
  fake = await startFakeOAuth({ autoApprove: true, pageTitle: TITLE, getStream: false })
  home = mkdtempSync(join(tmpdir(), 'bot-oauth-e2e-'))
  child = spawn(process.execPath, ['src/main.ts', '--home', home, '--host', '127.0.0.1', '--port', '0', '--model', 'magpie/group/auto-deepseek-flash', '--base-url', 'http://127.0.0.1:3425/v1', '--api-key-env', 'DEEPSEEK_BOT_MODEL_KEY'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, DEEPSEEK_BOT_MODEL_KEY: 'none', DEEPSEEK_BOT_GUARD_ALLOW: '127.0.0.1', DEEPSEEK_BOT_ONE_TAP_EXTRA: JSON.stringify([{ id: SERVICE, name: 'Acme Pages', url: fake.mcpUrl, description: 'Your pages in Acme.' }]) },
  })
  const pairUrl = await new Promise<string>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`no pairing url:\n${out}`)), 120_000)
    child!.stdout!.on('data', (d) => { out += d; const m = /(http:\/\/[^\s]+\/pair\?code=(\d{6}))/.exec(out); if (m) { clearTimeout(t); resolve(m[1]) } })
    child!.stderr!.on('data', (d) => { out += d })
    child!.on('exit', (c) => { clearTimeout(t); reject(new Error(`bot exited ${c}:\n${out}`)) })
  })
  for (let i = 0; i < 150 && !/listening to the assistant/.test(out); i++) await new Promise((r) => setTimeout(r, 200))
  const u = new URL(pairUrl); u.hostname = '127.0.0.1'; origin = u.origin
  ;({ token } = await (await fetch(`${origin}/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: u.searchParams.get('code'), name: 'e2e' }) })).json() as { token: string })
  h = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
  await fetch(`${origin}/consent`, { method: 'PUT', headers: h, body: JSON.stringify({ ai: true, age: 'adult' }) }) // the person agreed to the AI provider (required since 1a602a4)
  await fetch(`${origin}/settings`, { method: 'PUT', headers: h, body: JSON.stringify({ assistantName: 'Nori' }) })
})

after(async () => {
  if (!run) return
  if (child && child.exitCode === null) await new Promise<void>((r) => { child!.once('exit', () => r()); child!.kill('SIGTERM') })
  await fake?.close()
  if (home) rmSync(home, { recursive: true, force: true })
})

/** Follow one thread over /events; rows by id, idle when the last status says not running. */
async function follow(sessionId: string) {
  const ws = new WebSocket(`${origin.replace('http', 'ws')}/events`, ['bearer', token])
  const frames: Frame[] = []
  ws.on('message', (m) => frames.push(JSON.parse(m.toString())))
  await new Promise<void>((r) => ws.on('open', () => r()))
  ws.send(JSON.stringify({ type: 'follow', sessionId }))
  const rows = () => { const byId = new Map<string, Frow>(); for (const f of frames) for (const r of f.rows ?? []) byId.set(r.id, r); return [...byId.values()] }
  return { rows, close: () => ws.close() }
}

const approveAll = async () => { for (const a of await (await fetch(`${origin}/asks`, { headers: h })).json() as { kind: string; eventId: string }[]) if (a.kind === 'approval') await fetch(`${origin}/approvals/${encodeURIComponent(a.eventId)}`, { method: 'POST', headers: h, body: JSON.stringify({ outcome: 'allowed-once' }) }) }
async function until(fn: () => boolean | Promise<boolean>, ms: number, what: () => string) {
  const end = Date.now() + ms
  while (Date.now() < end) { if (await fn()) return; await new Promise((r) => setTimeout(r, 1000)) }
  throw new Error(`timed out waiting for ${what()}`)
}

test('"connect my Acme Pages" in a thread: the assistant answers with a connect card for that service', { skip: !run, timeout: 300_000 }, async () => {
  const listed = await (await fetch(`${origin}/connectors`, { headers: h })).json() as { catalog: { id: string; available: boolean }[] }
  assert.equal(listed.catalog.find((p) => p.id === SERVICE)?.available, true, 'the host-offered service is in the catalog and available')
  const t = await (await fetch(`${origin}/threads`, { method: 'POST', headers: h, body: '{}' })).json() as { sessionId: string }
  const f = await follow(t.sessionId)
  try {
    const r = await fetch(`${origin}/threads/${t.sessionId}/messages`, { method: 'POST', headers: h, body: JSON.stringify({ text: 'Connect my Acme Pages.' }) })
    assert.equal(r.status, 200)
    const card = () => f.rows().find((x) => x.kind === 'card' && x.card?.kind === 'connect')
    await until(async () => { await approveAll(); return Boolean(card()) }, 240_000, () => `a connect card (rows: ${JSON.stringify(f.rows().map((x) => [x.kind, x.name, x.card?.kind, (x.text ?? x.output ?? '').slice(0, 120)]))})`)
    assert.equal(card()!.card!.service, SERVICE)
    console.log(`[e2e] connect card: ${JSON.stringify(card()!.card)}`)
  } finally { f.close() }
})

test('Connect → sign-in → callback → connected with no restart → the assistant searches the pages with the person\'s token', { skip: !run, timeout: 480_000 }, async () => {
  const pid = child!.pid
  const { sessionId } = await (await fetch(`${origin}/sessions/main`, { method: 'POST', headers: h })).json() as { sessionId: string }
  const f = await follow(sessionId)
  try {
    // the phone: Connect → the authorization URL → the system browser
    const c = await fetch(`${origin}/connectors/${SERVICE}/connect`, { method: 'POST', headers: h })
    assert.equal(c.status, 200)
    const { url } = await c.json() as { url: string }
    const auth = new URL(url)
    assert.equal(auth.origin, fake.origin); assert.equal(auth.searchParams.get('redirect_uri'), `${origin}/connectors/callback`)
    // the browser: the service approves and redirects; the bot's callback answers without a device token
    const approved = await fetch(url, { redirect: 'manual' })
    assert.equal(approved.status, 302)
    const back = approved.headers.get('location')!
    assert.ok(back.startsWith(`${origin}/connectors/callback?`), back)
    const tCallback = Date.now()
    const page = await fetch(back)
    assert.equal(page.status, 200)
    assert.match(await page.text(), /Acme Pages is connected/)

    const listed = await (await fetch(`${origin}/connectors`, { headers: h })).json() as { connectors: { id: string; connected: boolean }[] }
    assert.equal(listed.connectors.find((x) => x.id === SERVICE)?.connected, true)
    const issued = [...fake.tokens.keys()]
    assert.equal(issued.length, 1, 'one access token issued')
    assert.doesNotMatch(JSON.stringify(listed), new RegExp(issued[0]))
    assert.doesNotMatch(readFileSync(join(home, 'connectors.json'), 'utf8'), new RegExp(issued[0]))

    // no restart: the same process, and DSH reaches the service through the proxy within seconds
    const mcpCalls = () => fake.log.filter((l) => l.path === '/mcp' && l.method === 'POST')
    await until(() => mcpCalls().some((l) => (l.body as { method?: string })?.method === 'tools/list' && l.headers.authorization === `Bearer ${issued[0]}`), 30_000, () => `DSH to list the service's tools (mcp calls: ${JSON.stringify(mcpCalls().map((l) => (l.body as { method?: string })?.method))})`)
    const listedAt = fake.log.findIndex((l) => l.path === '/mcp' && (l.body as { method?: string })?.method === 'tools/list')
    const mountMs = (fake.log[listedAt] as { at?: number }).at! - tCallback
    assert.ok(mountMs < 5000, `DSH mounted the service ${mountMs} ms after the callback; the "[Connected …]" message waits 5 s (src/main.ts)`)
    assert.equal(child!.pid, pid); assert.equal(child!.exitCode, null)
    console.log(`[e2e] connected; DSH listed the tools via the proxy ${mountMs} ms after the callback, bot pid unchanged (${pid})`)

    // the person asks; the assistant uses the service
    const r = await fetch(`${origin}/threads/${sessionId}/messages`, { method: 'POST', headers: h, body: JSON.stringify({ text: 'Search my Acme Pages for "garden" and tell me the title of the page you find.' }) })
    assert.equal(r.status, 200)
    const reply = () => f.rows().filter((x) => x.kind === 'them').map((x) => x.text ?? '').join('\n')
    await until(async () => { await approveAll(); return fake.toolCalls.length > 0 && reply().includes(TITLE) }, 360_000, () => `a search_pages call and a reply naming the page (calls: ${JSON.stringify(fake.toolCalls.map((x) => x.args))}; rows: ${JSON.stringify(f.rows().map((x) => [x.kind, x.name, (x.text ?? x.output ?? '').slice(0, 160)]))})`)
    const call = fake.toolCalls[0]
    assert.equal(call.bearer, issued[0], 'the service saw the bearer it issued to this person')
    assert.ok(f.rows().some((x) => x.kind === 'step' && x.name === `mcp__${SERVICE}__search_pages`), 'the thread shows the tool step')
    console.log(`[e2e] search_pages(${JSON.stringify(call.args)}) with the issued bearer; reply: ${reply().slice(-200).replace(/\n/g, ' ')}`)
  } finally { f.close() }
})
