// Export and import of everything the assistant knows about the person, as one
// JSON file: memory files, goals, schedules, connectors (names only, never
// secrets). The person owns this; moving to another machine or another
// harness starts with this file.
import { readFile, writeFile, mkdir, open as openFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'

export interface MemoryBundle {
  format: 'deepseek-bot-memory/1'
  exportedAt: string
  assistantName?: string
  files: { 'SOUL.md': string; 'USER.md': string; 'MEMORY.md': string }
  goals: unknown[]
  schedules: unknown[]
  connectors: unknown[]
}

/** O_NOFOLLOW: a symlink planted in the workspace must not make the export read or the import write a bot file. */
const read = async (p: string): Promise<string> => {
  try {
    const fh = await openFile(p, constants.O_RDONLY | constants.O_NOFOLLOW)
    try { return await fh.readFile({ encoding: 'utf8' }) } finally { await fh.close() }
  } catch { return '' }
}

const write = async (p: string, body: string): Promise<boolean> => {
  try {
    const fh = await openFile(p, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600)
    try { await fh.writeFile(body, 'utf8'); return true } finally { await fh.close() }
  } catch { return false }
}
const readJson = async (p: string) => { try { return JSON.parse(await readFile(p, 'utf8')) as unknown[] } catch { return [] } }

export async function exportBundle(root: string, assistantName?: string): Promise<MemoryBundle> {
  const ws = join(root, 'workspace')
  return {
    format: 'deepseek-bot-memory/1',
    exportedAt: new Date().toISOString(),
    assistantName,
    files: { 'SOUL.md': await read(join(ws, 'SOUL.md')), 'USER.md': await read(join(ws, 'USER.md')), 'MEMORY.md': await read(join(ws, 'MEMORY.md')) },
    goals: await readJson(join(root, 'goals.json')),
    schedules: await readJson(join(root, 'schedules.json')),
    connectors: (await readJson(join(root, 'connectors.json'))).map((c) => { const { env, headers, ...rest } = (c ?? {}) as Record<string, unknown>; void env; void headers; return rest }),
  }
}

/** Merge a bundle in: memory lines are appended (deduplicated), goals and schedules added when their ids are new. Nothing is deleted. */
export async function importBundle(root: string, bundle: unknown): Promise<{ facts: number; goals: number; schedules: number }> {
  const b = bundle as Partial<MemoryBundle>
  if (!b || b.format !== 'deepseek-bot-memory/1' || !b.files) throw new Error('not a deepseek-bot memory file')
  const ws = join(root, 'workspace'); await mkdir(ws, { recursive: true })
  let facts = 0
  for (const name of ['USER.md', 'MEMORY.md'] as const) {
    const incoming = (b.files[name] ?? '').split('\n').filter((l) => l.startsWith('- '))
    const current = await read(join(ws, name))
    const have = new Set(current.split('\n').filter((l) => l.startsWith('- ')).map((l) => l.replace(/^- \d{4}-\d{2}-\d{2} (\[\w+\] )?/, '').toLowerCase()))
    const add = incoming.filter((l) => !have.has(l.replace(/^- \d{4}-\d{2}-\d{2} (\[\w+\] )?/, '').toLowerCase()))
    if (add.length && !(await write(join(ws, name), `${current.replace(/\s*$/, '')}\n${add.join('\n')}\n`))) throw new Error('the memory file is not writable')
    facts += add.length
  }
  if (b.files['SOUL.md'] && !(await read(join(ws, 'SOUL.md'))).trim() && !(await write(join(ws, 'SOUL.md'), b.files['SOUL.md']))) throw new Error('the memory file is not writable')
  const mergeList = async (file: string, rows: unknown[] | undefined) => {
    const current = await readJson(join(root, file)) as { id: string }[]
    const ids = new Set(current.map((r) => r.id))
    const add = (rows ?? []).filter((r) => r && typeof (r as { id?: unknown }).id === 'string' && !ids.has((r as { id: string }).id))
    if (add.length) await writeFile(join(root, file), JSON.stringify([...current, ...add], null, 2) + '\n', { mode: 0o600 })
    return add.length
  }
  return { facts, goals: await mergeList('goals.json', b.goals), schedules: await mergeList('schedules.json', b.schedules) }
}
