// A small startup log a non-developer can send us. NSH's fs/promises has `writeFile`, not
// `appendFile` (windows/.nsh/types/fs/promises.d.ts), so each line rewrites a bounded
// snapshot; writes are serialized so an older snapshot cannot overwrite a newer one.
// Logging must never stop the app: every failure here is swallowed.
import process from 'process'
import { mkdir, writeFile } from 'fs/promises'

const MAX_LINES = 400
const lines: string[] = []
let path = ''
let ready = false
let queue: Promise<void> = Promise.resolve()

function flush(): void {
  if (!ready || !path) return
  const text = `${lines.join('\n')}\n`
  queue = queue.then(() => writeFile(path, text)).catch(() => {})
}

/** Put the log next to the bot's home (or in the app's data directory). Returns the path used. */
export async function initLog(home: string): Promise<string> {
  const dir = home || process.dataDir || ''
  if (!dir) return ''
  path = `${dir}${/[\\/]$/.test(dir) ? '' : '\\'}boop-start.log`
  try {
    await mkdir(dir, { recursive: true })
    ready = true
    flush()
  } catch { /* no log is better than a broken app */ }
  return path
}

/** Timestamped line, never a secret: paths, env names/values used, errors, child output. */
export function log(line: string): void {
  lines.push(`${new Date().toISOString()} ${line}`)
  if (lines.length > MAX_LINES) lines.shift()
  flush()
}
