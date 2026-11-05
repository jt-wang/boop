import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, statSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { Connectors, connectorRowsYaml, handleConnectorsRoute, type Preset } from '../src/connectors.ts'
import { requestOrigin } from '../src/connectors.ts'
import { ConnectorAuth, ConnectorSecrets, canonicalResource, discover } from '../src/oauth.ts'
import { startConnectorProxy } from '../src/connector-proxy.ts'
import { startFakeOAuth } from './fixtures/fake-oauth.ts'

// One tap: the app asks the bot for an authorization URL, the system browser
// opens it, the service redirects to the bot's callback, the bot exchanges the
// code and keeps the tokens in a 0600 file. The assistant reaches the service
// through the bot's loopback proxy, which adds the bearer and refreshes it.

const tmp = () => mkdtempSync(join(tmpdir(), 'oauth-'))
const PUBLIC = 'https://bot.example.test/s/abc'
const catalogFor = (mcpUrl: string, extra: Partial<Preset> = {}): Preset[] => [
  { id: 'fakenote', name: 'Fakenote', description: 'A fake notes service.', transport: 'streamable-http', url: mcpUrl, auth: 'oauth', envNames: [], hint: '', ...extra },
  { id: 'custom', name: 'Custom MCP server', description: 'Any MCP server.', transport: 'stdio', envNames: [], custom: true, hint: '' },
]

async function setup(o: { dcr?: boolean; client?: { id: string; secret?: string }; env?: NodeJS.ProcessEnv; preset?: Partial<Preset>; publicOrigin?: string; httpsOrLoopback?: boolean } = {}) {
  const svc = await startFakeOAuth({ dcr: o.dcr, client: o.client, httpsOrLoopback: o.httpsOrLoopback })
  const dir = tmp()
  const catalog = catalogFor(svc.mcpUrl, o.preset)
  const store = await Connectors.open(join(dir, 'connectors.json'), { catalog })
  const secrets = await ConnectorSecrets.open(join(dir, 'connector-secrets.json'))
  const connected: string[] = []
  const auth = new ConnectorAuth({ store, secrets, catalog, publicOrigin: () => o.publicOrigin ?? PUBLIC, loopbackOrigin: () => 'http://127.0.0.1:3850', env: o.env ?? {}, onConnected: (c) => { connected.push(c.id) } })
  return { svc, dir, store, secrets, auth, catalog, connected, close: () => svc.close() }
}

// Through TailPocket the phone's browser reaches the bot at the phone's own loopback port, which is new at every launch: the
// computer's port would land on nothing there (docs/connection.md).
test('a phone through the tunnel: the service comes back to the port that phone used', async () => {
  const s = await setup({ publicOrigin: 'http://127.0.0.1:3850' })
  try {
    const a = await s.auth.start('fakenote', { local: true, origin: 'http://127.0.0.1:50999' })
    assert.equal(new URL(a.url).searchParams.get('redirect_uri'), 'http://127.0.0.1:50999/connectors/callback')
    assert.deepEqual(requestOrigin({ peer: '127.0.0.1', host: '127.0.0.1:50999' }), 'http://127.0.0.1:50999')
    assert.equal(requestOrigin({ peer: '127.0.0.1', host: 'evil.example' }), undefined, 'only a loopback address')
    assert.equal(requestOrigin({ peer: '192.168.1.9', host: '127.0.0.1:50999' }), undefined, 'only over loopback')
    assert.equal(requestOrigin({ peer: '127.0.0.1', host: '127.0.0.1:50999', forwarded: true }), undefined, 'not relayed')
  } finally { await s.close?.() }
})

test('discover: protected-resource metadata names the authorization server; its metadata gives the endpoints', async () => {
  const svc = await startFakeOAuth()
  try {
    const meta = await discover(svc.mcpUrl)
    assert.equal(meta.authorization_endpoint, `${svc.origin}/authorize`)
    assert.equal(meta.token_endpoint, `${svc.origin}/token`)
    assert.equal(meta.registration_endpoint, `${svc.origin}/register`)
    // the path-aware RFC 9728 URL was tried first (https://mcp.notion.com/.well-known/oauth-protected-resource is what Notion serves; GitHub serves the /mcp/ suffixed one)
    assert.ok(svc.log.some((l) => l.path === '/.well-known/oauth-protected-resource/mcp'))
    assert.equal(canonicalResource('HTTPS://MCP.Example.com/mcp/#frag'), 'https://mcp.example.com/mcp/')
  } finally { await svc.close() }
})

test('one tap, dynamic client registration: start registers the client once, returns an authorization URL with PKCE; the callback stores the token (0600) and enables the connector', async () => {
  const s = await setup()
  try {
    const a = await s.auth.start('fakenote')
    const u = new URL(a.url)
    assert.equal(u.origin + u.pathname, `${s.svc.origin}/authorize`)
    assert.equal(u.searchParams.get('response_type'), 'code')
    assert.equal(u.searchParams.get('redirect_uri'), `${PUBLIC}/connectors/callback`)
    assert.equal(u.searchParams.get('code_challenge_method'), 'S256')
    assert.equal(u.searchParams.get('resource'), s.svc.mcpUrl)
    assert.match(u.searchParams.get('state') ?? '', /^[A-Za-z0-9_-]{20,}$/)
    assert.equal(u.searchParams.get('client_id')?.startsWith('dcr_'), true, 'a client registered through DCR')
    const reg = s.svc.log.find((l) => l.path === '/register')!
    assert.deepEqual(reg.body!.redirect_uris, [`${PUBLIC}/connectors/callback`])
    assert.equal(reg.body!.token_endpoint_auth_method, 'none')

    // a second start reuses the registered client instead of registering again
    await s.auth.start('fakenote')
    assert.equal(s.svc.log.filter((l) => l.path === '/register').length, 1)

    // the browser opens the URL; the person taps Allow; the service redirects to the callback
    const browser = await fetch(a.url)
    assert.equal(browser.status, 200)
    const back = new URL(s.svc.grant())
    const wrong = await s.auth.callback({ code: back.searchParams.get('code')!, state: 'not-the-state' })
    assert.equal(wrong.ok, false)
    const r = await s.auth.callback({ code: back.searchParams.get('code')!, state: back.searchParams.get('state')! })
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.deepEqual(s.connected, ['fakenote'])
    const c = s.store.get('fakenote')!
    assert.equal(c.enabled, true); assert.equal(c.auth, 'oauth'); assert.equal(c.url, s.svc.mcpUrl); assert.equal(c.transport, 'streamable-http')
    assert.equal(s.store.connected('fakenote'), true)

    // the token is in the secrets file only, mode 0600; the token endpoint saw the PKCE verifier
    const sec = join(s.dir, 'connector-secrets.json')
    assert.equal((statSync(sec).mode & 0o777).toString(8), '600')
    const stored = JSON.parse(readFileSync(sec, 'utf8'))
    assert.match(stored.connections.fakenote.token.accessToken, /^at_/)
    assert.doesNotMatch(readFileSync(join(s.dir, 'connectors.json'), 'utf8'), /at_|rt_/)
    const tok = s.svc.log.find((l) => l.path === '/token')!
    assert.equal(tok.body!.grant_type, 'authorization_code'); assert.ok(tok.body!.code_verifier); assert.equal(tok.body!.resource, s.svc.mcpUrl)
    // a used state is gone; the same callback again is refused
    const again = await s.auth.callback({ code: 'x', state: back.searchParams.get('state')! })
    assert.equal(again.ok, false)
  } finally { await s.close() }
})

test('the callback reports the service saying no, and a state that expired', async () => {
  const s = await setup()
  try {
    const a = await s.auth.start('fakenote')
    const r = await s.auth.callback({ state: new URL(a.url).searchParams.get('state')!, error: 'access_denied', error_description: 'The user said no' })
    assert.equal(r.ok, false); assert.match((r as { error: string }).error, /said no/)
    assert.equal(s.store.get('fakenote'), undefined)
    const old = new ConnectorAuth({ store: s.store, secrets: s.secrets, catalog: s.catalog, publicOrigin: () => PUBLIC, env: {}, ttlMs: 1 })
    const b = await old.start('fakenote')
    await new Promise((x) => setTimeout(x, 5))
    const e = await old.callback({ state: new URL(b.url).searchParams.get('state')!, code: 'c' })
    assert.equal(e.ok, false)
    // what happened only; callbackPage adds the one thing to do
    assert.equal((e as { error: string }).error, 'This sign-in link is no longer valid.')
  } finally { await s.close() }
})

test('a service without dynamic registration needs the client the host registered; without it the tile is unavailable and start refuses', async () => {
  const s = await setup({ dcr: false, client: { id: 'host-app', secret: 'host-secret-1234' }, preset: { clientEnv: 'DEEPSEEK_BOT_OAUTH_FAKENOTE' }, env: {} })
  try {
    assert.equal(s.auth.available('fakenote'), false)
    await assert.rejects(s.auth.start('fakenote'), /not available/)
  } finally { await s.close() }
  const t = await setup({ dcr: false, client: { id: 'host-app', secret: 'host-secret-1234' }, preset: { clientEnv: 'DEEPSEEK_BOT_OAUTH_FAKENOTE', scope: 'read write' }, env: { DEEPSEEK_BOT_OAUTH_FAKENOTE_CLIENT_ID: 'host-app', DEEPSEEK_BOT_OAUTH_FAKENOTE_CLIENT_SECRET: 'host-secret-1234' } })
  try {
    assert.equal(t.auth.available('fakenote'), true)
    const a = await t.auth.start('fakenote')
    const u = new URL(a.url)
    assert.equal(u.searchParams.get('client_id'), 'host-app'); assert.equal(u.searchParams.get('scope'), 'read write')
    assert.equal(t.svc.log.some((l) => l.path === '/register'), false)
    await fetch(a.url)
    const back = new URL(t.svc.grant())
    const r = await t.auth.callback({ code: back.searchParams.get('code')!, state: back.searchParams.get('state')! })
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(t.svc.log.find((l) => l.path === '/token')!.body!.client_secret, 'host-secret-1234')
    assert.doesNotMatch(readFileSync(join(t.dir, 'connectors.json'), 'utf8'), /host-secret/)
  } finally { await t.close() }
})

test('the proxy: the assistant reaches the service through the bot with the bearer added; an expired token is refreshed once and the call retried; disconnect deletes the token', async () => {
  const s = await setup()
  const proxy = await startConnectorProxy({ auth: s.auth, store: s.store })
  try {
    const a = await s.auth.start('fakenote'); await fetch(a.url)
    const back = new URL(s.svc.grant())
    assert.equal((await s.auth.callback({ code: back.searchParams.get('code')!, state: back.searchParams.get('state')! })).ok, true)
    const call = (id: string, secret = proxy.secret, body: unknown = { jsonrpc: '2.0', id: 1, method: 'tools/list' }) => fetch(`${proxy.url}/${id}`, { method: 'POST', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-session-id': 'sess-1' }, body: JSON.stringify(body) })
    assert.equal((await call('fakenote', 'wrong')).status, 401)
    assert.equal((await call('nope')).status, 404)
    let r = await call('fakenote')
    assert.equal(r.status, 200); assert.equal(r.headers.get('mcp-session-id'), 'sess-1')
    const first = await r.json() as { result: { tools: unknown[] } }
    assert.equal(first.result.tools.length, 1)
    const up = s.svc.log.filter((l) => l.path === '/mcp').at(-1)!
    assert.match(String(up.headers.authorization), /^Bearer at_/); assert.equal(up.headers['mcp-session-id'], 'sess-1')
    // time passes: the service refuses the old token; the proxy refreshes and the assistant never notices
    s.svc.expireAll()
    r = await call('fakenote', proxy.secret, { jsonrpc: '2.0', id: 2, method: 'ping' })
    assert.equal(r.status, 200)
    assert.equal(s.svc.log.filter((l) => l.path === '/token' && l.body?.grant_type === 'refresh_token').length, 1)
    assert.match(JSON.parse(readFileSync(join(s.dir, 'connector-secrets.json'), 'utf8')).connections.fakenote.token.accessToken, /^at_/)
    // GET (the SSE stream) is forwarded too
    const g = await fetch(`${proxy.url}/fakenote`, { headers: { authorization: `Bearer ${proxy.secret}`, accept: 'text/event-stream' } })
    assert.equal(g.status, 200); assert.match(g.headers.get('content-type') ?? '', /event-stream/)
    // the profile row points the harness at the proxy, never at the token
    const y = connectorRowsYaml(s.store.enabled(), {}, { url: proxy.url, secret: proxy.secret })
    assert.match(y, new RegExp(`serverName: fakenote\\n\\s+transport: streamable-http\\n\\s+url: "${proxy.url}/fakenote"\\n\\s+headers:\\n\\s+authorization: Bearer ${proxy.secret}`))
    assert.doesNotMatch(y, /at_|rt_/)
    assert.equal(connectorRowsYaml(s.store.enabled(), {}), '', 'without a proxy an oauth connector has no row')
    // disconnect: one call, token gone, connector gone, the proxy answers 404
    assert.equal(await s.auth.disconnect('fakenote'), true)
    assert.equal(s.store.get('fakenote'), undefined)
    assert.equal(JSON.parse(readFileSync(join(s.dir, 'connector-secrets.json'), 'utf8')).connections.fakenote, undefined)
    assert.equal((await call('fakenote')).status, 404)
  } finally { await proxy.close(); await s.close() }
})

test('routes: POST /connectors/:preset/connect gives the URL; GET /connectors/callback (no device) finishes and shows a plain page; GET /connectors shows connected without the token; DELETE drops the token', async () => {
  const s = await setup()
  const srv = createServer((req, res) => { handleConnectorsRoute(req, res, s.store, {}, s.auth).catch((e) => { res.writeHead(500); res.end(String(e)) }) })
  srv.listen(0, '127.0.0.1'); await once(srv, 'listening')
  const origin = `http://127.0.0.1:${(srv.address() as { port: number }).port}`
  try {
    let r = await fetch(`${origin}/connectors/fakenote/connect`, { method: 'POST' })
    assert.equal(r.status, 200)
    const { url } = await r.json() as { url: string }
    assert.ok(url.startsWith(`${s.svc.origin}/authorize?`))
    assert.equal((await fetch(`${origin}/connectors/nope/connect`, { method: 'POST' })).status, 400)
    let list = await (await fetch(`${origin}/connectors`)).json() as { connectors: { id: string; connected?: boolean }[]; catalog: { id: string; auth?: string; available?: boolean }[] }
    assert.equal(list.catalog.find((p) => p.id === 'fakenote')!.available, true)
    assert.equal(list.connectors.length, 0)
    await fetch(url)
    const back = new URL(s.svc.grant())
    r = await fetch(`${origin}/connectors/callback?${back.searchParams}`)
    assert.equal(r.status, 200); assert.match(r.headers.get('content-type') ?? '', /text\/html/)
    const page = await r.text()
    assert.match(page, /Fakenote/); assert.match(page, /back to the app/i)
    assert.doesNotMatch(page, /at_|code_/)
    list = await (await fetch(`${origin}/connectors`)).json() as typeof list
    assert.deepEqual(list.connectors.map((c) => [c.id, c.connected]), [['fakenote', true]])
    assert.doesNotMatch(JSON.stringify(list), /at_|rt_/)
    const bad = await fetch(`${origin}/connectors/callback?code=x&state=y`)
    assert.equal(bad.status, 400); assert.match(await bad.text(), /tap Connect again/i)
    assert.equal((await fetch(`${origin}/connectors/fakenote`, { method: 'DELETE' })).status, 200)
    assert.equal(existsSync(join(s.dir, 'connector-secrets.json')) ? JSON.parse(readFileSync(join(s.dir, 'connector-secrets.json'), 'utf8')).connections.fakenote : undefined, undefined)
  } finally { await new Promise<void>((x) => srv.close(() => x())); await s.close() }
})

// The page after signing in said "Acme Pages 已连接" on an English phone: Chrome on that emulator still sent zh
// first in Accept-Language (QA, Android, 2026-10-30). The page speaks the app's language; the header is the fallback.
test('routes: the callback page speaks the app\'s language, not the browser\'s', async () => {
  const s = await setup()
  let appLang: 'zh' | 'en' | undefined = 'en'
  const srv = createServer((req, res) => { handleConnectorsRoute(req, res, s.store, {}, s.auth, async () => appLang).catch((e) => { res.writeHead(500); res.end(String(e)) }) })
  srv.listen(0, '127.0.0.1'); await once(srv, 'listening')
  const origin = `http://127.0.0.1:${(srv.address() as { port: number }).port}`
  try {
    const zh = { 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8' }
    let page = await (await fetch(`${origin}/connectors/callback?code=x&state=y`, { headers: zh })).text()
    assert.match(page, /tap Connect again/i)
    appLang = undefined
    page = await (await fetch(`${origin}/connectors/callback?code=x&state=y`, { headers: zh })).text()
    assert.match(page, /再点一次连接/)
  } finally { await new Promise<void>((x) => srv.close(() => x())); await s.close() }
})

// Measured 2026-10-27 (docs/connectors.md): Notion and Linear refuse a plain-http
// LAN redirect URI ("must use HTTPS unless it is a loopback HTTP URI"); Atlassian
// accepts it. All three accept https and http://127.0.0.1.
test('redirect URI: a bot on the LAN over plain http falls back to loopback when the person connects from this computer, and says what to do when they connect from the phone', async () => {
  const LAN = 'http://192.168.1.20:3850'
  const strict = await setup({ publicOrigin: LAN, httpsOrLoopback: true })
  try {
    const here = new URL((await strict.auth.start('fakenote', { local: true })).url)
    assert.equal(here.searchParams.get('redirect_uri'), 'http://127.0.0.1:3850/connectors/callback', 'a browser on this computer comes back over loopback')
    await assert.rejects(strict.auth.start('fakenote', { local: false }), (e: Error) => /secure address/.test(e.message) && /on the computer the assistant runs on/.test(e.message) && !/redirect|uri|http/i.test(e.message))
    assert.equal(strict.svc.clients.size, 1, 'only the loopback registration succeeded')
  } finally { await strict.close() }

  const lax = await setup({ publicOrigin: LAN })
  try {
    const phone = new URL((await lax.auth.start('fakenote', { local: false })).url)
    assert.equal(phone.searchParams.get('redirect_uri'), `${LAN}/connectors/callback`, 'a service that takes the LAN address gets it')
    const here = new URL((await lax.auth.start('fakenote', { local: true })).url)
    assert.equal(here.searchParams.get('redirect_uri'), 'http://127.0.0.1:3850/connectors/callback')
  } finally { await lax.close() }

  const hosted = await setup({ httpsOrLoopback: true })
  try {
    for (const local of [true, false]) {
      const u = new URL((await hosted.auth.start('fakenote', { local })).url)
      assert.equal(u.searchParams.get('redirect_uri'), `${PUBLIC}/connectors/callback`, 'an https address is always used (a hosted bot sees the host as a local client)')
    }
  } finally { await hosted.close() }
})

test('routes: POST /connectors/:service/connect tells the flow whether the request came from this computer', async () => {
  const calls: { local?: boolean }[] = []
  const auth = { available: () => true, start: async (_id: string, o?: { local?: boolean }) => { calls.push({ local: o?.local }); return { url: 'https://svc.example/authorize', state: 's' } }, callback: async () => ({ ok: false as const, error: 'x' }), disconnect: async () => false }
  const store = await Connectors.open(join(tmp(), 'connectors.json'))
  const srv = createServer((req, res) => { handleConnectorsRoute(req, res, store, {}, auth).catch((e) => { res.writeHead(500); res.end(String(e)) }) })
  srv.listen(0, '127.0.0.1'); await once(srv, 'listening')
  const origin = `http://127.0.0.1:${(srv.address() as { port: number }).port}`
  try {
    assert.equal((await fetch(`${origin}/connectors/notion/connect`, { method: 'POST' })).status, 200)
    assert.equal((await fetch(`${origin}/connectors/notion/connect`, { method: 'POST', headers: { 'x-forwarded-for': '192.168.1.30' } })).status, 200)
    assert.deepEqual(calls, [{ local: true }, { local: false }], 'loopback socket = this computer; a forwarded request is not')
  } finally { await new Promise<void>((x) => srv.close(() => x())) }
})

// The page says what happened once, then one thing to do; never "tap Connect again. … try again."
test('callback page: one instruction, whatever went wrong', async () => {
  const { callbackPage } = await import('../src/oauth.ts')
  for (const error of ['This sign-in link is no longer valid.', 'You did not allow it.', 'The service did not allow it (server_error).']) {
    const html = callbackPage({ ok: false, name: 'Notion', error })
    const text = html.replace(/<[^>]+>/g, ' ')
    assert.equal((text.match(/again/g) ?? []).length, 1, text)
    assert.match(text, /Go back to the app and tap Connect again\./)
  }
  const ok = callbackPage({ ok: true, name: 'Notion' }).replace(/<[^>]+>/g, ' ')
  assert.match(ok, /Notion is connected/); assert.doesNotMatch(ok, /again/)
})


// The page after the sign-in speaks the phone's language (its browser's Accept-Language): a Chinese iPhone saw
// "Acme Pages is connected / You can go back to the app." (QA pass, 2026-10-27, iOS simulator).
test('callback page in Chinese for a Chinese browser; English otherwise', async () => {
  const { callbackPage, pageLang } = await import('../src/oauth.ts')
  assert.equal(pageLang('zh-CN,zh-Hans;q=0.9,en;q=0.8'), 'zh')
  assert.equal(pageLang('en-US,en;q=0.9'), 'en')
  assert.equal(pageLang(undefined), 'en')
  const ok = callbackPage({ ok: true, name: 'Acme Pages' }, 'zh')
  assert.match(ok, /lang="zh-CN"/)
  const text = ok.replace(/<[^>]+>/g, ' ')
  assert.match(text, /Acme Pages 已连接/); assert.match(text, /回到 App/)
  assert.doesNotMatch(text, /connected|go back/i)
  const bad = callbackPage({ ok: false, name: 'Acme Pages', error: 'You did not allow it.' }, 'zh').replace(/<[^>]+>/g, ' ')
  assert.match(bad, /没有连上/); assert.match(bad, /再点一次连接/)
})
