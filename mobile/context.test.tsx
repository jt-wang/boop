// What the phone tells the bot about the person (PUT /me/context, and the zone with each message): its language
// from NSH's `locale()` (a BCP 47 tag the platform gives, Android included) and its time zone only when the device
// really says one. Measured 2026-10-27 on the Android 15 emulator (NSH 0.3.0 development host):
// `Intl.DateTimeFormat()` without `new` throws "must be called with new" (so the app sent 'UTC'), and
// `new Intl.DateTimeFormat().resolvedOptions().timeZone` is an offset, with the matching getTimezoneOffset(); the iOS
// simulator and headless runs give an IANA name.
import { expect, open, test } from 'nsh/test'
import { deviceTimeZone } from './src/api.ts'

test('the zone: an IANA name as is; an offset (Android) as the matching Etc zone; nothing when only a bare UTC is known', () => {
  expect(deviceTimeZone(() => 'America/New_York', 240)).toBe('America/New_York')
  expect(deviceTimeZone(() => '+02:00', -120)).toBe('Etc/GMT-2')
  expect(deviceTimeZone(() => '-05:00', 300)).toBe('Etc/GMT+5')
  expect(deviceTimeZone(() => '+05:30', -330)).toBe('+05:30')
  expect(deviceTimeZone(() => { throw new TypeError('must be called with new') }, -120)).toBe('Etc/GMT-2')
  expect(deviceTimeZone(() => 'UTC', 0)).toBe(undefined)
  expect(deviceTimeZone(() => 'UTC', 240)).toBe('Etc/GMT+4')
})

const ORIGIN = 'http://127.0.0.1:3850'
const TOKEN = 'tok_abcdefghijklmnopqrstuvwxyz0123456789'
const me = { device: { id: 'd1', name: 'Phone' }, assistant: { name: 'Nori' }, mainSessionId: 'main', connected: true, pushPublicKey: null }

test('the app speaks the device\'s language from the first screen (NSH locale(), Android included)', async () => {
  const app = await open('./App.tsx', { locale: 'zh-Hans-CN' })
  await app.waitFor('id:start')
  expect(app.shows('text:我有自己的电脑')).toBe(true)
})

test('on connect: the locale is the device\'s (NSH locale()), the zone a real one', async () => {
  const app = await open('./App.tsx', { locale: 'zh-Hans-CN', storage: { origin: ORIGIN, token: TOKEN }, network: {
    [`GET ${ORIGIN}/me`]: { body: me }, [`GET ${ORIGIN}/threads`]: { body: [] }, [`PUT ${ORIGIN}/me/context`]: { body: { ok: true } },
  } })
  await app.waitUntil(() => app.requests().some((r) => r.url.endsWith('/me/context')))
  const body = JSON.parse(String(app.requests().find((r) => r.url.endsWith('/me/context'))!.body)) as { timeZone?: string; locale: string }
  expect(body.locale).toBe('zh-Hans-CN')
  expect(body.timeZone === undefined || (body.timeZone !== 'UTC' && body.timeZone.length > 0)).toBe(true)
})
