// Local use: the phone reaches this computer through TailPocket (docs/connection.md). The bot listens on loopback only;
// TailPocket's helper forwards each paired phone's connection to it. Boop's own pairing stays on top: the 6-digit code
// travels to the phone inside the tunnel (`payload`) and buys a device token as it always has, so a phone that holds a
// tunnel but no token gets nothing, and removing a device also removes its phone from the tunnel.
import { readFile } from 'node:fs/promises'
import { writeAtomic } from './atomic.ts'
import type { TailPocketHostOptions, TailPocketHostState, TailPocketPairing, TailPocketPhone } from '../vendor/tailpocket/index.d.ts'

export interface PocketWanted { inContainer: boolean; publicUrl?: string; tunnel?: string; configHost: string; argv: string[] }

/** Local use. deploy/ and Fly run the image and keep their https; a chosen address, tunnel or host is a choice to keep. */
export function pocketWanted(o: PocketWanted): boolean {
  if (o.inContainer || o.publicUrl || o.tunnel === 'cloudflared' || o.argv.includes('--no-tailpocket') || o.argv.includes('--host')) return false
  return o.configHost === '0.0.0.0'
}

/** TailPocket opens a pairing window for at most 15 minutes (sdk/node/index.d.ts). */
export const windowSeconds = (ms: number) => Math.max(60, Math.min(900, Math.round(ms / 1000)))

interface HostLike {
  pair(o: { ttl?: number; payload?: string }): Promise<Pick<TailPocketPairing, 'qr' | 'expiresAt' | 'paired' | 'closed' | 'cancel'>>
  revoke(phone: string): Promise<void>
  close(): Promise<void>
}
type Start = (o: TailPocketHostOptions) => Promise<HostLike>
interface Saved extends Partial<TailPocketHostState> { phones?: Record<string, string> }

export interface PocketOptions { statePath: string; forward: string; name?: string; start?: Start }

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
    const host = await start({ forward: o.forward, name: o.name, identity: saved.identity, allowed: saved.allowed, save: (s) => state.update(s) })
    return new Pocket(host, state)
  }

  /** Open a window whose QR pairs one phone and hands it `code`. */
  async window(code: string, ttl: number): Promise<{ qr: string; expiresAt: Date; closed: Promise<string> }> {
    const w = await this.host.pair({ ttl, payload: code })
    this.pending.set(code, {})
    w.paired.then((p: TailPocketPhone) => this.link(code, { phone: p.phone })).catch(() => {})
    w.closed.then(() => { if (!this.pending.get(code)?.phone) this.pending.delete(code) }).catch(() => {})
    return { qr: w.qr, expiresAt: w.expiresAt, closed: w.closed as Promise<string> }
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
