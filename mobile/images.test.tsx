// Images in the thread on a bad connection. An image that failed once on a slow connection said
// 「这个文件打不开了」 until the next launch (the owner's Android APK, 2026-10-27). Now it is fetched again the way chat
// apps do: with backoff while it is on screen, and at once when the app reconnects; only when the tries run out does
// it say so, and a tap tries again. A file that is not there (404) or not an image says so at once.
import { expect, open, test } from 'nsh/test'

const ORIGIN = 'http://127.0.0.1:3850'
const TOKEN = 'tok_abcdefghijklmnopqrstuvwxyz0123456789'
const AT = 1700000000000
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
const meBody = { device: { id: 'd1', name: 'iPhone' }, assistant: { name: 'Nori' }, mainSessionId: 'main', connected: true, pushPublicKey: null }
const threads = [{ sessionId: 'main', title: '', updatedAt: AT, running: false, blank: false }]
const PATH = '/data/workspace/charts/intc.png'
const URL_ = `${ORIGIN}/library/file?path=${encodeURIComponent(PATH)}&format=json`
const image = { body: { path: PATH, kind: 'image', mime: 'image/png', size: 70, truncated: false, base64: PNG } }
const fileRow = { kind: 'file', id: 'c7:0', path: PATH, name: 'intc.png', description: 'INTC daily', image: true, at: AT }
const snapshot = (rows: unknown[]) => ({ type: 'snapshot', sessionId: 'main', rows, running: false, statusText: '', title: '' })

/** The image route: `mode` decides each answer; every call is counted. */
function route() {
  const s = { mode: 'fail' as 'fail' | 'ok' | 'gone', calls: 0 }
  const answer = () => { s.calls++; return s.mode === 'ok' ? image : s.mode === 'gone' ? { status: 404, body: { error: 'not found' } } : { error: 'The request timed out.' } }
  return { s, answer }
}

async function chat(answer: () => unknown, lang = 'en') {
  const app = await open('./App.tsx', {
    storage: { origin: ORIGIN, token: TOKEN, lang },
    network: { [`GET ${ORIGIN}/me`]: { body: meBody }, [`GET ${ORIGIN}/threads`]: { body: threads }, [`GET ${URL_}`]: answer as never },
    clock: {},
  })
  await app.waitFor('id:composer')
  await app.host.send('thread', [snapshot([{ kind: 'you', id: 'u1', text: 'Chart please', at: AT }, fileRow])])
  await app.waitFor('id:file-c7:0-image')
  return app
}

test('an image that fails on a slow connection is fetched again with backoff and shows once it comes', async () => {
  const r = route()
  const app = await chat(r.answer)
  await app.waitUntil(() => r.s.calls >= 1)
  // one failure is not the end: no failure line, it tries again by itself
  await app.wait(300)
  expect(app.shows('text:This file cannot be opened.')).toBe(false)
  expect(app.shows('id:file-c7:0-image-retry')).toBe(false)
  await app.wait(1500)
  expect(r.s.calls).toBe(2)
  r.s.mode = 'ok'
  await app.wait(3000)
  expect(r.s.calls).toBe(3)
  await app.waitFor('id:file-c7:0-image-loaded')
  // shown: nothing fetches it again
  await app.wait(30000)
  expect(r.s.calls).toBe(3)
})

test('only when the tries run out does it say so; a tap tries again', async () => {
  const r = route()
  const app = await chat(r.answer)
  await app.wait(10000)
  expect(app.shows('id:file-c7:0-image-retry')).toBe(false) // still trying after 10 s
  await app.wait(40000)
  await app.waitFor('id:file-c7:0-image-retry')
  expect(app.shows('text:Couldn’t load. Tap to try again.')).toBe(true)
  const tries = r.s.calls
  expect(tries).toBe(6) // the first and five more, 1 + 2 + 4 + 8 + 16 s apart
  await app.wait(60000)
  expect(r.s.calls).toBe(tries) // exhausted: it waits for the person or a reconnect
  r.s.mode = 'ok'
  await app.press('id:file-c7:0-image-retry')
  await app.waitFor('id:file-c7:0-image-loaded')
  expect(r.s.calls).toBe(tries + 1)
  // the tap retried in place; it did not open the file's page
  expect(app.shows('id:delete-file')).toBe(false)
})

test('when the app reconnects, an image that could not load is fetched again at once', async () => {
  const r = route()
  const app = await chat(r.answer, 'zh')
  await app.wait(60000)
  await app.waitFor('id:file-c7:0-image-retry')
  expect(app.shows('text:没加载出来，点一下重试。')).toBe(true)
  r.s.mode = 'ok'
  await app.host.send('event', { type: 'reset' })
  await app.wait(200)
  await app.host.send('event', { type: 'hello', connected: true, asks: [] })
  await app.waitFor('id:file-c7:0-image-loaded', { timeout: 1000 })
})

test('an image no longer on screen is not fetched again until it shows', async () => {
  const r = route()
  const app = await chat(r.answer)
  await app.waitUntil(() => r.s.calls >= 1)
  await app.host.send('thread', [snapshot([{ kind: 'you', id: 'u1', text: 'Chart please', at: AT }])])
  await app.waitFor('id:file-c7:0-image', { state: 'gone' })
  const n = r.s.calls
  await app.wait(60000)
  expect(r.s.calls).toBe(n)
})

// The thread's list redraws a row while a turn goes on (a reply streaming in): on the Android emulator a screenshot
// that kept failing was fetched 11 times in 8 s, five of them within 15 ms, because each new view of it started over.
test('a row drawn again keeps the backoff: it does not start over', async () => {
  const r = route()
  const app = await chat(r.answer)
  await app.waitUntil(() => r.s.calls >= 1)
  const you = { kind: 'you', id: 'u1', text: 'Chart please', at: AT }
  for (let i = 0; i < 4; i++) {
    await app.host.send('thread', [snapshot([you])])
    await app.waitFor('id:file-c7:0-image', { state: 'gone' })
    await app.host.send('thread', [snapshot([you, fileRow])])
    await app.waitFor('id:file-c7:0-image')
  }
  expect(r.s.calls).toBe(1) // the second try is due 1 s after the first
  await app.wait(1200)
  expect(r.s.calls).toBe(2)
})

// At launch the connection goes online, then the bot's hello, sometimes twice: on the emulator each change started the
// backoff over and the image was fetched five times in 100 ms.
test('a connection that flaps does not fetch once per flap', async () => {
  const r = route()
  const app = await chat(r.answer)
  await app.waitUntil(() => r.s.calls >= 1)
  for (let i = 0; i < 4; i++) {
    await app.host.send('event', { type: 'reset' })
    await app.host.send('event', { type: 'hello', connected: true, asks: [] })
  }
  await app.wait(300)
  expect(r.s.calls).toBeLessThanOrEqual(2)
})

test('a file that is not there says so at once and is not fetched again', async () => {
  const r = route(); r.s.mode = 'gone'
  const app = await chat(r.answer)
  await app.waitFor('text:This file cannot be opened.', { timeout: 1000 })
  await app.wait(30000)
  expect(r.s.calls).toBe(1)
  expect(app.shows('id:file-c7:0-image-retry')).toBe(false)
})
