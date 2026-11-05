// A fake remote MCP service with OAuth 2.1 for the connector tests: the shape
// Notion, Linear and Atlassian expose (measured 2026-10-27, docs/connectors.md):
//   GET  /.well-known/oauth-protected-resource[/mcp]  → RFC 9728, names the authorization server
//   GET  /.well-known/oauth-authorization-server       → RFC 8414, endpoints + registration_endpoint
//   POST /register                                     → RFC 7591 dynamic client registration
//   GET  /authorize                                    → records the request; the test "taps Allow" by calling grant()
//   POST /token                                        → authorization_code (PKCE S256 checked) and refresh_token
//   POST /mcp                                          → the MCP endpoint: 401 without a live bearer, else echoes what it got
// Nothing here is a real service; `opts.dcr: false` makes it a provider that only
// accepts a pre-registered client (GitHub, Slack, Google). For the end-to-end test
// with a real DSH: `autoApprove` answers /authorize with the redirect (the person
// "taps Allow" at once), `pageTitle` adds a `search_pages` tool that returns that
// title and records each call with its bearer in `toolCalls`, and `getStream: false`
// answers the optional GET stream with 405 as many real servers do.
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { createHash, randomBytes } from 'node:crypto'

export interface FakeOAuthOptions { dcr?: boolean; client?: { id: string; secret?: string }; accessTtlSec?: number; mcpPath?: string; /** Refuse plain-http redirect URIs off loopback at registration, as Notion and Linear do (measured 2026-10-27). */ httpsOrLoopback?: boolean; autoApprove?: boolean; pageTitle?: string; getStream?: boolean }

export async function startFakeOAuth(opts: FakeOAuthOptions = {}) {
  const dcr = opts.dcr !== false
  const mcpPath = opts.mcpPath ?? '/mcp'
  const clients = new Map<string, { secret?: string; redirectUris: string[] }>()
  if (opts.client) clients.set(opts.client.id, { secret: opts.client.secret, redirectUris: [] })
  const codes = new Map<string, { clientId: string; redirectUri: string; challenge: string; resource?: string; scope?: string }>()
  const tokens = new Map<string, { clientId: string; expires: number; scope?: string }>()
  const refreshes = new Map<string, { clientId: string; scope?: string }>()
  const log: { method: string; path: string; body?: Record<string, unknown>; headers: Record<string, string | string[] | undefined>; at: number }[] = []
  const authorizeRequests: URL[] = []
  const toolCalls: { name: string; args: Record<string, unknown>; bearer: string }[] = []
  let origin = ''
  const json = (res: import('node:http').ServerResponse, status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
  const issue = (clientId: string, scope?: string) => {
    const access = `at_${randomBytes(12).toString('hex')}`; const refresh = `rt_${randomBytes(12).toString('hex')}`
    tokens.set(access, { clientId, expires: Date.now() + (opts.accessTtlSec ?? 3600) * 1000, scope }); refreshes.set(refresh, { clientId, scope })
    return { access_token: access, token_type: 'Bearer', expires_in: opts.accessTtlSec ?? 3600, refresh_token: refresh, ...(scope ? { scope } : {}) }
  }
  function grant(): string {
    const u = authorizeRequests[authorizeRequests.length - 1]; if (!u) throw new Error('no authorize request yet')
    const code = `code_${randomBytes(8).toString('hex')}`
    codes.set(code, { clientId: u.searchParams.get('client_id')!, redirectUri: u.searchParams.get('redirect_uri')!, challenge: u.searchParams.get('code_challenge')!, resource: u.searchParams.get('resource') ?? undefined, scope: u.searchParams.get('scope') ?? undefined })
    const back = new URL(u.searchParams.get('redirect_uri')!); back.searchParams.set('code', code); back.searchParams.set('state', u.searchParams.get('state') ?? '')
    return back.href
  }
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', origin)
    let raw = ''; for await (const c of req) raw += c
    let body: Record<string, unknown> | undefined
    if (raw) { try { body = req.headers['content-type']?.includes('json') ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw)) } catch { body = undefined } }
    log.push({ method: req.method ?? '', path: url.pathname, body, headers: req.headers, at: Date.now() })
    if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) return json(res, 200, { resource: `${origin}${mcpPath}`, authorization_servers: [origin], bearer_methods_supported: ['header'], resource_name: 'Fake MCP' })
    if (url.pathname === '/.well-known/oauth-authorization-server') return json(res, 200, { issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, ...(dcr ? { registration_endpoint: `${origin}/register` } : {}), response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none', 'client_secret_post'], scopes_supported: ['read', 'write'] })
    if (url.pathname === '/register' && req.method === 'POST') {
      if (!dcr) return json(res, 404, { error: 'not_found' })
      const uris = Array.isArray(body?.redirect_uris) ? (body!.redirect_uris as string[]) : []
      if (!uris.length) return json(res, 400, { error: 'invalid_redirect_uri' })
      if (opts.httpsOrLoopback && uris.some((u) => { try { const x = new URL(u); return x.protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(x.hostname) } catch { return true } })) return json(res, 400, { error: 'invalid_redirect_uri', error_description: 'Redirect URI must use HTTPS unless it is a loopback HTTP URI' })
      const id = `dcr_${randomBytes(6).toString('hex')}`
      clients.set(id, { redirectUris: uris })
      return json(res, 201, { client_id: id, redirect_uris: uris, token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'] })
    }
    if (url.pathname === '/authorize') {
      const c = clients.get(url.searchParams.get('client_id') ?? '')
      if (!c) { res.writeHead(400); return res.end('unknown client') }
      if (c.redirectUris.length && !c.redirectUris.includes(url.searchParams.get('redirect_uri') ?? '')) { res.writeHead(400); return res.end('redirect_uri mismatch') }
      if (url.searchParams.get('code_challenge_method') !== 'S256' || !url.searchParams.get('code_challenge')) { res.writeHead(400); return res.end('pkce required') }
      authorizeRequests.push(url)
      if (opts.autoApprove) { res.writeHead(302, { location: grant() }); return res.end() }
      res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<p>Allow?</p>')
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      const b = body ?? {}
      const client = clients.get(String(b.client_id ?? ''))
      if (!client) return json(res, 401, { error: 'invalid_client' })
      if (client.secret !== undefined && b.client_secret !== client.secret) return json(res, 401, { error: 'invalid_client' })
      if (b.grant_type === 'authorization_code') {
        const code = codes.get(String(b.code ?? '')); codes.delete(String(b.code ?? ''))
        if (!code || code.clientId !== b.client_id) return json(res, 400, { error: 'invalid_grant' })
        if (code.redirectUri !== b.redirect_uri) return json(res, 400, { error: 'invalid_grant', error_description: 'redirect_uri' })
        const expected = createHash('sha256').update(String(b.code_verifier ?? '')).digest('base64url')
        if (expected !== code.challenge) return json(res, 400, { error: 'invalid_grant', error_description: 'pkce' })
        return json(res, 200, issue(code.clientId, code.scope))
      }
      if (b.grant_type === 'refresh_token') {
        const r = refreshes.get(String(b.refresh_token ?? '')); if (!r || r.clientId !== b.client_id) return json(res, 400, { error: 'invalid_grant' })
        refreshes.delete(String(b.refresh_token))
        return json(res, 200, issue(r.clientId, r.scope))
      }
      return json(res, 400, { error: 'unsupported_grant_type' })
    }
    if (url.pathname === mcpPath) {
      const bearer = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ''))?.[1]
      const t = bearer ? tokens.get(bearer) : undefined
      if (!t || t.expires < Date.now()) { res.writeHead(401, { 'www-authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource${mcpPath}"` }); return res.end() }
      if (req.method === 'GET' && opts.getStream === false) { res.writeHead(405, { allow: 'POST' }); return res.end() }
      if (req.method === 'GET') { res.writeHead(200, { 'content-type': 'text/event-stream', 'mcp-session-id': 'sess-1' }); res.write('event: ping\ndata: {}\n\n'); return res.end() }
      const msg = (body ?? {}) as { id?: unknown; method?: string; params?: { protocolVersion?: string; name?: string; arguments?: Record<string, unknown> } }
      if (msg.id === undefined) { res.writeHead(202); return res.end() }
      const tools = [{ name: 'whoami', description: 'who', inputSchema: { type: 'object' } }, ...(opts.pageTitle ? [{ name: 'search_pages', description: 'Search the pages in this workspace by words in their title or text. Returns matching page titles.', inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Words to search for' } }, required: ['query'] } }] : [])]
      if (msg.method === 'tools/call' && msg.params?.name === 'search_pages' && opts.pageTitle) {
        toolCalls.push({ name: 'search_pages', args: msg.params.arguments ?? {}, bearer: bearer! })
        res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'sess-1' })
        return res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify({ results: [{ title: opts.pageTitle, url: `${origin}/pages/1` }] }) }] } }))
      }
      const result = msg.method === 'initialize' ? { protocolVersion: msg.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '0' } } : msg.method === 'tools/list' ? { tools } : { echo: msg.method, bearer }
      res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'sess-1' }); return res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }))
    }
    res.writeHead(404); res.end()
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  return {
    origin, mcpUrl: `${origin}${mcpPath}`, log, authorizeRequests, clients, tokens, toolCalls,
    /** The person taps Allow on the last authorize page: the redirect the browser would follow. */
    grant,
    /** Make every issued access token expired, as time passing would. */
    expireAll() { for (const t of tokens.values()) t.expires = 0 },
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()) }),
  }
}
