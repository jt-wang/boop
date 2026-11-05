// Memory is two Markdown files the person can read: USER.md (who they are)
// and MEMORY.md (what to keep). One fact per line, dated. Facts are data
// about the person, never instructions — the AGENTS.md prompt says so.
import { open } from 'node:fs/promises'
import { constants } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

export type MemoryFile = 'user' | 'memory'
export type MemoryKind = 'preference' | 'fact' | 'decision' | 'project' | 'person'
export interface MemoryItem { id: string; file: MemoryFile; kind: MemoryKind; text: string; date: string }

const LINE = /^- (\d{4}-\d{2}-\d{2}) (?:\[(preference|fact|decision|project|person)\] )?(.*)$/
const KINDS: MemoryKind[] = ['preference', 'fact', 'decision', 'project', 'person']
/** Who the person is → USER.md; what to keep (decisions, waits, people) → MEMORY.md. A kind both files hold stays where it is. */
const fileOf = (kind: MemoryKind, current: MemoryFile): MemoryFile => (kind === 'preference' || kind === 'fact' ? 'user' : kind === 'person' ? current : 'memory')
const idOf = (file: MemoryFile, text: string) => `${file}:${createHash('sha1').update(text.trim().toLowerCase()).digest('hex').slice(0, 12)}`

/** YYYY-MM-DD of `d` in `zone`; the process's own zone when there is none or it is unknown. */
function dayIn(d: Date, zone: string | null): string {
  try { if (zone) return new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d) } catch {}
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export class Memory {
  private readonly workspace: string
  private readonly zone: () => string | null
  private readonly now: () => Date
  /** `zone`: the person's time zone, so a line is dated with their day (the bot's own clock can be in UTC). */
  constructor(workspace: string, o: { zone?: () => string | null; now?: () => Date } = {}) { this.workspace = workspace; this.zone = o.zone ?? (() => null); this.now = o.now ?? (() => new Date()) }
  private path(f: MemoryFile) { return join(this.workspace, f === 'user' ? 'USER.md' : 'MEMORY.md') }

  /** O_NOFOLLOW: a symlink planted in the workspace must not make the bot read or write a file outside it. */
  private async readText(f: MemoryFile): Promise<string> {
    try {
      const fh = await open(this.path(f), constants.O_RDONLY | constants.O_NOFOLLOW)
      try { return await fh.readFile({ encoding: 'utf8' }) } finally { await fh.close() }
    } catch { return '' }
  }

  private async writeText(f: MemoryFile, text: string): Promise<boolean> {
    try {
      const fh = await open(this.path(f), constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600)
      try { await fh.writeFile(text, 'utf8'); return true } finally { await fh.close() }
    } catch { return false }
  }

  async read(f: MemoryFile) { return this.readText(f) }

  /** Append one fact; returns false when an identical line already exists. */
  async remember(f: MemoryFile, fact: string, kind?: MemoryKind): Promise<boolean> {
    const line = fact.replace(/\s+/g, ' ').trim()
    if (!line) return false
    const existing = (await this.items()).map((i) => i.text.toLowerCase())
    if (existing.includes(line.toLowerCase())) return false
    const text = await this.read(f)
    const date = dayIn(this.now(), this.zone())
    const k = kind ?? (f === 'user' ? 'fact' : 'decision')
    return this.writeText(f, `${text.replace(/\s*$/, '')}\n- ${date} [${k}] ${line}\n`)
  }

  /** Every remembered item across both files, oldest first, with stable ids for the app. */
  async items(): Promise<MemoryItem[]> {
    const out: MemoryItem[] = []
    for (const f of ['user', 'memory'] as MemoryFile[]) {
      for (const l of (await this.read(f)).split('\n')) {
        const m = LINE.exec(l); if (!m) continue
        const kind = (m[2] as MemoryKind | undefined) ?? (f === 'user' ? 'fact' : 'decision')
        out.push({ id: idOf(f, m[3]), file: f, kind, text: m[3].trim(), date: m[1] })
      }
    }
    return out
  }

  /** Remove one item by id; returns the removed text or null. */
  async forgetById(id: string): Promise<string | null> {
    for (const f of ['user', 'memory'] as MemoryFile[]) {
      const lines = (await this.read(f)).split('\n')
      const i = lines.findIndex((l) => { const m = LINE.exec(l); return m && idOf(f, m[3]) === id })
      if (i >= 0) { const [removed] = lines.splice(i, 1); if (!(await this.writeText(f, lines.join('\n')))) return null; return LINE.exec(removed)![3] }
    }
    return null
  }

  /**
   * The person corrects one item from the app (PATCH /memory/:id): new words, a new group, or both.
   * The line keeps its date and place; a kind that belongs to the other file moves it there.
   * Returns the updated item (its id follows the text), null for an unknown id; throws on an empty
   * text, a text another line already has, or an unknown kind.
   */
  async update(id: string, patch: { text?: string; kind?: MemoryKind }): Promise<MemoryItem | null> {
    if (patch.kind !== undefined && !KINDS.includes(patch.kind)) throw new Error('unknown kind')
    const items = await this.items()
    const it = items.find((i) => i.id === id)
    if (!it) return null
    const text = patch.text === undefined ? it.text : patch.text.replace(/\s+/g, ' ').trim()
    if (!text) throw new Error('empty text')
    if (items.some((i) => i.id !== id && i.text.toLowerCase() === text.toLowerCase())) throw new Error('already remembered')
    const kind = patch.kind ?? it.kind
    const target = fileOf(kind, it.file)
    const line = `- ${it.date} [${kind}] ${text}`
    const lines = (await this.read(it.file)).split('\n')
    const i = lines.findIndex((l) => { const m = LINE.exec(l); return m && idOf(it.file, m[3]) === id })
    if (target === it.file) lines[i] = line
    else {
      lines.splice(i, 1)
      const other = await this.read(target)
      if (!(await this.writeText(target, `${other.replace(/\s*$/, '')}\n${line}\n`))) throw new Error('the memory file is not writable')
    }
    if (!(await this.writeText(it.file, lines.join('\n')))) throw new Error('the memory file is not writable')
    return { id: idOf(target, text), file: target, kind, text, date: it.date }
  }

  /** Remove every fact line containing the query (case-insensitive); returns the removed lines. */
  async forget(query: string): Promise<string[]> {
    const q = query.trim().toLowerCase()
    if (!q) return []
    const removed: string[] = []
    for (const f of ['user', 'memory'] as MemoryFile[]) {
      const text = await this.read(f)
      const kept = text.split('\n').filter((l) => { const m = LINE.exec(l); const hit = Boolean(m && m[3].toLowerCase().includes(q)); if (hit) removed.push(m![3]); return !hit })
      if (removed.length) await this.writeText(f, kept.join('\n'))
    }
    return removed
  }

  /** Fact lines only (no headings), newest last. */
  async facts(f: MemoryFile): Promise<string[]> {
    return (await this.items()).filter((i) => i.file === f).map((i) => i.text)
  }
}
