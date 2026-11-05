// The Library: everything the assistant makes or works on, viewable from the
// phone. Lists the workspace (`~/.deepseek-bot/workspace`) minus the memory
// files and dotfiles, reads one file, deletes one file, and remembers the
// files the assistant declared with DSH's `present` tool.
//
// `present` lands in the session journal as a durable `deliverables/presented`
// event: `{ turn, callId, files: [{ path, description? }] }`, relative paths
// against the session cwd (DSH 0.2.0-rc.2, node_modules/@deepseek-ai/dsh-tool-present/lib/index.js:116).
// `follow()` opens `session/follow` and picks those events out of the snapshot
// and the live stream.
import { readdir, stat, lstat, realpath, readFile, unlink, open as openFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { join, resolve, relative, sep, isAbsolute, extname, basename } from 'node:path'
import { Mux, sessionAddress, type DshTarget } from './dshclient.ts'

export type FileKind = 'text' | 'image' | 'binary'

export interface LibraryEntry {
  /** Workspace-relative path; absolute for a presented file outside the workspace. */
  path: string
  size: number
  /** ms since epoch */
  mtime: number
  kind: FileKind
  /** From the assistant's `present` call, when it made one. */
  description?: string
}

export interface LibraryFile { kind: FileKind; mime: string; bytes: Buffer; size: number; truncated: boolean }

export interface PresentedFile { path: string; description?: string }

const MEMORY_FILES = new Set(['SOUL.md', 'USER.md', 'MEMORY.md'])
const TEXT_LIMIT = 1 << 20
const LIST_CAP = 500
const TEXT_EXT: Record<string, string> = {
  '.md': 'text/markdown', '.markdown': 'text/markdown', '.txt': 'text/plain', '.csv': 'text/csv', '.tsv': 'text/tab-separated-values', '.log': 'text/plain',
  '.json': 'application/json', '.yml': 'text/yaml', '.yaml': 'text/yaml', '.toml': 'text/plain', '.ini': 'text/plain', '.xml': 'text/xml',
  '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.ts': 'text/plain', '.tsx': 'text/plain', '.jsx': 'text/plain',
  '.py': 'text/x-python', '.rb': 'text/plain', '.sh': 'text/x-shellscript', '.go': 'text/plain', '.rs': 'text/plain', '.java': 'text/plain', '.c': 'text/plain', '.h': 'text/plain', '.cpp': 'text/plain', '.sql': 'text/plain', '.svg': 'image/svg+xml',
}
const IMAGE_EXT: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.heic': 'image/heic', '.bmp': 'image/bmp' }
const BINARY_EXT: Record<string, string> = { '.pdf': 'application/pdf', '.zip': 'application/zip', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation', '.mp3': 'audio/mpeg', '.mp4': 'video/mp4', '.wav': 'audio/wav' }

/** Kind and mime from the extension; unknown extensions are sniffed (a NUL in the first 8 KiB means binary). */
async function classify(file: string): Promise<{ kind: FileKind; mime: string }> {
  const ext = extname(file).toLowerCase()
  if (ext === '.svg') return { kind: 'image', mime: 'image/svg+xml' }
  if (IMAGE_EXT[ext]) return { kind: 'image', mime: IMAGE_EXT[ext] }
  if (TEXT_EXT[ext]) return { kind: 'text', mime: `${TEXT_EXT[ext]}; charset=utf-8` }
  if (BINARY_EXT[ext]) return { kind: 'binary', mime: BINARY_EXT[ext] }
  try {
    const fh = await openFile(file, 'r')
    try {
      const buf = Buffer.alloc(8192)
      const { bytesRead } = await fh.read(buf, 0, 8192, 0)
      return buf.subarray(0, bytesRead).includes(0) ? { kind: 'binary', mime: 'application/octet-stream' } : { kind: 'text', mime: 'text/plain; charset=utf-8' }
    } finally { await fh.close() }
  } catch { return { kind: 'binary', mime: 'application/octet-stream' } }
}

export class Library {
  readonly workspace: string
  private readonly workspaceReal: string
  /** Absolute path → description, for files the assistant presented. */
  private readonly presented = new Map<string, string | undefined>()
  private readonly follows = new Map<string, { mux: Mux; cancel(): void }>()
  /** Test/observability hook: called with absolute paths after each `present`. */
  onPresented: ((files: PresentedFile[]) => void) | null = null

  constructor(workspace: string) { this.workspace = resolve(workspace); try { this.workspaceReal = realpathSync(this.workspace) } catch { this.workspaceReal = this.workspace } }

  /** Absolute path for a request, or null when it points outside the workspace, at a dotfile or a memory file. Presented files outside the workspace pass by exact path. */
  resolve(path: string): string | null {
    if (!path || path.includes('\0')) return null
    if (isAbsolute(path)) {
      const abs = resolve(path)
      if (this.presented.has(abs) && !this.inside(abs)) return abs
      if (!this.inside(abs)) return null
      return this.check(abs)
    }
    return this.check(resolve(this.workspace, path))
  }
  private inside(abs: string) { const rel = relative(this.workspace, abs); return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) }
  private within(root: string, abs: string) { const rel = relative(root, abs); return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) }
  /** Resolve through symlinks; a path that leaves the workspace is refused, even when the lexical path is inside. */
  private async safe(abs: string): Promise<string | null> {
    try { if ((await lstat(abs)).isSymbolicLink()) return null } catch { return null }
    if (this.inside(abs)) {
      const real = await realpath(abs).catch(() => null)
      return real && this.within(this.workspaceReal, real) ? real : null
    }
    return this.presented.has(abs) ? abs : null
  }
  private check(abs: string): string | null {
    if (!this.inside(abs)) return null
    const parts = relative(this.workspace, abs).split(sep)
    if (parts.some((p) => p.startsWith('.'))) return null
    if (parts.length === 1 && MEMORY_FILES.has(parts[0])) return null
    return abs
  }
  private display(abs: string) { return this.inside(abs) ? relative(this.workspace, abs).split(sep).join('/') : abs }

  async list(): Promise<LibraryEntry[]> {
    const out: LibraryEntry[] = []
    const walk = async (dir: string): Promise<void> => {
      let names: import('node:fs').Dirent[]
      try { names = await readdir(dir, { withFileTypes: true }) } catch { return }
      names.sort((a, b) => a.name.localeCompare(b.name))
      for (const d of names) {
        if (out.length >= LIST_CAP) return
        if (d.name.startsWith('.')) continue
        const abs = join(dir, d.name)
        if (d.isDirectory()) { await walk(abs); continue }
        if (!d.isFile()) continue
        if (dir === this.workspace && MEMORY_FILES.has(d.name)) continue
        const entry = await this.entry(abs); if (entry) out.push(entry)
      }
    }
    await walk(this.workspace)
    for (const abs of this.presented.keys()) {
      if (this.inside(abs) || out.length >= LIST_CAP) continue
      const entry = await this.entry(abs); if (entry) out.push(entry)
    }
    return out
  }
  private async entry(abs: string): Promise<LibraryEntry | null> {
    try {
      const s = await lstat(abs); if (!s.isFile()) return null
      const { kind } = await classify(abs)
      const e: LibraryEntry = { path: this.display(abs), size: s.size, mtime: s.mtimeMs, kind }
      if (this.presented.has(abs)) { const d = this.presented.get(abs); if (d) e.description = d; else e.description = basename(abs) }
      return e
    } catch { return null }
  }

  /** Text is cut at 1 MiB (`truncated`); images and other binaries come whole. Null when missing or not allowed. */
  async read(path: string): Promise<LibraryFile | null> {
    const abs = this.resolve(path); if (!abs) return null
    const real = await this.safe(abs); if (!real) return null
    try {
      const s = await stat(real); if (!s.isFile()) return null
      const { kind, mime } = await classify(real)
      if (kind === 'text' && s.size > TEXT_LIMIT) {
        const fh = await openFile(real, 'r')
        try { const buf = Buffer.alloc(TEXT_LIMIT); const { bytesRead } = await fh.read(buf, 0, TEXT_LIMIT, 0); return { kind, mime, bytes: buf.subarray(0, bytesRead), size: s.size, truncated: true } } finally { await fh.close() }
      }
      return { kind, mime, bytes: await readFile(real), size: s.size, truncated: false }
    } catch { return null }
  }

  async remove(path: string): Promise<boolean> {
    const abs = this.resolve(path); if (!abs) return false
    if (!(await this.safe(abs))) return false
    try { await unlink(abs); this.presented.delete(abs); return true } catch { return false }
  }

  /** Record one `present` call. Relative paths resolve against the session cwd (the workspace when unknown). */
  notePresented(files: PresentedFile[], cwd: string = this.workspace) {
    const noted: PresentedFile[] = []
    for (const f of files) {
      if (!f || typeof f.path !== 'string' || !f.path.trim()) continue
      const abs = resolve(cwd, f.path)
      this.presented.set(abs, typeof f.description === 'string' && f.description.trim() ? f.description.trim() : undefined)
      noted.push({ path: abs, description: f.description })
    }
    if (noted.length) this.onPresented?.(noted)
  }

  /** Follow one session's journal for `deliverables/presented`. Idempotent per session; keeps at most 8 follows. */
  follow(dsh: DshTarget, sessionId: string) {
    if (this.follows.has(sessionId)) return
    if (this.follows.size >= 8) { const [oldest] = this.follows.keys(); this.stopFollow(oldest) }
    const mux = new Mux(dsh)
    const handle = { mux, cancel: () => {} }
    this.follows.set(sessionId, handle)
    mux.ws.on('error', () => this.stopFollow(sessionId))
    mux.ws.on('close', () => { if (this.follows.get(sessionId) === handle) this.follows.delete(sessionId) })
    ;(async () => {
      const stream = await mux.open('session/follow', { request: { address: sessionAddress(sessionId), maxMessages: 500 } })
      handle.cancel = () => stream.cancel()
      let cwd = this.workspace
      type Ev = { type: string; data?: { files?: PresentedFile[] } }
      const take = (ev: Ev | undefined) => { if (ev?.type === 'deliverables/presented' && Array.isArray(ev.data?.files)) this.notePresented(ev.data!.files, cwd) }
      for await (const item of stream) {
        const v = item as { type: string; header?: { cwd?: string }; records?: { type: string; event?: Ev }[]; event?: Ev }
        if (v.type === 'snapshot') { if (v.header?.cwd) cwd = v.header.cwd; for (const r of v.records ?? []) if (r.type === 'event') take(r.event) }
        else if (v.type === 'event') take(v.event)
      }
    })().catch(() => {}).finally(() => { if (this.follows.get(sessionId) === handle) this.follows.delete(sessionId) })
  }
  private stopFollow(sessionId: string) {
    const h = this.follows.get(sessionId); if (!h) return
    this.follows.delete(sessionId)
    try { h.cancel() } catch {}
    h.mux.close()
  }
  close() { for (const id of [...this.follows.keys()]) this.stopFollow(id) }
}
