// Local use: this phone reaches its computer through TailPocket (docs/connection.md). The shell registers the bridge
// (TailPocketNsh.attach), the bridge keeps the phone's key and the link in the Keychain or Keystore, and each opening of
// the tunnel gives a new loopback port, so the saved origin is only ever a guess until the tunnel is open again.
import { host, platform, signal, Storage } from 'nsh'
import { createTailPocket, TailPocketError, type TailPocketConnection, type TailPocketHostLink, type TailPocketPath, type TailPocketRouteType } from './tailpocket/client.ts'
import { pair } from './api.ts'

// NSH 0.4.0 rejects a host call with `code: 'ERR_NSH_HOST_ERROR'` and the bridge's own code as the message (measured
// 2026-11-05). TailPocket's client reads `code` first, so its own nsh.ts would lose "expired", "cancelled", "not-paired".
const tailPocket = createTailPocket({
  call: (name, args, timeoutMs) => host.call(name, args ?? null, timeoutMs === undefined ? null : { timeout: timeoutMs })
    .catch((e: { code?: string; message?: string }) => { throw e?.code === 'ERR_NSH_HOST_ERROR' ? new Error(e.message) : e }),
  on: (event, listener) => host.on(event, listener),
})

/** This session goes through TailPocket: a loopback address that is not on this phone's network at all. */
export const viaPocket = signal(false)
/** What TailPocket reports about the way there; null when it has nothing to say. `direct` and `relay` over Tailcat or a
 *  tailpocket-relay (`relay` names it), `lan` straight over the local network, end-to-end encrypted either way. */
export const pocketPath = signal<{ kind: 'direct' | 'relay' | 'lan'; relay?: string } | null>(null)

let tunnel: TailPocketConnection | null = null

/** Why the computer cannot be reached, from TailPocket's `lastFailure()` (v0.3.4): `not-running` (refused or a closed
 *  handshake: TailPocket is not running there, or the computer was reset), `no-answer` (off, asleep, or this network
 *  blocks it), `relay-down`. null: nothing failed, or not known yet. Not authenticated, as anyone on the network can
 *  refuse a connection: it only picks the words shown, and never unpairs, deletes the link or changes the pinned key. */
export type Unreachable = 'not-running' | 'no-answer' | 'relay-down'
export const unreachable = signal<Unreachable | null>(null)
const REASONS: Record<string, Unreachable> = { refused: 'not-running', 'handshake-closed': 'not-running', 'no-answer': 'no-answer', 'relay-down': 'relay-down' }
/** How many routes one dial tries: those in the link that this phone may use (Settings › Connection). */
let dialRoutes = 1
/** How long TailPocket may take to fail a dial, max(20 s, routes × 10 s) (INTEGRATE.md): until then `lastFailure()`
 *  may still be null, and opening the tunnel again sooner would cut the dial short. */
export const dialBoundMs = () => Math.max(20_000, dialRoutes * 10_000)
function countRoutes(l: TailPocketHostLink): number {
  const allowed = ROUTES[routeMode()]
  const kinds = new Set((l.via ?? []).map((r) => r.t))
  if (l.address) kinds.add('tailcat')
  return Math.max(1, [...kinds].filter((t) => allowed === null || (allowed as string[]).includes(t)).length)
}
let readAgain: ReturnType<typeof setTimeout> | null = null
/** A request through the tunnel failed: ask TailPocket why. Null may mean the dial has not ended (the app's own timeout
 *  is shorter than the dial's), so then it asks once more after the bound. */
export async function readFailure(again = true): Promise<void> {
  const t = tunnel; if (!t) return
  let f
  try { f = await t.lastFailure() } catch { return } // a bridge before v0.3.4 cannot say
  if (t !== tunnel) return
  // an empty reason (no route tried, `code` says it) adds nothing: only the computer answering clears a known one (`reached`)
  if (f) { const r = REASONS[f.reason]; if (r) unreachable.set(r); return }
  if (!again || readAgain) return
  readAgain = setTimeout(() => { readAgain = null; readFailure(false).catch(() => {}) }, dialBoundMs())
}
/** The computer answered: no reason to show. */
export const reached = () => unreachable.set(null)

/** The four emoji a pairing shows while the computer's user compares them (TailPocket v0.3.0-pre.4); null otherwise. */
export const pairEmoji = signal<string[] | null>(null)

/** Which routes this phone may use (Settings › Connection, TailPocket v0.3.2 `setRoutes`): every route the computer lists, or
 *  only one kind. Without Tailcat the phone starts no Tailcat client at all. Per phone, in Storage (`pocketRoutes`);
 *  TailPocket takes it before each `connect`, so it is set at launch and the tunnel opens again when it changes. */
export type RouteMode = 'all' | 'lan' | 'relay' | 'tailcat'
export const ROUTE_MODES: readonly RouteMode[] = ['all', 'lan', 'relay', 'tailcat']
const ROUTES: Record<RouteMode, TailPocketRouteType[] | null> = { all: null, lan: ['lan'], relay: ['relay'], tailcat: ['tailcat'] }
export const routeMode = signal<RouteMode>('all')
export async function loadRouteMode(): Promise<void> {
  const saved = await Storage.getItem('pocketRoutes').catch(() => null)
  // before v0.3.2 the one choice was the Tailcat-only switch (`tailcatOnly` = '1')
  const mode = ROUTE_MODES.find((m) => m === saved) ?? ((await Storage.getItem('tailcatOnly').catch(() => null)) === '1' ? 'tailcat' : 'all')
  routeMode.set(mode)
  if (mode !== 'all') await tailPocket.setRoutes(ROUTES[mode]).catch(() => {}) // a browser has no bridge
}
/** TailPocket takes the routes first: one it refuses is neither shown nor kept, so the screen never claims a limit the
 *  phone does not have. Always an array or an explicit null (TailPocket v0.3.3 and later refuse anything else). */
export async function setRouteMode(mode: RouteMode): Promise<void> {
  await tailPocket.setRoutes(ROUTES[mode])
  routeMode.set(mode)
  await Storage.setItem('pocketRoutes', mode).catch(() => {})
  await Storage.removeItem('tailcatOnly').catch(() => {})
}

/** A browser has no bridge and no camera scanner: it keeps the address form. */
export const canScan = () => platform.os !== 'web'
/** A TailPocket invite: `tailpocket1:` from every computer, `tailpocket2:` from one with a relay (TailPocket v0.3). */
export const isInvite = (text: string) => /^tailpocket[12]:[A-Za-z0-9_-]+$/.test(text.trim())

export async function restorePocket(): Promise<boolean> {
  const on = (await Storage.getItem('pocket')) === '1'
  viaPocket.set(on)
  return on
}

/** The camera, until a QR with an invite is seen. */
export const scanInvite = () => tailPocket.scan()

/** The opening of the tunnel; closes the one before it. */
export async function openTunnel(): Promise<string> {
  const before = tunnel
  tunnel = null
  await before?.close().catch(() => {})
  tunnel = await tailPocket.connect()
  syncKey(tunnel)
  return tunnel.baseUrl
}

/** A link from before TailPocket v0.3 has no `pk`: once connected, it registers its end-to-end key over the tunnel and gets
 *  the computer's key and routes, so it can use the encrypted ones without a new QR. Not awaited: a computer before v0.3
 *  does not answer it, and the phone simply keeps using Tailcat. */
function syncKey(t: TailPocketConnection) {
  t.link().then((l) => { dialRoutes = countRoutes(l); return l.pk ? undefined : t.sync() }).catch(() => {})
}

const CLAIM_TRIES = 20

/** Pair with the computer behind `invite`, then spend the Boop code it sent inside the tunnel. A `tailpocket2:` invite
 *  shows four emoji (`pairEmoji`) until the computer's user confirms; `unauthorized`: they said no, or the code was spent. */
export async function pairInvite(invite: string, device: string): Promise<{ origin: string; token: string }> {
  let link
  try { link = await tailPocket.pair(invite.trim(), { device, save: true, onEmoji: (e) => pairEmoji.set(e.slice(0, 4)) }) }
  finally { pairEmoji.set(null) }
  // every URL goes under the tunnel's base (`…/_tailpocket/<token>`), never resolved against "/"
  const origin = await openTunnel()
  try {
    const token = await claim(origin, link.payload ?? '', device)
    await Storage.setItem('pocket', '1'); viaPocket.set(true); reached()
    return { origin, token }
  } catch (e) { await forgetPocket(); throw e }
}

/** Spends the Boop code that came inside the tunnel; the first connection through a new tunnel takes seconds to find
 *  the way, and fails until then. */
async function claim(origin: string, code: string, device: string): Promise<string> {
  for (let i = 0; i < CLAIM_TRIES; i++) {
    try {
      const r = await pair(origin, code, device)
      if (r.ok) return r.token
      throw new TailPocketError('expired')
    } catch (e) {
      if (e instanceof TailPocketError) throw e
      await new Promise((resolve) => setTimeout(resolve, 1500))
    }
  }
  throw new TailPocketError('unreachable')
}

/** Pair again, only from the person's tap (Settings, when the computer looks reset). The new link is tried on a tunnel
 *  of its own and saved only once Boop took this phone: until then, and if it fails or is cancelled, the old link stays
 *  and keeps working when the computer comes back. */
export async function repairInvite(invite: string, device: string): Promise<{ origin: string; token: string }> {
  let link: TailPocketHostLink
  try { link = await tailPocket.pair(invite.trim(), { device, save: false, onEmoji: (e) => pairEmoji.set(e.slice(0, 4)) }) }
  finally { pairEmoji.set(null) }
  const trial = await tailPocket.connect({ link })
  let token: string
  try { token = await claim(trial.baseUrl, link.payload ?? '', device) } catch (e) { await trial.close().catch(() => {}); throw e }
  await tailPocket.store.saveLink(link)
  const before = tunnel
  tunnel = trial; dialRoutes = countRoutes(link)
  await before?.close().catch(() => {})
  await Storage.setItem('pocket', '1'); viaPocket.set(true); reached()
  return { origin: trial.baseUrl, token }
}

/** This phone is done with this computer: the tunnel closes and the link goes. */
export async function forgetPocket(): Promise<void> {
  const open = tunnel
  tunnel = null
  await open?.close().catch(() => {})
  await tailPocket.store.deleteLink().catch(() => {})
  await Storage.removeItem('pocket')
  viaPocket.set(false); pocketPath.set(null); reached()
}

/** Asks TailPocket which way the tunnel goes. A bridge that cannot say leaves it unsaid. Rejects `revoked` when the
 *  computer removed this phone: the caller signs out, as for a refused token. */
export async function refreshPath(): Promise<void> {
  if (!tunnel) { pocketPath.set(null); return }
  let p: TailPocketPath
  try { p = await tunnel.path() } catch (e) {
    if ((e as { code?: string }).code === 'revoked') throw e
    pocketPath.set(null); return
  }
  pocketPath.set(p.route === 'direct' || p.route === 'lan' ? { kind: p.route } : p.route === 'relay' ? { kind: 'relay', relay: p.relay || undefined } : null)
}
