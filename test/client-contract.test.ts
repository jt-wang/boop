// Every request the phone app makes still has a route on the computer, for this version of the app and for the last
// release's (REGRESSION.md, "Upgrade paths"): a phone that has not updated yet talks to a computer that has. Each call is
// sent as the app sends it: a paired device's token (none on /pair, as a new phone has none), after the person agreed to the AI provider (PUT /consent first),
// /pair with a live code, the bodies of BODIES, the query it carries. A fixed path must answer 2xx JSON; a path with an
// id or a value in it (x) may also answer a JSON 404 for that made-up item. So a fixed route removed or moved to another
// method, an invalid token, or a missing consent fails it. This is a route check, not proof the payloads still agree; and
// a removed item route inside the device block also answers a JSON 404, which it cannot tell apart.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBotServer, type Settings } from '../src/server.ts'
import { MemoryDeviceStore } from '../src/devices.ts'
import { Pairing } from '../src/pairing.ts'
import { Connectors } from '../src/connectors.ts'
import { Compliance, REPORT_REASONS } from '../src/compliance.ts'
import { createServer } from 'node:http'

/** The last release's app: the newest vX.Y.Z tag behind HEAD (the public repo; tests.yml fetches tags), else 0.1.10's private
 * commit (the private repo has no release tags; .dev/handoff/boop-0.1.10-ship.md, Source-Rev of v0.1.10-release.1).
 * Null in a checkout with neither: a shallow clone (android-release.yml) or source-export's copy of the export tree.
 * There the last-release test skips and says why; tests.yml sets BOOP_REQUIRE_RELEASE_BASELINE=1, so CI fails instead. */
const git = (...a: string[]) => execFileSync('git', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
function released(): string | null {
  try { return git('describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*', '--exclude', '*-*', 'HEAD') } catch {}
  try { git('cat-file', '-e', '8c0d1b8^{commit}'); return '8c0d1b8' } catch {}
  return null
}
const RELEASED = released()
const NO_BASELINE = 'no release to compare with in this checkout (fetch the tags: actions/checkout fetch-depth: 0)'
if (!RELEASED && process.env.BOOP_REQUIRE_RELEASE_BASELINE === '1') throw new Error(NO_BASELINE)

type Call = { method: string; path: string; auth: boolean }
/** The bot's calls in the app's sources, as they are written there: api().get/text('/x'), api().send('METHOD', '/x'),
 * api().rpc('m'), a request() to `${origin}/x` or `${this.s.origin}/x` with its method, and Stop's post(`/sessions/…`).
 * A type argument may nest (`send<{ ai: NonNullable<Me['ai']> }>('PUT', '/consent'`). An id or a value in a path is x;
 * the query stays (x for its values), as the bot reads it. auth: the call carries the device's token; a request() whose
 * options name neither this.headers() nor authorization goes without one, as /pair from a phone not yet paired does. */
export function calls(sources: string[]): Call[] {
  const out = new Map<string, Call>()
  const add = (method: string, raw: string, auth = true) => {
    const path = raw.replace(/\$\{[^}]*\}/g, 'x')
    out.set(`${method} ${path}`, { method, path, auth })
  }
  const generic = String.raw`(?:<[^()]*>)?`
  for (const s of sources) {
    for (const m of s.matchAll(new RegExp(String.raw`\.(get|text)${generic}\(\s*[\`']([^\`']+)[\`']`, 'g'))) if (m[2].startsWith('/')) add('GET', m[2])
    for (const m of s.matchAll(new RegExp(String.raw`\.send${generic}\(\s*'(POST|PUT|PATCH|DELETE)',\s*[\`']([^\`']+)[\`']`, 'g'))) add(m[1], m[2])
    for (const m of s.matchAll(new RegExp(String.raw`\.rpc${generic}\(\s*'([^']+)'`, 'g'))) add('POST', `/api/${m[1]}`)
    for (const m of s.matchAll(/request\('\w+',\s*`\$\{(?:this\.s\.)?origin\}(\/[^`]*)`,\s*\{\s*method:\s*'(\w+)'([^\n]*)/g)) if (!m[1].startsWith('/api/')) add(m[2], m[1], /this\.headers\(|authorization/.test(m[3]))
    for (const m of s.matchAll(/post\(`(\/sessions\/[^`]+)`\)/g)) add('POST', m[1])
  }
  return [...out.values()]
}

const REPORT_REASON = REPORT_REASONS[0]
/** What the app sends with the calls a fixed path takes (mobile/src); the others send {} or nothing. */
const BODIES: Record<string, (p: Pairing) => unknown> = {
  'POST /pair': (p) => ({ code: p.create(), name: 'Second phone' }),
  'PUT /consent': () => ({ age: 'adult', ai: true }),
  'PUT /settings': () => ({ proactivity: 'low' }),
  'PUT /me/context': () => ({ timeZone: 'Europe/Lisbon', locale: 'en' }),
  'PATCH /devices/me': () => ({ name: 'Phone' }),
  'POST /reports': () => ({ kind: 'reply', reason: REPORT_REASON, excerpt: 'A reply' }),
  'POST /threads/x/messages': () => ({ text: 'Hello' }),
  'POST /push/subscribe': () => ({ kind: 'fcm', token: 'f'.repeat(40) }),
  'POST /push/unsubscribe': () => ({ kind: 'fcm', token: 'f'.repeat(40) }),
  'POST /connectors': () => ({ preset: 'memory' }),
}

const appFiles = (dir: string) => readdirSync(dir).filter((f) => /\.tsx?$/.test(f)).map((f) => readFileSync(join(dir, f), 'utf8'))
const releasedFiles = () => {
  const names = git('ls-tree', '--name-only', `${RELEASED}:mobile/src`).split('\n').filter((f) => /\.tsx?$/.test(f))
  return names.map((f) => git('show', `${RELEASED}:mobile/src/${f}`))
}

async function boot() {
  const root = mkdtempSync(join(tmpdir(), 'contract-'))
  const harness = {
    kind: 'fake', events: { on() {}, clientId: 'c' },
    async createSession() { return { sessionId: 'main' } }, async listSessions() { return [] },
    async prompt() {}, async answer() {}, async cancel() { return true }, async rpc() { return { items: [] } as never }, async close() {},
    async follow() { return () => {} },
  }
  let settings: Settings = { assistantName: 'Nori', mainSessionId: 'main', language: 'auto' }
  const store = { get: async () => ({ ...settings }), set: async (p: Partial<Settings>) => { settings = { ...settings, ...p }; return { ...settings } } }
  const devices = new MemoryDeviceStore()
  const token = await devices.issue('Phone')
  const pairingOf = new Pairing(devices)
  // DSH behind the bot's /api proxy: every gateway call answers as DSH does
  const dsh = createServer((_q, r) => { r.writeHead(200, { 'content-type': 'application/json' }); r.end(JSON.stringify({ type: 'server-response', rpcId: 'r', result: { ok: true, value: {} } })) })
  await new Promise<void>((r) => dsh.listen(0, '127.0.0.1', r))
  const ui = { list: () => [], module: () => undefined, verify: () => false, block: async () => false, setGrants: async () => false, setHidden: async () => false }
  const library = { list: async () => [], read: async () => null, remove: async () => false }
  const bot = await createBotServer({ dsh: { origin: `http://127.0.0.1:${(dsh.address() as { port: number }).port}`, cookie: 'c=1' },
    ui: ui as never, library, home: root,
    compliance: await Compliance.open(root, { settings: store, model: { provider: 'siliconflow', model: 'deepseek-ai/DeepSeek-V4.1-Flash', baseURL: 'https://api.siliconflow.cn/v1' }, origin: () => 'http://127.0.0.1:9' }), connectors: await Connectors.open(join(root, 'connectors.json')), devices, pairing: pairingOf, harness: harness as never,
    watcher: { clientId: 'c', on() {} } as never, host: '127.0.0.1', port: 0, settings: store, workspace: root,
    ideas: { list: () => [], refresh: async () => [], dismiss: async () => false }, memory: { items: async () => [], forgetById: async () => null, update: async () => null } as never,
    scheduler: { list: () => [], remove: async () => false, update: async () => undefined }, goals: { list: () => [], update: async () => undefined, remove: async () => false }, activity: () => [],
    appDir: join(import.meta.dirname, '..', 'app') })
  return { bot, token, pairing: pairingOf, close: async () => { await bot.close(); dsh.close() } }
}

for (const [which, sources, skip] of [['this version', () => appFiles(join(import.meta.dirname, '..', 'mobile', 'src')), false], [`the last release (${RELEASED ?? 'none here'})`, releasedFiles, RELEASED ? false : NO_BASELINE]] as const) {
  test(`every call the app of ${which} makes has a route on this computer`, { skip }, async () => {
    const list = calls(sources())
    // the extraction itself: it must find the calls the app is built on, or an empty list would pass
    for (const must of ['GET /me', 'GET /threads', 'POST /ws-ticket', 'POST /threads/x/messages', 'POST /sessions/x/cancel', 'DELETE /devices/x', 'POST /api/session/create', 'POST /pair', 'PUT /consent'])
      assert.ok(list.some((c) => `${c.method} ${c.path}` === must), `found ${must}`)
    // a phone pairs before it has a token: /pair goes without one, every other call with it
    assert.deepEqual(list.filter((c) => !c.auth).map((c) => `${c.method} ${c.path}`), ['POST /pair'])
    const { bot, token, pairing, close } = await boot()
    try {
      // the person has agreed (every /api call needs it), then the calls in the app's order of a session
      const ordered = [...list].sort((x, y) => Number(y.path === '/consent') - Number(x.path === '/consent'))
      const wrong: string[] = []
      for (const c of ordered) {
        const body = c.method === 'GET' ? undefined : JSON.stringify(BODIES[`${c.method} ${c.path}`]?.(pairing) ?? {})
        const r = await fetch(bot.origin + c.path, { method: c.method, headers: { ...(c.auth ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' }, body })
        const type = r.headers.get('content-type') ?? ''
        await r.arrayBuffer()
        // a fixed path answers 2xx; an item's (an id or a value in it, x) may also say there is no such item
        const item = /\/x(\/|$|\?)|=x(&|$)/.test(c.path)
        const ok = type.includes('json') && (r.ok || (item && r.status === 404))
        if (process.env.CONTRACT_DEBUG) console.log(`${c.method} ${c.path} → ${r.status}`)
        if (!ok) wrong.push(`${c.method} ${c.path} → ${r.status} ${type || '(no type)'}`)
      }
      assert.deepEqual(wrong, [])
    } finally { await close() }
  })
}
