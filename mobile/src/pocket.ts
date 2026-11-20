// Local use: this phone reaches its computer through TailPocket (docs/connection.md). The shell registers the bridge
// (TailPocketNsh.attach), the bridge keeps the phone's key and the link in the Keychain or Keystore, and each opening of
// the tunnel gives a new loopback port, so the saved origin is only ever a guess until the tunnel is open again.
import { host, platform, signal, Storage } from 'nsh'
import { createTailPocket, TailPocketError, type TailPocketConnection, type TailPocketPath } from './tailpocket/client.ts'
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

/** The four emoji a pairing shows while the computer's user compares them (TailPocket v0.3.0-pre.4); null otherwise. */
export const pairEmoji = signal<string[] | null>(null)

/** Tailcat only (Settings): the phone ignores the relay and local network routes a computer lists. Per phone, in Storage
 *  (`tailcatOnly` = '1'); TailPocket takes it before each `connect`, so it is set at launch and the tunnel opens again
 *  when it changes. */
export const tailcatOnly = signal(false)
export async function loadTailcatOnly(): Promise<void> {
  const on = (await Storage.getItem('tailcatOnly').catch(() => null)) === '1'
  tailcatOnly.set(on)
  if (on) await tailPocket.setTailcatOnly(true).catch(() => {}) // a browser has no bridge
}
export async function setTailcatOnly(on: boolean): Promise<void> {
  tailcatOnly.set(on)
  await Storage.setItem('tailcatOnly', on ? '1' : '0').catch(() => {})
  await tailPocket.setTailcatOnly(on).catch(() => {})
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
  t.link().then((l) => (l.pk ? undefined : t.sync())).catch(() => {})
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
  // the first connection through a new tunnel takes seconds to find the way: it fails until then
  let refused = false
  for (let i = 0; i < CLAIM_TRIES; i++) {
    try {
      const r = await pair(origin, link.payload ?? '', device)
      if (r.ok) { await Storage.setItem('pocket', '1'); viaPocket.set(true); return { origin, token: r.token } }
      refused = true; break
    } catch { await new Promise((resolve) => setTimeout(resolve, 1500)) }
  }
  await forgetPocket()
  throw new TailPocketError(refused ? 'expired' : 'unreachable')
}

/** This phone is done with this computer: the tunnel closes and the link goes. */
export async function forgetPocket(): Promise<void> {
  const open = tunnel
  tunnel = null
  await open?.close().catch(() => {})
  await tailPocket.store.deleteLink().catch(() => {})
  await Storage.removeItem('pocket')
  viaPocket.set(false); pocketPath.set(null)
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
