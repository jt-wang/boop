// QA 2026-10-28: a text a little longer than one line lost its end on both phones (the age
// screen's terms on Android, the Interfaces footer on iOS and Android). NSH 0.3.0 breaks a Text's lines at its full width,
// ignoring the Text's own horizontal padding, then draws it inside the padding: one line was laid out, two were needed,
// and the second was cut (measured on the iOS 26.3 simulator, mobile/textfit: the same string wraps in a padded View and
// is cut with "…" when the padding is on the Text). Horizontal padding goes on a View around the Text.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const dirs = ['mobile', 'mobile/src']
test('no Text in the app carries its own horizontal padding (NSH ignores it when breaking lines)', () => {
  const bad: string[] = []
  for (const d of dirs) for (const f of readdirSync(d).filter((x) => x.endsWith('.tsx') && !x.includes('.test.') && !x.includes('.local.'))) {
    readFileSync(join(d, f), 'utf8').split('\n').forEach((line, i) => {
      for (const m of line.matchAll(/<Text\b[^>]*?class=["{`]+([^"`}]*)/g)) if (/(^|\s)(dark:)?p[xlr]-/.test(m[1])) bad.push(`${d}/${f}:${i + 1}`)
    })
  }
  assert.deepEqual(bad, [])
})
