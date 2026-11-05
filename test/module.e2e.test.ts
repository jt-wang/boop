import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { ThreadView } from './threadview.ts'

// Generative UI, second layer, with the real model: asked for a tip calculator,
// the assistant writes an NSH TSX module with the `ui` tool; the bot signs it;
// the package verifies against the bot's root key; the module's result posted
// to /ui/:id/result shows as the person's message and the assistant reads it.
// Skipped unless DEEPSEEK_BOT_E2E_MODEL=1 (model via the local Magpie gateway).
const run = process.env.DEEPSEEK_BOT_E2E_MODEL === '1'
const NSH = process.env.NSH_BIN ?? join(homedir(), '.local', 'bin', 'nsh')

async function startBot() {
  const home = mkdtempSync(join(tmpdir(), 'bot-module-'))
  const child: ChildProcess = spawn(process.execPath, ['src/main.ts', '--home', home, '--host', '127.0.0.1', '--port', '0', '--model', 'magpie/group/auto-deepseek-flash', '--base-url', 'http://127.0.0.1:3425/v1', '--api-key-env', 'DEEPSEEK_BOT_MODEL_KEY'], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, DEEPSEEK_BOT_MODEL_KEY: 'local' } })
  let out = ''
  const pairUrl = await new Promise<string>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`no pairing url:\n${out}`)), 90_000)
    child.stdout!.on('data', (d) => { out += d; const m = /(http:\/\/[^\s]+\/pair\?code=(\d{6}))/.exec(out); if (m) { clearTimeout(t); resolve(m[1]) } })
    child.stderr!.on('data', (d) => { out += d })
    child.on('exit', (c) => { clearTimeout(t); reject(new Error(`bot exited ${c}:\n${out}`)) })
  })
  for (let i = 0; i < 100 && !/listening to the assistant/.test(out); i++) await new Promise((r) => setTimeout(r, 200))
  assert.match(out, /ui modules on/, 'the bot found nsh and made its keys')
  const u = new URL(pairUrl); u.hostname = '127.0.0.1'
  return { home, origin: u.origin, code: u.searchParams.get('code')!, log: () => out, stop: () => new Promise<void>((r) => { child.once('exit', () => { rmSync(home, { recursive: true, force: true }); r() }); child.kill('SIGTERM') }) }
}


test('tip calculator: the assistant builds a module with `ui`; the package verifies; the posted result becomes the person\'s message and gets a reply', { skip: !run, timeout: 600_000 }, async () => {
  const bot = await startBot()
  try {
    const { token } = await (await fetch(`${bot.origin}/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: bot.code, name: 'e2e' }) })).json() as { token: string }
    const h = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
    await fetch(`${bot.origin}/consent`, { method: 'PUT', headers: h, body: JSON.stringify({ ai: true, age: 'adult' }) }) // the person agreed to the AI provider (required since 1a602a4)
    await fetch(`${bot.origin}/settings`, { method: 'PUT', headers: h, body: JSON.stringify({ assistantName: 'Nori' }) })
    const me = await (await fetch(`${bot.origin}/me`, { headers: h })).json() as { uiRootPublicKey: string | null }
    assert.match(me.uiRootPublicKey ?? '', /^[A-Za-z0-9+/]{43}=$/, 'the root key is on /me')
    const t = await (await fetch(`${bot.origin}/threads`, { method: 'POST', headers: h, body: '{}' })).json() as { sessionId: string }
    const { WebSocket } = await import('ws')
    const ws = new WebSocket(`${bot.origin.replace('http', 'ws')}/events`, ['bearer', token])
    // this thread only (other sessions' status frames share the socket), applied the way the app applies frames
    const view = new ThreadView(t.sessionId)
    ws.on('message', (m) => view.apply(JSON.parse(m.toString())))
    await new Promise<void>((r) => ws.on('open', () => r()))
    ws.send(JSON.stringify({ type: 'follow', sessionId: t.sessionId }))
    const rows = () => view.rows()
    const waitIdle = async (ms: number) => { const end = Date.now() + ms; while (Date.now() < end && !view.turnOver()) await new Promise((x) => setTimeout(x, 250)); assert.ok(view.turnOver(), `the turn ended within ${ms / 1000} s`) }

    const t0 = Date.now()
    const r1 = await fetch(`${bot.origin}/threads/${t.sessionId}/messages`, { method: 'POST', headers: h, body: JSON.stringify({ text: 'Make me a tip calculator for a €42 bill with 10/15/20% buttons; use the ui tool.' }) })
    assert.equal(r1.status, 200)
    await waitIdle(300_000)
    const turnMs = Date.now() - t0
    const steps = rows().filter((r) => r.kind === 'step' && r.name === 'mcp__bot__ui')
    const mod = rows().find((r) => r.kind === 'module')
    assert.ok(mod, `a module row (ui attempts that failed: ${steps.length}; rows: ${JSON.stringify(rows().map((r) => [r.kind, r.name, (r.output ?? '').slice(0, 200)]))})`)
    assert.match(mod!.moduleId ?? '', /^m[0-9a-f]{10}$/); assert.ok(mod!.title); assert.equal(mod!.url, `/ui/${mod!.moduleId}.nshpkg`)
    console.log(`[e2e] module ${mod!.moduleId} "${mod!.title}" after ${turnMs} ms, ${steps.length} compile-error round(s) first`)

    // the phone's part: download the package, verify it against the root
    const pkg = await fetch(`${bot.origin}${mod!.url}?session=${t.sessionId}`, { headers: h })
    assert.equal(pkg.status, 200)
    const bytes = Buffer.from(await pkg.arrayBuffer())
    const file = join(bot.home, 'downloaded.nshpkg'); writeFileSync(file, bytes)
    const verified = execFileSync(NSH, ['verify', file, '--root', join(bot.home, 'keys', 'root.pub')], { encoding: 'utf8' })
    assert.match(verified, new RegExp(`^valid: dev\\.deepseekbot\\.ui\\.${mod!.moduleId} `))
    console.log(`[e2e] package ${bytes.length} bytes: ${verified.trim()}`)
    const src = await (await fetch(`${bot.origin}/ui/${mod!.moduleId}/source`, { headers: h })).text()
    assert.match(src, /mount\(/); assert.match(src, /\/result/)
    const meta = await (await fetch(`${bot.origin}/ui/${mod!.moduleId}/meta`, { headers: h })).json() as { token: string }

    // the module's part: post the result with its own token
    view.nextTurn()
    const posted = await fetch(`${bot.origin}/ui/${mod!.moduleId}/result`, { method: 'POST', headers: { authorization: `Bearer ${meta.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ value: { tip: 6.3 } }) })
    assert.equal(posted.status, 200)
    await waitIdle(180_000)
    ws.close()
    const after = rows()
    assert.equal(after.find((r) => r.id === mod!.id)?.answer, 'tip: 6.3', 'the module row shows the answer')
    assert.ok(after.some((r) => r.kind === 'you' && r.text === 'tip: 6.3'), 'the result shows as the person')
    const reply = after.filter((r) => r.kind === 'them').map((r) => r.text ?? '').join('\n')
    assert.ok(/6[.,]3/.test(reply) || /tip/i.test(reply), `the reply acknowledges the tip: ${reply.slice(-300)}`)
  } finally { await bot.stop() }
})
