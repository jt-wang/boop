// Local use: this phone reaches its computer through TailPocket (docs/connection.md). The shell registers the bridge
// (TailPocketNsh.attach), the bridge keeps the phone's key and the link in the Keychain or Keystore, and each opening of
// the tunnel gives a new loopback port, so the saved origin is only ever a guess until the tunnel is open again.
import { platform, signal, Storage } from 'nsh'
import { tailPocket, TailPocketError, type TailPocketConnection } from './tailpocket/nsh.ts'
import { pair } from './api.ts'

/** This session goes through TailPocket: a loopback address that is not on this phone's network at all. */
export const viaPocket = signal(false)
/** What TailPocket reports about the way there; null when it has nothing to say. */
export const pocketPath = signal<{ kind: 'direct' | 'relay'; relay?: string } | null>(null)

let tunnel: TailPocketConnection | null = null

/** A browser has no bridge and no camera scanner: it keeps the address form. */
export const canScan = () => platform.os !== 'web'
export const isInvite = (text: string) => /^tailpocket1:[A-Za-z0-9_-]+$/.test(text.trim())

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
  return tunnel.baseUrl
}

const CLAIM_TRIES = 20

/** Pair with the computer behind `invite`, then spend the Boop code it sent inside the tunnel. */
export async function pairInvite(invite: string, device: string): Promise<{ origin: string; token: string }> {
  const link = await tailPocket.pair(invite.trim(), { device, save: true })
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

/** Asks TailPocket which way the tunnel goes. A version that cannot say leaves it unsaid. */
export async function refreshPath(): Promise<void> {
  const ask = (tunnel as (TailPocketConnection & { path?: () => Promise<{ kind: 'direct' | 'relay'; relay?: string }> }) | null)?.path
  if (!ask) { pocketPath.set(null); return }
  pocketPath.set(await ask.call(tunnel).catch(() => null))
}
