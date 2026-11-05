// The assistant's profile — Activity, Permissions, Upcoming, Memory. The bot is mocked.
import { expect, open, test } from 'nsh/test'
const O = 'http://127.0.0.1:3850'
const me = { device: { id: 'd1', name: 'iPhone' }, assistant: { name: 'Nori' }, mainSessionId: 'main', connected: true }
const storage = (tab: string, lang = 'en') => ({ origin: O, token: 'tok_abcdefghijklmnopqrstuvwxyz0123456789', tab, lang })
const now = new Date().toISOString()
const net = {
  [`GET ${O}/me`]: { body: me }, [`POST ${O}/ws-ticket`]: { body: { ticket: 't' } }, [`GET ${O}/threads`]: { body: [] },
  [`GET ${O}/activity`]: { body: [
    { id: 'a1', at: now, kind: 'memory', text: 'Updated memory: Coffee with oat milk' },
    { id: 'a2', at: now, kind: 'schedule', text: 'Deleted reminder 3f2a9c1e' },
    { id: 'a3', at: '2026-10-01T03:00:00Z', kind: 'connector', text: 'Connected Linear' },
  ] },
  [`GET ${O}/schedules`]: { body: [{ id: 's1', name: 'Pay the rent', instruction: 'Remind me', when: { kind: 'daily', time: '09:00' }, nextRunAt: '2026-10-29T00:00:00Z', active: true }] },
  [`GET ${O}/connectors`]: { body: { connectors: [{ id: 'linear', name: 'Linear', preset: 'linear', transport: 'streamable-http', auth: 'oauth', enabled: true, missingEnv: [], connected: true }], catalog: [{ id: 'linear', name: 'Linear', description: 'Issues', transport: 'streamable-http', auth: 'oauth', envNames: [], hint: '', available: true }], env: {}, restartNeeded: false } },
  [`GET ${O}/memory`]: { body: [] },
}

test('the header: avatar with a pencil, the name, what it is doing; four segments, Activity first', async () => {
  const app = await open('./profile.harness.tsx', { storage: storage(''), network: net })
  await app.waitFor('id:tab-activity')
  expect(app.shows('text:Nori')).toBe(true)
  expect(app.shows('text:Online')).toBe(true)
  for (const k of ['activity', 'permissions', 'upcoming', 'memory']) expect(app.shows(`id:seg-${k}`)).toBe(true)
  await app.press('id:profile-edit')
  await app.waitUntil(() => app.storage().opened === 'settings')
})

test('Activity: by day, in plain words, no ids', async () => {
  const app = await open('./profile.harness.tsx', { storage: storage('activity'), network: net })
  await app.waitFor('id:act-a1')
  expect(app.shows('text:Today')).toBe(true)
  expect(app.shows('text:Earlier')).toBe(true)
  expect(app.shows('text:Remembered: Coffee with oat milk')).toBe(true)
  expect(app.shows('text:Removed a reminder')).toBe(true)
  expect(app.texts().some((x) => /3f2a9c1e|Updated memory/.test(x))).toBe(false)
})

test('Activity: while it works, the task sits on top with what it is doing and a stop button', async () => {
  const app = await open('./profile.harness.tsx', { storage: storage('activity'), network: net })
  await app.waitFor('id:tab-activity')
  await app.host.send('thread', [{ type: 'snapshot', sessionId: 'main', rows: [{ kind: 'you', id: 'u1', text: 'Find kids rain jackets', at: 1 }, { kind: 'step', id: 's1', name: 'web_search', description: 'Checking rain jacket stock in size small', at: 2 }], running: true, statusText: 'Checking rain jacket stock in size small…', title: '' }])
  await app.waitFor('id:activity-running')
  expect(app.shows('text:Find kids rain jackets')).toBe(true)
  expect(app.shows('text:Checking rain jacket stock in size small')).toBe(true)
  expect(app.shows('id:activity-stop')).toBe(true)
  expect(app.shows('text:/Checking rain jacket stock/')).toBe(true)
})

test('Permissions: the services it is signed in to, and Connectors', async () => {
  const app = await open('./profile.harness.tsx', { storage: storage('permissions'), network: net })
  await app.waitFor('id:perm-linear')
  expect(app.shows('text:/asks you before anything hard to undo/')).toBe(true)
  await app.press('id:perm-connectors')
  await app.waitFor('id:connectors')
})

test('Upcoming: reminders with when they come next', async () => {
  const app = await open('./profile.harness.tsx', { storage: storage('upcoming'), network: net })
  await app.waitFor('id:up-s1')
  expect(app.shows('text:Pay the rent')).toBe(true)
})

test('switching segments keeps one page: Memory shows its empty state', async () => {
  const app = await open('./profile.harness.tsx', { storage: storage('activity'), network: net })
  await app.waitFor('id:seg-memory')
  await app.press('id:seg-memory')
  await app.waitFor('text:/Nothing remembered yet/')
  expect(app.shows('id:tab-activity')).toBe(false)
})
