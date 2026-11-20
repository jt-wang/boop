// Local use: the phone reaches this computer through TailPocket (docs/connection.md). The bot listens on loopback only;
// TailPocket's helper forwards each paired phone's connection to it. Boop's own pairing stays on top: the 6-digit code
// travels to the phone inside the tunnel (`payload`) and buys a device token as it always has, so a phone that holds a
// tunnel but no token gets nothing, and removing a device also removes its phone from the tunnel.
import { readFile } from 'node:fs/promises'
import { writeAtomic } from './atomic.ts'
import type { TailPocketHostOptions, TailPocketHostState, TailPocketPairing, TailPocketPhone, TailPocketRelay } from '../vendor/tailpocket/index.d.ts'

export interface PocketWanted { inContainer: boolean; publicUrl?: string; tunnel?: string; configHost: string; argv: string[] }

/** Local use. deploy/ and Fly run the image and keep their https; a chosen address, tunnel or host is a choice to keep. */
export function pocketWanted(o: PocketWanted): boolean {
  if (o.inContainer || o.publicUrl || o.tunnel === 'cloudflared' || o.argv.includes('--no-tailpocket') || o.argv.includes('--host')) return false
  return o.configHost === '0.0.0.0'
}

/** Where the bot listens. Local use stays on loopback whether or not the helper is there (`pocket`): without it no phone
 *  gets in, rather than plain HTTP on the local network by default. `plain`: the person chose an address on the local
 *  network (`--host`, `--no-tailpocket`, a config host), so everything there, the token too, goes unencrypted. */
export function listenPlan(o: PocketWanted, helper: boolean): { host: string; pocket: boolean; plain: boolean } {
  if (pocketWanted(o)) return { host: '127.0.0.1', pocket: helper, plain: false }
  const loopback = o.configHost === 'localhost' || o.configHost === '::1' || o.configHost.startsWith('127.')
  return { host: o.configHost, pocket: false, plain: !o.inContainer && !o.publicUrl && !loopback }
}

/** TailPocket opens a pairing window for at most 15 minutes (sdk/node/index.d.ts). */
export const windowSeconds = (ms: number) => Math.max(60, Math.min(900, Math.round(ms / 1000)))

interface HostLike {
  pair(o: { ttl?: number; payload?: string; emoji?: boolean }): Promise<Pick<TailPocketPairing, 'qr2' | 'expiresAt' | 'paired' | 'closed' | 'cancel' | 'on' | 'confirm'>>
  revoke(phone: string): Promise<void>
  close(): Promise<void>
}
type Start = (o: TailPocketHostOptions) => Promise<HostLike>
interface Saved extends Partial<TailPocketHostState> { phones?: Record<string, string> }

/** `relay`: a tailpocket-relay phones may also come in through, end-to-end encrypted (Noise; the relay sees only ciphertext,
 *  so not opaque and no `appAuth`). `noLan`: no route straight over the local network. `tailcatOnly`: Tailcat alone, no
 *  local network and no relay (the helper refuses it together with a relay, so the caller drops the relay). */
export interface PocketOptions { statePath: string; forward: string; name?: string; relay?: TailPocketRelay; noLan?: boolean; tailcatOnly?: boolean; start?: Start }

/** A phone asking to pair through the window: its name and the four emoji its screen shows. */
export interface PairAsk { device: string; route: string; emoji: string[] }

/** The file holds the node's private keys: 0600, and every change lands whole. */
class PocketState {
  saved: Saved
  private readonly path: string
  constructor(path: string, saved: Saved) { this.path = path; this.saved = saved }
  update(part: Saved): Promise<void> { this.saved = { ...this.saved, ...part }; return writeAtomic(this.path, () => JSON.stringify(this.saved), 0o600) }
}

export class Pocket {
  /** One open window's code → what is known so far; the phone's pairing and its claim can arrive in either order. */
  private readonly pending = new Map<string, { phone?: string; device?: string }>()
  private readonly host: HostLike
  private readonly state: PocketState

  private constructor(host: HostLike, state: PocketState) { this.host = host; this.state = state }

  static async open(o: PocketOptions): Promise<Pocket> {
    const saved: Saved = await readFile(o.statePath, 'utf8').then((s) => JSON.parse(s) as Saved).catch(() => ({}))
    const state = new PocketState(o.statePath, saved)
    const start: Start = o.start ?? (async (opts) => (await import('../vendor/tailpocket/index.js')).TailPocketHost.start(opts))
    // `keys`: each phone's Noise key; without it a phone that synced its key would be a stranger on the encrypted routes after a restart
    const host = await start({
      forward: o.forward, name: o.name, identity: saved.identity, allowed: saved.allowed, keys: saved.keys,
      ...(o.relay && !o.tailcatOnly ? { relays: [o.relay] } : {}), ...(o.tailcatOnly ? { tailcatOnly: true } : o.noLan ? { noLan: true } : {}),
      save: (s) => state.update(s),
    })
    return new Pocket(host, state)
  }

  /** Open a window whose QR (the v2 invite, `tailpocket2:`) pairs one phone and hands it `code`. Before the phone is saved,
   *  `ask` gets its name and the four emoji its screen shows; answer with `confirm(true)` once the person saw the same on
   *  the phone, within 55 s. A no, no answer or a phone that left ends the window (`closed`), and its code pairs nobody.
   *  `askEnded`: the question went away without an answer. Pairing over a v2 invite needs a v0.3.0-pre.4 app. */
  async window(code: string, ttl: number, on: { ask(a: PairAsk): void; askEnded(): void }): Promise<{ qr: string; expiresAt: Date; closed: Promise<string>; confirm(yes: boolean): void }> {
    const w = await this.host.pair({ ttl, payload: code, emoji: true })
    this.pending.set(code, {})
    w.on('request', (r) => on.ask({ device: r.device, route: r.route, emoji: r.emoji ?? [] }))
    w.on('requestCancelled', () => on.askEnded())
    w.paired.then((p: TailPocketPhone) => this.link(code, { phone: p.phone })).catch(() => {})
    w.closed.then(() => { if (!this.pending.get(code)?.phone) this.pending.delete(code) }).catch(() => {})
    return { qr: w.qr2!, expiresAt: w.expiresAt, closed: w.closed as Promise<string>, confirm: (yes) => w.confirm(yes) }
  }

  /** The phone holding `code` spent it: this device is that phone. */
  async claimed(code: string, deviceId: string): Promise<void> { await this.link(code, { device: deviceId }) }

  private async link(code: string, part: { phone?: string; device?: string }) {
    const p = this.pending.get(code); if (!p) return
    Object.assign(p, part)
    if (!p.phone || !p.device) return
    this.pending.delete(code)
    const phones = Object.fromEntries(Object.entries(this.state.saved.phones ?? {}).filter(([, phone]) => phone !== p.phone))
    await this.state.update({ phones: { ...phones, [p.device]: p.phone } })
  }

  /** A device was removed: its phone leaves the tunnel too. */
  async deviceRevoked(deviceId: string): Promise<void> {
    const phone = this.state.saved.phones?.[deviceId]; if (!phone) return
    const { [deviceId]: _gone, ...phones } = this.state.saved.phones!
    await this.state.update({ phones })
    await this.host.revoke(phone)
  }

  close(): Promise<void> { return this.host.close() }
}
