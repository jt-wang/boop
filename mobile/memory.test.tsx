// The profile's Memory segment and the edit page. The bot is mocked.
import { expect, open, test } from 'nsh/test'
const O = 'http://127.0.0.1:3850'
const me = { device: { id: 'd1', name: 'iPhone' }, assistant: { name: 'Nori' }, mainSessionId: 'main', connected: true }
const base = (extra: Record<string, string> = {}) => ({ storage: { origin: O, token: 'tok_abcdefghijklmnopqrstuvwxyz0123456789', tab: 'memory', lang: 'en', ...extra } })
const net = { [`GET ${O}/me`]: { body: me }, [`POST ${O}/ws-ticket`]: { body: { ticket: 't' } }, [`GET ${O}/threads`]: { body: [] } }
const item = (id: string, kind: string, text: string, date = '2026-10-27') => ({ id, file: kind === 'fact' || kind === 'preference' ? 'user' : 'memory', kind, text, date })
const ITEMS = [
  item('user:1', 'fact', 'Call me Owl'),
  item('user:2', 'preference', 'Coffee with oat milk'),
  item('memory:2', 'project', 'Waiting for the landlord to reply by Friday'),
  item('memory:3', 'decision', 'Invoices go to the office'),
  item('memory:4', 'person', 'Xiaoyu is my daughter'),
]
const slug = (id: string) => id.replace(/[^a-z0-9]/gi, '-')

test('the Memory segment: a count, four groups, one row per item with when it was learned; ⋮ → Forget asks first, then deletes that one', async () => {
  const app = await open('./profile.harness.tsx', { ...base(), network: { ...net, [`GET ${O}/memory`]: { body: ITEMS }, [`DELETE ${O}/memory/memory%3A2`]: { body: { removed: 'Waiting…' } } } })
  await app.waitFor('id:mem-count')
  expect(app.shows('text:5 things it remembers about you')).toBe(true)
  for (const g of ['About you', 'Tracking', 'Decisions', 'People and places']) expect(app.texts()).toContain(g)
  for (const t of ['Call me Owl', 'Coffee with oat milk', 'Invoices go to the office', 'Xiaoyu is my daughter']) expect(app.texts()).toContain(t)
  expect(app.shows('text:/^Learned Oct 27$/')).toBe(true)
  // no red word on every row: one ⋮ per row, the destructive action lives in the sheet
  expect(app.texts().filter((t) => t === 'Forget').length).toBe(0)
  app.onDialog(() => 'Forget')
  await app.press(`id:more-${slug('memory:2')}`)
  await app.waitUntil(() => app.requests().some((r) => r.method === 'DELETE'))
  expect(app.requests().find((r) => r.method === 'DELETE')!.url).toBe(`${O}/memory/memory%3A2`)
  expect(app.dialogs().length).toBe(2) // the sheet, then the confirmation
  expect(app.dialogs()[0].sheet).toBe(true)
  expect(app.dialogs()[0].buttons).toEqual(['Edit', 'Forget', 'Cancel'])
  expect(app.dialogs()[1].message).toBe('Waiting for the landlord to reply by Friday')
  await app.waitUntil(() => !app.texts().includes('Waiting for the landlord to reply by Friday'))
  await app.waitFor('text:Forgotten')
})

test('more than five in a group fold under "Show N more"', async () => {
  const many = Array.from({ length: 7 }, (_, i) => item(`user:${i}`, 'fact', `Fact number ${i + 1}`))
  const app = await open('./profile.harness.tsx', { ...base(), network: { ...net, [`GET ${O}/memory`]: { body: many } } })
  await app.waitFor('text:Fact number 5')
  expect(app.shows('text:Fact number 6')).toBe(false)
  expect(app.shows('text:Show 2 more')).toBe(true)
  await app.press('id:mem-more-memAboutYou')
  await app.waitFor('text:Fact number 7')
})

test('a note in the chat opens Memory with that item first and marked, even when its group is folded', async () => {
  const many = Array.from({ length: 7 }, (_, i) => item(`user:${i}`, 'fact', `Fact number ${i + 1}`))
  const app = await open('./profile.harness.tsx', { ...base({ focus: 'number 7' }), network: { ...net, [`GET ${O}/memory`]: { body: many } } })
  await app.waitFor('text:Fact number 7')
  const texts = app.texts()
  expect(texts.indexOf('Fact number 7')).toBeLessThan(texts.indexOf('Fact number 1'))
})

test('edit: tap a row, change the words and the group, Save → PATCH with the new text and kind; the list refetches', async () => {
  let listCalls = 0
  const app = await open('./profile.harness.tsx', { ...base(), network: { ...net,
    [`GET ${O}/memory`]: () => { listCalls++; return { body: listCalls > 1 ? [item('memory:9', 'person', 'Xiaoyu is my daughter, 9, plays piano')] : ITEMS } },
    [`PATCH ${O}/memory/memory%3A4`]: { body: item('memory:9', 'person', 'Xiaoyu is my daughter, 9, plays piano') },
  } })
  await app.waitFor('text:Xiaoyu is my daughter')
  await app.press(`id:mem-${slug('memory:4')}`)
  await app.waitFor('id:memory-text')
  expect(app.shows('id:group-memPeople')).toBe(true)
  await app.type('id:memory-text', ', 9, plays piano')
  await app.press('id:memory-save')
  await app.waitUntil(() => app.requests().some((r) => r.method === 'PATCH'))
  expect(JSON.parse(String(app.requests().find((r) => r.method === 'PATCH')!.body))).toEqual({ text: 'Xiaoyu is my daughter, 9, plays piano', kind: 'person' })
  await app.waitFor('text:Xiaoyu is my daughter, 9, plays piano')
})

test('edit: moving an item to another group sends that group\'s kind; a duplicate is explained, nothing else changes', async () => {
  const app = await open('./profile.harness.tsx', { ...base(), network: { ...net, [`GET ${O}/memory`]: { body: ITEMS }, [`PATCH ${O}/memory/memory%3A3`]: { status: 400, body: { error: 'already remembered' } } } })
  await app.waitFor('text:Invoices go to the office')
  await app.press(`id:mem-${slug('memory:3')}`)
  await app.waitFor('id:group-memTracking')
  await app.press('id:group-memTracking')
  await app.press('id:memory-save')
  await app.waitUntil(() => app.requests().some((r) => r.method === 'PATCH'))
  expect(JSON.parse(String(app.requests().find((r) => r.method === 'PATCH')!.body))).toEqual({ text: 'Invoices go to the office', kind: 'project' })
  await app.waitFor('text:It already remembers that.')
  expect(app.shows('id:memory-edit')).toBe(true)
})

test('edit page: Forget asks, then deletes and goes back', async () => {
  const app = await open('./profile.harness.tsx', { ...base(), network: { ...net, [`GET ${O}/memory`]: { body: ITEMS }, [`DELETE ${O}/memory/user%3A1`]: { body: { removed: 'Call me Owl' } } } })
  await app.waitFor('text:Call me Owl')
  await app.press(`id:mem-${slug('user:1')}`)
  await app.waitFor('id:memory-forget')
  app.onDialog(() => 'Forget')
  await app.press('id:memory-forget')
  await app.waitUntil(() => app.requests().some((r) => r.method === 'DELETE'))
  await app.waitFor('id:mem-count')
})

test('Forget everything asks once, then deletes every item', async () => {
  const app = await open('./profile.harness.tsx', { ...base(), network: { ...net, [`GET ${O}/memory`]: { body: ITEMS.slice(0, 2) }, [`DELETE ${O}/memory/user%3A1`]: { body: { removed: 'x' } }, [`DELETE ${O}/memory/user%3A2`]: { body: { removed: 'y' } } } })
  await app.waitFor('id:mem-forget-all')
  app.onDialog(() => 'Forget everything')
  await app.press('id:mem-forget-all')
  await app.waitUntil(() => app.requests().filter((r) => r.method === 'DELETE').length === 2)
  await app.waitFor('text:/Nothing remembered yet/')
})

test('empty memory says how it learns', async () => {
  const app = await open('./profile.harness.tsx', { ...base(), network: { ...net, [`GET ${O}/memory`]: { body: [] } } })
  await app.waitFor('text:/Nothing remembered yet/')
})
