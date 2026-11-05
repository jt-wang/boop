// The fingerprint of the sources the browser build (app/) is made from: every file under mobile/ that goes into the
// app (App.tsx, nsh.json, src/, assets/, web/), not its tests, fixtures or harnesses. scripts/build-web.sh writes it to
// app/source.sha256; test/app-fresh.test.ts fails when mobile/ changed and app/ was not rebuilt.
// Usage: node scripts/app-source-hash.ts   → prints the hash
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const MOBILE = join(ROOT, 'mobile')
const PARTS = ['App.tsx', 'nsh.json', 'src', 'assets', 'web']
const NOT_APP = /\.(test|fixture|harness)\.tsx?$/

function files(path: string): string[] {
  let st
  try { st = statSync(path) } catch { return [] }
  if (st.isFile()) return NOT_APP.test(path) ? [] : [path]
  return readdirSync(path).filter((n) => !n.startsWith('.')).flatMap((n) => files(join(path, n)))
}

export function appSourceHash(mobile = MOBILE): string {
  const h = createHash('sha256')
  const all = PARTS.flatMap((p) => files(join(mobile, p))).map((f) => relative(mobile, f).split(sep).join('/')).sort()
  for (const f of all) { h.update(f); h.update('\0'); h.update(readFileSync(join(mobile, f))); h.update('\0') }
  return h.digest('hex')
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) console.log(appSourceHash())
