// The app uses four type sizes, 28/17/15/13 (the owner's list of 2026-10-29: no more than four, none below 12).
// A letter in an avatar or a service mark took a share of its circle (size × 0.45, × 0.6), 15.3 or 22.8 points.
import { expect, test } from 'nsh/test'
import { letterSize } from './src/ui.tsx'

test('a letter in a circle takes one of the four type sizes', () => {
  for (const size of [18, 22, 32, 34, 38, 64, 72, 112]) expect([28, 17, 15, 13]).toContain(letterSize(size))
  expect(letterSize(34)).toBe(15)
  expect(letterSize(64)).toBe(28)
  expect(letterSize(18)).toBe(13)
})
