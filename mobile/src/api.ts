// The bot client: pairing, bot endpoints (threads, messages, settings…) and the
// /events WebSocket (one-time ticket; carries asks and the thread frames).
// Storage is async in NSH's TSX runtime (measured 2026-10-27).
import { locale, Storage } from 'nsh'

export interface Session { origin: string; token: string }

export const uuid = () => (typeof globalThis.crypto?.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`)

export async function loadSession(): Promise<Session | null> {
  const origin = await Storage.getItem('origin'); const token = await Storage.getItem('token')
  return origin && token ? { origin, token } : null
}
export async function saveSession(s: Session | null) {
  if (!s) { await Storage.removeItem('origin'); await Storage.removeItem('token'); return }
  await Storage.setItem('origin', s.origin); await Storage.setItem('token', s.token)
}

/** Accepts a bare origin or a whole pairing link; returns {origin, code?}. A TailPocket code stays as it is, for the connect screen. */
export function parseAddress(input: string): { origin: string; code?: string } | null {
  let s = input.trim()
  if (!s) return null
  if (/^tailpocket1:/.test(s)) return { origin: s }
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`
  try {
    const u = new URL(s)
    const code = u.searchParams.get('code') ?? undefined
    return { origin: u.origin, code: code && /^\d{6}$/.test(code) ? code : undefined }
  } catch { return null }
}

export async function pair(origin: string, code: string, name: string): Promise<{ ok: true; token: string } | { ok: false; status: number }> {
  const r = await fetch(`${origin}/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, name }) })
  if (r.status !== 200) return { ok: false, status: r.status }
  return { ok: true, token: (await r.json()).token }
}

export class Bot {
  constructor(readonly s: Session) {}
  private headers(extra: Record<string, string> = {}) { return { authorization: `Bearer ${this.s.token}`, 'content-type': 'application/json', ...extra } }
  async get<T>(path: string): Promise<T> { const r = await fetch(this.s.origin + path, { headers: this.headers() }); if (r.status === 401) throw new Error('unpaired'); return r.json() }
  async send<T>(method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown, raw = false): Promise<T> {
    const r = await fetch(this.s.origin + path, { method, headers: this.headers(raw ? { 'content-type': 'text/plain' } : {}), body: body === undefined ? undefined : raw ? String(body) : JSON.stringify(body) })
    if (r.status === 401) throw new Error('unpaired')
    if (r.status >= 500) throw new Error(`HTTP ${r.status}`)
    const t = await r.text(); try { return JSON.parse(t) } catch { return t as unknown as T }
  }
  async text(path: string): Promise<string> { const r = await fetch(this.s.origin + path, { headers: this.headers() }); if (r.status === 401) throw new Error('unpaired'); return r.text() }

  /** One DSH gateway call through the bot. */
  async rpc<T = unknown>(method: string, args: Record<string, unknown>): Promise<T> {
    const r = await fetch(`${this.s.origin}/api/${method}`, { method: 'POST', headers: this.headers(), body: JSON.stringify({ type: 'client-request', rpcId: uuid(), method, payload: { args } }) })
    if (r.status === 401) throw new Error('unpaired')
    if (r.status === 404) { const e = new Error('capability-unavailable') as Error & { code: string }; e.code = 'capability-unavailable'; throw e }
    const env = await r.json()
    if (!env.result?.ok) { const e = new Error(env.result?.error?.message ?? `${method} failed`) as Error & { code?: string }; e.code = env.result?.error?.code; throw e }
    return env.result.value
  }

  /** What this phone knows about the person, sent on every connect (PUT /me/context) so the assistant never asks for it. */
  async sendContext(extra: { name?: string } = {}) {
    await this.send('PUT', '/me/context', { ...deviceContext(), ...extra })
  }

  /** One message into a thread: POST /threads/:id/messages. `cardId` marks a tap on a card. Throws unless the bot answered 200. */
  async prompt(sessionId: string, text: string, cardId?: string) {
    const tz = deviceTimeZone()
    const body: { text: string; timeZone?: string; cardId?: string } = tz ? { text, timeZone: tz } : { text }
    if (cardId) body.cardId = cardId
    const r = await fetch(`${this.s.origin}/threads/${encodeURIComponent(sessionId)}/messages`, { method: 'POST', headers: this.headers(), body: JSON.stringify(body) })
    if (r.status === 401) throw new Error('unpaired')
    if (r.status !== 200) throw new Error(`HTTP ${r.status}`)
    return r.json()
  }

  /** POST with no body; the status. */
  async cancel(path: string): Promise<number> { return (await fetch(this.s.origin + path, { method: 'POST', headers: { authorization: `Bearer ${this.s.token}` } })).status }

  async ticket(): Promise<string> { return (await this.send<{ ticket: string }>('POST', '/ws-ticket')).ticket }
  wsUrl(path: string, ticket: string) { return `${this.s.origin.replace(/^http/, 'ws')}${path}?ticket=${ticket}` }
}

/** The language the person chose in the app, when they did: it wins over the phone's. */
let chosenLanguage = ''
export const setChosenLanguage = (l: string) => { chosenLanguage = l }

/** Time zone and language straight from the device; nothing the person has to type. A zone only when the device says one. */
export function deviceContext(): { timeZone?: string; locale: string } {
  let l = chosenLanguage
  if (!l) try { l = locale() } catch {}
  if (!l) { try { l = new Intl.DateTimeFormat().resolvedOptions().locale } catch {} }
  const timeZone = deviceTimeZone()
  return timeZone ? { timeZone, locale: l } : { locale: l }
}

/**
 * The device's time zone as the bot can use it (an IANA name), or nothing when the device does not say one.
 * Android's runtime gives an offset ("-05:00"; NSH 0.3.0, 2026-10-27), which becomes the matching fixed zone
 * (Etc/GMT+5: the Etc names count the other way); a half-hour offset stays an offset. A bare "UTC" with no offset
 * is what a runtime without zone data says, so it is not sent; with an offset, the offset wins.
 */
export function deviceTimeZone(read: () => string = () => new Intl.DateTimeFormat().resolvedOptions().timeZone, offsetMin: number = new Date().getTimezoneOffset()): string | undefined {
  let tz = ''
  try { tz = read() || '' } catch {}
  if (tz.includes('/')) return tz
  const m = /^([+-])(\d{2}):?(\d{2})$/.exec(tz)
  const offset = m ? -(m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : offsetMin // minutes west, as getTimezoneOffset
  if (!Number.isFinite(offset) || offset === 0) return undefined
  if (offset % 60 === 0) return `Etc/GMT${offset > 0 ? '+' : '-'}${Math.abs(offset) / 60}`
  const east = -offset
  return `${east >= 0 ? '+' : '-'}${String(Math.floor(Math.abs(east) / 60)).padStart(2, '0')}:${String(Math.abs(east) % 60).padStart(2, '0')}`
}
