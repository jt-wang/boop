// The loopback boundary proxy between DSH and the model provider. DSH only
// ever gets a per-boot surrogate key in its environment; this bot process
// (outside the DSH cell) adds the real key at the network boundary. A leaked surrogate can call the model
// as the agent already can; it cannot reveal the provider key.
import { createServer } from 'node:http'
import { once } from 'node:events'
import { Readable } from 'node:stream'
import type { Guard } from './guard.ts'

export interface ModelProxyOptions {
  /** The provider root, e.g. https://api.siliconflow.cn/v1 or https://api.deepseek.com */
  upstream: string
  /** The real key; absent means the upstream needs no auth. */
  apiKey?: string
  /** `bearer` for OpenAI-compatible gateways, `x-api-key` for the native Messages adapter. */
  auth?: 'bearer' | 'x-api-key'
  /** Request body cap. Model requests include the whole context; default 64 MiB. */
  maxBytes?: number
  fetch?: typeof fetch
  /** Refuse a private or redirected upstream before the real key is added. */
  guard?: Guard
  port?: number
}

export interface ModelProxy { url: string; close(): Promise<void> }

const SKIP = new Set(['host', 'connection', 'content-length', 'authorization', 'x-api-key'])

export async function startModelProxy(o: ModelProxyOptions): Promise<ModelProxy> {
  const target = new URL(o.upstream)
  const base = target.origin
  const cap = o.maxBytes ?? 64 << 20
  const f = o.fetch ?? fetch
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = []
      let size = 0
      for await (const ch of req) {
        size += (ch as Buffer).length
        if (size > cap) { res.writeHead(413); return res.end() }
        chunks.push(ch as Buffer)
      }
      const body = chunks.length ? Buffer.concat(chunks) : undefined
      const headers: Record<string, string> = {}
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string' && !SKIP.has(k.toLowerCase())) headers[k] = v
      if (o.apiKey) {
        if (o.auth === 'x-api-key') headers['x-api-key'] = o.apiKey
        else headers.authorization = `Bearer ${o.apiKey}`
      }
      const target = `${base}${req.url ?? '/'}`
      if (o.guard) {
        try { await o.guard.checkURL(target) } catch (e) {
          res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
          return res.end(JSON.stringify({ error: (e as Error).message }))
        }
      }
      const up = await f(target, {
        method: req.method,
        headers,
        body: body as unknown as BodyInit | undefined,
        signal: AbortSignal.timeout(300_000),
        ...(o.guard ? { redirect: 'manual' as const } : {}),
      })
      if (o.guard && up.status >= 300 && up.status < 400) {
        await up.body?.cancel().catch(() => {})
        res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' })
        return res.end(JSON.stringify({ error: 'the model provider redirected; blocked by the outbound guard' }))
      }
      const out: Record<string, string> = {}
      for (const [k, v] of up.headers) if (k !== 'content-length' && k !== 'content-encoding' && k !== 'transfer-encoding' && k !== 'connection') out[k] = v
      res.writeHead(up.status, out)
      if (!up.body) return res.end()
      Readable.fromWeb(up.body as import('node:stream/web').ReadableStream).on('error', () => res.end()).pipe(res)
      req.on('close', () => { if (!res.writableEnded) up.body?.cancel().catch(() => {}) })
    } catch (e) {
      console.error('[bot] model proxy', (e as Error).message)
      if (!res.headersSent) res.writeHead(502)
      res.end()
    }
  })
  server.listen(o.port ?? 0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address() as { port: number }
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()) }) }
}
