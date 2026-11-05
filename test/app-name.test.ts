// The name under the icon and in iOS's "◀ back to app" label is the product's name. The iOS shell's Info.plist
// still said "DeepSeek Bot" after the rename to Boop (QA, iOS, 2026-10-30); Android takes it from mobile/nsh.json.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

test('the iOS shell shows the name in mobile/nsh.json', () => {
  const name = JSON.parse(readFileSync('mobile/nsh.json', 'utf8')).name
  const plist = readFileSync('ios/DeepSeekBot/Info.plist', 'utf8')
  assert.equal(/<key>CFBundleDisplayName<\/key>\s*<string>([^<]*)<\/string>/.exec(plist)?.[1], name)
  assert.doesNotMatch(plist, /DeepSeek Bot/)
})
