// Headless tests for the Ideas page (`cd mobile && nsh test ideas.test.tsx`). Bot routes are mocked.
import { expect, open, test } from 'nsh/test'

const ORIGIN = 'http://127.0.0.1:3850'
const TOKEN = 'tok_abcdefghijklmnopqrstuvwxyz0123456789'
const me = { device: { id: 'd1', name: 'iPhone' }, assistant: { name: 'Nori' }, mainSessionId: 'main', connected: true, pushPublicKey: null }
const ideas = [
  { id: 'a1', title: 'Book the dentist', body: 'You said the check-up is overdue.', action: 'Find me a dentist slot next Tuesday morning', createdAt: '2026-10-27T00:00:00Z', dismissed: false },
  { id: 'b2', title: 'Plan this week\'s runs', body: 'Your 10 km goal has no run logged this week.', action: 'Plan my three runs for this week', createdAt: '2026-10-27T00:00:00Z', dismissed: false },
  { id: 'c3', title: 'Pack for Porto', body: 'The wedding is in three weeks.', action: 'Make me a packing list for the Porto trip', createdAt: '2026-10-27T00:00:00Z', dismissed: false },
]
const base = { storage: { origin: ORIGIN, token: TOKEN }, network: { [`GET ${ORIGIN}/me`]: { body: me }, [`POST ${ORIGIN}/ws-ticket`]: { body: { ticket: 'ticket' } } } }

test('lists the ideas; "Do it" sends the idea\'s message to the main thread and leaves the page', async () => {
  const app = await open('./ideas.harness.tsx', { ...base, network: { ...base.network,
    [`GET ${ORIGIN}/ideas`]: { body: ideas },
    [`POST ${ORIGIN}/threads/main/messages`]: { body: { ok: true } },
  } })
  await app.waitFor('text:Book the dentist')
  expect(app.shows('text:Plan this week\'s runs')).toBe(true)
  expect(app.shows('text:Pack for Porto')).toBe(true)
  await app.press('id:idea-b2-do')
  await app.waitFor('id:sent')
  const prompt = app.requests().find((r) => r.url.endsWith('/threads/main/messages'))
  expect(Boolean(prompt)).toBe(true)
  expect(JSON.parse(String(prompt!.body)).text).toBe('Plan my three runs for this week')
})

test('"Not now" dismisses on the bot and hides the card right away', async () => {
  let current = ideas
  const app = await open('./ideas.harness.tsx', { ...base, network: { ...base.network,
    [`GET ${ORIGIN}/ideas`]: () => ({ body: current }),
    [`POST ${ORIGIN}/ideas/a1/dismiss`]: () => { current = current.filter((i) => i.id !== 'a1'); return { body: { ok: true } } },
  } })
  await app.waitFor('text:Book the dentist')
  await app.press('id:idea-a1-dismiss')
  await app.waitFor('text:Book the dentist', { state: 'gone' })
  expect(app.shows('text:Plan this week\'s runs')).toBe(true)
  expect(app.requests().some((r) => r.method === 'POST' && r.url.endsWith('/ideas/a1/dismiss'))).toBe(true)
})

test('empty state explains what Refresh does; Refresh asks the bot and shows what comes back', async () => {
  const app = await open('./ideas.harness.tsx', { ...base, network: { ...base.network,
    [`GET ${ORIGIN}/ideas`]: { body: [] },
    [`POST ${ORIGIN}/ideas/refresh`]: { body: ideas.slice(0, 1), delay: 50 },
  } })
  await app.waitFor('text:/No ideas yet/')
  await app.press('id:ideas-refresh')
  await app.waitFor('text:Book the dentist')
  expect(app.shows('text:/No ideas yet/')).toBe(false)
  expect(app.requests().some((r) => r.method === 'POST' && r.url.endsWith('/ideas/refresh'))).toBe(true)
})

test('when the bot cannot reach the model, Refresh shows a toast and keeps the list', async () => {
  const app = await open('./ideas.harness.tsx', { ...base, network: { ...base.network,
    [`GET ${ORIGIN}/ideas`]: { body: ideas },
    [`POST ${ORIGIN}/ideas/refresh`]: { status: 502, body: { error: 'the model did not answer' } },
  } })
  await app.waitFor('text:Book the dentist')
  await app.press('id:ideas-refresh')
  await app.waitFor('id:toast')
  expect(app.shows('text:Book the dentist')).toBe(true)
})
