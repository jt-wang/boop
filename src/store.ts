// A JSON file holding a list of rows, written atomically. Small, single-process.
import { readFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { writeAtomic } from './atomic.ts'

export class JsonList<T extends { id: string }> {
  private rows: T[] = []
  private readonly path: string
  private constructor(path: string) { this.path = path }

  static async open<T extends { id: string }>(path: string) {
    const s = new JsonList<T>(path)
    try { s.rows = JSON.parse(await readFile(path, 'utf8')) } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
    return s
  }

  all(): T[] { return this.rows.map((r) => ({ ...r })) }
  get(id: string): T | undefined { const r = this.rows.find((x) => x.id === id); return r && { ...r } }
  async insert(row: Omit<T, 'id'> & { id?: string }): Promise<T> {
    const full = { ...row, id: row.id ?? randomBytes(6).toString('hex') } as T
    this.rows.push(full); await this.persist(); return { ...full }
  }
  async update(id: string, patch: Partial<T>): Promise<T | undefined> {
    const r = this.rows.find((x) => x.id === id); if (!r) return undefined
    Object.assign(r, patch); await this.persist(); return { ...r }
  }
  async remove(id: string): Promise<boolean> {
    const n = this.rows.length; this.rows = this.rows.filter((x) => x.id !== id)
    if (this.rows.length !== n) await this.persist()
    return this.rows.length !== n
  }
  private async persist() {
    await writeAtomic(this.path, () => JSON.stringify(this.rows, null, 2) + '\n')
  }
}
