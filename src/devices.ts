// Paired phones. A device holds one bearer token; `bot` checks it on every
// request and never lets the dsh cookie leave the machine.
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto'
import { readFile, rename } from 'node:fs/promises'
import { writeAtomic } from './atomic.ts'

/** `role: 'host'`: the pairing the host that runs this computer keeps for itself (src/host/server.ts), not a device of the person's. */
export interface Device { id: string; name: string; tokenHash: string; createdAt: string; revokedAt?: string; role?: 'host' }

export interface DeviceStore {
  /** Mint a token for a new device; the plain token is returned once. */
  issue(name: string, opts?: { role?: 'host' }): Promise<string>
  /** The device a plain bearer token belongs to, or null. */
  lookup(token: string): Promise<Device | null>
  revoke(id: string): Promise<void>
  rename(id: string, name: string): Promise<void>
  list(): Promise<Device[]>
}

const hash = (t: string) => createHash('sha256').update(t).digest('hex')
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))

export class MemoryDeviceStore implements DeviceStore {
  protected devices: Device[] = []
  async issue(name: string, opts: { role?: 'host' } = {}) {
    const token = randomBytes(32).toString('base64url')
    this.devices.push({ id: randomBytes(8).toString('hex'), name, tokenHash: hash(token), createdAt: new Date().toISOString(), ...(opts.role ? { role: opts.role } : {}) })
    await this.persist()
    return token
  }
  async lookup(token: string) {
    const h = hash(token)
    return this.devices.find((d) => !d.revokedAt && same(d.tokenHash, h)) ?? null
  }
  async revoke(id: string) {
    const d = this.devices.find((x) => x.id === id)
    if (d) { d.revokedAt = new Date().toISOString(); await this.persist() }
  }
  async rename(id: string, name: string) {
    const d = this.devices.find((x) => x.id === id)
    if (d && d.name !== name) { d.name = name; await this.persist() }
  }
  async list() { return this.devices.map((d) => ({ ...d })) }
  protected async persist() {}
}

/** JSON file under the bot home; written atomically. */
export class FileDeviceStore extends MemoryDeviceStore {
  private readonly path: string
  constructor(path: string) { super(); this.path = path }
  static async open(path: string) {
    const s = new FileDeviceStore(path)
    try { s.devices = JSON.parse(await readFile(path, 'utf8')) } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
    return s
  }
  protected override async persist() {
    await writeAtomic(this.path, () => JSON.stringify(this.devices, null, 2))
  }
}

export function bearerToken(header: string | undefined): string | null {
  const m = /^Bearer\s+([A-Za-z0-9_-]{16,})$/.exec(header ?? '')
  return m ? m[1] : null
}
