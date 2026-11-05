import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
const row = (title: RegExp) => readme.split('\n').find((l) => title.test(l)) ?? ''

// The public APK carries no Firebase config, and a phone app built without one gets no notifications (docs/push.md).
test('a reminder is promised as a message in the chat, with no notification', () => {
  const reminders = row(/^\| Reminders and checks \|/)
  assert.match(reminders, /arrives as a message in the chat/)
  assert.doesNotMatch(reminders, /notification/i)
})

test('notifications say the phone apps need your own Firebase or APNs setup, and link how', () => {
  const notifications = row(/^\| Notifications/)
  assert.match(notifications, /phone apps need your own Firebase or APNs setup/)
  assert.match(notifications, /\(docs\/push\.md\)/)
})
