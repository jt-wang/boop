// Minimal client for dsh web's gateway, used by bot itself (approvals,
// pushes, health). Wire shapes: DSH Mobile docs/PROTOCOL.md, re-measured
// against DSH 0.2.0-rc.2 on 2026-10-26 (see test/chat.e2e.test.ts).
import { randomUUID } from 'node:crypto'
import { WebSocket } from 'ws'

export interface DshTarget { origin: string; cookie: string }

export class DshRpcError extends Error {
  readonly method: string; readonly code: string; readonly details?: unknown
  constructor(method: string, code: string, message: string, details?: unknown) { super(`${method}: ${code}: ${message}`); this.method = method; this.code = code; this.details = details }
}

export async function rpc<T = unknown>(t: DshTarget, method: string, args: Record<string, unknown>): Promise<T> {
  const rpcId = randomUUID()
  const res = await fetch(`${t.origin}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: t.cookie },
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } }),
  })
  if (res.status !== 200) throw new DshRpcError(method, `http-${res.status}`, await res.text())
  const env = await res.json() as { result: { ok: true; value: T } | { ok: false; error: { code: string; message: string; details?: unknown } } }
  if (!env.result.ok) throw new DshRpcError(method, env.result.error.code, env.result.error.message, env.result.error.details)
  return env.result.value
}

export interface MuxFrame { type: 'item' | 'error' | 'end'; streamId: string; value?: unknown; error?: { code: string; message: string } }

/** One mux socket; `open()` returns an async iterator over one logical stream. */
export class Mux {
  readonly ws: WebSocket
  private next = 1
  private listeners = new Map<string, (f: MuxFrame) => void>()
  readonly ready: Promise<void>
  constructor(t: DshTarget) {
    this.ws = new WebSocket(`${t.origin.replace(/^http/, 'ws')}/api/remote.mux`, { headers: { cookie: t.cookie } })
    this.ready = new Promise((res, rej) => { this.ws.once('open', res); this.ws.once('error', rej) })
    this.ws.on('message', (d) => {
      const f = JSON.parse(d.toString()) as MuxFrame
      this.listeners.get(f.streamId)?.(f)
    })
  }
  async open(endpoint: string, args: Record<string, unknown>): Promise<AsyncIterable<unknown> & { cancel(): void }> {
    await this.ready
    const streamId = String(this.next++)
    const queue: MuxFrame[] = []
    let wake: (() => void) | null = null
    this.listeners.set(streamId, (f) => { queue.push(f); wake?.(); wake = null })
    this.ws.send(JSON.stringify({ type: 'open', streamId, endpoint, payload: { args } }))
    const self = this
    const it = {
      cancel() { self.ws.send(JSON.stringify({ type: 'cancel', streamId })); self.listeners.delete(streamId) },
      async *[Symbol.asyncIterator]() {
        for (;;) {
          while (queue.length === 0) await new Promise<void>((r) => { wake = r })
          const f = queue.shift()!
          if (f.type === 'item') yield f.value
          else if (f.type === 'error') throw new DshRpcError(endpoint, f.error!.code, f.error!.message)
          else return
        }
      },
    }
    return it
  }
  close() { this.ws.close() }
}

export const sessionAddress = (sessionId: string) => ({ kind: 'session', sessionId })
