import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CATALOG, Connectors, connectorEnvNames, connectorRowsYaml, envPresence, extraOneTap, handleConnectorsRoute, type Connector } from '../src/connectors.ts'
import { openHome } from '../src/home.ts'

const tmp = () => mkdtempSync(join(tmpdir(), 'connectors-'))

test('the catalog: one-tap services (OAuth, remote MCP) first, local presets and custom after; every preset names a setup hint; stdio presets pin a version', () => {
  assert.ok(CATALOG.length >= 8)
  for (const p of CATALOG) {
    assert.match(p.id, /^[a-z0-9-]{1,32}$/, p.id)
    assert.ok(p.name && p.description, p.id)
    assert.ok(Array.isArray(p.envNames), p.id)
    if (p.custom) continue
    if (p.auth === 'oauth') { assert.match(p.url ?? '', /^https:\/\//, p.id); assert.equal(p.transport, 'streamable-http', p.id); assert.deepEqual(p.envNames, [], `${p.id}: a one-tap service asks for no env var`); continue }
    assert.ok(p.hint, p.id)
    if (p.transport === 'stdio') {
      assert.equal(p.command, 'npx', p.id)
      assert.ok(p.args?.some((a) => /@\d+\.\d+\.\d+$/.test(a)), `${p.id} pins a version: ${p.args?.join(' ')}`)
    } else {
      assert.match(p.url ?? '', /^https:\/\//, p.id)
    }
  }
  const ids = CATALOG.map((p) => p.id)
  for (const want of ['notion', 'linear', 'atlassian', 'github', 'slack', 'gmail', 'google-calendar', 'google-drive', 'filesystem', 'memory', 'custom']) assert.ok(ids.includes(want), want)
  // measured 2026-10-27 (docs/connectors.md): Notion, Linear and Atlassian register any client dynamically; GitHub, Slack and Google need a client the host registered
  for (const id of ['notion', 'linear', 'atlassian']) assert.equal(CATALOG.find((p) => p.id === id)!.clientEnv, undefined, id)
  for (const id of ['github', 'slack', 'gmail', 'google-calendar', 'google-drive']) assert.match(CATALOG.find((p) => p.id === id)!.clientEnv ?? '', /^DEEPSEEK_BOT_OAUTH_[A-Z]+$/, id)
  assert.equal(CATALOG.find((p) => p.id === 'notion')!.url, 'https://mcp.notion.com/mcp')
  assert.equal(CATALOG.find((p) => p.id === 'linear')!.url, 'https://mcp.linear.app/mcp')
  assert.equal(CATALOG.find((p) => p.id === 'atlassian')!.url, 'https://mcp.atlassian.com/v2/mcp')
  assert.equal(CATALOG.find((p) => p.id === 'github')!.url, 'https://api.githubcopilot.com/mcp/')
  assert.equal(CATALOG.find((p) => p.id === 'slack')!.url, 'https://mcp.slack.com/mcp')
  assert.equal(CATALOG.find((p) => p.id === 'gmail')!.url, 'https://gmailmcp.googleapis.com/mcp/v1')
  assert.ok(ids.indexOf('notion') < ids.indexOf('filesystem') && ids.indexOf('filesystem') < ids.indexOf('custom'))
})

test('an OAuth preset cannot be added by POST: it is connected through the OAuth flow (src/oauth.ts)', async () => {
  const dir = tmp()
  const store = await Connectors.open(join(dir, 'connectors.json'))
  await assert.rejects(store.add({ preset: 'notion' }), /Connect/)
})

test('add from a preset: the filesystem preset takes one existing folder and becomes an enabled stdio connector', async () => {
  const dir = tmp()
  const store = await Connectors.open(join(dir, 'connectors.json'))
  const c = await store.add({ preset: 'filesystem', path: dir })
  assert.equal(c.id, 'filesystem'); assert.equal(c.transport, 'stdio'); assert.equal(c.enabled, true)
  assert.equal(c.command, 'npx'); assert.ok(c.args!.includes(dir))
  assert.deepEqual(c.envNames, [])
  assert.ok(existsSync(join(dir, 'connectors.json')))
  const again = await Connectors.open(join(dir, 'connectors.json'))
  assert.equal(again.list().length, 1)
  // a second one gets its own id
  const c2 = await store.add({ preset: 'filesystem', path: dir })
  assert.equal(c2.id, 'filesystem-2')
})

test('add from a preset refuses a missing folder, a relative path, an unknown preset, and the custom pseudo-preset', async () => {
  const dir = tmp()
  const store = await Connectors.open(join(dir, 'connectors.json'))
  await assert.rejects(store.add({ preset: 'filesystem' }), /folder/)
  await assert.rejects(store.add({ preset: 'filesystem', path: 'relative/dir' }), /absolute/)
  await assert.rejects(store.add({ preset: 'filesystem', path: join(dir, 'nope') }), /folder/)
  await assert.rejects(store.add({ preset: 'nope' }), /preset/)
  await assert.rejects(store.add({ preset: 'custom' }), /custom: true/)
  assert.equal(store.list().length, 0)
})

test('the memory preset gets a literal file under the store; nothing secret is ever in connectors.json', async () => {
  const dir = tmp()
  const store = await Connectors.open(join(dir, 'connectors.json'))
  const mem = await store.add({ preset: 'memory' })
  assert.equal(mem.env?.MEMORY_FILE_PATH, join(dir, 'connectors', 'memory.jsonl'))
  const raw = readFileSync(join(dir, 'connectors.json'), 'utf8')
  assert.doesNotMatch(raw, /ghp_|ntn_/)
})

test('custom servers need an explicit custom: true and only env var names', async () => {
  const dir = tmp()
  const store = await Connectors.open(join(dir, 'connectors.json'))
  await assert.rejects(store.add({ name: 'My server', transport: 'stdio', command: 'my-mcp' }), /custom: true/)
  await assert.rejects(store.add({ custom: true, name: 'My server', transport: 'stdio', command: 'my-mcp', env: { TOKEN: 'abc' } }), /names/)
  await assert.rejects(store.add({ custom: true, name: 'My server', transport: 'streamable-http', url: 'http://x/mcp', headers: { authorization: 'Bearer abc' } }), /names/)
  await assert.rejects(store.add({ custom: true, name: 'My server', transport: 'stdio', command: 'my-mcp', envNames: ['lower-case'] }), /env var name/)
  await assert.rejects(store.add({ custom: true, name: 'My server', transport: 'streamable-http', url: 'ftp://x' }), /url/)
  await assert.rejects(store.add({ custom: true, name: 'My server', transport: 'stdio' }), /command/)
  const c = await store.add({ custom: true, name: 'My Server!', transport: 'stdio', command: 'my-mcp', args: ['--flag'], envNames: ['MY_TOKEN'] })
  assert.equal(c.id, 'my-server'); assert.equal(c.preset, 'custom'); assert.deepEqual(c.envNames, ['MY_TOKEN'])
  const h = await store.add({ custom: true, name: 'Remote', transport: 'streamable-http', url: 'https://example.com/mcp', bearerEnv: 'REMOTE_TOKEN' })
  assert.equal(h.bearerEnv, 'REMOTE_TOKEN')
})

test('enable, disable, remove persist', async () => {
  const dir = tmp()
  const store = await Connectors.open(join(dir, 'connectors.json'))
  const c = await store.add({ preset: 'memory' })
  assert.equal((await store.setEnabled(c.id, false))!.enabled, false)
  assert.equal(store.enabled().length, 0)
  assert.equal((await Connectors.open(join(dir, 'connectors.json'))).get(c.id)!.enabled, false)
  assert.equal(await store.remove(c.id), true)
  assert.equal(await store.remove(c.id), false)
  assert.equal(await store.setEnabled('ghost', true), undefined)
})

test('restartNeeded: true once the enabled set differs from what the harness was started with', async () => {
  const dir = tmp()
  const store = await Connectors.open(join(dir, 'connectors.json'))
  store.markApplied()
  assert.equal(store.restartNeeded(), false)
  const c = await store.add({ preset: 'memory' })
  assert.equal(store.restartNeeded(), true)
  store.markApplied()
  assert.equal(store.restartNeeded(), false)
  await store.setEnabled(c.id, false)
  assert.equal(store.restartNeeded(), true)
})

test('onChange fires after add, enable/disable and remove, so the bot can rewrite the profile patch at once (dsh reloads it live; measured 2026-10-27)', async () => {
  const dir = tmp()
  const store = await Connectors.open(join(dir, 'connectors.json'))
  const seen: number[] = []
  store.onChange = async () => { seen.push(store.enabled().length) }
  const c = await store.add({ preset: 'memory' })
  await store.setEnabled(c.id, false)
  await store.remove(c.id)
  assert.deepEqual(seen, [1, 0, 0])
})

// The harness gets an allow-listed env (src/dsh.ts harnessEnv, since b1af93f), so a connector's `!!js process.env.X`
// read nothing: test/connectors.e2e's probe answered "marker=" (2026-11-01). The names the person gave a connector
// go into the harness's env; the bot's own secrets (DEEPSEEK_BOT_*) never do, whatever a row says.
test('connectorEnvNames: the env names enabled connectors forward, without the bot\'s own secrets', () => {
  const rows: Connector[] = [
    { id: 'a', name: 'a', preset: 'custom', transport: 'stdio', command: 'x', envNames: ['A_TOKEN', 'DEEPSEEK_BOT_HOST_SECRET'], enabled: true, addedAt: '' },
    { id: 'b', name: 'b', preset: 'custom', transport: 'streamable-http', url: 'https://b', bearerEnv: 'B_KEY', envNames: ['B_KEY'], enabled: true, addedAt: '' },
    { id: 'c', name: 'c', preset: 'custom', transport: 'stdio', command: 'x', envNames: ['C_TOKEN'], enabled: false, addedAt: '' },
    { id: 'd', name: 'd', preset: 'notion', transport: 'streamable-http', url: 'https://d', auth: 'oauth', envNames: ['D_TOKEN'], enabled: true, addedAt: '' },
  ] as Connector[]
  assert.deepEqual(connectorEnvNames(rows), ['A_TOKEN', 'B_KEY'])
})

test('restartNeeded: a connector that needs an env name the harness was not started with', async () => {
  const dir = tmp()
  const store = await Connectors.open(join(dir, 'connectors.json'))
  store.markApplied(); store.markStarted()
  await store.add({ custom: true, name: 'probe', transport: 'stdio', command: 'node', envNames: ['PROBE_TOKEN'] })
  store.markApplied() // the live reload took the row, but the harness's env was fixed when it started
  assert.equal(store.restartNeeded(), true)
  store.markStarted()
  assert.equal(store.restartNeeded(), false)
})

test('connectorRowsYaml: one mcp-client row per enabled connector, secrets by env var name only', () => {
  const rows: Connector[] = [
    { id: 'filesystem', name: 'Files', preset: 'filesystem', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem@1.0.0', '/tmp/a b "q"'], envNames: [], enabled: true, addedAt: 'x' },
    { id: 'notion', name: 'Notion', preset: 'notion', transport: 'stdio', command: 'npx', args: ['-y', '@notionhq/notion-mcp-server@2.5.2'], envNames: ['NOTION_TOKEN'], env: { LITERAL: '/p' }, enabled: true, addedAt: 'x' },
    { id: 'github', name: 'GitHub', preset: 'github', transport: 'streamable-http', url: 'https://api.githubcopilot.com/mcp/', bearerEnv: 'GITHUB_TOKEN', envNames: ['GITHUB_TOKEN'], enabled: true, addedAt: 'x' },
    { id: 'off', name: 'Off', preset: 'memory', transport: 'stdio', command: 'npx', args: [], envNames: [], enabled: false, addedAt: 'x' },
  ]
  const y = connectorRowsYaml(rows, { NOTION_TOKEN: 'ntn_secret_value', GITHUB_TOKEN: 'ghp_secret_value' })
  assert.match(y, /- insert:\n\s+- id: connector-filesystem\n\s+name: '@deepseek-ai\/dsh-mcp-client'\n\s+config:\n\s+serverName: filesystem\n\s+transport: stdio\n\s+command: "npx"\n\s+args: \["-y","@modelcontextprotocol\/server-filesystem@1\.0\.0","\/tmp\/a b \\"q\\""\]\n\s+failOnStartupError: false/)
  assert.match(y, /serverName: notion[\s\S]*env:\n\s+LITERAL: "\/p"\n\s+NOTION_TOKEN: !!js "process\.env\.NOTION_TOKEN \?\? ''"/)
  assert.match(y, /serverName: github\n\s+transport: streamable-http\n\s+url: "https:\/\/api\.githubcopilot\.com\/mcp\/"\n\s+headers:\n\s+Authorization: !!js "`Bearer \$\{process\.env\.GITHUB_TOKEN \?\? ''\}`"/)
  assert.doesNotMatch(y, /secret_value/)
  assert.doesNotMatch(y, /serverName: off/)
  assert.equal(connectorRowsYaml([], {}), '')
})

test('envPresence reports booleans only', () => {
  assert.deepEqual(envPresence(['A_TOKEN', 'B_KEY'], { A_TOKEN: 'v' }), { A_TOKEN: true, B_KEY: false })
  assert.deepEqual(envPresence(['E'], { E: '' }), { E: false })
})

test('openHome appends the connector rows to the profile patch', async () => {
  const root = tmp()
  const store = await Connectors.open(join(root, 'connectors.json'))
  const fs = await store.add({ preset: 'filesystem', path: root })
  await store.add({ custom: true, name: 'github', transport: 'streamable-http', url: 'https://api.githubcopilot.com/mcp/', bearerEnv: 'GITHUB_TOKEN' })
  await openHome(root, { model: { provider: 'deepseek-official', model: 'deepseek-flash' }, tools: { url: 'http://127.0.0.1:1/mcp', secret: 's' }, connectors: store.enabled() })
  const patch = readFileSync(join(root, 'dsh', 'profiles', 'web', 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /serverName: bot[\s\S]*serverName: filesystem[\s\S]*serverName: github/)
  assert.ok(patch.includes(JSON.stringify(fs.args)), 'args rendered as a JSON array')
  assert.match(patch, /GITHUB_TOKEN \?\? ''/)
  // disabled → gone on the next write
  await store.setEnabled('github', false)
  await openHome(root, { model: { provider: 'deepseek-official', model: 'deepseek-flash' }, connectors: store.enabled() })
  assert.doesNotMatch(readFileSync(join(root, 'dsh', 'profiles', 'web', 'cordis.patch.yml'), 'utf8'), /serverName: github/)
})

async function routeServer(store: Connectors, env: NodeJS.ProcessEnv) {
  const srv = createServer((req, res) => { handleConnectorsRoute(req, res, store, env).catch((e) => { res.writeHead(500); res.end(String(e)) }) })
  srv.listen(0, '127.0.0.1'); await once(srv, 'listening')
  const origin = `http://127.0.0.1:${(srv.address() as { port: number }).port}`
  const call = async (method: string, path: string, body?: unknown) => { const r = await fetch(origin + path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, body: await r.json() as Record<string, unknown> } }
  return { call, close: () => new Promise<void>((r) => srv.close(() => r())) }
}

test('routes: GET lists connectors, catalog and env presence; POST/PATCH/DELETE change the store; env values never pass', async () => {
  const dir = tmp()
  const store = await Connectors.open(join(dir, 'connectors.json'))
  store.markApplied()
  const s = await routeServer(store, { GITHUB_TOKEN: 'ghp_value' })
  try {
    let r = await s.call('GET', '/connectors')
    assert.equal(r.status, 200)
    assert.deepEqual(r.body.connectors, []); assert.equal((r.body.catalog as unknown[]).length, CATALOG.length)
    assert.equal(r.body.restartNeeded, false)
    assert.doesNotMatch(JSON.stringify(r.body), /ghp_value/)
    r = await s.call('POST', '/connectors', { preset: 'notion' })
    assert.equal(r.status, 400); assert.match(String(r.body.error), /Connect/)

    r = await s.call('POST', '/connectors', { custom: true, name: 'notion', transport: 'stdio', command: 'npx', args: ['-y', '@notionhq/notion-mcp-server@2.5.2'], envNames: ['NOTION_TOKEN'] })
    assert.equal(r.status, 200); assert.equal((r.body as { id: string }).id, 'notion')
    r = await s.call('POST', '/connectors', { preset: 'filesystem', path: '/definitely/not/here' })
    assert.equal(r.status, 400); assert.match(String(r.body.error), /folder/)
    r = await s.call('POST', '/connectors', { name: 'x', transport: 'stdio', command: 'x' })
    assert.equal(r.status, 400); assert.match(String(r.body.error), /custom: true/)
    r = await s.call('POST', '/connectors', { custom: true, name: 'x', transport: 'stdio', command: 'x', env: { A: 'b' } })
    assert.equal(r.status, 400)

    r = await s.call('GET', '/connectors')
    const list = r.body.connectors as { id: string; enabled: boolean; missingEnv: string[] }[]
    assert.equal(list.length, 1); assert.deepEqual(list[0].missingEnv, ['NOTION_TOKEN']); assert.equal(r.body.restartNeeded, true)
    assert.equal((r.body.env as Record<string, boolean>).NOTION_TOKEN, false)

    r = await s.call('PATCH', '/connectors/notion', { enabled: false })
    assert.equal(r.status, 200); assert.equal((r.body as { enabled: boolean }).enabled, false)
    r = await s.call('PATCH', '/connectors/ghost', { enabled: true })
    assert.equal(r.status, 404)
    r = await s.call('DELETE', '/connectors/notion')
    assert.equal(r.status, 200); assert.deepEqual(r.body, { ok: true })
    assert.equal(store.list().length, 0)
    r = await s.call('PUT', '/connectors')
    assert.equal(r.status, 404)
  } finally { await s.close() }
})

test('extraOneTap: a host offers more one-tap services through DEEPSEEK_BOT_ONE_TAP_EXTRA (JSON); bad entries are dropped; http only on loopback', () => {
  assert.deepEqual(extraOneTap({}), [])
  assert.deepEqual(extraOneTap({ DEEPSEEK_BOT_ONE_TAP_EXTRA: 'not json' }), [])
  const got = extraOneTap({ DEEPSEEK_BOT_ONE_TAP_EXTRA: JSON.stringify([
    { id: 'acme-pages', name: 'Acme Pages', url: 'http://127.0.0.1:4100/mcp' },
    { id: 'team-wiki', name: 'Team Wiki', url: 'https://wiki.example.com/mcp', description: 'The team wiki.' },
    { id: 'Bad Id', name: 'x', url: 'https://x.example.com/mcp' },
    { id: 'lan', name: 'LAN', url: 'http://192.168.1.5/mcp' },
    { id: 'notion', name: 'Shadow', url: 'https://evil.example.com/mcp' },
    { id: 'nourl', name: 'No URL' },
  ]) })
  assert.deepEqual(got.map((p) => p.id), ['acme-pages', 'team-wiki'])
  for (const p of got) { assert.equal(p.auth, 'oauth'); assert.equal(p.transport, 'streamable-http'); assert.deepEqual(p.envNames, []); assert.ok(p.description) }
  assert.equal(got[1].description, 'The team wiki.')
})
