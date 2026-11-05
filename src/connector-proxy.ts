// The loopback proxy between DSH and a connected service. The profile patch
// row for an OAuth connector points at `http://127.0.0.1:<port>/<id>` with
// this process's secret; the proxy forwards the MCP request to the service's
// URL with the person's bearer (src/oauth.ts), so the token is never in the
// patch, the environment, or the model's context. An upstream 401 refreshes
// the token once and retries. Streamable HTTP is plain requests (POST, the
// optional GET event stream, DELETE), so each one is forwarded as is, body
// buffered (MCP messages are small), response streamed.
import { createServer } from 'node:http'
import { once } from 'node:events'
import { randomBytes } from 'node:crypto'
import { Readable } from 'node:stream'
import type { ConnectorAuth } from './oauth.ts'
import type { Connectors } from './connectors.ts'

export interface ConnectorProxy { url: string; secret: string; close(): Promise<void> }

const FORWARD = new Set(['accept', 'content-type', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id'])
const BACK = new Set(['content-type', 'mcp-session-id', 'mcp-protocol-version', 'cache-control', 'www-authenticate'])

export async function startConnectorProxy(o: { auth: ConnectorAuth; store: Connectors; fetch?: typeof fetch; port?: number }): Promise<ConnectorProxy> {
  const f = o.fetch ?? fetch
  const secret = randomBytes(24).toString('base64url')
  const server = createServer(async (req, res) => {
    try {
      if (req.headers.authorization !== `Bearer ${secret}`) { res.writeHead(401); return res.end() }
      const m = /^\/([A-Za-z0-9_-]{1,32})\/?$/.exec(new URL(req.url ?? '/', 'http://x').pathname)
      const c = m ? o.store.get(m[1]) : undefined
      if (!c || c.auth !== 'oauth' || !c.url) { res.writeHead(404); return res.end() }
      const chunks: Buffer[] = []
      for await (const ch of req) { chunks.push(ch as Buffer); if (chunks.reduce((n, b) => n + b.length, 0) > 4 << 20) { res.writeHead(413); return res.end() } }
      const body = chunks.length ? Buffer.concat(chunks) : undefined
      const headers: Record<string, string> = {}
      for (const [k, v] of Object.entries(req.headers)) if (FORWARD.has(k) && typeof v === 'string') headers[k] = v
      const send = async (token: string) => f(c.url!, { method: req.method, headers: { ...headers, authorization: `Bearer ${token}` }, body: body as unknown as BodyInit | undefined, signal: AbortSignal.timeout(120_000) })
      let token = await o.auth.accessToken(c.id)
      if (!token) { res.writeHead(401); return res.end() }
      let up = await send(token)
      if (up.status === 401) {
        token = await o.auth.accessToken(c.id, true)
        if (token) up = await send(token)
      }
      const out: Record<string, string> = {}
      for (const k of BACK) { const v = up.headers.get(k); if (v) out[k] = v }
      res.writeHead(up.status, out)
      if (!up.body) return res.end()
      Readable.fromWeb(up.body as import('node:stream/web').ReadableStream).on('error', () => res.end()).pipe(res)
      req.on('close', () => { if (!res.writableEnded) up.body?.cancel().catch(() => {}) })
    } catch (e) {
      console.error('[bot] connector proxy', (e as Error).message)
      if (!res.headersSent) res.writeHead(502)
      res.end()
    }
  })
  server.listen(o.port ?? 0, '127.0.0.1'); await once(server, 'listening')
  const { port } = server.address() as { port: number }
  return { url: `http://127.0.0.1:${port}`, secret, close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()) }) }
}
