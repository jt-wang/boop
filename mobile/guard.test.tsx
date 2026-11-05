// An automated guard for these screens: in a Chinese session every word a person
// reads is Chinese (service names excepted), and nothing internal shows — no tool names, permission names, ids,
// paths, env vars, addresses, time-zone ids or locale tags. Add to INTERNAL whenever a person finds a new leak.
import { expect, open, test } from 'nsh/test'

const O = 'http://127.0.0.1:3850'
const AT = 1700000000000
const INTERNAL = /\btokens?\b|mcp__|danger-full-access|workspace-write|\bbash\b|\/data\/|DEEPSEEK_|config\.json|_TOKEN|https?:\/\/|oauth|npx|(?:America|Europe|Pacific)\/[A-Z]|zh-CN|toolName|session|\bid\b|[0-9a-f]{8,}/i
/** Words allowed in a Chinese screen: the services' and the assistant's names. */
const NAMES = /Notion|Linear|Jira|Confluence|GitHub|Slack|Gmail|Google|Drive|Acme Pages|Acme|Nori|Quarterly Garden Plan 7Q4/g
const english = (t: string) => /[A-Za-z]{2,}/.test(t.replace(NAMES, ''))
/** The guard itself is checked against a screen known to fail (guard.test.tsx, last test). */
const verdict = (texts: string[]) => ({ leaks: texts.filter((t) => INTERNAL.test(t)), foreign: texts.filter(english) })
const check = (app: { texts(): string[] }, where: string) => {
  const leaks = app.texts().filter((t) => INTERNAL.test(t))
  const foreign = app.texts().filter(english)
  expect({ where, leaks, foreign }).toEqual({ where, leaks: [], foreign: [] })
}

const me = { device: { id: 'd1', name: 'iPhone' }, assistant: { name: 'Nori' }, mainSessionId: 'main', connected: true, pushPublicKey: null }
const oauth = (id: string, name: string, available = true) => ({ id, name, description: `${name} things.`, transport: 'streamable-http', url: `https://mcp.${id}.test/mcp`, auth: 'oauth', envNames: [], hint: '', available })
const connectors = { body: { connectors: [
  { id: 'linear', name: 'Linear', preset: 'linear', transport: 'streamable-http', url: 'https://mcp.linear.test/mcp', auth: 'oauth', enabled: true, missingEnv: [], connected: true },
  { id: 'atlassian', name: 'Jira and Confluence', preset: 'atlassian', transport: 'streamable-http', auth: 'oauth', enabled: true, missingEnv: [], connected: false },
  { id: 'filesystem', name: 'Files on this computer', preset: 'filesystem', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem@1.0.0', '/home/demo/Documents'], envNames: [], enabled: true, missingEnv: [], connected: true },
], catalog: [oauth('notion', 'Notion'), oauth('linear', 'Linear'), oauth('atlassian', 'Jira and Confluence'), oauth('gmail', 'Gmail', false), oauth('acme-pages', 'Acme Pages'),
  { id: 'filesystem', name: 'Files on this computer', description: 'Read and change files in one folder you pick.', transport: 'stdio', envNames: [], needsPath: true, hint: 'Pick one folder.', available: true }], env: {}, restartNeeded: false } }
const memory = { body: [
  { id: 'user:a1b2c3d4e5f6', file: 'user', kind: 'fact', text: '称呼他老王', date: '2026-10-27' },
  { id: 'memory:0a1b2c3d4e5f', file: 'memory', kind: 'project', text: '在等房东回复续租，周五前答复', date: '2026-10-27' },
  { id: 'memory:9f8e7d6c5b4a', file: 'memory', kind: 'person', text: '女儿小雨，学钢琴', date: '2026-10-26' },
] }
const net = {
  [`GET ${O}/me`]: { body: me }, [`POST ${O}/ws-ticket`]: { body: { ticket: 't' } }, [`GET ${O}/threads`]: { body: [] }, [`PUT ${O}/me/context`]: { body: { ok: true } },
  [`GET ${O}/activity`]: { body: [
    { id: 'a1', at: new Date().toISOString(), kind: 'memory', text: 'Updated memory: 咖啡只喝燕麦奶拿铁' },
    { id: 'a2', at: new Date().toISOString(), kind: 'schedule', text: 'Updated "交房租" — next 2026-10-29T11:00:00.000Z' },
    { id: 'a3', at: new Date().toISOString(), kind: 'schedule', text: 'Deleted reminder 3f2a9c1e77' },
    { id: 'a4', at: new Date().toISOString(), kind: 'connector', text: 'Connected Linear' },
    { id: 'a5', at: new Date().toISOString(), kind: 'ideas', text: '2 new ideas: 找咖啡店; 回顾这周' },
  ] },
  [`GET ${O}/schedules`]: { body: [{ id: 'sched-1', name: '交房租', instruction: '提醒我交房租', when: { kind: 'daily', time: '09:00', timeZone: 'America/New_York' }, nextRunAt: '2026-10-29T00:00:00Z', active: true }] },
  [`GET ${O}/goals`]: { body: [{ id: 'g1', title: '三个月跑完 10 公里', plan: ['每周跑三次'], notes: [], status: 'active' }] },
  [`GET ${O}/ideas`]: { body: [{ id: 'i1', title: '我可以帮你找一家有燕麦奶拿铁的咖啡店', body: '你下午三点多常想喝一杯。', action: '帮我找咖啡店' }] },
  [`GET ${O}/connectors`]: connectors,
  [`GET ${O}/memory`]: memory,
  [`POST ${O}/connectors/notion/connect`]: { status: 400, body: { error: '没能开始登录，再试一次。' } },
}
const storage = (tab: string) => ({ origin: O, token: 'tok_abcdefghijklmnopqrstuvwxyz0123456789', lang: 'zh', tab })

test('profile, every segment, in Chinese: one language, nothing internal', async () => {
  const app = await open('./profile.harness.tsx', { storage: storage('activity'), network: net })
  await app.waitFor('id:act-a1')
  check(app, 'activity')
  for (const k of ['permissions', 'upcoming', 'memory']) {
    await app.press(`id:seg-${k}`)
    await app.wait(300)
    check(app, k)
  }
  await app.press('id:mem-memory-0a1b2c3d4e5f')
  await app.waitFor('id:memory-text')
  check(app, 'memory edit')
})

test('connectors list and one connector, in Chinese, in every state: one language, nothing internal, nothing that cannot be used', async () => {
  const app = await open('./profile.harness.tsx', { storage: storage('permissions'), network: net })
  await app.waitFor('id:perm-connectors')
  await app.press('id:perm-connectors')
  await app.waitFor('id:service-notion')
  check(app, 'connectors')
  expect(app.shows('text:Gmail')).toBe(false)
  expect(app.shows('text:需要重新登录')).toBe(true)
  await app.press('id:open-notion')
  await app.waitFor('id:connector-continue')
  check(app, 'connector: not connected')
  await app.press('id:connector-continue')
  await app.waitFor('id:connector-retry')
  check(app, 'connector: failed')
  await app.back()
  await app.waitFor('id:open-linear')
  await app.press('id:open-linear')
  await app.waitFor('id:connector-try')
  check(app, 'connector: connected')
})

test('discover in Chinese: one language, nothing internal; an approval without a reason never shows the tool', async () => {
  const app = await open('./discover.harness.tsx', { storage: storage(''), network: { ...net, [`GET ${O}/asks`]: { body: [] } } })
  await app.waitFor('id:tracking')
  await app.host.send('asks', [{ kind: 'approval', eventId: 'e1', sessionId: 'main', request: { toolName: 'bash' }, at: AT }])
  await app.waitFor('id:need-e1')
  check(app, 'discover')
})

test('a Chinese thread that used a service and remembered something: one language, nothing internal', async () => {
  const app = await open('./chat.fixture.tsx', { storage: { lang: 'zh' }, network: net })
  await app.host.send('thread', [{ type: 'snapshot', sessionId: 'main', running: false, statusText: '', title: '', rows: [
    { kind: 'you', id: 'u1', text: '帮我在 Acme Pages 找花园计划，顺便记住我只喝燕麦奶', at: AT },
    { kind: 'step', id: 's1', name: 'mcp__acme-pages__search_pages', command: 'garden', output: '[]', at: AT + 1000 },
    { kind: 'step', id: 's2', name: 'mcp__bot__remember', command: '咖啡只喝燕麦奶拿铁', output: 'Saved (preference).', at: AT + 2000 },
    { kind: 'them', id: 't1', text: '找到了：Quarterly Garden Plan 7Q4。', at: AT + 4000 },
  ] }])
  await app.waitFor('id:svc-card-acme-pages')
  await app.press('text:/做了 2 件事/')
  await app.wait(300)
  check(app, 'thread')
})

// QA 2026-10-28: Usage said 「助理用掉的 token 数」.
test('usage in Chinese: one language, nothing internal', async () => {
  const app = await open('./App.tsx', { storage: { origin: O, token: 'tok_abcdefghijklmnopqrstuvwxyz0123456789', lang: 'zh' }, network: { ...net,
    [`GET ${O}/usage`]: { body: { today: { inputTokens: 12345, cachedTokens: 678, outputTokens: 90, sessions: 1 }, sessions: [] } } } })
  await app.press('label:设置')
  await app.press('text:用量')
  await app.waitFor('text:12,345')
  check(app, 'usage')
})

test('the guard catches what it is for: English words, tool names, ids and time-zone ids in a Chinese screen', () => {
  expect(verdict(['记下了：咖啡', '使用 Notion', '用了 2 次']).leaks.length + verdict(['记下了：咖啡', '使用 Notion', '用了 2 次']).foreign.length).toBe(0)
  expect(verdict(['Updated memory: 咖啡']).foreign).toEqual(['Updated memory: 咖啡'])
  expect(verdict(['search pages']).foreign).toEqual(['search pages'])
  expect(verdict(['mcp__notion__search']).leaks.length).toBe(1)
  expect(verdict(['住在葡萄牙（时区 America/New_York）']).leaks.length).toBe(1)
  expect(verdict(['使用中文（zh-CN）交流']).leaks.length).toBe(1)
  expect(verdict(['删除提醒 3f2a9c1e77']).leaks.length).toBe(1)
  expect(verdict(['bash']).leaks.length).toBe(1)
  expect(verdict(['助理用掉的 token 数']).leaks.length).toBe(1)
})
