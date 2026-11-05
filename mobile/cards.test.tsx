// Headless tests for the six card kinds (and the table the person picks a row from) (`nsh test cards.test.tsx`).
// The bot is mocked; the answered state comes only from a `rows` frame, as in the app.
import { expect, open, test } from 'nsh/test'

const ORIGIN = 'http://127.0.0.1:3850'
const MESSAGES = `POST ${ORIGIN}/threads/main/messages`
const AT = 1700000000000
const me = { device: { id: 'd1', name: 'iPhone' }, assistant: { name: 'Nori' }, mainSessionId: 'main', connected: true, pushPublicKey: null }
const threads = [{ sessionId: 'main', title: '', updatedAt: AT, running: false, blank: false }]
const cardRow = (id: string, card: unknown, answer?: string) => ({ kind: 'card', id, card, at: AT, ...(answer === undefined ? {} : { answer }) })
const snapshot = (rows: unknown[]) => ({ type: 'snapshot', sessionId: 'main', rows, running: false, statusText: '', title: '' })
const rowsFrame = (rows: unknown[]) => ({ type: 'rows', sessionId: 'main', rows })

const choices = { kind: 'choices', title: 'Which one do you prefer?', detail: 'Pick one.', options: [{ label: 'Train', detail: 'About 3 h' }, { label: 'Bus' }, { label: 'Rental car' }] }
const multi = { kind: 'choices', title: 'What should I pack?', options: [{ label: 'Charger' }, { label: 'Umbrella' }, { label: 'Snacks' }], multiple: true }
const form = { kind: 'form', title: 'Booking details', fields: [
  { name: 'who', label: 'Name', type: 'text', required: true },
  { name: 'guests', label: 'Guests', type: 'number' },
  { name: 'window', label: 'Window seat', type: 'toggle' },
  { name: 'meal', label: 'Meal', type: 'select', options: ['Veg', 'Fish'] },
], submit: 'Book' }
const confirm = { kind: 'confirm', title: 'Book the 9:00 train?', detail: 'Two tickets, 2nd class.', yes: 'Go ahead', no: 'Not yet' }
const table = { kind: 'table', title: 'Lisbon to Porto', columns: ['Way', 'Time', 'Price'], rows: [['Train', '~3 h', '~€30'], ['Bus', '~3.5 h', '~€20'], ['Car', '~3 h', '~€60']] }
const pickTable = { kind: 'table', title: 'Which way?', columns: ['Way', 'Time', 'Price'], rows: [['Train', '~3 h', '~€30'], ['Bus', '~3.5 h', '~€20']], pick: true }
const progress = { kind: 'progress', title: 'Trip plan', items: [{ label: 'Compare options', state: 'done' }, { label: 'Book tickets', state: 'doing' }, { label: 'Pack', state: 'todo' }] }
const summary = { kind: 'summary', title: 'Your booking', items: [{ label: 'Train', value: '09:00 → 12:05' }, { label: 'Seats', value: '12A, 12B' }], link: 'https://example.com/booking/1' }

const openCards = async (rows: unknown[], extra: Record<string, unknown> = {}, storage: Record<string, string> = {}) => {
  const app = await open('./cards.fixture.tsx', { storage, network: { [`GET ${ORIGIN}/me`]: { body: me }, [`GET ${ORIGIN}/threads`]: { body: threads }, [MESSAGES]: { body: { ok: true } }, ...extra } })
  await app.host.send('thread', [snapshot(rows)])
  return app
}
const posted = (app: Awaited<ReturnType<typeof open>>) => app.requests().filter((r) => r.url.endsWith('/threads/main/messages')).map((r) => JSON.parse(String(r.body)))

test('choices: a tap posts the option with the card id; the rows frame with the answer locks the card', async () => {
  const app = await openCards([cardRow('c1', choices)])
  await app.waitFor('text:Which one do you prefer?')
  expect(app.shows('text:About 3 h')).toBe(true)
  await app.press('text:Bus')
  await app.waitUntil(() => posted(app).length === 1)
  expect(posted(app)[0]).toEqual({ text: 'Bus', cardId: 'c1', timeZone: posted(app)[0].timeZone })
  expect(app.shows('id:card-c1-answered')).toBe(false)
  await app.host.send('thread', [rowsFrame([cardRow('c1', choices, 'Bus')])])
  await app.waitFor('id:card-c1-answered')
  expect(app.shows('id:opt-c1-1-selected')).toBe(true)
  expect(app.shows('id:opt-c1-0-selected')).toBe(false)
  await expect(() => app.press('text:Train')).rejects.toThrow('disabled')
  expect(posted(app).length).toBe(1)
})

test('choices with multiple: checkboxes, then Done posts the labels joined with ", " in option order', async () => {
  const app = await openCards([cardRow('c2', multi)])
  await app.waitFor('text:What should I pack?')
  await app.press('text:Snacks')
  await app.press('text:Charger')
  await app.press('id:done-c2')
  await app.waitUntil(() => posted(app).length === 1)
  expect(posted(app)[0].text).toBe('Charger, Snacks')
  expect(posted(app)[0].cardId).toBe('c2')
})

test('form: fields of every type; submit posts "label: value" lines; the answer collapses the form', async () => {
  const app = await openCards([cardRow('f1', form)])
  await app.waitFor('text:Booking details')
  expect(app.shows('text:Book')).toBe(true)
  await app.type('id:field-f1-who', 'Sam')
  await app.type('id:field-f1-guests', '2')
  await app.press('id:field-f1-window')
  await app.press('text:Veg')
  await app.press('id:submit-f1')
  await app.waitUntil(() => posted(app).length === 1)
  expect(posted(app)[0].text).toBe('Name: Sam\nGuests: 2\nWindow seat: yes\nMeal: Veg')
  expect(posted(app)[0].cardId).toBe('f1')
  await app.host.send('thread', [rowsFrame([cardRow('f1', form, 'Name: Sam\nGuests: 2\nWindow seat: yes\nMeal: Veg')])])
  await app.waitFor('id:card-f1-answered')
  expect(app.shows('id:field-f1-who')).toBe(false)
  expect(app.shows('id:submit-f1')).toBe(false)
  expect(app.shows('text:Window seat: yes')).toBe(true)
})

test('form: a required field empty keeps the submit button disabled', async () => {
  const app = await openCards([cardRow('f2', form)])
  await app.waitFor('id:submit-f2')
  await expect(() => app.press('id:submit-f2')).rejects.toThrow('disabled')
  await app.type('id:field-f2-who', 'Sam')
  await app.press('id:submit-f2')
  await app.waitUntil(() => posted(app).length === 1)
  expect(posted(app)[0].text).toBe('Name: Sam\nWindow seat: no')
})

test('confirm: two buttons; yes posts its label; the answer replaces the buttons', async () => {
  const app = await openCards([cardRow('k1', confirm)])
  await app.waitFor('text:Book the 9:00 train?')
  expect(app.shows('text:Two tickets, 2nd class.')).toBe(true)
  expect(app.shows('text:Not yet')).toBe(true)
  await app.press('text:Go ahead')
  await app.waitUntil(() => posted(app).length === 1)
  expect(posted(app)[0]).toEqual({ text: 'Go ahead', cardId: 'k1', timeZone: posted(app)[0].timeZone })
  await app.host.send('thread', [rowsFrame([cardRow('k1', confirm, 'Go ahead')])])
  await app.waitFor('id:card-k1-answered')
  expect(app.shows('text:Not yet')).toBe(false)
  expect(app.shows('text:Go ahead')).toBe(true)
})

// A confirm card the assistant gave no button words to speaks the person's language: a Chinese conversation
// showed "Yes" and "No" (QA pass, 2026-10-27, iOS, "每天 8:00 提醒喝水").
test('confirm without its own words: the buttons are in the person\'s language, and so is the answer', async () => {
  const bare = { kind: 'confirm', title: '每天 8:00 提醒喝水', detail: '现在建好吗？' }
  const app = await openCards([cardRow('k9', bare)], {}, { lang: 'zh' })
  await app.waitFor('text:每天 8:00 提醒喝水')
  expect(app.shows('text:Yes')).toBe(false)
  expect(app.shows('text:No')).toBe(false)
  await app.press('text:好')
  await app.waitUntil(() => posted(app).length === 1)
  expect(posted(app)[0].text).toBe('好')
  const en = await openCards([cardRow('k8', { kind: 'confirm', title: 'Set it up?' })])
  await en.waitFor('text:Yes')
  expect(en.shows('text:No')).toBe(true)
})

test('table, progress and summary render; the summary link opens', async () => {
  const app = await openCards([cardRow('t1', table), cardRow('p1', progress), cardRow('s1', summary)])
  await app.waitFor('text:Lisbon to Porto')
  expect(app.shows('text:Price')).toBe(true)
  expect(app.shows('text:~€20')).toBe(true)
  expect(app.shows('text:Trip plan')).toBe(true)
  expect(app.shows('id:progress-p1-0-done')).toBe(true)
  expect(app.shows('id:progress-p1-1-doing')).toBe(true)
  expect(app.shows('id:progress-p1-2-todo')).toBe(true)
  expect(app.shows('text:Your booking')).toBe(true)
  expect(app.shows('text:12A, 12B')).toBe(true)
  await app.press('id:link-s1')
  await app.waitUntil(() => app.openedUrls().length === 1)
  expect(app.openedUrls()[0]).toBe('https://example.com/booking/1')
})

// [agent:connectors] "Connect Notion" from the thread: the same sign-in as Settings → Connectors.
test('connect card: Connect asks the bot for the sign-in URL, opens it, shows Connecting… and then Connected', async () => {
  let polls = 0
  const connectCard = { kind: 'connect', title: 'Connect Notion', detail: 'So I can read your pages.', service: 'notion' }
  const list = (connected: boolean) => ({ body: { connectors: connected ? [{ id: 'notion', preset: 'notion', auth: 'oauth', enabled: true, missingEnv: [], connected: true }] : [], catalog: [], env: {}, restartNeeded: false } })
  const app = await openCards([cardRow('k1', connectCard)], {
    [`GET ${ORIGIN}/connectors`]: () => { polls++; return list(polls >= 3) },
    [`POST ${ORIGIN}/connectors/notion/connect`]: { body: { url: 'https://mcp.notion.test/authorize?state=s1' } },
  })
  await app.waitFor('text:Connect Notion')
  expect(app.shows('text:So I can read your pages.')).toBe(true)
  await app.waitFor('id:connect-k1')
  await app.press('id:connect-k1')
  await app.waitUntil(() => app.openedUrls().length === 1)
  expect(app.openedUrls()[0]).toBe('https://mcp.notion.test/authorize?state=s1')
  await app.waitFor('id:connecting-k1')
  await app.waitFor('id:connected-k1')
  expect(posted(app).length).toBe(0) // the card answers nothing itself; the bot tells the assistant
})

// Four columns on a phone left each about 80 points; a word wrapped every few letters (audit of 2026-10-30). Past three
// columns a row is a record: its first cell as the title, each other cell under it with its column's name.
const wide = { kind: 'table', title: 'Three hotels', columns: ['Hotel', 'Price', 'Rating', 'Walk to station'], rows: [['Harbor Inn', '€12,000', '4.5', '5 min'], ['River House', '€9,800', '4.2', '12 min']] }
test('a table of more than three columns shows each row as a record: the first cell, then "column: value"', async () => {
  const app = await openCards([cardRow('w1', wide)])
  await app.waitFor('text:Three hotels')
  expect(app.shows('text:Harbor Inn')).toBe(true)
  expect(app.shows('text:Walk to station: 5 min')).toBe(true)
  expect(app.shows('text:Price: €9,800')).toBe(true)
  expect(app.shows('text:Rating')).toBe(false) // no header row
})

test('in Chinese a record line takes the full-width colon', async () => {
  const app = await openCards([cardRow('w2', { ...wide, columns: ['酒店', '价格', '评分', '走到车站'] })], {}, { lang: 'zh' })
  await app.waitFor('text:Harbor Inn')
  expect(app.shows('text:价格：€12,000')).toBe(true)
})

test('table with pick: a tap on a row posts its first cell with the card id; the answer locks the table', async () => {
  const app = await openCards([cardRow('t2', pickTable)])
  await app.waitFor('text:Which way?')
  await app.press('id:row-t2-1')
  await app.waitUntil(() => posted(app).length === 1)
  expect(posted(app)[0]).toEqual({ text: 'Bus', cardId: 't2', timeZone: posted(app)[0].timeZone })
  await app.host.send('thread', [rowsFrame([cardRow('t2', pickTable, 'Bus')])])
  await app.waitFor('id:card-t2-answered')
  expect(app.shows('id:row-t2-1-selected')).toBe(true)
  expect(app.shows('id:row-t2-0-selected')).toBe(false)
  await expect(() => app.press('id:row-t2-0')).rejects.toThrow('disabled')
  expect(posted(app).length).toBe(1)
})

test('offline: a tap shows "Not connected" and posts nothing', async () => {
  const app = await openCards([cardRow('c3', choices)], {}, { offline: '1' })
  await app.waitFor('text:Which one do you prefer?')
  await app.press('text:Bus')
  await app.waitFor('text:Not connected')
  expect(posted(app).length).toBe(0)
})
