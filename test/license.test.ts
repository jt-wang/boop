import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// The README and the launch say MIT: the repository has to carry the licence itself.
test('the repository carries the MIT licence and says so in package.json', () => {
  const text = readFileSync(new URL('../LICENSE', import.meta.url), 'utf8')
  assert.match(text, /^MIT License\n/)
  assert.match(text, /Copyright \(c\) 2026 Jingtao Wang/)
  assert.match(text, /THE SOFTWARE IS PROVIDED "AS IS"/)
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { license?: string }
  assert.equal(pkg.license, 'MIT')
})
