// Accounts of a host: who signed in, their (hashed) account tokens, and the one
// sandbox each account owns. A JSON file under the host home, written atomically.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { dirname } from 'node:path'

export type SandboxState = 'creating' | 'ready' | 'failed'

export interface SandboxRecord {
  /** Also the provider's sandbox id (container `dsb-<id>`). */
  id: string
  state: SandboxState
  error?: string
  /** Device token the host itself uses on the bot (GET /schedules). Plain: this file is the host's own secret store. */
  hostToken?: string
  /** Device token handed to the account's app with every GET/POST /host/sandbox. */
  phoneToken?: string
  /** Last request through the proxy (ISO). */
  lastSeenAt: string
  /** Earliest schedule inside, read when the sandbox was stopped; the host starts it a minute before. */
  wakeAt: string | null
}

export interface Account {
  id: string
  email?: string
  appleSub?: string
  createdAt: string
  tokenHashes: string[]
  sandbox?: SandboxRecord
  /** [compliance] Set by the operator after a report: no sign-in, no proxy. */
  suspendedAt?: string
}

const hash = (t: string) => createHash('sha256').update(t).digest('hex')
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))

export class AccountStore {
  private rows: Account[] = []
  private readonly path: string
  private readonly prefix: string
  private constructor(path: string, prefix: string) { this.path = path; this.prefix = prefix }

  /** `idPrefix` goes in front of every new account id (and so of its sandbox): tests use `test-` so containers can be swept. */
  static async open(path: string, opts: { idPrefix?: string } = {}) {
    const s = new AccountStore(path, opts.idPrefix ?? '')
    try { s.rows = JSON.parse(await readFile(path, 'utf8')) } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
    return s
  }

  all(): Account[] { return this.rows.map((r) => structuredClone(r)) }
  get(id: string): Account | undefined { const r = this.rows.find((x) => x.id === id); return r && structuredClone(r) }

  /** The account for a dev email or an Apple `sub`, created on first sight. */
  async findOrCreate(by: { email?: string; appleSub?: string }): Promise<Account> {
    let r = this.rows.find((x) => (by.appleSub && x.appleSub === by.appleSub) || (by.email && !by.appleSub && x.email === by.email && !x.appleSub))
    if (!r) {
      r = { id: `${this.prefix}${randomBytes(6).toString('hex')}`, email: by.email, appleSub: by.appleSub, createdAt: new Date().toISOString(), tokenHashes: [] }
      this.rows.push(r)
      await this.persist()
    }
    return structuredClone(r)
  }

  /** Mint an account token; the plain token is returned once. Keeps the last 10 per account. */
  async issueToken(accountId: string): Promise<string> {
    const r = this.rows.find((x) => x.id === accountId); if (!r) throw new Error('no such account')
    const token = randomBytes(32).toString('base64url')
    r.tokenHashes = [...r.tokenHashes.slice(-9), hash(token)]
    await this.persist()
    return token
  }

  async lookup(token: string): Promise<Account | null> {
    const h = hash(token)
    const r = this.rows.find((x) => x.tokenHashes.some((t) => same(t, h)))
    return r ? structuredClone(r) : null
  }

  /** [compliance] The account signed in with this email (not an Apple one). */
  byEmail(email: string): Account | undefined { const e = email.trim().toLowerCase(); const r = this.rows.find((x) => x.email === e && !x.appleSub); return r && structuredClone(r) }

  /** [compliance] Delete the account record (its tokens with it). */
  async remove(accountId: string): Promise<boolean> {
    const n = this.rows.length
    this.rows = this.rows.filter((x) => x.id !== accountId)
    if (this.rows.length !== n) await this.persist()
    return this.rows.length !== n
  }

  async suspend(accountId: string): Promise<void> {
    const r = this.rows.find((x) => x.id === accountId); if (!r) throw new Error('no such account')
    r.suspendedAt = new Date().toISOString()
    await this.persist()
  }

  bySandbox(sandboxId: string): Account | undefined { const r = this.rows.find((x) => x.sandbox?.id === sandboxId); return r && structuredClone(r) }

  async setSandbox(accountId: string, sandbox: SandboxRecord | undefined): Promise<void> {
    const r = this.rows.find((x) => x.id === accountId); if (!r) throw new Error('no such account')
    if (sandbox) r.sandbox = sandbox; else delete r.sandbox
    await this.persist()
  }

  async patchSandbox(accountId: string, patch: Partial<SandboxRecord>): Promise<SandboxRecord | undefined> {
    const r = this.rows.find((x) => x.id === accountId); if (!r?.sandbox) return undefined
    Object.assign(r.sandbox, patch)
    await this.persist()
    return structuredClone(r.sandbox)
  }

  // Writes are serialized: two requests patching lastSeenAt at once used to share one tmp
  // name, and the second rename failed with ENOENT (seen 2026-10-27 behind the proxy).
  private chain: Promise<void> = Promise.resolve()
  private persist(): Promise<void> {
    const snapshot = JSON.stringify(this.rows, null, 2) + '\n'
    const run = async () => {
      await mkdir(dirname(this.path), { recursive: true })
      const tmp = `${this.path}.${process.pid}.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}.tmp`
      await writeFile(tmp, snapshot, { mode: 0o600 })
      await rename(tmp, this.path)
    }
    this.chain = this.chain.then(run, run)
    return this.chain
  }
}
