// The system tab bar's icons by the platform's name for them (nsh/mobile TabBarItem.icon): SF Symbols on iOS,
// drawables on Android. The Android shell (android/) ships its own black-and-white drawables, tab_chat and
// tab_discover (android/app/src/main/res/drawable-*), which NSH's TabBar tints. The system's own (a chat bubble and a
// phone dialer) stood in while the APK came from `nsh package`, which packages no app drawables.
import { expect, test } from 'nsh/test'
import { systemTabBarStyle, tabIcons } from './src/ui.tsx'

test('iOS gets SF Symbols; Android gets the shell\'s own drawables', () => {
  expect(tabIcons('ios')).toEqual(['message', 'square.grid.2x2'])
  expect(tabIcons('android')).toEqual(['tab_chat', 'tab_discover'])
})

// QA 2026-10-28 #17: on iOS the Discover tab came up without its label. NSH's bar fills its host, which has no height
// until the bar reports one, and items set while the bar is 0 tall keep no label on a tab that is not selected
// (iOS 26.3 simulator: 4 of 4 bars right after naming the assistant). A height from the first layout avoids it; the
// device check is ios/DeepSeekBotUITests/TabBarTests.swift testDiscoverKeepsItsLabel.
test('the iOS system tab bar has a height from its first layout; Android keeps the system\'s', () => {
  expect(systemTabBarStyle('ios', 34)).toEqual({ height: 83 })
  expect(systemTabBarStyle('ios', 0)).toEqual({ height: 49 })
  expect(systemTabBarStyle('android', 24)).toBe(undefined)
})
