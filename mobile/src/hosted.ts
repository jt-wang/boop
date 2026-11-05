// The hosted path: a host gives this account a
// computer of its own and pairs the phone with it. The app only knows the
// four Host API calls; once the sandbox is `ready` the {origin, token} it
// returns is an ordinary Session and everything else is the same as self-hosting.
import { host } from 'nsh'
import type { Session } from './api.ts'
import { BUILT_IN_HOST_URL } from './build-config.ts'

let fromPage: string | null = null
/** The browser build learns its host from the page (web/host.js) after launch. */
export function setHostUrl(v: string | undefined) { fromPage = typeof v === 'string' && /^https?:\/\//.test(v) ? v.replace(/\/$/, '') : null }

/** The launch parameter wins (iOS Info.plist, the page's meta tag), then the build's default; else no hosted path. */
export function pickHostUrl(params: { hostUrl?: unknown } | undefined, builtIn: string): string | null {
  const ok = (v: unknown) => (typeof v === 'string' && /^https?:\/\//.test(v) ? v.replace(/\/$/, '') : null)
  return ok(params?.hostUrl) ?? ok(builtIn)
}

/** Where the host lives: the native shell passes `hostUrl`, a build may carry one; nothing means "no hosted path". */
export function hostUrl(): string | null {
  if (fromPage) return fromPage
  let params: { hostUrl?: unknown } | undefined
  try { params = host.params as { hostUrl?: unknown } | undefined } catch { params = undefined }
  return pickHostUrl(params, BUILT_IN_HOST_URL)
}

export type SandboxState = { state: 'creating' | 'ready' | 'stopped'; origin?: string; token?: string }

async function call<T>(base: string, path: string, init: RequestInit & { account?: string } = {}): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (init.account) headers.authorization = `Bearer ${init.account}`
  const r = await fetch(`${base}${path}`, { ...init, headers })
  if (!r.ok) throw new Error(`host ${path}: ${r.status}`)
  return (await r.json()) as T
}

/** Dev-mode sign-in by email, or Sign in with Apple's identity token. */
/** Why a sign-in failed, in terms the screen can say. */
export type SignInError = 'code' | 'busy' | 'full' | 'other'

export async function signIn(base: string, who: { email: string; code?: string } | { apple: string }): Promise<string> {
  const r = await fetch(`${base}/host/sign-in`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(who) })
  if (r.ok) return ((await r.json()) as { accountToken: string }).accountToken
  const text = String(((await r.json().catch(() => ({}))) as { error?: string }).error ?? '')
  const why: SignInError = r.status === 429 ? 'busy' : /full/.test(text) ? 'full' : /code/.test(text) ? 'code' : 'other'
  throw Object.assign(new Error(text || `host /host/sign-in: ${r.status}`), { why })
}

/** What the host asks for at sign-in (an access code when its owner approves who gets in). */
export async function hostConfig(base: string): Promise<{ codeRequired: boolean }> {
  try { const r = await fetch(`${base}/host/config`); return r.ok ? ((await r.json()) as { codeRequired: boolean }) : { codeRequired: false } } catch { return { codeRequired: false } }
}

/** Creates (or finds) the account's computer and waits until it is ready; `onState` hears every poll. */
export async function waitForSandbox(base: string, account: string, onState?: (s: SandboxState) => void, opts: { pollMs?: number; timeoutMs?: number } = {}): Promise<Session> {
  let s = await call<SandboxState>(base, '/host/sandbox', { method: 'POST', body: '{}', account })
  const end = Date.now() + (opts.timeoutMs ?? 180_000)
  while (s.state !== 'ready' || !s.origin || !s.token) {
    onState?.(s)
    if (Date.now() > end) throw new Error('host: the computer did not come up in time')
    await new Promise((r) => setTimeout(r, opts.pollMs ?? 1500))
    s = await call<SandboxState>(base, '/host/sandbox', { account })
  }
  onState?.(s)
  return { origin: s.origin, token: s.token }
}

/**
 * Whether the paired computer is one a host made (Settings then calls it the cloud computer, not its address).
 * `hostedBy` is remembered when the hosted flow pairs; a phone paired that way before the app remembered it is
 * recognised by its origin sharing the build's host's parent domain (a sandbox at sandbox.example.fly.dev and the host on
 * fly.dev). A tunnel or a LAN address is the person's own computer.
 */
export function isHostedOrigin(origin: string, hostedBy: string | null, host: string | null): boolean {
  if (hostedBy) return true
  if (!host) return false
  const parent = (u: string) => { try { return new URL(u).hostname.split('.').slice(-2).join('.') } catch { return '' } }
  const p = parent(host)
  return Boolean(p) && /^https:/.test(origin) && parent(origin) === p
}
