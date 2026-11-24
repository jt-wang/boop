// No empty state while a list is still loading or could not load (REGRESSION.md, "No flash of an empty state").
// A list page that shows "No chats" on the way back to it, before its rows arrive, is the bug this guards; Boop's own cold start once showed the
// empty thread before its history (App.test.tsx, "cold start with history"). Each list page here is opened, left and
// opened again over a slow connection, sampled every 50 ms: its empty sentence never shows while its rows are on the
// way. And a list the computer could not send is not called empty.
import { expect, open, test } from 'nsh/test'

const ORIGIN = 'http://127.0.0.1:3850'
const TOKEN = 'tok_abcdefghijklmnopqrstuvwxyz0123456789'
const AT = 1700000000000
const me = { device: { id: 'd1', name: 'iPhone' }, assistant: { name: 'Nori' }, mainSessionId: 'main', connected: true, pushPublicKey: null }
const main = { sessionId: 'main', title: '', updatedAt: AT, running: false, blank: false }

// Each list page: how it is reached from the menu, what it fetches, a row of it, its row's text and its empty sentence.
const pages = [
  { name: 'Other chats', entry: null, url: `GET ${ORIGIN}/threads`, rows: [main, { sessionId: 's2', title: 'Trip plan', updatedAt: AT, running: false, blank: false }], row: 'text:Trip plan', empty: 'text:/No other chats yet/' },
  { name: 'Upcoming', entry: 'text:Upcoming', url: `GET ${ORIGIN}/schedules`, rows: [{ id: 't1', name: 'Take pills', instruction: 'Remind me', when: { kind: 'daily', time: '08:00' }, nextRunAt: '2026-10-28T08:00:00.000Z', active: true }], row: 'text:Take pills', empty: 'text:/Nothing scheduled/' },
  { name: 'Activity', entry: 'text:Activity', url: `GET ${ORIGIN}/activity`, rows: [{ id: 'a1', at: '2026-10-28T08:00:00.000Z', kind: 'memory', text: 'Remembered that you like green tea' }], row: 'text:/like green tea/', empty: 'text:/Nothing yet/' },
  { name: 'Goals', entry: 'text:Goals', url: `GET ${ORIGIN}/goals`, rows: [{ id: 'g1', title: 'Run a 10k', plan: [], notes: [], status: 'active' }], row: 'text:Run a 10k', empty: 'text:/No goals yet/' },
] as const

type Mode = 'slow' | 'down' | 'offline'
function openApp(page: (typeof pages)[number], mode: () => Mode | 'ok') {
  const answer = (body: unknown) => () => mode() === 'offline' ? { error: 'offline' } : mode() === 'down' ? { status: 502, body: { error: 'the assistant did not answer' } } : mode() === 'slow' ? { delay: 1500, body } : { body }
  return open('./App.tsx', {
    storage: { origin: ORIGIN, token: TOKEN, lang: 'en' },
    network: {
      [`GET ${ORIGIN}/me`]: { body: me },
      [`GET ${ORIGIN}/threads`]: { body: [main] },
      [`POST ${ORIGIN}/ws-ticket`]: { status: 500, body: {} },
      [`PUT ${ORIGIN}/me/context`]: { body: { ok: true } },
      [`POST ${ORIGIN}/api/session/list`]: { body: { result: { ok: true, value: { items: [] } } } },
      [page.url]: answer(page.rows),
    },
  })
}
type App = Awaited<ReturnType<typeof openApp>>
const toPage = async (app: App, page: (typeof pages)[number]) => {
  await app.press('label:Menu'); await app.waitFor('text:Main chat')
  if (page.entry) await app.press(page.entry)
}
/** Every 50 ms until the row shows (or `ms` passes): the empty sentence never on screen. */
const neverEmpty = async (app: App, page: (typeof pages)[number], ms: number, untilRow: boolean) => {
  for (let t = 0; t < ms; t += 50) {
    expect({ page: page.name, t, empty: app.shows(page.empty) }).toEqual({ page: page.name, t, empty: false })
    if (untilRow && app.shows(page.row)) return
    await app.wait(50)
  }
  if (untilRow) expect(app.shows(page.row)).toBe(true)
}

for (const page of pages) {
  test(`${page.name}: opened again over a slow connection, never empty before its rows`, async () => {
    let mode: Mode | 'ok' = 'ok'
    const app = await openApp(page, () => mode)
    await app.waitFor('label:Menu')
    await toPage(app, page)
    await app.waitFor(page.row)
    // back to the chat and in again, as one leaves a list for a row and comes back
    await app.back(); if (page.entry) await app.back()
    await app.waitFor('id:composer')
    mode = 'slow'
    await toPage(app, page)
    await neverEmpty(app, page, 4000, true)
  }, 60000)

  // the computer answered with an error (502), or nothing answered at all (the tunnel is down: the request fails)
  for (const failure of ['down', 'offline'] as const) {
    test(`${page.name}: a list the computer could not send (${failure === 'down' ? '502' : 'no answer'}) is not called empty`, async () => {
      const app = await openApp(page, () => failure)
      await app.waitFor('label:Menu')
      await toPage(app, page)
      await neverEmpty(app, page, 2000, false)
    }, 60000)
  }
}
