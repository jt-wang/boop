// bot's own connection to dsh's `$events` stream: approvals, questions,
// cancellations and session status. The PWA gets its own mux through the
// proxy; this one exists so pushes go out even when no phone is connected.
//
// Frame shapes measured 2026-10-26 (DSH 0.2.0-rc.2, `ready`) and taken from
// DSH Mobile docs/PROTOCOL.md for waterfall / cancel / emit.
import { EventEmitter } from 'node:events'
import { WebSocket } from 'ws'

export type BotEvent =
  | { type: 'ready'; clientId: string }
  | { type: 'approval'; eventId: string; sessionId: string; request: { toolName?: string; callId?: string; reason?: string; displayReason?: Record<string, string>; [k: string]: unknown } }
  | { type: 'question'; eventId: string; sessionId: string; request: Record<string, unknown> }
  | { type: 'cancel'; eventId: string }
  | { type: 'status'; sessionId: string; running: boolean }
  | { type: 'emit'; event: string; args: unknown[] }
  | { type: 'disconnected' }

export interface WatcherOptions { origin: string; cookie: string; reconnectMs?: number }

export class EventWatcher extends EventEmitter<{ event: [BotEvent] }> {
  clientId: string | null = null
  private ws: WebSocket | null = null
  private stopped = false
  private timer: NodeJS.Timeout | null = null
  private readonly opts: WatcherOptions
  constructor(opts: WatcherOptions) { super(); this.opts = opts }

  start() { this.stopped = false; this.connect() }

  async stop() {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.ws?.terminate()
    this.ws = null
  }

  dropForTest() { this.ws?.terminate() }

  private connect() {
    const url = `${this.opts.origin.replace(/^http/, 'ws')}/api/remote.mux`
    const ws = new WebSocket(url, { headers: { cookie: this.opts.cookie } })
    this.ws = ws
    ws.on('open', () => ws.send(JSON.stringify({ type: 'open', streamId: 'events', endpoint: '$events', payload: { args: {} } })))
    ws.on('message', (data) => {
      let frame: { type: string; streamId?: string; value?: Record<string, unknown> }
      try { frame = JSON.parse(data.toString()) } catch { return }
      if (frame.type !== 'item' || frame.streamId !== 'events' || !frame.value) return
      const ev = this.translate(frame.value)
      if (ev) this.emit('event', ev)
    })
    const onDown = () => {
      if (this.ws !== ws) return
      this.ws = null
      this.clientId = null
      this.emit('event', { type: 'disconnected' })
      if (!this.stopped) this.timer = setTimeout(() => this.connect(), this.opts.reconnectMs ?? 1000)
    }
    ws.on('close', onDown)
    ws.on('error', () => ws.terminate())
  }

  private translate(v: Record<string, unknown>): BotEvent | null {
    switch (v.type) {
      case 'ready':
        this.clientId = String(v.clientId)
        return { type: 'ready', clientId: this.clientId }
      case 'waterfall': {
        const eventId = String(v.eventId), sessionId = String(v.agentId ?? ''), request = (v.request ?? {}) as Record<string, unknown>
        if (v.event === 'approval/request') return { type: 'approval', eventId, sessionId, request }
        if (v.event === 'user-questions/request') return { type: 'question', eventId, sessionId, request }
        return null
      }
      case 'cancel':
        return { type: 'cancel', eventId: String(v.eventId) }
      case 'emit': {
        const args = (v.args ?? []) as unknown[]
        if (v.event === 'api-session/status') return { type: 'status', sessionId: String(args[0]), running: Boolean(args[1]) }
        return { type: 'emit', event: String(v.event), args }
      }
      default:
        return null
    }
  }
}
