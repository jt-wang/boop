// The sandbox image prunes packages DSH's web profile does not load. It once pruned `openai`, which DSH's
// OpenAI-compatible model adapter imports for every model the bot can use (the DeepSeek API and any
// OpenAI-compatible gateway): every turn in a hosted sandbox then ended with "Cannot find package 'openai'"
// (2026-10-27, test/hosted.e2e.test.ts). This keeps the prune list away from what that adapter imports.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Bare package names a module imports statically (`from "pkg"` / `from "@scope/pkg/sub"`). */
function packagesImportedBy(file: string): string[] {
  const src = readFileSync(file, 'utf8')
  const names = new Set<string>()
  for (const m of src.matchAll(/\bfrom\s+["']([^"'.][^"']*)["']/g)) {
    const spec = m[1]
    if (spec.startsWith('node:')) continue
    names.add(spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0])
  }
  return [...names]
}

/** The node_modules paths the Dockerfile's dependency stage deletes. */
function prunedPaths(): string[] {
  const dockerfile = readFileSync('Dockerfile', 'utf8')
  const rm = /rm -rf ([^&]+?)\s*&&\s*npm cache clean/s.exec(dockerfile)
  assert.ok(rm, 'the Dockerfile has its prune step')
  return rm[1].split(/\s+/).filter((p) => p.startsWith('node_modules/'))
}

const isPruned = (pkg: string, pruned: string[]) =>
  pruned.some((p) => {
    const re = new RegExp('^node_modules/' + p.slice('node_modules/'.length).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$')
    return re.test(`node_modules/${pkg}`) || pkg.startsWith(p.slice('node_modules/'.length) + '/')
  })

// It also pruned `node_modules/@img`, sharp's native builds, as an SDK no model loads. DSH's `read_image`
// (dsh-tool-fs) stores the image through dsh-attachment-local, which loads sharp on first use; sharp loads
// `@img/sharp-<platform>/sharp.node`, which links `@img/sharp-libvips-<platform>`. In the hosted sandbox every
// read_image then failed with "Could not load the sharp module".
test('the sandbox image keeps sharp and its Linux builds, which read_image loads', () => {
  const store = readFileSync(join(process.cwd(), 'node_modules/@deepseek-ai/dsh-attachment-local/lib/index.js'), 'utf8')
  assert.match(store, /createLazyRequire\("sharp"/, 'the attachment store still loads sharp')
  const loader = readFileSync(join(process.cwd(), 'node_modules/sharp/dist/sharp.cjs'), 'utf8')
  const deps = Object.keys((JSON.parse(readFileSync(join(process.cwd(), 'node_modules/sharp/package.json'), 'utf8')) as { dependencies?: Record<string, string> }).dependencies ?? {})
  assert.ok(deps.includes('@img/colour'), `sharp's dependencies were read: ${deps.join(', ')}`)
  const needed = ['sharp', ...deps]
  for (const arch of ['x64', 'arm64']) {
    assert.ok(loader.includes(`@img/sharp-linux-${arch}/sharp.node`), `sharp loads its linux-${arch} build`)
    needed.push(`@img/sharp-linux-${arch}`, `@img/sharp-libvips-linux-${arch}`)
  }
  const pruned = prunedPaths()
  assert.deepEqual(needed.filter((p) => isPruned(p, pruned)), [], 'pruned but loaded by read_image')
})

test('the sandbox image keeps every package the OpenAI-compatible model adapter imports', () => {
  // npm hoists DSH's model layer to the top of node_modules (its package.json is not exported, so no resolve)
  const adapter = join(process.cwd(), 'node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js')
  const imported = packagesImportedBy(adapter)
  assert.ok(imported.includes('openai'), `the adapter's imports were read: ${imported.join(', ')}`)
  const pruned = prunedPaths()
  const missing = imported.filter((p) => isPruned(p, pruned))
  assert.deepEqual(missing, [], `pruned but imported by ${adapter}`)
})
