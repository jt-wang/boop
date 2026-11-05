// Headless UI tests for the connector pages (`cd mobile && nsh test connectors.test.tsx`). The bot is mocked.
// The flow: a row per service with Connect, the information step, Continue, the service's own sign-in.
// The states: waiting (Reopen / Cancel), failed (Try again), needs sign-in (Reconnect).
// Advanced keeps the old path (a folder, any MCP server) behind Show steps.
import { expect, open, test } from 'nsh/test'

const ORIGIN = 'http://127.0.0.1:3850'
const storage = { origin: ORIGIN, token: 'tok_abcdefghijklmnopqrstuvwxyz0123456789' }
const me = { device: { id: 'd1', name: 'iPhone' }, assistant: { name: 'Nori' }, mainSessionId: 'main', connected: true, pushPublicKey: null }
const oauth = (id: string, name: string, description: string, available = true) => ({ id, name, description, transport: 'streamable-http', url: `https://mcp.${id}.test/mcp`, auth: 'oauth', envNames: [], hint: '', available })
const catalog = [
  oauth('notion', 'Notion', 'Search, read and write your pages and databases.'),
  oauth('linear', 'Linear', 'Issues, projects and cycles.'),
  oauth('gmail', 'Gmail', 'Read, search and draft your email.', false),
  { id: 'filesystem', name: 'Files on this computer', description: 'Read and change files in one folder you pick.', transport: 'stdio', envNames: [], needsPath: true, hint: 'Pick one folder.', available: true },
  { id: 'custom', name: 'Custom MCP server', description: 'Any MCP server.', transport: 'stdio', envNames: [], custom: true, hint: 'Keys stay on the computer.', available: true },
]
const linearConnected = { id: 'linear', name: 'Linear', preset: 'linear', transport: 'streamable-http', url: 'https://mcp.linear.test/mcp', auth: 'oauth', envNames: [], enabled: true, missingEnv: [], connected: true }
const notionConnected = { ...linearConnected, id: 'notion', name: 'Notion', preset: 'notion', url: 'https://mcp.notion.test/mcp' }
const folder = { id: 'filesystem', name: 'Files on this computer', preset: 'filesystem', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem@1.0.0', '/home/demo/Documents'], envNames: [], enabled: false, missingEnv: [], connected: false }
const view = (connectors: unknown[], restartNeeded = false) => ({ body: { connectors, catalog, env: {}, restartNeeded } })
const base = { [`GET ${ORIGIN}/me`]: { body: me }, [`POST ${ORIGIN}/ws-ticket`]: { body: { ticket: 'ticket' } } }
const AUTH_URL = 'https://mcp.notion.test/authorize?client_id=dcr_1&state=s1'

test('the list: connected services first (tap for details), then the ones to connect with a Connect pill; services this computer cannot offer are not listed; nothing technical', async () => {
  const app = await open('./connectors.harness.tsx', { storage, network: { ...base, [`GET ${ORIGIN}/connectors`]: view([linearConnected, folder]) } })
  await app.waitFor('id:service-notion')
  const texts = app.texts()
  expect(texts.indexOf('Linear')).toBeLessThan(texts.indexOf('Notion'))
  expect(app.shows('text:Available')).toBe(true)
  expect(app.shows('id:connect-notion')).toBe(true)
  expect(app.shows('id:connect-linear')).toBe(false)
  expect(app.shows('id:service-linear >> text:Connected')).toBe(true)
  // Gmail has no client on this computer: not listed at all
  expect(app.shows('id:service-gmail')).toBe(false)
  expect(app.shows('text:Gmail')).toBe(false)
  expect(app.texts().some((x) => /_TOKEN|https?:\/\/|restart|mcp|oauth|npx|\/home\//i.test(x))).toBe(false)
  expect(app.shows('id:restart-needed')).toBe(false)
  // the old-style connector keeps its switch and its remove; adding more lives behind "Show steps"
  expect(app.shows('id:toggle-filesystem')).toBe(true)
  expect(app.shows('id:remove-filesystem')).toBe(true)
  expect(app.shows('id:add')).toBe(false)
})

test('Connect opens the information step first (what it can do, where the sign-in lives); Continue asks the bot, opens the sign-in, waits with Reopen and Cancel, then shows Connected', async () => {
  let polls = 0
  const app = await open('./connectors.harness.tsx', { storage, network: { ...base,
    [`GET ${ORIGIN}/connectors`]: () => { polls++; return view(polls >= 5 ? [notionConnected] : []) },
    [`POST ${ORIGIN}/connectors/notion/connect`]: { body: { url: AUTH_URL } },
  } })
  await app.waitFor('id:connect-notion')
  await app.press('id:connect-notion')
  await app.waitFor('id:connector-continue')
  expect(app.shows('text:What it can do')).toBe(true)
  expect(app.shows('text:Find and read your pages')).toBe(true)
  expect(app.shows('text:/never sees your password/')).toBe(true)
  expect(app.requests().some((r) => r.url.endsWith('/connect'))).toBe(false)
  await app.press('id:connector-continue')
  await app.waitUntil(() => app.openedUrls().length === 1)
  expect(app.openedUrls()[0]).toBe(AUTH_URL)
  await app.waitFor('id:connector-reopen')
  expect(app.shows('text:Connecting…')).toBe(true)
  expect(app.shows('text:/finish signing in to Notion/')).toBe(true)
  await app.press('id:connector-reopen')
  expect(app.openedUrls()).toEqual([AUTH_URL, AUTH_URL])
  await app.waitFor('id:connector-try')
  expect(app.shows('text:Connected')).toBe(true)
  await app.waitFor('text:Notion connected')
  expect(app.shows('id:remove-notion')).toBe(true)
  // the token never reaches the phone: the app only ever asked for the list and the sign-in URL
  expect(app.requests().every((r) => !/token|secret/i.test(String(r.body ?? '')))).toBe(true)
})

test('Cancel while waiting goes back to Continue; nothing is connected', async () => {
  const app = await open('./connectors.harness.tsx', { storage, network: { ...base, [`GET ${ORIGIN}/connectors`]: view([]), [`POST ${ORIGIN}/connectors/notion/connect`]: { body: { url: AUTH_URL } } } })
  await app.waitFor('id:open-notion')
  await app.press('id:open-notion')
  await app.press('id:connector-continue')
  await app.waitFor('id:connector-cancel')
  await app.press('id:connector-cancel')
  await app.waitFor('id:connector-continue')
})

test('when the bot cannot start the sign-in, the page says why and offers Try again; the list says it did not finish', async () => {
  const app = await open('./connectors.harness.tsx', { storage, network: { ...base, [`GET ${ORIGIN}/connectors`]: view([]), [`POST ${ORIGIN}/connectors/notion/connect`]: { status: 400, body: { error: 'Notion only connects over a secure address.' } } } })
  await app.waitFor('id:open-notion')
  await app.press('id:open-notion')
  await app.press('id:connector-continue')
  await app.waitFor('id:connector-retry')
  expect(app.shows('id:connector-failed')).toBe(true)
  expect(app.shows('text:Notion only connects over a secure address.')).toBe(true)
  expect(app.openedUrls().length).toBe(0)
  await app.back()
  await app.waitFor('id:service-notion >> text:Try again')
})

test('a service that lost its sign-in says "Needs sign-in" with Reconnect, which starts the sign-in again', async () => {
  const stale = { ...notionConnected, connected: false }
  const app = await open('./connectors.harness.tsx', { storage, network: { ...base, [`GET ${ORIGIN}/connectors`]: view([stale]), [`POST ${ORIGIN}/connectors/notion/connect`]: { body: { url: AUTH_URL } } } })
  await app.waitFor('id:reconnect-notion')
  expect(app.shows('id:service-notion >> text:Needs sign-in')).toBe(true)
  await app.press('id:reconnect-notion')
  await app.waitUntil(() => app.openedUrls().length === 1)
})

test('a connected service: Try it sends a question to the thread; Disconnect asks first (what stays in memory), then deletes', async () => {
  const app = await open('./connectors.harness.tsx', { storage, network: { ...base, [`GET ${ORIGIN}/connectors`]: view([linearConnected]), [`DELETE ${ORIGIN}/connectors/linear`]: { body: { ok: true } }, [`POST ${ORIGIN}/threads/main/messages`]: { body: { ok: true } }, [`GET ${ORIGIN}/threads`]: { body: [] } } })
  await app.waitFor('id:open-linear')
  await app.press('id:open-linear')
  await app.waitFor('id:connector-try')
  await app.press('id:connector-try')
  await app.waitUntil(() => app.requests().some((r) => r.url.endsWith('/threads/main/messages')))
  expect(JSON.parse(String(app.requests().find((r) => r.url.endsWith('/threads/main/messages'))!.body)).text).toBe('What can you do with my Linear?')
  await app.waitFor('id:open-linear')
  await app.press('id:open-linear')
  await app.waitFor('id:remove-linear')
  app.onDialog(() => 'Disconnect')
  await app.press('id:remove-linear')
  await app.waitUntil(() => app.requests().some((r) => r.method === 'DELETE' && r.url.endsWith('/connectors/linear')))
  expect(app.dialogs()[0].title).toBe('Disconnect Linear?')
  expect(String(app.dialogs()[0].message)).toMatch(/stays in its memory/)
  await app.waitFor('text:Removed')
})

test('the restart notice shows only when the bot says a restart is needed (profiles without live reload)', async () => {
  const app = await open('./connectors.harness.tsx', { storage, network: { ...base, [`GET ${ORIGIN}/connectors`]: view([folder], true) } })
  await app.waitFor('id:restart-needed')
  expect(app.shows('text:/Restart Boop on your computer/')).toBe(true)
})

test('Advanced: the folder preset needs a path; a server error is shown, not swallowed; one-tap services are not listed there', async () => {
  const app = await open('./connectors.harness.tsx', { storage: { ...storage, showWork: '1' }, network: { ...base, [`GET ${ORIGIN}/connectors`]: view([]), [`POST ${ORIGIN}/connectors`]: { status: 400, body: { error: 'that folder does not exist on the computer' } } } })
  await app.waitFor('id:add')
  await app.press('id:add')
  await app.waitFor('id:preset-filesystem')
  expect(app.shows('id:preset-notion')).toBe(false)
  await app.press('id:preset-filesystem')
  await app.waitFor('id:folder')
  expect(app.enabled('id:add-filesystem')).toBe(false)
  await app.type('id:folder', '/home/demo/nope')
  await app.press('id:add-filesystem')
  await app.waitFor('text:/that folder does not exist/')
  expect(JSON.parse(String(app.requests().find((r) => r.method === 'POST' && r.url.endsWith('/connectors'))!.body))).toEqual({ preset: 'filesystem', path: '/home/demo/nope' })
})

test('Advanced: a custom server asks for confirmation and posts custom: true with env var names only; the toggle on an old-style connector PATCHes', async () => {
  const app = await open('./connectors.harness.tsx', { storage: { ...storage, showWork: '1' }, network: { ...base, [`GET ${ORIGIN}/connectors`]: view([folder]), [`PATCH ${ORIGIN}/connectors/filesystem`]: { body: { ...folder, enabled: true } }, [`POST ${ORIGIN}/connectors`]: { body: { id: 'my-server', enabled: true, missingEnv: ['MY_KEY'] } } } })
  await app.waitFor('id:toggle-filesystem')
  await app.press('id:toggle-filesystem')
  await app.waitUntil(() => app.requests().some((r) => r.method === 'PATCH' && r.url.endsWith('/connectors/filesystem')))
  expect(JSON.parse(String(app.requests().find((r) => r.method === 'PATCH')!.body))).toEqual({ enabled: true })
  await app.press('id:add')
  await app.press('id:preset-custom')
  await app.waitFor('id:custom-name')
  await app.type('id:custom-name', 'My server')
  await app.type('id:custom-command', 'my-mcp')
  await app.type('id:custom-args', '--flag')
  await app.type('id:custom-env', 'MY_KEY')
  await app.press('id:custom-add')
  await app.waitFor('id:custom-confirm')
  expect(app.shows('text:/Only add servers you trust/')).toBe(true)
  expect(app.requests().some((r) => r.method === 'POST' && r.url.endsWith('/connectors'))).toBe(false)
  await app.press('id:custom-confirm-add')
  await app.waitUntil(() => app.requests().some((r) => r.method === 'POST' && r.url.endsWith('/connectors')))
  const body = JSON.parse(String(app.requests().find((r) => r.method === 'POST' && r.url.endsWith('/connectors'))!.body))
  expect(body).toEqual({ custom: true, name: 'My server', transport: 'stdio', envNames: ['MY_KEY'], command: 'my-mcp', args: ['--flag'] })
  await app.waitFor('text:Added.')
})
