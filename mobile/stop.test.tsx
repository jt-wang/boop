// Headless tests for the Stop control (`nsh test stop.test.tsx`).
import { expect, open, test } from 'nsh/test'

const ORIGIN = 'http://127.0.0.1:3850'
const CANCEL = `POST ${ORIGIN}/sessions/main/cancel`

test('no Stop button while the assistant is idle', async () => {
  const app = await open('./stop.fixture.tsx', { storage: { running: '0' } })
  await app.waitFor('text:Online')
  expect(app.shows('id:stop')).toBe(false)
})

test('while working: Stop → confirm sheet → the cancel is posted and "Stopped" shows', async () => {
  const app = await open('./stop.fixture.tsx', { storage: { running: '1' }, network: { [CANCEL]: { body: { ok: true } } } })
  await app.waitFor('id:stop')
  await app.press('id:stop')
  await app.waitFor('text:Stop this task?')
  expect(app.requests().length).toBe(0)
  await app.press('id:stop-confirm')
  await app.waitFor('text:Stopped')
  const sent = app.requests().filter((r) => r.url.endsWith('/sessions/main/cancel'))
  expect(sent.length).toBe(1)
  expect(sent[0].method).toBe('POST')
  expect(sent[0].headers['authorization']).toBe('Bearer tok_test')
})

test('"Keep going" closes the sheet without posting', async () => {
  const app = await open('./stop.fixture.tsx', { storage: { running: '1' }, network: { [CANCEL]: { body: { ok: true } } } })
  await app.press('id:stop')
  await app.waitFor('id:stop-keep')
  await app.press('id:stop-keep')
  // the sheet animates away: wait for it to be gone, not for the button that was under it all along
  await app.waitFor('text:Stop this task?', { state: 'gone' })
  expect(app.shows('id:stop')).toBe(true)
  expect(app.requests().length).toBe(0)
})

test('a 404 from the bot is explained: this version cannot stop tasks', async () => {
  const app = await open('./stop.fixture.tsx', { storage: { running: '1' }, network: { [CANCEL]: { status: 404, body: { error: 'stop not supported' } } } })
  await app.press('id:stop')
  await app.press('id:stop-confirm')
  await app.waitFor('text:This version cannot stop tasks.')
})

test('the confirm sheet closes by itself when the turn it would stop ends (QA 2026-10-28 H7)', async () => {
  const app = await open('./stop.fixture.tsx', { storage: { running: '1', endAfter: '2500' }, network: { [CANCEL]: { body: { ok: true } } } })
  await app.press('id:stop')
  await app.waitFor('text:Stop this task?')
  await app.waitFor('text:Online', { timeout: 6000 })
  await app.waitFor('text:Stop this task?', { state: 'gone', timeout: 6000 })
  expect(app.shows('id:stop-confirm')).toBe(false)
  expect(app.requests().length).toBe(0)
})
