import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { WebSocket } from 'ws'
import { Connectors } from '../src/connectors.ts'

// Real dsh + real model: connectors added in the store become MCP servers the
// assistant can use. Two connectors: the filesystem preset on a temp folder
// (the answer must name a file only that folder has), and a custom stdio server
// that returns an env var forwarded by name (DSH scrubs TOKEN-like ambient vars,
// so the value arrives only through the `!!js process.env.X` the row carries).
// Skipped unless DEEPSEEK_BOT_E2E_MODEL=1 (needs the local model gateway).
const run = process.env.DEEPSEEK_BOT_E2E_MODEL === '1'
const MARKER = `marker-${randomUUID().slice(0, 8)}`
const FILE = 'zebra-manifest-4471.txt'

async function startBot(home: string, extraEnv: Record<string, string>) {
  const child: ChildProcess = spawn(process.execPath, ['src/main.ts', '--home', home, '--host', '127.0.0.1', '--port', '0', '--model', 'magpie/group/auto-deepseek-flash', '--base-url', 'http://127.0.0.1:3425/v1', '--api-key-env', 'DEEPSEEK_BOT_MODEL_KEY'], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, DEEPSEEK_BOT_MODEL_KEY: 'local', ...extraEnv } })
  let out = ''
  const pairUrl = await new Promise<string>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`no pairing url:\n${out}`)), 120_000)
    child.stdout!.on('data', (d) => { out += d; const m = /(http:\/\/[^\s]+\/pair\?code=(\d{6}))/.exec(out); if (m) { clearTimeout(t); resolve(m[1]) } })
    child.stderr!.on('data', (d) => { out += d })
    child.on('exit', (c) => { clearTimeout(t); reject(new Error(`bot exited ${c}:\n${out}`)) })
  })
  for (let i = 0; i < 150 && !/listening to the assistant/.test(out); i++) await new Promise((r) => setTimeout(r, 200))
  return { origin: new URL(pairUrl).origin, code: new URL(pairUrl).searchParams.get('code')!, log: () => out, stop: () => new Promise<void>((r) => { child.once('exit', () => r()); child.kill('SIGTERM') }) }
}

/** Follow one session through the bot's proxy (device token as bearer), collecting tool names and the last assistant text. */
function followSession(origin: string, token: string, sessionId: string) {
  const state = { tools: [] as string[], text: '', turns: 0 }
  const ws = new WebSocket(`${origin.replace('http', 'ws')}/api/remote.mux`, { headers: { authorization: `Bearer ${token}` } })
  ws.on('open', () => ws.send(JSON.stringify({ type: 'open', streamId: '1', endpoint: 'session/follow', payload: { args: { request: { address: { kind: 'session', sessionId }, maxMessages: 1 } } } })))
  ws.on('message', (d) => {
    const f = JSON.parse(d.toString()) as { type: string; value?: { type: string; event?: { type: string; data?: { name?: string; message?: { content?: { type: string; text?: string }[] } } } } }
    const ev = f.type === 'item' && f.value?.type === 'event' ? f.value.event : undefined
    if (!ev) return
    if (ev.type === 'tool/call' && ev.data?.name) state.tools.push(ev.data.name)
    if (ev.type === 'assistant/message') { const t = (ev.data?.message?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join(''); if (t.trim()) state.text = t }
    if (ev.type === 'turn/end') state.turns++
  })
  return { state, close: () => ws.close() }
}

async function until(fn: () => boolean | Promise<boolean>, ms: number, what: string) {
  const end = Date.now() + ms
  while (Date.now() < end) { if (await fn()) return; await new Promise((r) => setTimeout(r, 1000)) }
  throw new Error(`timed out waiting for ${what}`)
}

test('connectors: the assistant lists a folder through the filesystem MCP server and reads a forwarded env var through a custom one', { skip: !run, timeout: 420_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'bot-connectors-'))
  const folder = join(home, 'shared-folder'); mkdirSync(folder); writeFileSync(join(folder, FILE), 'hello\n')
  const store = await Connectors.open(join(home, 'connectors.json'))
  await store.add({ preset: 'filesystem', path: folder })
  await store.add({ custom: true, name: 'envprobe', transport: 'stdio', command: process.execPath, args: [join(process.cwd(), 'test', 'fixtures', 'env-mcp.mjs')], envNames: ['BOT_E2E_PROBE_TOKEN'] })

  const bot = await startBot(home, { BOT_E2E_PROBE_TOKEN: MARKER })
  try {
    assert.match(bot.log(), /\[bot\] connectors: filesystem, envprobe/)
    const { token } = await (await fetch(`${bot.origin}/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: bot.code, name: 'e2e' }) })).json() as { token: string }
    const h = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
    await fetch(`${bot.origin}/consent`, { method: 'PUT', headers: h, body: JSON.stringify({ ai: true, age: 'adult' }) }) // the person agreed to the AI provider (required since 1a602a4)
    const listed = await (await fetch(`${bot.origin}/connectors`, { headers: h })).json() as { connectors: { id: string; enabled: boolean; missingEnv: string[] }[]; env: Record<string, boolean>; restartNeeded: boolean }
    assert.deepEqual(listed.connectors.map((c) => c.id), ['filesystem', 'envprobe'])
    assert.equal(listed.env.BOT_E2E_PROBE_TOKEN, true); assert.equal(listed.restartNeeded, false)
    assert.doesNotMatch(JSON.stringify(listed), new RegExp(MARKER))

    await fetch(`${bot.origin}/settings`, { method: 'PUT', headers: h, body: JSON.stringify({ assistantName: 'Nori' }) })
    const { sessionId } = await (await fetch(`${bot.origin}/sessions/main`, { method: 'POST', headers: h })).json() as { sessionId: string }
    const f = followSession(bot.origin, token, sessionId)
    // MCP tools may ask for approval; say yes to everything during this test.
    const approveAll = async () => { for (const a of await (await fetch(`${bot.origin}/asks`, { headers: h })).json() as { kind: string; eventId: string }[]) if (a.kind === 'approval') await fetch(`${bot.origin}/approvals/${encodeURIComponent(a.eventId)}`, { method: 'POST', headers: h, body: JSON.stringify({ outcome: 'allowed-once' }) }) }
    const ask = async (text: string) => {
      const r = await fetch(`${bot.origin}/api/session/prompt`, { method: 'POST', headers: h, body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: 'session/prompt', payload: { args: { request: { requestId: randomUUID(), sessionId, mode: 'queue', content: [{ type: 'text', text }] } } } }) })
      assert.equal(r.status, 200)
    }

    // The bot may queue its own first prompt into a fresh main thread, so count
    // outcomes, not turns: the connector's tool was called and the answer names the file.
    const fsTool = () => f.state.tools.some((t) => /^mcp__filesystem__/.test(t))
    await ask(`Call the tool mcp__filesystem__list_directory on the folder ${folder} (do not use bash or your built-in file tools for this). Reply with the file names only.`)
    await until(async () => { await approveAll(); return fsTool() && f.state.text.includes(FILE) }, 180_000, `an mcp__filesystem__ call and an answer naming ${FILE} (tools called: ${f.state.tools.join(', ')}; last text: ${JSON.stringify(f.state.text)})`)

    const probeTool = () => f.state.tools.includes('mcp__envprobe__probe')
    await ask('Call the tool mcp__envprobe__probe once and reply with exactly the text it returns, nothing else.')
    await until(async () => { await approveAll(); return probeTool() && f.state.text.includes(MARKER) }, 180_000, `an mcp__envprobe__probe call and an answer containing the forwarded env value (tools called: ${f.state.tools.join(', ')}; last text: ${JSON.stringify(f.state.text)})`)
    f.close()
  } finally { await bot.stop() }
})
