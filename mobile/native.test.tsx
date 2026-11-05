// The app inside the native shell: the host's push functions and events are
// played by the test (`open`'s `host`).
import { expect, open, test } from 'nsh/test'

const ORIGIN = 'http://127.0.0.1:3850'
const TOKEN = 'ab'.repeat(32)
const meBody = (name: string) => ({ device: { id: 'd1', name: 'iPhone' }, assistant: { name }, mainSessionId: 'main', connected: true, pushPublicKey: null })
const until = async (ok: () => boolean, timeout = 5000) => { const end = Date.now() + timeout; while (!ok()) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 20)) } }
const paired = {
  storage: { origin: ORIGIN, token: 'tok_abcdefghijklmnopqrstuvwxyz0123456789' },
  network: {
    [`GET ${ORIGIN}/me`]: { body: meBody('Nori') },
    [`POST ${ORIGIN}/ws-ticket`]: { body: { ticket: 'ticket' } },
    [`POST ${ORIGIN}/push/subscribe`]: { body: { ok: true } },
  },
}

test('in the native shell, a paired app asks for permission, fetches the token and posts { kind: "apns", token } to the bot', async () => {
  const app = await open('./App.tsx', { ...paired, host: { handlers: { 'push.request': { granted: true }, 'push.token': { token: TOKEN } } } })
  await app.waitFor('text:Nori')
  await until(() => app.requests().some((r) => r.url.endsWith('/push/subscribe')))
  expect(app.host.calls().map((c) => c.name)).toEqual(['push.request', 'push.token'])
  const posted = app.requests().find((r) => r.url.endsWith('/push/subscribe'))!
  expect(JSON.parse(String(posted.body))).toEqual({ kind: 'apns', token: TOKEN })
})

test('permission denied: no token call, nothing posted', async () => {
  const app = await open('./App.tsx', { ...paired, host: { handlers: { 'push.request': { granted: false }, 'push.token': { token: TOKEN } } } })
  await app.waitFor('text:Nori')
  await until(() => app.host.calls().length >= 1)
  await new Promise((r) => setTimeout(r, 50))
  expect(app.host.calls().map((c) => c.name)).toEqual(['push.request'])
  expect(app.requests().some((r) => r.url.endsWith('/push/subscribe'))).toBe(false)
})

test('the person turned notifications off: the shell is not asked', async () => {
  const app = await open('./App.tsx', { ...paired, storage: { ...paired.storage, nativePush: 'off' }, host: { handlers: { 'push.request': { granted: true }, 'push.token': { token: TOKEN } } } })
  await app.waitFor('text:Nori')
  await new Promise((r) => setTimeout(r, 50))
  expect(app.host.calls().length).toBe(0)
})

test('without a host (dev host, web) the app never calls push functions', async () => {
  const app = await open('./App.tsx', paired)
  await app.waitFor('text:Nori')
  await new Promise((r) => setTimeout(r, 50))
  expect(app.requests().some((r) => r.url.endsWith('/push/subscribe'))).toBe(false)
})

test('a pairing link from the shell prefills the connect screen', async () => {
  const app = await open('./App.tsx', { host: { params: { pairUrl: `${ORIGIN}/pair?code=654321` } } })
  await app.waitFor('text:Connect to your computer')
  await app.waitFor('text:654321')
})

test('in the browser (web/host.js answers the same names), push.token returns a Web Push subscription and the app posts it as is', async () => {
  const sub = { endpoint: 'https://push.example/abc', keys: { p256dh: 'p', auth: 'a' } }
  const calls: unknown[] = []
  const app = await open('./App.tsx', { ...paired, platform: 'web', network: { ...paired.network, [`GET ${ORIGIN}/me`]: { body: { ...meBody('Nori'), pushPublicKey: 'BPUBLICKEY' } } }, host: { handlers: { 'launch.params': {}, 'push.request': { granted: true }, 'push.token': (args: unknown) => { calls.push(args); return { subscription: sub } } } } })
  await app.waitFor('text:Nori')
  await until(() => app.requests().some((r) => r.url.endsWith('/push/subscribe')))
  const posted = app.requests().find((r) => r.url.endsWith('/push/subscribe'))!
  expect(JSON.parse(String(posted.body))).toEqual(sub)
  expect((calls[0] as { vapid?: string }).vapid).toBe('BPUBLICKEY')
})

// QA 2026-10-28: a pairing link (the QR code) opened while the app was already on the
// connect screen filled nothing in; only a cold start took it. The shell sends it as the `pair` event.
test('a pairing link that arrives while the app runs fills in the connect screen', async () => {
  const app = await open('./App.tsx', { host: { handlers: {} } })
  await app.waitFor('id:own-computer')
  await app.press('id:own-computer')
  await app.waitFor('text:Connect to your computer')
  await app.host.send('pair', { url: `${ORIGIN}/pair?code=654321` })
  await app.waitFor('text:654321')
  expect(app.value('id:address')).toBe(ORIGIN)
})

test('a pairing link that arrives on the welcome screen opens the connect screen filled in', async () => {
  const app = await open('./App.tsx', { host: { handlers: {} } })
  await app.waitFor('id:own-computer')
  await app.host.send('pair', { url: `${ORIGIN}/pair?code=123987` })
  await app.waitFor('text:123987')
})
