// Six-digit pairing codes shown as a QR in the terminal. One code, one phone.
import { randomInt } from 'node:crypto'
import type { DeviceStore } from './devices.ts'

export interface PairingOptions { ttlMs?: number; now?: () => number; maxAttempts?: number; onClaim?: (code: string, deviceId: string) => void | Promise<void> }

export class Pairing {
  private codes = new Map<string, number>()
  private failures = 0
  private lockedUntil = 0
  private readonly ttl: number
  private readonly now: () => number
  private readonly maxAttempts: number
  private readonly devices: DeviceStore
  private readonly onClaim: PairingOptions['onClaim']
  constructor(devices: DeviceStore, opts: PairingOptions = {}) {
    this.devices = devices
    this.ttl = opts.ttlMs ?? 10 * 60_000
    this.now = opts.now ?? Date.now
    this.maxAttempts = opts.maxAttempts ?? 5
    this.onClaim = opts.onClaim
  }

  create(ttlMs = this.ttl): string {
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
    this.codes.set(code, this.now() + ttlMs)
    return code
  }

  /** Spend a code; returns the new device token or null. */
  async claim(code: string, deviceName: string): Promise<string | null> {
    const t = this.now()
    if (t < this.lockedUntil) return null
    const exp = this.codes.get(code)
    if (exp === undefined || exp < t) {
      if (++this.failures >= this.maxAttempts) { this.lockedUntil = t + 60_000; this.failures = 0 }
      return null
    }
    this.codes.delete(code)
    this.failures = 0
    const token = await this.devices.issue(deviceName.slice(0, 64) || 'phone')
    if (this.onClaim) { const d = await this.devices.lookup(token); if (d) await this.onClaim(code, d.id) }
    return token
  }

  active(): string[] {
    const t = this.now()
    return [...this.codes].filter(([, e]) => e >= t).map(([c]) => c)
  }
}
