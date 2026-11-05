// The system header of pushed pages (Menu, Discover, Settings…) follows the app's theme in both schemes.
// Android's toolbar is drawn opaque in the color the app gives it, so it takes the grouped page's background
// (Material 3's top app bar sits on the surface it scrolls over); white in dark mode was the bug (2026-10-27).
// iOS keeps UIKit's own bar background (transparent at the scroll edge, the system material once content scrolls
// under it), which already follows the scheme; both get the foreground for the title and the back button.
import { expect, test } from 'nsh/test'
import { systemHeaderClass, underBarClass } from './src/ui.tsx'

test('Android: the header takes the page background and foreground in light and dark', () => {
  const c = systemHeaderClass('android').split(' ')
  expect(c).toContain('bg-card')
  expect(c).toContain('dark:bg-background')
  expect(c).toContain('text-foreground')
  expect(c).toContain('tint-foreground')
})

test('iOS: the system bar keeps its own material; title and buttons in the foreground', () => {
  const c = systemHeaderClass('ios').split(' ')
  expect(c.some((x) => x.includes('bg-'))).toBe(false)
  expect(c).toContain('text-foreground')
  expect(c).toContain('tint-foreground')
})

// The profile and Discover are plain white (black in dark) pages; the grouped grey there was a band across the top.
test('Android: a plain page gets a header in its own background', () => {
  const c = systemHeaderClass('android', 'plain').split(' ')
  expect(c).toContain('bg-background')
  expect(c.some((x) => x.includes('bg-card'))).toBe(false)
  expect(c).toContain('tint-foreground')
  expect(systemHeaderClass('ios', 'plain')).toBe(systemHeaderClass('ios'))
})

// The strip under the tab bar showed the app's root background under grouped pages, a lighter band across the bottom in
// light mode (iOS simulator, 2026-10-30, Library). It takes the background of the page above it.
test('the strip under the tab bar takes the background of the page above it', () => {
  expect(underBarClass('library')).toBe('bg-card dark:bg-background')
  expect(underBarClass('menu')).toBe('bg-card dark:bg-background')
  for (const plain of ['chat', 'discover', 'profile']) expect(underBarClass(plain)).toBe('bg-background')
})
