// A tapped notification opens the place it is about: the shell hands the app its `url`,
// as `host.params.notificationUrl` when the tap launched the app and as the `notification` event while it runs
// (ios/DeepSeekBot/PushBridge.swift, android/…/PushBridge.java). The bot's urls: /threads/<id>,
// /threads/<id>/asks/<event>, /discover (src/push-text.ts).
import { expect, open, test } from 'nsh/test'

const ORIGIN = 'http://127.0.0.1:3850'
const TOKEN = 'tok_abcdefghijklmnopqrstuvwxyz0123456789'
const AT = 1700000000000
const meBody = { device: { id: 'd1', name: 'Pixel' }, assistant: { name: 'Nori' }, mainSessionId: 'main', connected: true, pushPublicKey: null }
const threads = [
  { sessionId: 'main', title: '', updatedAt: AT, running: false, blank: false },
  { sessionId: 'side-1', title: 'Trip', updatedAt: AT, running: false, blank: false },
]
// what this phone kept of each thread last time (state.ts `thread:<id>`): the thread the app follows shows it at once
const kept = {
  'thread:main': JSON.stringify([{ kind: 'them', id: 'm1', text: 'Words in the main thread.', at: AT }]),
  'thread:side-1': JSON.stringify([{ kind: 'them', id: 's1', text: 'Words in the side thread.', at: AT }]),
}
const network = {
  [`GET ${ORIGIN}/me`]: { body: meBody },
  [`GET ${ORIGIN}/threads`]: { body: threads },
  [`POST ${ORIGIN}/ws-ticket`]: { body: { ticket: 't' } },
  [`POST ${ORIGIN}/push/subscribe`]: { body: { ok: true } },
  [`GET ${ORIGIN}/goals`]: { body: [] }, [`GET ${ORIGIN}/schedules`]: { body: [] }, [`GET ${ORIGIN}/activity`]: { body: [] }, [`GET ${ORIGIN}/ideas`]: { body: [] },
}
const storage = { origin: ORIGIN, token: TOKEN, me: JSON.stringify(meBody), ...kept }
const until = async (ok: () => boolean, timeout = 5000) => { const end = Date.now() + timeout; while (!ok()) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 20)) } }

test('a tap while the app runs on another page: back to the chat, on the thread the notification is about', async () => {
  const app = await open('./App.tsx', { storage, network, host: { handlers: { 'push.request': { granted: false } } } })
  await app.waitFor('text:Words in the main thread.')
  await app.press('label:Settings')
  await app.waitFor('id:composer', { state: 'gone' })
  await app.host.send('notification', { url: '/threads/side-1/asks/q-1' })
  await app.waitFor('text:Words in the side thread.')
  await app.waitFor('id:composer')
  expect(app.shows('text:Words in the main thread.')).toBe(false)
})

test('a tap that launched the app: it opens on that thread, not the main one', async () => {
  const app = await open('./App.tsx', { storage, network, host: { params: { notificationUrl: '/threads/side-1' }, handlers: { 'push.request': { granted: false } } } })
  await app.waitFor('text:Words in the side thread.')
  await app.wait(500) // the main thread opens after /me answers; it must not take the screen back
  expect(app.shows('text:Words in the side thread.')).toBe(true)
  expect(app.shows('text:Words in the main thread.')).toBe(false)
})

test('the morning ideas open Discover', async () => {
  const app = await open('./App.tsx', { storage, network, host: { handlers: { 'push.request': { granted: false } } } })
  await app.waitFor('id:composer')
  await app.host.send('notification', { url: '/discover' })
  await app.waitFor('id:composer', { state: 'gone' })
  await app.waitFor('id:tab-discover-content')
})

test('on Android the shell’s token is an FCM one: the app posts { kind: "fcm", token }', async () => {
  const fcm = 'eE2e_fcm:APA91b' + 'Z'.repeat(140)
  const app = await open('./App.tsx', { storage, network, platform: 'android', host: { handlers: { 'push.request': { granted: true }, 'push.token': { token: fcm, kind: 'fcm' } } } })
  await app.waitFor('text:Words in the main thread.')
  await until(() => app.requests().some((r) => r.url.endsWith('/push/subscribe')))
  const posted = app.requests().find((r) => r.url.endsWith('/push/subscribe'))!
  expect(JSON.parse(String(posted.body))).toEqual({ kind: 'fcm', token: fcm })
})

test('in the browser a tap that opened a new window arrives through launch.params (web/sw.js opens /?open=<url>)', async () => {
  const app = await open('./App.tsx', { storage, network, platform: 'web', host: { handlers: { 'launch.params': { notificationUrl: '/threads/side-1' }, 'push.request': { granted: false } } } })
  await app.waitFor('text:Words in the side thread.')
  await app.wait(500)
  expect(app.shows('text:Words in the main thread.')).toBe(false)
})
