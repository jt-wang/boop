// Discover: goals and ideas. The bot is mocked.
import { expect, open, test } from 'nsh/test'
const O = 'http://127.0.0.1:3850'
const me = { device: { id: 'd1', name: 'iPhone' }, assistant: { name: 'Nori' }, mainSessionId: 'main', connected: true }
const base = { storage: { origin: O, token: 'tok_abcdefghijklmnopqrstuvwxyz0123456789', lang: 'en' } }
const goal = { id: 'g1', title: 'Run a 10k', plan: ['Run 3x a week'], notes: [{ at: '2026-10-27T00:00:00Z', text: 'Ran twice this week' }], status: 'active' }
const task = { id: 's1', name: 'Stretch', instruction: 'Stand up', when: { kind: 'daily', time: '09:00', timeZone: 'America/New_York' }, nextRunAt: '2026-10-28T00:00:00Z', active: true }
const wait = { id: 'memory:abc', file: 'memory', kind: 'project', text: 'Waiting for the landlord to reply by Friday', date: '2026-10-27' }
const idea = { id: 'i1', title: 'I can book the dentist', body: 'It has been a year since the last check-up.', action: 'Find me a dentist' }
const net = (extra: Record<string, unknown> = {}) => ({
  [`GET ${O}/me`]: { body: me }, [`POST ${O}/ws-ticket`]: { body: { ticket: 't' } }, [`GET ${O}/threads`]: { body: [] },
  [`GET ${O}/goals`]: { body: [goal] }, [`GET ${O}/schedules`]: { body: [task] }, [`GET ${O}/ideas`]: { body: [idea] },
  [`GET ${O}/memory`]: { body: [wait, { ...wait, id: 'user:x', file: 'user', kind: 'fact', text: 'Call me Owl' }] }, [`GET ${O}/activity`]: { body: [] },
  ...extra,
})

test('Tracking holds goals and the waits it remembered; reminders under Upcoming; ideas as rows; what it did is not here', async () => {
  const app = await open('./discover.harness.tsx', { ...base, network: net() })
  await app.waitFor('id:tracking')
  for (const s of ['Run a 10k', 'Ran twice this week', 'Waiting for the landlord to reply by Friday', 'Stretch', 'I can book the dentist', 'It has been a year since the last check-up.']) expect(app.texts()).toContain(s)
  expect(app.shows('text:Call me Owl')).toBe(false) // only what it is tracking, not everything it knows
  expect(app.texts()).toContain('Learned Oct 27') // a date, nothing trailing (seen on the simulator: "Learned Oct 27,")
  expect(app.shows('text:Recently done')).toBe(false)
  const texts = app.texts()
  expect(texts.indexOf('Tracking')).toBeLessThan(texts.indexOf('Upcoming'))
  expect(texts.indexOf('Upcoming')).toBeLessThan(texts.indexOf('Ideas'))
})

test('the checkbox finishes a goal (PATCH done) and a wait (it forgets the wait)', async () => {
  const app = await open('./discover.harness.tsx', { ...base, network: net({ [`PATCH ${O}/goals/g1`]: { body: { ...goal, status: 'done' } }, [`DELETE ${O}/memory/memory%3Aabc`]: { body: { removed: 'x' } } }) })
  await app.waitFor('id:check-g1')
  await app.press('id:check-g1')
  await app.waitUntil(() => app.requests().some((r) => r.method === 'PATCH'))
  expect(JSON.parse(String(app.requests().find((r) => r.method === 'PATCH')!.body))).toEqual({ status: 'done' })
  await app.press('id:check-memory-abc')
  await app.waitUntil(() => app.requests().some((r) => r.method === 'DELETE' && r.url.endsWith('/memory/memory%3Aabc')))
})

test('⋮ on a reminder offers Pause and Remove; Pause PATCHes active: false', async () => {
  const app = await open('./discover.harness.tsx', { ...base, network: net({ [`PATCH ${O}/schedules/s1`]: { body: { ...task, active: false } } }) })
  await app.waitFor('id:more-s1')
  app.onDialog(() => 'Pause')
  await app.press('id:more-s1')
  await app.waitUntil(() => app.requests().some((r) => r.method === 'PATCH' && r.url.endsWith('/schedules/s1')))
  expect(app.dialogs()[0].buttons).toEqual(['Pause', 'Remove', 'Cancel'])
})

test('an idea opens Do it / Not now; Not now dismisses it, Do it sends its message', async () => {
  const app = await open('./discover.harness.tsx', { ...base, network: net({ [`POST ${O}/ideas/i1/dismiss`]: { body: { ok: true } }, [`POST ${O}/threads/main/messages`]: { body: { ok: true } } }) })
  await app.waitFor('id:idea-i1')
  app.onDialog(() => 'Not now')
  await app.press('id:idea-i1')
  await app.waitUntil(() => app.requests().some((r) => r.url.endsWith('/ideas/i1/dismiss')))
  app.onDialog(() => 'Do it')
  await app.press('id:idea-i1')
  await app.waitUntil(() => app.requests().some((r) => r.url.endsWith('/threads/main/messages')))
  expect(JSON.parse(String(app.requests().find((r) => r.url.endsWith('/threads/main/messages'))!.body)).text).toBe('Find me a dentist')
})

test('more than three tracked things fold under "Show N more"', async () => {
  const goals = Array.from({ length: 5 }, (_, i) => ({ ...goal, id: `g${i}`, title: `Goal ${i + 1}`, notes: [] }))
  const app = await open('./discover.harness.tsx', { ...base, network: net({ [`GET ${O}/goals`]: { body: goals }, [`GET ${O}/memory`]: { body: [] } }) })
  await app.waitFor('text:Goal 3')
  expect(app.shows('text:Goal 4')).toBe(false)
  await app.press('id:show-more-tracked')
  await app.waitFor('text:Goal 5')
})

test('discover empty state names the assistant', async () => {
  const app = await open('./discover.harness.tsx', { ...base, network: net({ [`GET ${O}/goals`]: { body: [] }, [`GET ${O}/schedules`]: { body: [] }, [`GET ${O}/ideas`]: { body: [] }, [`GET ${O}/memory`]: { body: [] } }) })
  await app.waitFor('text:/Nori is not tracking anything yet/')
})

// The Discover tab stays mounted beside the thread: a goal the assistant set during a turn shows up when that turn ends,
// without reopening the app (simulator, 2026-10-27: the tab still said nothing was tracked after the reply said "Goal set").
test('discover refetches when a turn ends', async () => {
  let goalCalls = 0
  const g9 = { id: 'g9', title: 'One coffee a day', plan: ['Log the cup'], notes: [], status: 'active' }
  const app = await open('./discover.harness.tsx', { ...base, network: net({ [`GET ${O}/goals`]: () => ({ body: ++goalCalls > 1 ? [g9] : [] }), [`GET ${O}/schedules`]: { body: [] }, [`GET ${O}/ideas`]: { body: [] }, [`GET ${O}/memory`]: { body: [] } }) })
  await app.waitFor('text:/Nori is not tracking anything yet/')
  await app.host.send('thread', [{ type: 'status', sessionId: 'main', running: true, statusText: 'Setting a goal' }])
  await app.wait(100)
  await app.host.send('thread', [{ type: 'status', sessionId: 'main', running: false }])
  await app.waitFor('id:goal-g9')
})
