// Write a JSON or text file so that a reader sees the old content or the new, never half of either: write a temp
// file next to it, then rename it over. Writes to one path go one at a time, and each takes its content when its
// turn comes, so the newest value lands last. A shared temp name (`<path>.<pid>.tmp`) broke when two requests saved
// at once: the first rename took the temp file, the second found none (ENOENT, 2026-11-01).
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { dirname } from 'node:path'

const queues = new Map<string, Promise<unknown>>()

export function writeAtomic(path: string, content: () => string | Promise<string>, mode = 0o600): Promise<void> {
  const write = (queues.get(path) ?? Promise.resolve()).catch(() => undefined).then(async () => {
    await mkdir(dirname(path), { recursive: true })
    const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
    try {
      await writeFile(tmp, await content(), { mode })
      await rename(tmp, path)
    } catch (e) { await rm(tmp, { force: true }); throw e }
  })
  queues.set(path, write)
  write.then(() => { if (queues.get(path) === write) queues.delete(path) }, () => { if (queues.get(path) === write) queues.delete(path) })
  return write
}
