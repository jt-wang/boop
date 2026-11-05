// The layout guard: no page's content starts under its header. Started with `layoutGuard` in storage, each page writes where
// its first row starts and where the header ends (ui.tsx `TopProbe`); this walks every screen and fails when a
// first row's top is above the header's bottom. Headless it runs as Android, where the bug was (2026-10-27: list
// pages started under the toolbar; the chat's empty state under the floating header). It covers the assistant's
// profile and each of its segments, a connector's page (connected and not) and the memory edit page. The same file runs on the
// devices: `nsh test --target android layout.test.tsx`, `--target ios` (iOS large titles are inset by UIKit, which
// a headless run does not draw, so headless covers Android only).
import { expect, open, test } from 'nsh/test'

const ORIGIN = 'https://computer.example.com'
const TOKEN = 'tok_abcdefghijklmnopqrstuvwxyz0123456789'
const me = { device: { id: 'd1', name: 'Phone' }, assistant: { name: 'Nori' }, mainSessionId: 'main', connected: true, pushPublicKey: null }
const network = {
  [`GET ${ORIGIN}/me`]: { body: me },
  [`GET ${ORIGIN}/threads`]: { body: [{ sessionId: 'main', title: '', updatedAt: 1700000000000, running: false, blank: false }] },
  [`POST ${ORIGIN}/ws-ticket`]: { status: 500, body: {} },
  [`PUT ${ORIGIN}/me/context`]: { body: { ok: true } },
  [`GET ${ORIGIN}/usage`]: { body: { today: { inputTokens: 1200, cachedTokens: 300, outputTokens: 80, sessions: 1 }, sessions: [] } },
  // one service connected, one to connect: the list, then a service's own page
  [`GET ${ORIGIN}/connectors`]: { body: { connectors: [{ id: 'notion', name: 'Notion', preset: 'notion', transport: 'streamable-http', url: 'https://mcp.notion.test/mcp', auth: 'oauth', envNames: [], enabled: true, missingEnv: [], connected: true }], catalog: [
    { id: 'notion', name: 'Notion', description: 'Pages and databases.', transport: 'streamable-http', auth: 'oauth', envNames: [], hint: '', available: true },
    { id: 'linear', name: 'Linear', description: 'Issues.', transport: 'streamable-http', auth: 'oauth', envNames: [], hint: '', available: true },
  ], env: {}, restartNeeded: false } },
  [`GET ${ORIGIN}/activity`]: { body: [] },
  [`GET ${ORIGIN}/devices`]: { body: [] },
  [`GET ${ORIGIN}/memory`]: { body: [{ id: 'user:1', file: 'user', kind: 'preference', text: 'Likes short answers', date: '2026-10-27' }] },
  [`GET ${ORIGIN}/goals`]: { body: [] },
  [`GET ${ORIGIN}/schedules`]: { body: [] },
  [`GET ${ORIGIN}/ideas`]: { body: [] },
  [`GET ${ORIGIN}/library`]: { body: [] },
  [`POST ${ORIGIN}/api/session/list`]: { body: { result: { ok: true, value: { items: [] } } } },
}

type Report = { page: string; top: number; headerBottom: number }
type App = Awaited<ReturnType<typeof open>>
const reports = (app: App): Report[] => { try { return JSON.parse(app.storage().layout ?? '[]') } catch { return [] } }
const latest = (app: App, page: string) => reports(app).filter((r) => r.page === page).pop()
const seen = async (app: App, page: string) => { await app.waitUntil(() => Boolean(latest(app, page)), { timeout: 8000 }) }
const describeBad = (rs: Report[]) => rs.filter((r) => r.top < r.headerBottom).map((r) => `${r.page}: content at ${r.top}, header ends at ${r.headerBottom}`)

for (const scheme of ['light', 'dark'] as const) {
  test(`every screen (${scheme}): the first row starts below the header, the keyboard up or down`, async () => {
    const app = await open('./App.tsx', { platform: 'android', colorScheme: scheme, network, storage: { origin: ORIGIN, token: TOKEN, lang: 'en', layoutGuard: '1' } })
    // the empty thread shows once the bot said the thread is empty
    await app.waitFor('id:composer')
    for (let i = 0; i < 50 && !latest(app, 'ChatScreen'); i++) { await app.host.send('thread', [{ type: 'snapshot', sessionId: 'main', rows: [], running: false, statusText: '', title: '' }]); await app.wait(100) }
    await seen(app, 'ChatScreen')
    const checked: Report[] = [latest(app, 'ChatScreen')!]
    // the keyboard up over the chat (on a device it shows; headless the composer only takes the focus)
    await app.type('id:composer', 'x')
    await app.wait(1500)
    checked.push(latest(app, 'ChatScreen')!)
    const visit = async (press: string, page: string) => { await app.press(press); await seen(app, page); await app.wait(1200); checked.push(latest(app, page)!) }
    await visit('label:Settings', 'SettingsPage')
    await visit('text:Connectors', 'ConnectorsPage')
    await visit('id:open-notion', 'ConnectorPage'); await app.back()
    await visit('id:open-linear', 'ConnectorPage'); await app.back()
    await app.back()
    await visit('text:Usage', 'UsagePage'); await app.back()
    await visit('text:Activity', 'ActivityPage'); await app.back()
    await visit('text:Devices', 'DevicesPage'); await app.back()
    await visit('id:memory-row', 'ProfilePage/memory')
    await visit('id:mem-user-1', 'MemoryEditPage')
    await app.type('id:memory-text', ' x') // the keyboard up over the edit page
    await app.wait(1200); checked.push(latest(app, 'MemoryEditPage')!)
    await app.back()
    await app.back()
    await app.back()
    // the assistant's profile from the chat's header, every segment
    await visit('id:status', 'ProfilePage/activity')
    for (const seg of ['permissions', 'upcoming', 'memory'] as const) await visit(`id:seg-${seg}`, `ProfilePage/${seg}`)
    await app.back()
    await visit('label:Menu', 'MenuPage')
    await visit('text:Upcoming', 'UpcomingPage'); await app.back()
    await visit('text:Goals', 'GoalsPage'); await app.back()
    await visit('text:Library', 'LibraryPage'); await app.back()
    await app.back()
    await app.host.send('tab', 1)
    await seen(app, 'DiscoverPage'); await app.wait(1500)
    checked.push(latest(app, 'DiscoverPage')!)
    expect(describeBad(checked)).toEqual([])
    expect(checked.length).toBe(21)
  }, 240000)
}

// While it works, the live activity (its current step, and the list of steps when opened) sits under the header and
// is part of it: no message may start under it (the owner, Android APK, 2026-10-27: 「发给你，指标再补」 showed behind
// 「生成界面」 and its steps). The thread reports where its first row starts and where the whole top chrome ends.
test('while it works: the first message starts below the header and the live activity, opened or not', async () => {
  const AT = 1700000000000
  const rows = [
    { kind: 'you', id: 'u1', text: 'Make me a chart of INTC and HOOD', at: AT },
    { kind: 'them', id: 'a1', text: 'On it — I will send it to you, the indicators come next.', at: AT },
    { kind: 'you', id: 'u2', text: 'Thanks', at: AT },
    { kind: 'step', id: 's1', name: 'mcp__bot__ui', description: 'Building the chart', at: AT, output: 'ok' },
    { kind: 'step', id: 's2', name: 'bash', description: 'Fetching prices', at: AT },
  ]
  const app = await open('./App.tsx', { platform: 'android', network, storage: { origin: ORIGIN, token: TOKEN, lang: 'en', layoutGuard: '1' } })
  await app.waitFor('id:composer')
  await app.host.send('thread', [{ type: 'snapshot', sessionId: 'main', rows, running: true, statusText: 'Working…', title: '' }])
  await app.waitFor('id:activity-live')
  await seen(app, 'ChatThread'); await app.wait(1500)
  const closed = latest(app, 'ChatThread')!
  await app.press('id:activity-live'); await app.wait(1500)
  const opened = latest(app, 'ChatThread')!
  expect(describeBad([closed, opened])).toEqual([])
}, 60000)
