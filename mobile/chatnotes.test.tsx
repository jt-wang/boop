// What the thread shows when a turn used a connected service or changed memory:
// a card per service under the receipt, and one line per remembered or forgotten thing
// (ChatGPT's "Memory updated") that opens it in the profile's Memory.
import { expect, open, test } from 'nsh/test'

const ORIGIN = 'http://127.0.0.1:3850'
const AT = 1700000000000
const me = { device: { id: 'd1', name: 'iPhone' }, assistant: { name: 'Nori' }, mainSessionId: 'main', connected: true, pushPublicKey: null }
const net = { [`GET ${ORIGIN}/me`]: { body: me }, [`GET ${ORIGIN}/threads`]: { body: [{ sessionId: 'main', title: '', updatedAt: AT, running: false, blank: false }] }, [`POST ${ORIGIN}/ws-ticket`]: { body: { ticket: 't' } }, [`PUT ${ORIGIN}/me/context`]: { body: { ok: true } } }
const turn = (zh: boolean) => [
  { kind: 'you', id: 'u1', text: zh ? '记一下我咖啡只喝燕麦奶，再帮我在 Acme Pages 找花园计划' : 'Remember I take oat milk, and find the garden plan in Acme Pages', at: AT },
  { kind: 'step', id: 's1', name: 'mcp__bot__remember', command: zh ? '咖啡只喝燕麦奶拿铁' : 'Coffee with oat milk', output: 'Saved (preference).', at: AT + 1000 },
  { kind: 'step', id: 's2', name: 'mcp__acme-pages__search_pages', command: 'garden', output: '[{"title":"Quarterly Garden Plan 7Q4"}]', at: AT + 3000 },
  { kind: 'step', id: 's3', name: 'mcp__acme-pages__read_page', output: '…', at: AT + 5000 },
  { kind: 'them', id: 't1', text: zh ? '记下了。找到了：Quarterly Garden Plan 7Q4。' : 'Noted. Found it: Quarterly Garden Plan 7Q4.', at: AT + 8000 },
]
const snapshot = (rows: unknown[]) => ({ type: 'snapshot', sessionId: 'main', rows, running: false, statusText: '', title: '' })

test('a turn that used a service shows its card; a turn that remembered something says what, and the line opens it in Memory', async () => {
  const app = await open('./chat.fixture.tsx', { storage: { lang: 'en' }, network: net })
  await app.host.send('thread', [snapshot(turn(false))])
  await app.waitFor('id:svc-card-acme-pages')
  expect(app.shows('id:svc-card-acme-pages >> text:Acme Pages')).toBe(true)
  expect(app.shows('id:svc-card-acme-pages >> text:Used 2 times')).toBe(true)
  expect(app.shows('text:Remembered: Coffee with oat milk')).toBe(true)
  await app.press('id:mem-note-remembered')
  await app.waitUntil(() => app.storage().opened === 'memory:Coffee with oat milk')
  // never the tool's own name
  expect(app.texts().some((x) => /mcp__|search_pages|read_page|remember\b/.test(x))).toBe(false)
})

test('in Chinese the notes are Chinese, and the steps name the service', async () => {
  const app = await open('./chat.fixture.tsx', { storage: { lang: 'zh' }, network: net })
  await app.host.send('thread', [snapshot(turn(true))])
  await app.waitFor('id:svc-card-acme-pages')
  expect(app.shows('text:记住了：咖啡只喝燕麦奶拿铁')).toBe(true)
  expect(app.shows('text:用了 2 次')).toBe(true)
  // its search and its read both say 「使用 Acme Pages」: one line (the same words twice in a row, below)
  await app.press('text:/做了 2 件事/')
  await app.waitFor('text:使用 Acme Pages')
})

// Seen on the simulator, 2026-10-27: after connecting a service the bot tells the assistant, which answers with no
// message from the person in between; the receipt of the turn before then read "Did 1 thing · 1912 s".
test('a receipt counts its own turn: a later message the assistant sends on its own does not stretch it', async () => {
  const { foldActivities } = await import('./src/chat.tsx')
  const items = foldActivities([
    { kind: 'you', id: 'u1', text: 'invoices to the office', at: AT },
    { kind: 'step', id: 's1', name: 'mcp__bot__remember', command: 'Invoices go to the office', output: 'Saved (decision).', at: AT + 1000 },
    { kind: 'them', id: 't1', text: 'Noted.', at: AT + 3000 },
    { kind: 'them', id: 't2', text: 'Acme Pages is connected now.', at: AT + 1_900_000 },
  ] as never, false)
  const act = items.find((i) => i.activity)!.activity!
  expect(act.endAt).toBe(AT + 3000)
})

// iOS QA, 2026-10-30: a second message sent while a search ran split the work: "Did 1 thing" (with the breathing
// dot of the running step) stayed above the new bubble, and the live block started again below it.
test('a message sent mid-task stays inside the running work: one live block, after it', async () => {
  const { foldActivities } = await import('./src/chat.tsx')
  const items = foldActivities([
    { kind: 'you', id: 'u1', text: 'Compare three ways to Sintra', at: AT },
    { kind: 'step', id: 's1', name: 'web_search', at: AT + 1000 },
    { kind: 'you', id: 'u2', text: 'Also compare the same for Evora.', at: AT + 2000 },
    { kind: 'step', id: 's2', name: 'web_fetch', at: AT + 3000 },
  ] as never, true)
  const acts = items.filter((i) => i.activity)
  expect(acts.length).toBe(1)
  expect(acts[0].activity!.steps.length).toBe(2)
  expect(items.at(-1)!.activity?.live).toBe(true)
  expect(items.map((i) => i.id).slice(0, 2)).toEqual(['u1', 'u2'])
  // a turn that ended in a card: the next message starts a new block
  const after = foldActivities([
    { kind: 'you', id: 'u1', text: 'Which day?', at: AT },
    { kind: 'step', id: 's1', name: 'mcp__bot__show', at: AT + 1000, output: 'Shown.' },
    { kind: 'card', id: 'c1', card: { kind: 'confirm', title: 'Thu?' }, at: AT + 1000 },
    { kind: 'you', id: 'u2', text: 'Thu', at: AT + 5000 },
    { kind: 'step', id: 's2', name: 'web_search', at: AT + 6000 },
  ] as never, true)
  expect(after.filter((i) => i.activity).length).toBe(2)
})

test('several things remembered in one turn: one line that says how many, opening Memory', async () => {
  const rows = turn(false)
  rows.splice(2, 0, { kind: 'step', id: 's1b', name: 'mcp__bot__remember', command: 'Call me Owl', output: 'Saved (fact).', at: AT + 2000 })
  const app = await open('./chat.fixture.tsx', { storage: { lang: 'en' }, network: net })
  await app.host.send('thread', [snapshot(rows)])
  await app.waitFor('id:mem-note-many')
  expect(app.shows('text:Remembered 2 things')).toBe(true)
  expect(app.shows('text:Remembered: Coffee with oat milk')).toBe(false)
  await app.press('id:mem-note-many')
  await app.waitUntil(() => app.storage().opened === 'memory:')
})

// Android pass of 2026-11-02 (Evora trip, real model): the open list said 「查波拉美术馆门票价」 twice in a row: the
// assistant searched twice under the same words. One line per thing it did, as the person reads it; the count agrees.
test('the same words twice in a row are one line, and the count agrees', async () => {
  const app = await open('./chat.fixture.tsx', { storage: { lang: 'zh' }, network: net })
  await app.host.send('thread', [snapshot([
    { kind: 'you', id: 'u1', text: '排一个埃武拉两天的行程', at: AT },
    { kind: 'step', id: 's1', name: 'web_search', description: '查埃武拉周末天气', at: AT + 1000 },
    { kind: 'step', id: 's2', name: 'web_search', description: '查波拉美术馆门票价', at: AT + 2000 },
    { kind: 'step', id: 's3', name: 'web_fetch', description: '查波拉美术馆门票价', at: AT + 3000 },
    { kind: 'step', id: 's4', name: 'web_search', description: '查埃武拉周末天气', at: AT + 4000 },
    { kind: 'them', id: 't1', text: '排好了。', at: AT + 5000 },
  ])])
  await app.press('text:/做了 3 件事/')
  await app.waitFor('text:查波拉美术馆门票价')
  expect(app.texts().filter((x) => x === '查波拉美术馆门票价').length).toBe(1)
  // not next to each other: said again, since it went back to it
  expect(app.texts().filter((x) => x === '查埃武拉周末天气').length).toBe(2)
})

// Android pass of 2026-11-02: with a turn's steps open, the back button left the app. Back closes the open steps first.
test('the back button closes an open step list before anything else', async () => {
  const app = await open('./chat.fixture.tsx', { storage: { lang: 'en' }, network: net })
  await app.host.send('thread', [snapshot(turn(false))])
  await app.press('text:/Did 2 things/')
  await app.waitFor('id:step-s3-done')
  await app.back()
  await app.waitUntil(() => !app.shows('id:step-s3-done'))
})
