// The server-side outbound guard. The bot process — not the agent cell — holds
// the real model key, the connector tokens and the host secret, and a paired
// phone can ask it to call a URL (a custom model base URL, a push endpoint).
// This module is the one place that decides whether such a destination is
// public. It is on by default; DEEPSEEK_BOT_GUARD=off turns it off for a
// self-hosted stack.
//
// The rules: resolve the name, refuse loopback/private/link-local/metadata, and keep credential-holding calls on the
// server side (Claude Cowork: "Connector authorization tokens never enter the
// sandbox"). The cell's own egress proxy is a separate layer, but it imports
// the same OutboundPolicy and isBlockedAddress from net-policy.ts; this module
// does not start a proxy.
import { isIP } from 'node:net'
import { lookup as dnsLookup } from 'node:dns/promises'
import { Agent as HttpsAgent } from 'node:https'
import { Agent as UndiciAgent, fetch as undiciFetch } from 'undici'
import { isBlockedAddress, matchesHost, outboundPolicy, type OutboundPolicy } from './net-policy.ts'

export { isBlockedAddress } from './net-policy.ts'

export interface GuardPolicy extends OutboundPolicy {
  /** The bot is one account's sandbox on a host (DEEPSEEK_BOT_HOST_SECRET). */
  hosted: boolean
  /** In a hosted sandbox the phone may not repoint the model. */
  lockModel: boolean
}

export class GuardError extends Error {
  readonly code = 'guard-blocked'
  constructor(message: string) { super(message); this.name = 'GuardError' }
}

export interface Guard {
  readonly policy: GuardPolicy
  canChangeModel(): { ok: true } | { ok: false; status: 403; error: string }
  checkURL(raw: string, o?: { https?: boolean }): Promise<URL>
  checkModelBaseURL(raw: string): Promise<URL>
  checkPushEndpoint(raw: string): Promise<URL>
  /** Resolve and validate once; the address returned is the one a socket must connect to. */
  resolveAddress(host: string): Promise<{ address: string; family: 4 | 6 }>
  /** fetch through an undici dispatcher whose connect lookup validates and pins every connection. */
  fetch: typeof fetch
  /** https.Agent with the same lookup, for web-push (which uses https.request directly). */
  httpsAgent(): HttpsAgent
  close(): Promise<void>
}

export type Resolve = (host: string) => Promise<string[]>

/** Read the operator's switch. Defaults: on, no exceptions, hosted bots lock the model. */
export function guardPolicy(env: NodeJS.ProcessEnv = process.env): GuardPolicy {
  const policy = outboundPolicy(env)
  const hosted = Boolean(env.DEEPSEEK_BOT_HOST_SECRET) || env.DEEPSEEK_BOT_HOSTED === '1'
  return { ...policy, hosted, lockModel: hosted && env.DEEPSEEK_BOT_ALLOW_MODEL_CHANGE !== '1' }
}

const cleanHost = (host: string) => host.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase()

export function createGuard(policy: GuardPolicy, o: { resolve?: Resolve } = {}): Guard {
  const resolve = o.resolve ?? (async (host: string) => (await dnsLookup(host, { all: true, verbatim: true })).map((a) => a.address))

  async function resolveAddress(raw: string): Promise<{ address: string; family: 4 | 6 }> {
    const host = cleanHost(raw)
    if (!host) throw new GuardError('the URL has no host')
    if (policy.mode === 'on') {
      if (policy.only.length && !matchesHost(policy.only, host)) throw new GuardError(`${host} is not in the outbound allowlist`)
      if (!matchesHost(policy.allow, host) && !policy.allowPrivate) {
        if (host === 'localhost' || host.endsWith('.localhost')) throw new GuardError('refusing localhost')
      }
    }
    const allowed = policy.mode === 'off' || matchesHost(policy.allow, host) || policy.allowPrivate
    const literal = isIP(host)
    let addresses: string[]
    if (literal) addresses = [host]
    else {
      try { addresses = await resolve(host) } catch (e) { throw new GuardError(`cannot resolve ${host}: ${(e as Error).message}`) }
    }
    if (!addresses.length) throw new GuardError(`cannot resolve ${host}`)
    if (!allowed) {
      const blocked = addresses.find(isBlockedAddress)
      if (blocked) throw new GuardError(`refusing private or special address for ${host}`)
    }
    const address = addresses[0]
    return { address, family: isIP(address) === 6 ? 6 : 4 }
  }

  async function checkURL(raw: string, opts: { https?: boolean } = {}): Promise<URL> {
    let url: URL
    try { url = new URL(raw) } catch { throw new GuardError(`not a URL: ${raw.slice(0, 80)}`) }
    if (policy.mode === 'off') return url
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new GuardError('only http and https are allowed')
    if (opts.https && url.protocol !== 'https:') throw new GuardError('this destination must use https')
    if (url.username || url.password) throw new GuardError('URLs with a username or password are not allowed')
    await resolveAddress(url.hostname)
    return url
  }

  const connectLookup = (hostname: string, opts: { all?: boolean }, cb: (err: NodeJS.ErrnoException | null, address: string | { address: string; family: number }[], family?: number) => void) => {
    resolveAddress(hostname).then((t) => {
      if (opts.all) cb(null, [{ address: t.address, family: t.family }])
      else cb(null, t.address, t.family)
    }).catch((e) => cb(e as NodeJS.ErrnoException, '', 0))
  }

  let dispatcher: UndiciAgent | null = null
  let pushAgent: HttpsAgent | null = null
  const guardFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    dispatcher ??= new UndiciAgent({ connect: { lookup: connectLookup } })
    try {
      return await undiciFetch(input as never, { ...(init as never), dispatcher } as never)
    } catch (e) {
      for (let c: unknown = e; c && typeof c === 'object'; c = (c as { cause?: unknown }).cause) if (c instanceof GuardError) throw c
      throw e
    }
  }) as typeof fetch

  return {
    policy,
    canChangeModel() {
      if (policy.mode === 'off' || !policy.lockModel) return { ok: true }
      return { ok: false, status: 403, error: 'the model is fixed by whoever runs this bot' }
    },
    checkURL,
    checkModelBaseURL: (raw) => checkURL(raw),
    checkPushEndpoint: (raw) => checkURL(raw, { https: true }),
    resolveAddress,
    fetch: guardFetch,
    httpsAgent() { return (pushAgent ??= new HttpsAgent({ lookup: connectLookup })) },
    async close() {
      await dispatcher?.close(); dispatcher = null
      pushAgent?.destroy(); pushAgent = null
    },
  }
}
