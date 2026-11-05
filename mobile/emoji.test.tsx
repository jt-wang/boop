// What the assistant is doing is one emoji + a phrase, and your bubble gets a 👀 first.
// The text stand-ins (⌕ ✎ ⊙⊙) were for the iOS 26.3 simulator, whose Apple Color Emoji font does not load
// (Apple FB22206123); devices, iOS 17 simulators, Android, macOS and the web draw color emoji (measured 2026-10-27).
import { expect, test } from 'nsh/test'
import { ACK, emojiFor } from './src/chat.tsx'

test('each kind of step has its emoji', () => {
  expect(emojiFor('web_search')).toBe('🔎')
  expect(emojiFor('browser_navigate')).toBe('🔎')
  expect(emojiFor('write')).toBe('📝')
  expect(emojiFor('bash')).toBe('🛠️')
  expect(emojiFor('remember')).toBe('🧠')
  expect(emojiFor('schedule_create')).toBe('⏰')
  expect(emojiFor('goal_set')).toBe('🎯')
  expect(emojiFor('notify')).toBe('🔔')
  expect(emojiFor('something_else')).toBe('✨')
})

test('the acknowledgement under your bubble is 👀', () => {
  expect(ACK).toBe('👀')
})
