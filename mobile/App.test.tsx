// Headless UI tests (`nsh test mobile`). The bot is mocked with network routes.
// The /events WebSocket cannot be stubbed headless, so tests hand thread frames
// to the app the way an embedding host does: `app.host.send('thread', frames)`
// (state.ts applies them exactly as the socket handler does).
import { expect, open, test } from 'nsh/test'
import { isHostedOrigin } from './src/hosted.ts'

const ORIGIN = 'http://127.0.0.1:3850'
const TOKEN = 'tok_abcdefghijklmnopqrstuvwxyz0123456789'
const meBody = (name: string) => ({ device: { id: 'd1', name: 'iPhone' }, assistant: { name }, mainSessionId: 'main', connected: true, pushPublicKey: null })
const paired = { origin: ORIGIN, token: TOKEN }
const threads = [{ sessionId: 'main', title: '', updatedAt: 1700000000000, running: false, blank: false }]

// Rows and frames of bot's own thread protocol (src/thread.ts, src/fold.ts).
const AT = 1700000000000
const you = (text: string, id = 'u1') => ({ kind: 'you', id, text, at: AT })
const them = (text: string, id = 'a1', streaming = false) => ({ kind: 'them', id, text, at: AT, streaming })
const step = (id: string, name: string, extra: Record<string, unknown> = {}) => ({ kind: 'step', id, name, at: AT, ...extra })
const notice = (text: string, id = 'n1') => ({ kind: 'notice', id, text, at: AT })
const snapshot = (rows: unknown[], running = false, statusText = running ? 'Working…' : '') => ({ type: 'snapshot', sessionId: 'main', rows, running, statusText, title: '' })
const rowsFrame = (rows: unknown[]) => ({ type: 'rows', sessionId: 'main', rows })
const status = (running: boolean, statusText = '') => ({ type: 'status', sessionId: 'main', running, statusText })

/** The bot answered that the main thread is empty (the empty state shows only then): the frame goes once the app follows it. */
const emptyReady = async (app: Awaited<ReturnType<typeof open>>) => {
  await app.waitFor('id:composer')
  for (let i = 0; i < 50 && !app.shows('text:/Say hi to Nori/'); i++) { await app.host.send('thread', [snapshot([])]); await app.wait(100) }
  await app.waitFor('text:/Say hi to Nori/')
}

const chatApp = (routes: Record<string, unknown> = {}) => open('./App.tsx', {
  storage: paired,
  network: { [`GET ${ORIGIN}/me`]: { body: meBody('Nori') }, [`GET ${ORIGIN}/threads`]: { body: threads }, ...routes },
})

// Opening the app with history: the owner saw the empty thread (the avatar and three starters) for seconds, then
// the history replaced it (Android APK, 2026-10-27). The app took "not loaded yet" for "empty". It shows the thread it
// kept from last time at once, asks the bot in the background, and shows the empty state only when the bot said so.
const neverStarters = async (app: Awaited<ReturnType<typeof open>>, ms: number) => {
  for (let t = 0; t < ms; t += 100) { expect(app.shows('id:starter-0')).toBe(false); expect(app.shows('id:empty-thread')).toBe(false); await app.wait(100) }
}
test('cold start with history over a slow connection: the kept thread shows at once, never the starters', async () => {
  const kept = [you('What is on today?'), them('Two meetings and the dentist at 4.')]
  const app = await open('./App.tsx', {
    storage: { ...paired, me: JSON.stringify(meBody('Nori')), 'thread:main': JSON.stringify(kept) },
    network: { [`GET ${ORIGIN}/me`]: { body: meBody('Nori'), delay: 2500 }, [`GET ${ORIGIN}/threads`]: { body: threads, delay: 2500 } },
  })
  await app.waitFor('text:Two meetings and the dentist at 4.', { timeout: 1500 })
  await neverStarters(app, 3000)
  await app.host.send('thread', [snapshot([...kept, you('And tomorrow?', 'u2'), them('Nothing yet.', 'a2')])])
  await app.waitFor('text:Nothing yet.')
  await neverStarters(app, 500)
})
test('nothing kept and the bot slow: nothing until it answers; the empty state once it says the thread is empty', async () => {
  const app = await open('./App.tsx', { storage: { ...paired, me: JSON.stringify(meBody('Nori')) }, network: { [`GET ${ORIGIN}/me`]: { body: meBody('Nori') }, [`GET ${ORIGIN}/threads`]: { body: threads, delay: 1500 } } })
  await app.waitFor('id:composer')
  await neverStarters(app, 2500)
  await app.host.send('thread', [snapshot([])])
  await app.waitFor('id:starter-0')
})

test('connect screen pairs with the address and code, then asks for a name', async () => {
  const app = await open('./App.tsx', {
    network: {
      [`POST ${ORIGIN}/pair`]: { body: { token: TOKEN } },
      [`GET ${ORIGIN}/me`]: { body: meBody('') },
    },
  })
  await app.press('id:own-computer')
  await app.waitFor('text:Connect to your computer')
  await app.type('id:address', `${ORIGIN}/pair?code=123456`)
  await app.press('id:connect')
  await app.waitFor('text:What will you call your assistant?')
  const posted = app.requests().find((r) => r.url.endsWith('/pair'))
  expect(Boolean(posted)).toBe(true)
  expect(JSON.parse(String(posted!.body)).code).toBe('123456')
})

// First run: a welcome screen; Start = a hosted computer,
// "I have my own computer" = address + code.
const HOST = 'http://host.test'
test('the welcome screen leads to the connect screen through "own computer"', async () => {
  const app = await open('./App.tsx', { host: { params: { hostUrl: HOST } } })
  await app.waitFor('text:/own computer/')
  expect(app.shows('id:start')).toBe(true)
  await app.press('id:own-computer')
  await app.waitFor('text:Connect to your computer')
})

// A host that only lets in people its owner approved asks for the owner's access code with the email.
test('a host that needs an access code: the sign-in screen asks for it and sends it; a wrong one is explained', async () => {
  let attempt = 0
  const app = await open('./App.tsx', {
    host: { params: { hostUrl: HOST } },
    network: {
      [`GET ${HOST}/host/config`]: { body: { codeRequired: true, apple: false } },
      [`POST ${HOST}/host/sign-in`]: () => (++attempt === 1 ? { status: 403, body: { error: 'that access code is not right' } } : { body: { accountToken: 'acc_1' } }),
      [`POST ${HOST}/host/sandbox`]: { body: { state: 'ready', origin: ORIGIN, token: TOKEN } },
      [`GET ${HOST}/host/sandbox`]: { body: { state: 'ready', origin: ORIGIN, token: TOKEN } },
      [`GET ${ORIGIN}/me`]: { body: meBody('') },
    },
  })
  await app.press('id:start')
  await app.waitFor('id:access-code')
  await app.type('id:email', 'sam@example.com')
  await app.type('id:access-code', 'wrong')
  await app.press('id:sign-in')
  await app.waitFor('text:/access code/i')
  await app.clear('id:access-code')
  await app.type('id:access-code', 'right-code')
  await app.press('id:sign-in')
  await app.waitFor('text:What will you call your assistant?', { timeout: 15000 })
  const sent = app.requests().filter((r) => r.url.endsWith('/host/sign-in')).map((r) => JSON.parse(String(r.body)))
  expect(sent[1]).toEqual({ email: 'sam@example.com', code: 'right-code' })
})

test('Start signs in, waits for the hosted computer, then asks for a name', async () => {
  let polls = 0
  const app = await open('./App.tsx', {
    host: { params: { hostUrl: HOST } },
    network: {
      [`POST ${HOST}/host/sign-in`]: { body: { accountToken: 'acc_1' } },
      [`POST ${HOST}/host/sandbox`]: { body: { state: 'creating' } },
      [`GET ${HOST}/host/sandbox`]: () => ({ body: ++polls < 2 ? { state: 'creating' } : { state: 'ready', origin: ORIGIN, token: TOKEN } }),
      [`GET ${ORIGIN}/me`]: { body: meBody('') },
    },
  })
  await app.press('id:start')
  await app.waitFor('id:email')
  await app.type('id:email', 'sam@example.com')
  await app.press('id:sign-in')
  await app.waitFor('text:/Setting up its computer/')
  await app.waitFor('text:What will you call your assistant?', { timeout: 15000 })
  const signIn = app.requests().find((r) => r.url.endsWith('/host/sign-in'))
  expect(JSON.parse(String(signIn!.body)).email).toBe('sam@example.com')
  const sandbox = app.requests().find((r) => r.url.endsWith('/host/sandbox') && r.method === 'POST')
  expect(sandbox!.headers['authorization']).toBe('Bearer acc_1')
  expect(app.storage().token).toBe(TOKEN)
  expect(app.storage().hostedBy).toBe(HOST) // the computer came from this host: Settings calls it the cloud computer
})

test('a phone the host paired names itself on the computer when it first connects, as a phone paired by code does (QA 2026-10-28 H4)', async () => {
  const hostedMe = { ...meBody(''), device: { id: 'd1', name: 'phone' } }
  const app = await open('./App.tsx', {
    platform: 'android',
    host: { params: { hostUrl: HOST } },
    network: {
      [`POST ${HOST}/host/sign-in`]: { body: { accountToken: 'acc_1' } },
      [`POST ${HOST}/host/sandbox`]: { body: { state: 'ready', origin: ORIGIN, token: TOKEN } },
      [`GET ${ORIGIN}/me`]: { body: hostedMe },
      [`PATCH ${ORIGIN}/devices/me`]: { body: { ok: true } },
    },
  })
  await app.press('id:start')
  await app.waitFor('id:email')
  await app.type('id:email', 'sam@example.com')
  await app.press('id:sign-in')
  await app.waitFor('text:What will you call your assistant?', { timeout: 15000 })
  await app.wait(300)
  const named = app.requests().filter((r) => r.method === 'PATCH' && r.url === `${ORIGIN}/devices/me`)
  expect(named.length).toBe(1)
  expect(named[0].headers['authorization']).toBe(`Bearer ${TOKEN}`)
  expect(JSON.parse(String(named[0].body)).name).toBe('Android')
})

test('a phone paired by code is named at pairing: it sends no name afterwards', async () => {
  const app = await open('./App.tsx', { storage: { origin: ORIGIN, token: TOKEN }, network: { [`GET ${ORIGIN}/me`]: { body: { ...meBody(''), device: { id: 'd1', name: 'phone' } } } } })
  await app.waitFor('text:What will you call your assistant?', { timeout: 15000 })
  await app.wait(300)
  expect(app.requests().filter((r) => r.url.endsWith('/devices/me')).length).toBe(0)
})

test('a hosted phone from before the app named itself (still "phone") names itself on the next launch', async () => {
  const app = await open('./App.tsx', { storage: { origin: ORIGIN, token: TOKEN, hostedBy: HOST }, network: { [`GET ${ORIGIN}/me`]: { body: { ...meBody(''), device: { id: 'd1', name: 'phone' } } }, [`PATCH ${ORIGIN}/devices/me`]: { body: { ok: true } } } })
  await app.waitFor('text:What will you call your assistant?', { timeout: 15000 })
  await app.wait(300)
  expect(app.requests().filter((r) => r.method === 'PATCH' && r.url.endsWith('/devices/me')).length).toBe(1)
})

test('without a host configured, Start goes straight to the connect screen', async () => {
  const app = await open('./App.tsx', {})
  await app.press('id:start')
  await app.waitFor('text:Connect to your computer')
})

test('a wrong code is explained inline, not swallowed', async () => {
  const app = await open('./App.tsx', { network: { [`POST ${ORIGIN}/pair`]: { status: 403, body: { error: 'wrong or expired code' } } } })
  await app.press('id:own-computer')
  await app.type('id:address', ORIGIN)
  await app.type('id:code', '000000')
  await app.press('id:connect')
  await app.waitFor('text:/That code did not work/')
})

test('with a saved session and a named assistant, the chat screen shows the name and the empty-thread hint', async () => {
  const app = await chatApp({ [`POST ${ORIGIN}/ws-ticket`]: { body: { ticket: 'ticket' } } })
  await app.waitFor('text:Nori')
  await emptyReady(app)
  expect(app.shows('id:composer')).toBe(true)
})

// The phone's token was rotated or revoked while the app was open: the events ticket is refused. The app kept
// retrying and showed "reconnecting" until it was relaunched (2026-10-28); it goes back to the start screen, as at launch.
test('a refused events ticket signs the phone out instead of reconnecting forever', async () => {
  const app = await chatApp({ [`POST ${ORIGIN}/ws-ticket`]: { status: 401, body: { error: 'unauthorized' } } })
  await app.waitFor('text:Boop', { timeout: 8000 })
})

// QA 2026-10-28: opened with the network off, the app asked for an events ticket that
// never answered, and 20 s after the network came back it still said "Not connected". A request that hangs is given
// up and asked again, as a refused one is.
// The same pass, on the device: the app was opened with the network off, so asking the computer who it is (/me) failed,
// and nothing ever asked again: 85 s after the network came back it still said 「未连接」 (Android emulator, measured).
test('opened offline, the app keeps asking until the computer answers, then connects', async () => {
  let asked = 0
  const app = await open('./App.tsx', {
    storage: { ...paired, me: JSON.stringify(meBody('Nori')) },
    network: {
      [`GET ${ORIGIN}/me`]: () => { asked++; return asked <= 2 ? { error: 'network is unreachable' } : { body: meBody('Nori') } },
      [`GET ${ORIGIN}/threads`]: { body: threads },
      [`POST ${ORIGIN}/ws-ticket`]: { body: { ticket: 'ticket' } },
      [`PUT ${ORIGIN}/me/context`]: { body: { ok: true } },
    },
  })
  await app.waitFor('text:Nori')
  await app.waitUntil(() => app.requests().some((r) => r.url.endsWith('/ws-ticket')), { timeout: 20000 })
  expect(asked).toBeGreaterThanOrEqual(3)
}, 30000)

test('an events ticket that never answers is asked again', async () => {
  let asked = 0
  const app = await chatApp({ [`POST ${ORIGIN}/ws-ticket`]: () => { asked++; return asked === 1 ? { delay: 120000, body: { ticket: 'late' } } : { body: { ticket: 'ticket' } } } })
  await app.waitFor('text:Nori')
  await app.waitUntil(() => asked >= 2, { timeout: 20000 })
}, 30000)

// It comes with a name; one tap continues, typing renames.
// QA 2026-10-28: the field came filled in with "Nori"; a person who typed "Nori" got
// "NoriNori" (the Android emulator, and the hosted web). The suggestion is the placeholder.
test('typing the suggested name on the naming screen gives it once, not twice', async () => {
  const app = await open('./App.tsx', {
    storage: paired,
    network: {
      [`GET ${ORIGIN}/me`]: { body: meBody('') },
      [`PUT ${ORIGIN}/settings`]: { body: { assistantName: 'Nori', mainSessionId: 'main', language: 'auto' } },
      [`PUT ${ORIGIN}/me/context`]: { body: { ok: true } },
      [`GET ${ORIGIN}/threads`]: { body: threads },
      [`POST ${ORIGIN}/ws-ticket`]: { body: { ticket: 'ticket' } },
    },
  })
  await app.waitFor('text:What will you call your assistant?')
  await app.type('id:name', 'Nori')
  expect(app.value('id:name')).toBe('Nori')
  await app.press('id:name-go')
  await app.waitUntil(() => app.requests().some((r) => r.url.endsWith('/settings') && r.method === 'PUT'))
  const saved = app.requests().find((r) => r.url.endsWith('/settings') && r.method === 'PUT')!
  expect(JSON.parse(String(saved.body)).assistantName).toBe('Nori')
})

test('the naming screen suggests a name, so Continue alone names the assistant', async () => {
  const app = await open('./App.tsx', {
    storage: paired,
    network: {
      [`GET ${ORIGIN}/me`]: { body: meBody('') },
      [`PUT ${ORIGIN}/settings`]: { body: { assistantName: 'Nori', mainSessionId: 'main', language: 'auto' } },
      [`PUT ${ORIGIN}/me/context`]: { body: { ok: true } },
      [`GET ${ORIGIN}/threads`]: { body: threads },
      [`POST ${ORIGIN}/ws-ticket`]: { body: { ticket: 'ticket' } },
    },
  })
  await app.waitFor('text:What will you call your assistant?')
  await app.press('id:name-go')
  await app.waitFor('id:composer')
  const saved = app.requests().find((r) => r.url.endsWith('/settings') && r.method === 'PUT')
  expect(JSON.parse(String(saved!.body)).assistantName).toBe('Nori')
})

// The phone tells the bot what it knows (time zone, language) every time it connects, so the assistant never asks.
test('on connect the app sends the phone\'s time zone and language to the bot', async () => {
  const app = await chatApp({ [`PUT ${ORIGIN}/me/context`]: { body: { ok: true } }, [`POST ${ORIGIN}/ws-ticket`]: { body: { ticket: 'ticket' } } })
  await app.waitFor('id:composer')
  const ctx = app.requests().find((r) => r.url.endsWith('/me/context'))
  expect(Boolean(ctx)).toBe(true)
  const body = JSON.parse(String(ctx!.body)) as { timeZone: string; locale: string }
  expect(typeof body.timeZone === 'string' && body.timeZone.length > 0).toBe(true)
  expect(typeof body.locale).toBe('string')
})

test('naming the assistant saves it and opens the chat', async () => {
  const app = await open('./App.tsx', {
    storage: paired,
    network: {
      [`GET ${ORIGIN}/me`]: { body: meBody('') },
      [`PUT ${ORIGIN}/settings`]: { body: { assistantName: 'Pumpkin', mainSessionId: 'main', language: 'auto' } },
      [`GET ${ORIGIN}/threads`]: { body: threads },
      [`POST ${ORIGIN}/ws-ticket`]: { body: { ticket: 'ticket' } },
    },
  })
  await app.waitFor('text:What will you call your assistant?')
  await app.type('id:name', 'Pumpkin')
  await app.press('id:name-go')
  await app.waitFor('text:Pumpkin')
  expect(app.shows('id:composer')).toBe(true)
})

test('rows replace the empty-thread hint; a working turn shows one activity block in words, never the command; it ends as a receipt', async () => {
  const app = await chatApp()
  await emptyReady(app)
  await app.host.send('thread', [snapshot([you('List my files'), them('Sure.'), step('c1', 'bash', { description: 'List the files', command: 'ls -1' })], true, 'List the files…')])
  await app.waitFor('text:List my files')
  await app.waitFor('text:/Say hi to Nori/', { state: 'gone' })
  await app.waitFor('id:activity-live')
  expect(app.shows('text:/List the files/')).toBe(true)
  expect(app.shows('text:/ls -1/')).toBe(false)
  await app.host.send('thread', [rowsFrame([step('c1', 'bash', { description: 'List the files', command: 'ls -1', output: 'a.txt\nb.txt' }), step('c2', 'web_search', { description: 'Look up the sizes', command: 'file sizes' })]), status(true, 'Look up the sizes…')])
  await app.waitFor('text:/Look up the sizes/')
  expect(app.shows('text:/a.txt/')).toBe(false)
  await app.press('id:activity-live')
  await app.waitFor('id:step-c1-done') // the finished step: a ✓ at the right of its row
  expect(app.shows('id:step-c2-doing')).toBe(true)
  // open, the list says each step once: the closed line's phrase is not repeated above it (iOS QA, 2026-10-30)
  expect(app.texts().filter((x) => /Look up the sizes/.test(x)).length).toBe(2) // the header's status line and the list
  expect(app.shows('text:/List the files/')).toBe(true)
  expect(app.shows('text:/ls -1/')).toBe(false)
  expect(app.shows('text:/a.txt/')).toBe(false)
  await app.host.send('thread', [rowsFrame([step('c2', 'web_search', { description: 'Look up the sizes', command: 'file sizes', output: '12 KB' }), them('Two files.', 'a2')]), status(false)])
  await app.waitFor('text:Two files.')
  expect(app.shows('id:activity-live')).toBe(false)
  await app.waitFor('text:/Did 2 things/')
  expect(app.shows('text:Working…')).toBe(false)
  expect(app.shows('text:/12 KB/')).toBe(false)
})

// The receipt of a turn that ended while the app was open (it appeared with the entrance motion) opens on a tap, like an old one.
test('a receipt that arrived live opens its steps on a tap', async () => {
  const app = await chatApp()
  await emptyReady(app)
  await app.host.send('thread', [snapshot([you('Check my goals')], true)])
  await app.waitFor('text:Check my goals')
  await app.host.send('thread', [rowsFrame([step('s1', 'mcp__bot__goal_list', { description: 'Check the goals', at: AT })]), status(true)])
  await app.waitFor('id:activity-live')
  await app.host.send('thread', [rowsFrame([step('s1', 'mcp__bot__goal_list', { description: 'Check the goals', output: '1 goal', at: AT }), { ...them('One goal.', 'a5'), at: AT + 5_000 }]), status(false)])
  await app.waitFor('text:/Did 1 thing/')
  await app.press('id:activity-act-s1')
  await app.waitFor('id:step-s1-done')
  await app.press('id:activity-act-s1')
  await app.waitFor('id:step-s1-done', { state: 'gone' })
})

test('"show its work" on: the expanded receipt also shows commands and outputs', async () => {
  const app = await open('./App.tsx', { storage: { ...paired, showWork: '1' }, network: { [`GET ${ORIGIN}/me`]: { body: meBody('Nori') }, [`GET ${ORIGIN}/threads`]: { body: threads } } })
  await emptyReady(app)
  await app.host.send('thread', [snapshot([you('List my files'), step('c1', 'bash', { description: 'List the files', command: 'ls -1', output: 'a.txt\nb.txt', at: AT }), { ...them('Two files.', 'a2'), at: AT + 40_000 }])])
  await app.waitFor('text:/Did 1 thing in 40 s/')
  expect(app.shows('text:/ls -1/')).toBe(false)
  await app.press('text:/Did 1 thing/')
  await app.waitFor('text:/ls -1/')
  expect(app.shows('text:/a.txt/')).toBe(true)
  await app.press('text:/Did 1 thing/')
  await app.waitFor('text:/ls -1/', { state: 'gone' })
})

test('a model error lands as a grey notice and the status line goes back to idle', async () => {
  const app = await chatApp()
  await emptyReady(app)
  await app.host.send('thread', [snapshot([you('hi')], true)])
  await app.waitFor('text:Working…')
  await app.host.send('thread', [rowsFrame([notice('Insufficient balance')]), status(false)])
  await app.waitFor('text:Insufficient balance')
  expect(app.shows('text:Working…')).toBe(false)
})

test('sending: the composer clears; on failure the text comes back with a toast', async () => {
  const app = await chatApp({ [`POST ${ORIGIN}/threads/main/messages`]: { error: 'connection reset' } })
  await app.waitFor('id:composer')
  await app.type('id:composer', 'hello there')
  await app.press('id:send')
  await app.waitFor('text:Could not reach the assistant.')
  await app.waitUntil(() => app.value('id:composer') === 'hello there')
})

test('a sent message is posted to the thread', async () => {
  const app = await chatApp({ [`POST ${ORIGIN}/threads/main/messages`]: { body: { ok: true } } })
  await app.waitFor('id:composer')
  await app.type('id:composer', 'hello there')
  await app.press('id:send')
  await app.waitUntil(() => app.requests().some((r) => r.url.endsWith('/threads/main/messages')))
  await app.waitUntil(() => app.value('id:composer') === '')
  const body = JSON.parse(String(app.requests().find((r) => r.url.endsWith('/threads/main/messages'))!.body))
  expect(body.text).toBe('hello there')
  expect(body.cardId).toBe(undefined)
  await app.waitFor('text:Working…')
  await app.waitFor('id:ack')
  await app.host.send('thread', [rowsFrame([you('hello there', 'u9')])])
  await app.wait(100)
  expect(app.shows('id:ack')).toBe(true)
  await app.host.send('thread', [rowsFrame([them('Hi!', 'a9')])])
  await app.waitFor('id:ack', { state: 'gone' })
})

test('a delta frame streams text into the assistant row; an end with an error leaves a notice', async () => {
  const app = await chatApp()
  await emptyReady(app)
  await app.host.send('thread', [snapshot([them('Hel', 'a1', true)], true)])
  await app.waitFor('text:/Hel/')
  await app.host.send('thread', [{ type: 'delta', sessionId: 'main', rowId: 'a1', text: 'lo world' }])
  await app.waitFor('text:/Hello world/')
  await app.host.send('thread', [{ type: 'end', sessionId: 'main', error: { code: 'follow-failed', message: 'Follow lost' } }])
  await app.waitFor('text:Follow lost')
})

test('a rows frame replaces a row in place and appends a new one; a card row renders in the thread', async () => {
  const app = await chatApp()
  await emptyReady(app)
  await app.host.send('thread', [snapshot([you('first', 'u1'), them('draft', 'a1')])])
  await app.waitFor('text:draft')
  await app.host.send('thread', [rowsFrame([them('final', 'a1'), { kind: 'card', id: 'c1', at: AT, card: { kind: 'table', title: 'Lisbon to Porto', columns: ['Way', 'Time'], rows: [['Train', '3 h'], ['Bus', '3.5 h']] } }])])
  await app.waitFor('text:final')
  expect(app.shows('text:draft')).toBe(false)
  await app.waitFor('text:Lisbon to Porto')
  expect(app.shows('text:3.5 h')).toBe(true)
  expect(app.shows('id:msg-0')).toBe(false)
})

// Polish: a time label above the first row and whenever 15 min pass between rows.
test('time labels: one above the thread, another when rows are 15 minutes apart', async () => {
  const app = await chatApp()
  await emptyReady(app)
  await app.host.send('thread', [snapshot([you('first', 'u1'), them('one', 'a1')])])
  await app.waitFor('text:one')
  expect(app.count('id:time-divider')).toBe(1)
  await app.host.send('thread', [rowsFrame([{ ...you('later', 'u2'), at: AT + 20 * 60_000 }])])
  await app.waitFor('text:later')
  expect(app.count('id:time-divider')).toBe(2)
})

// Polish: the empty thread offers three things to ask; a tap puts the words in the composer, nothing is sent.
test('a starter on the empty thread fills the composer', async () => {
  const app = await chatApp()
  await emptyReady(app)
  await app.press('id:starter-0')
  await app.waitUntil(() => (app.value('id:composer') ?? '').length > 0)
  expect(app.requests().some((r) => r.url.endsWith('/threads/main/messages'))).toBe(false)
})

test('long-pressing an assistant message offers Copy and Report; Copy copies it', async () => {
  const app = await chatApp()
  await emptyReady(app)
  await app.host.send('thread', [snapshot([them('Here is **the plan**.')])])
  await app.waitFor('id:msg-0')
  app.onDialog(() => 'Copy')
  await app.longPress('id:msg-0')
  expect(app.dialogs()[0].buttons).toEqual(['Copy', 'Report', 'Cancel'])
  await app.waitFor('text:Copied')
  expect(app.clipboard()).toBe('Here is **the plan**.')
})

test('pull-to-refresh follows the thread again (it starts from a clean snapshot)', async () => {
  const app = await chatApp()
  await emptyReady(app)
  await app.host.send('thread', [snapshot([you('older')])])
  await app.waitFor('text:older')
  await app.drag('id:thread', { y: 260 })
  await emptyReady(app)
})

test('an approval card is answered with one tap and leaves a grey notice', async () => {
  const app = await chatApp({ [`POST ${ORIGIN}/approvals/e1`]: { body: { ok: true } } })
  await emptyReady(app)
  await app.host.send('asks', [{ kind: 'approval', eventId: 'e1', sessionId: 'main', request: { toolName: 'bash', reason: 'rm -rf build\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10' }, at: 1 }])
  await app.waitFor('text:Running a command')
  expect(app.shows('text:Waiting for you')).toBe(true)
  expect(app.shows('text:View details')).toBe(true)
  expect(app.shows('text:Allow for this task')).toBe(true) // the two scoped allows stay, as plain text under the Decline / Allow once pair
  expect(app.shows('text:Always allow')).toBe(true)
  await app.press('text:View details')
  await app.waitFor('text:Hide details')
  await app.press('text:Allow once')
  await app.waitFor('id:ask-e1', { state: 'gone' })
  await app.waitFor('text:Allowed running a command')
  const posted = app.requests().find((r) => r.url.endsWith('/approvals/e1'))
  expect(JSON.parse(String(posted!.body))).toEqual({ outcome: 'allowed-once' })
})

// The card's frame is the interface and speaks the person's language; the reason is the agent's own and is never changed.
test('an approval card: the interface in the person\'s language, the agent\'s reason exactly as it wrote it', async () => {
  const app = await open('./App.tsx', { storage: { ...paired, lang: 'zh' }, network: { [`GET ${ORIGIN}/me`]: { body: meBody('Nori') }, [`GET ${ORIGIN}/threads`]: { body: threads }, [`POST ${ORIGIN}/approvals/e1`]: { body: { ok: true } } } })
  await app.waitFor('id:composer')
  await app.host.send('asks', [{ kind: 'approval', eventId: 'e1', sessionId: 'main', request: { toolName: 'edit', reason: 'Allow this operation to use danger-full-access permissions', displayReason: { zh: '允许本次操作使用 danger-full-access 权限', en: 'Allow this operation to use danger-full-access permissions' } }, at: 1 }])
  await app.waitFor('text:改文件')
  expect(app.shows('text:edit')).toBe(false)
  expect(app.shows('text:允许本次操作使用 danger-full-access 权限')).toBe(true)
  await app.press('text:仅这次允许')
  await app.waitFor('text:已允许改文件')
})

test('an agent that wrote no reason in the person\'s language: what it wrote, unchanged, under a card in their language', async () => {
  const app = await open('./App.tsx', { storage: { ...paired, lang: 'ru' }, network: { [`GET ${ORIGIN}/me`]: { body: meBody('Nori') }, [`GET ${ORIGIN}/threads`]: { body: threads } } })
  await app.waitFor('id:composer')
  await app.host.send('asks', [{ kind: 'approval', eventId: 'e1', sessionId: 'main', request: { toolName: 'bash', displayReason: { en: 'Needs workspace-write permissions to save the notes' } }, at: 1 }])
  await app.waitFor('text:Needs workspace-write permissions to save the notes')
  expect(app.shows('text:Выполнение команды')).toBe(true)
})

test('declining leaves a "Declined" notice; cards stack', async () => {
  const app = await chatApp({ [`POST ${ORIGIN}/approvals/e1`]: { body: { ok: true } }, [`POST ${ORIGIN}/approvals/e2`]: { body: { ok: true } } })
  await emptyReady(app)
  await app.host.send('asks', [
    { kind: 'approval', eventId: 'e1', sessionId: 'main', request: { toolName: 'bash', reason: 'first' }, at: 1 },
    { kind: 'approval', eventId: 'e2', sessionId: 'main', request: { toolName: 'write', reason: 'second' }, at: 2 },
  ])
  await app.waitFor('id:ask-e2')
  expect(app.count('text:Allow once')).toBe(2)
  await app.press('id:ask-e2 >> text:Decline')
  await app.waitFor('text:Declined')
  expect(app.count('text:Allow once')).toBe(1)
})

test('a question card sends the chosen option and leaves an "Answered" notice', async () => {
  const app = await chatApp({ [`POST ${ORIGIN}/questions/q1`]: { body: { ok: true } } })
  await emptyReady(app)
  await app.host.send('asks', [{ kind: 'question', eventId: 'q1', sessionId: 'main', request: { questions: [{ id: 'k', prompt: 'Tea or coffee?', options: [{ label: 'Tea' }, { label: 'Coffee' }] }] }, at: 1 }])
  await app.waitFor('text:Tea or coffee?')
  await app.press('text:Coffee')
  await app.press('text:Send answer')
  await app.waitFor('text:Answered')
  const posted = app.requests().find((r) => r.url.endsWith('/questions/q1'))
  expect(JSON.parse(String(posted!.body)).answers).toEqual([{ id: 'k', selected: ['Coffee'] }])
})

// QA 2026-10-30 (iOS, zh): after 跳过 the card left 已回答, as if a choice had been made.
test('Skip on a question card sends DSH’s skip for every question and leaves a "Skipped" notice, not "Answered"', async () => {
  const app = await chatApp({ [`POST ${ORIGIN}/questions/q1`]: { body: { ok: true } } })
  await emptyReady(app)
  await app.host.send('asks', [{ kind: 'question', eventId: 'q1', sessionId: 'main', request: { questions: [
    { id: 'k', prompt: 'Tea or coffee?', options: [{ label: 'Tea' }, { label: 'Coffee' }] },
    { id: 'm', prompt: 'Milk?', options: [{ label: 'Yes' }, { label: 'No' }] },
  ] }, at: 1 }])
  await app.waitFor('text:Tea or coffee?')
  await app.press('text:Coffee') // a pick before Skip is not sent
  await app.press('text:Skip')
  await app.waitFor('text:Skipped')
  expect(app.shows('text:Answered')).toBe(false)
  const posted = app.requests().find((r) => r.url.endsWith('/questions/q1'))
  expect(JSON.parse(String(posted!.body)).answers).toEqual([{ id: 'k', selected: [] }, { id: 'm', selected: [] }])
})

test('settings: name, entries, language and unpair with a confirmation', async () => {
  const app = await chatApp({ [`DELETE ${ORIGIN}/devices/d1`]: { body: { ok: true } } })
  await app.waitFor('label:Settings')
  await app.press('label:Settings')
  await app.waitFor('id:memory-row')
  expect(app.shows('id:assistant-name')).toBe(true)
  expect(app.shows('text:Connectors')).toBe(true)
  expect(app.shows('text:Usage')).toBe(true)
  expect(app.shows('id:export')).toBe(true)
  expect(app.shows('text:Devices')).toBe(true)
  expect(app.shows('text:Activity')).toBe(true)
  expect(app.shows('id:computer-status')).toBe(true) // what it says is in computer.test.tsx
  app.onDialog((d) => d.buttons.find((b) => b === 'Unpair this phone') ?? null)
  await app.press('id:unpair')
  await app.waitFor('text:Boop') // unpaired: back to the welcome screen
  expect(app.dialogs().length).toBe(1)
  expect(app.requests().some((r) => r.method === 'DELETE' && r.url.endsWith('/devices/d1'))).toBe(true)
})

test('menu: the main chat, other chats, and the three entries', async () => {
  const app = await chatApp({ [`GET ${ORIGIN}/threads`]: { body: [...threads, { sessionId: 's2', title: 'Trip plan', updatedAt: Date.now(), blank: false, running: true }] } })
  await app.waitFor('label:Menu')
  await app.press('label:Menu')
  await app.waitFor('text:Main chat')
  await app.waitFor('text:Trip plan')
  expect(app.shows('text:Upcoming')).toBe(true)
  expect(app.shows('text:Goals')).toBe(true)
  expect(app.shows('text:New chat')).toBe(true)
})

// QA 2026-10-30 (iOS, Chinese): 其他对话 listed the main chat's background tasks, "You are researching actual
// travel" and twice 「小诺初次问候用户」, each 工作中… for minutes. The menu read the harness's own session list, which
// has every session; the bot's GET /threads lists the person's conversations only (src/harness.ts listSessions).
test('menu: other chats are the bot\'s threads; a background task is not one', async () => {
  const task = { sessionId: 'task-1', updatedAt: Date.now(), blank: false, running: true, origin: 'subagent', parentSessionId: 'main', projections: { values: { title: 'You are researching actual travel' } } }
  const side = { sessionId: 's2', updatedAt: Date.now() - 60_000, blank: false, running: false }
  const app = await chatApp({
    [`GET ${ORIGIN}/threads`]: { body: [...threads, { ...side, title: 'Trip plan' }] },
    [`POST ${ORIGIN}/api/session/list`]: { body: { result: { ok: true, value: { items: [task, { ...side, projections: { values: { title: 'Trip plan' } } }] } } } },
  })
  await app.waitFor('label:Menu')
  await app.press('label:Menu')
  await app.waitFor('text:Trip plan')
  expect(app.shows('text:You are researching actual travel')).toBe(false)
  expect(app.shows('text:Working…')).toBe(false)
})

test('upcoming and goals show their rows and empty states', async () => {
  const app = await chatApp({
    [`GET ${ORIGIN}/schedules`]: { body: [{ id: 't1', name: 'Take pills', instruction: 'Remind me to take my pills', when: { kind: 'daily', time: '08:00' }, nextRunAt: '2026-10-28T08:00:00.000Z', active: true }] },
    [`GET ${ORIGIN}/goals`]: { body: [] },
    [`POST ${ORIGIN}/api/session/list`]: { body: { result: { ok: true, value: { items: [] } } } },
  })
  await app.waitFor('label:Menu')
  await app.press('label:Menu')
  await app.press('text:Upcoming')
  await app.waitFor('text:Take pills')
  expect(app.shows('text:/Daily at 08:00/')).toBe(true)
  expect(app.shows('text:Pause')).toBe(true)
  await app.back()
  await app.press('text:Goals')
  await app.waitFor('text:/No goals yet/')
})

test('scrolled up, a new reply shows the "New messages" pill; tapping it returns to the bottom', async () => {
  const app = await chatApp()
  await emptyReady(app)
  await app.host.send('thread', [snapshot(Array.from({ length: 16 }, (_, i) => (i % 2 ? them(`Reply ${i}: a longer paragraph so the thread is tall enough to scroll well past one screen of rows.`, `a${i}`) : you(`Message ${i}`, `u${i}`))))])
  await app.waitFor('text:Message 0')
  expect(app.shows('id:new-messages')).toBe(false)
  await app.scroll('id:thread', -700)
  await app.host.send('thread', [rowsFrame([them('A brand new reply.', 'a99')])])
  await app.waitFor('id:new-messages')
  await app.press('id:new-messages')
  await app.waitFor('id:new-messages', { state: 'gone' })
})

// QA 2026-10-28: on iOS, once the thread had been scrolled up, every message the person
// sent landed below the screen and the thread stayed where it was. Sending is the person's own move: back to the end.
test('scrolled up, sending a message goes back to the end: the reply that follows shows no "New messages" pill', async () => {
  const app = await chatApp({ [`POST ${ORIGIN}/threads/main/messages`]: { body: { ok: true } } })
  await emptyReady(app)
  await app.host.send('thread', [snapshot(Array.from({ length: 16 }, (_, i) => (i % 2 ? them(`Reply ${i}: a longer paragraph so the thread is tall enough to scroll well past one screen of rows.`, `a${i}`) : you(`Message ${i}`, `u${i}`))))])
  await app.waitFor('text:Message 0')
  await app.scroll('id:thread', -700)
  await app.type('id:composer', 'and one more thing')
  await app.press('id:send')
  await app.waitUntil(() => app.requests().some((r) => r.url.endsWith('/threads/main/messages')))
  await app.host.send('thread', [rowsFrame([you('and one more thing', 'u99'), them('Here is the answer to it.', 'a99')])])
  await app.waitFor('text:Here is the answer to it.')
  await app.wait(400)
  expect(app.shows('id:new-messages')).toBe(false)
})

// An approval that arrived while the person was scrolled up landed at the end of the list, behind the "New messages"
// pill: the assistant waited and the person did not see why (side-by-side run against DS-Bot, 2026-10-27). A card that
// blocks the assistant sits above the composer, outside the scrolling list, as Telegram's reply keyboard and Claude
// Code's permission prompt do: on screen and answerable wherever the thread is scrolled.
test('scrolled up, an approval or a question still shows above the composer and can be answered there', async () => {
  const app = await chatApp({ [`POST ${ORIGIN}/approvals/e1`]: { body: { ok: true } }, [`POST ${ORIGIN}/questions/q1`]: { body: { ok: true } } })
  await emptyReady(app)
  await app.host.send('thread', [snapshot(Array.from({ length: 30 }, (_, i) => (i % 2 ? them(`Reply ${i}: a longer paragraph so the thread is tall enough to scroll well past one screen of rows.`, `a${i}`) : you(`Message ${i}`, `u${i}`))))])
  await app.waitFor('text:/Reply 29/')
  await app.scroll('id:thread', -2400)
  await app.waitFor('text:Message 0')
  await app.host.send('asks', [{ kind: 'approval', eventId: 'e1', sessionId: 'main', request: { toolName: 'bash', reason: 'Delete the build folder' }, at: 1 }])
  await app.wait(400)
  expect(app.shows('id:pinned-asks >> id:ask-e1')).toBe(true)
  expect(app.shows('id:thread >> id:ask-e1')).toBe(false) // not a row the list can scroll away
  expect(app.shows('text:Message 0')).toBe(true) // the person stays where they were reading
  await app.press('id:ask-e1 >> text:Allow once')
  await app.waitFor('id:ask-e1', { state: 'gone' })
  expect(JSON.parse(String(app.requests().find((r) => r.url.endsWith('/approvals/e1'))!.body))).toEqual({ outcome: 'allowed-once' })
  await app.host.send('asks', [{ kind: 'question', eventId: 'q1', sessionId: 'main', request: { questions: [{ id: 'k', prompt: 'Tea or coffee?', options: [{ label: 'Tea' }, { label: 'Coffee' }] }] }, at: 2 }])
  await app.wait(400)
  expect(app.shows('id:pinned-asks >> id:ask-q1')).toBe(true)
  await app.press('id:ask-q1 >> text:Coffee')
  await app.press('id:ask-q1 >> text:Send answer')
  await app.waitFor('id:ask-q1', { state: 'gone' })
})

test('the Discover tab shows what it is tracking; the chat tab comes back', async () => {
  const app = await chatApp({
    [`GET ${ORIGIN}/goals`]: { body: [{ id: 'g1', title: 'Run 10 km', plan: ['Build a base'], notes: [], status: 'active' }] },
    [`GET ${ORIGIN}/schedules`]: { body: [] }, [`GET ${ORIGIN}/activity`]: { body: [] }, [`GET ${ORIGIN}/ideas`]: { body: [] },
  })
  await app.waitFor('id:composer')
  await app.host.send('tab', 1) // the system tab bar is not drawn headless; the host seam picks the tab
  await app.waitFor('text:Run 10 km')
  expect(app.shows('id:composer')).toBe(false)
  await app.host.send('tab', 0)
  await app.waitFor('id:composer')
})

test('settings: the morning brief switch is saved; export copies the bundle; usage shows today', async () => {
  const app = await chatApp({
    [`PUT ${ORIGIN}/settings`]: { body: { morningBrief: true } },
    [`GET ${ORIGIN}/export`]: { body: { format: 'deepseek-bot-memory/1', files: { 'USER.md': 'x'.repeat(3000) } } },
    [`GET ${ORIGIN}/usage`]: { body: { today: { inputTokens: 12345, cachedTokens: 678, outputTokens: 90, sessions: 1 }, sessions: [] } },
  })
  await app.press('label:Settings')
  await app.waitFor('id:brief')
  await app.press('id:brief')
  await app.waitUntil(() => app.requests().some((r) => r.method === 'PUT' && r.url.endsWith('/settings') && JSON.parse(String(r.body)).morningBrief === true))
  await app.press('id:export')
  await app.waitFor('text:/Copied to the clipboard/')
  expect((app.clipboard() ?? '').length).toBeGreaterThan(2000)
  await app.press('text:Usage')
  await app.waitFor('text:12,345')
})

test('settings: "Show steps" is a per-phone switch kept in storage', async () => {
  const app = await chatApp({ [`POST ${ORIGIN}/ws-ticket`]: { body: { ticket: 'ticket' } } })
  await app.waitFor('text:Nori')
  await app.press('label:Settings')
  await app.waitFor('id:show-work')
  expect(app.storage().showWork).toBe(undefined)
  await app.press('id:show-work')
  await app.waitUntil(() => app.storage().showWork === '1')
})

test('in the browser, the page hands over the pairing link and the host (web/host.js → launch.params)', async () => {
  const app = await open('./App.tsx', {
    platform: 'web',
    host: { handlers: { 'launch.params': { pairUrl: `${ORIGIN}/pair?code=654321`, hostUrl: 'http://host.test' } } },
    network: { [`POST ${ORIGIN}/pair`]: { body: { token: TOKEN } }, [`GET ${ORIGIN}/me`]: { body: meBody('') } },
  })
  await app.waitFor('text:Connect to your computer')
  await app.press('id:connect')
  await app.waitFor('text:What will you call your assistant?')
  expect(JSON.parse(String(app.requests().find((r) => r.url.endsWith('/pair'))!.body)).code).toBe('654321')
})

// Your words show the moment you press Send (Messages, ChatGPT), not when the bot echoes them back; the bot's
// row then takes the place of the one the phone drew, so the bubble never doubles.
test('a sent message shows at once and the bot\'s row replaces it; a failed send takes it back', async () => {
  let fail = false
  const app = await chatApp({ [`POST ${ORIGIN}/threads/main/messages`]: () => (fail ? { error: 'connection reset' } : { body: { ok: true }, delay: 400 }) })
  await app.waitFor('id:composer')
  await app.type('id:composer', 'hello there')
  await app.press('id:send')
  expect(app.count('text:hello there')).toBe(1) // before the bot answered the POST
  await app.host.send('thread', [rowsFrame([you('hello there', 'u9')])])
  await app.wait(50)
  expect(app.count('text:hello there')).toBe(1)
  // a snapshot (a re-follow) that already has it keeps one
  await app.host.send('thread', [snapshot([you('hello there', 'u9')], true)])
  expect(app.count('text:hello there')).toBe(1)
  fail = true
  await app.type('id:composer', 'second try')
  await app.press('id:send')
  await app.waitFor('text:Could not reach the assistant.')
  expect(app.count('text:second try')).toBe(1) // only the composer has it again
  expect(app.value('id:composer')).toBe('second try')
})

// While the assistant writes its first message there is no empty state: the thread and the status line say it is
// working (empty states only when there is nothing to show; the avatar, name and Working… under the header). When the turn ends with nothing written, the empty state comes back.
test('an empty thread while the assistant is working shows the thread with the working status, not the empty state', async () => {
  const app = await chatApp()
  await emptyReady(app)
  await app.host.send('thread', [snapshot([], true, 'Writing…')])
  await app.waitFor('id:status >> text:Writing…')
  expect(app.shows('id:empty-thread')).toBe(false)
  expect(app.shows('text:/Say hi to Nori/')).toBe(false)
  expect(app.shows('id:starter-0')).toBe(false)
  await app.host.send('thread', [rowsFrame([them('Hi, I am Nori.', 'a1', true)])])
  await app.waitFor('text:/Hi, I am Nori/') // the streaming caret follows the words
  expect(app.shows('id:empty-thread')).toBe(false)
  await app.host.send('thread', [snapshot([]), status(false)])
  await emptyReady(app)
})

// Stop with the keyboard up: on iOS the confirm sheet came up under the keyboard, so only the dim showed and the
// task kept running (iOS QA 2026-10-30). Stop takes the keyboard down first. Headless draws no keyboard and cannot
// show the sheet behind it; the focus is its keyboard (a key typed after Stop reaches no input), and the sheet is
// open and its button posts the cancel.
test('Stop with the keyboard up takes the keyboard down; the confirm sheet is open and stops the task', async () => {
  const app = await chatApp({ [`POST ${ORIGIN}/sessions/main/cancel`]: { body: { ok: true } } })
  await app.waitFor('id:composer')
  await app.host.send('thread', [snapshot([you('Compare three ways to Sintra')], true)])
  await app.type('id:composer', 'hi')
  await app.press('id:stop')
  await app.waitFor('text:Stop this task?')
  await app.keyboard.press('y')
  expect(app.value('id:composer')).toBe('hi')
  await app.press('id:stop-confirm')
  await app.waitUntil(() => app.requests().some((r) => r.method === 'POST' && r.url.endsWith('/sessions/main/cancel')))
})

// Renaming it in the chat ("call yourself Momo") changes the name on the bot; the bot tells the apps on /events
// (`me-updated`, or a `settings` frame) and the app reads /me again: header, avatar letter and Settings follow.
test('a me-updated or settings event refetches /me: header, avatar letter and the Settings name follow', async () => {
  let name = 'Nori'
  const app = await chatApp({ [`GET ${ORIGIN}/me`]: () => ({ body: meBody(name) }) })
  await app.waitFor('text:Nori')
  name = 'Momo'
  await app.host.send('event', { type: 'me-updated' })
  await app.waitFor('text:Momo')
  expect(app.shows('text:Nori')).toBe(false)
  expect(app.shows('text:M')).toBe(true)
  await app.press('label:Settings')
  await app.waitUntil(() => app.value('id:assistant-name') === 'Momo')
  name = 'Kiki'
  await app.host.send('event', { type: 'settings' })
  await app.waitUntil(() => app.value('id:assistant-name') === 'Kiki')
})

// Every /events message goes through handleEvent (the socket and the tests alike): after a turn the status line says
// it is updating its memory, then how many things it remembered, for a few seconds.
test('memory-updating, then memory-updated with counts: the status line says how many things it remembered', async () => {
  const app = await chatApp({ [`GET ${ORIGIN}/me`]: { body: meBody('Nori') } })
  await app.waitFor('text:Nori')
  await app.host.send('event', { type: 'memory-updating' })
  await app.host.send('event', { type: 'memory-updated', user: 1, memory: 1 })
  await app.waitFor('text:Remembered 2 things')
  await app.waitFor('text:Remembered 2 things', { state: 'gone', timeout: 8000 })
})

// QA pass, 2026-10-27 (Android, Chinese): Activity showed the raw kind "show" under an entry; Upcoming showed the
// reminder's instruction to the assistant ("提醒他喝水：一句话，轻松点…") under its name.
test('Activity names every kind in words or not at all; Upcoming shows what and when, not the instruction', async () => {
  const app = await open('./App.tsx', { storage: { ...paired, lang: 'zh' }, network: {
    [`GET ${ORIGIN}/me`]: { body: meBody('Nori') }, [`GET ${ORIGIN}/threads`]: { body: threads },
    [`GET ${ORIGIN}/activity`]: { body: [
      { id: 'a1', at: '2026-10-27T09:46:00Z', kind: 'show', text: '第一周：先能跑起来' },
      { id: 'a2', at: '2026-10-27T09:45:00Z', kind: 'ui', text: '做了一个界面：周末去哪儿' },
      { id: 'a3', at: '2026-10-27T09:44:00Z', kind: 'name', text: '改名为 小墨' },
      { id: 'a4', at: '2026-10-27T09:43:00Z', kind: 'something-new', text: '别的事' },
      // the bot's own English line: the profile says it in words, Settings → Activity said it raw (QA, Android, 2026-10-30)
      { id: 'a5', at: '2026-10-27T09:42:00Z', kind: 'ui', text: 'Built an interface: Tip calculator' },
    ] },
    [`GET ${ORIGIN}/schedules`]: { body: [{ id: 's1', name: '喝水提醒', instruction: '提醒他喝水：一句话，轻松点。不要长篇。', when: { kind: 'daily', time: '08:00' }, nextRunAt: '2026-10-28T08:00:00-04:00', active: true }] },
    [`GET ${ORIGIN}/goals`]: { body: [] }, [`GET ${ORIGIN}/ideas`]: { body: [] }, [`POST ${ORIGIN}/api/session/list`]: { body: { result: { ok: true, value: { items: [] } } } },
  } })
  await app.waitFor('label:设置')
  await app.press('label:设置')
  await app.press('text:活动')
  await app.waitFor('text:第一周：先能跑起来')
  expect(app.texts().some((x) => /\b(show|ui|name|something-new)\b/.test(x))).toBe(false)
  expect(app.shows('text:做了一个界面：Tip calculator')).toBe(true)
  expect(app.shows('text:/Built an interface/')).toBe(false)
  await app.back(); await app.back()
  await app.press('label:菜单')
  await app.press('text:日程')
  await app.waitFor('text:喝水提醒')
  expect(app.shows('text:/提醒他喝水/')).toBe(false)
})

// Settings does not point people at the assistant's raw files (QA pass, 2026-10-27: 「长按这里编辑原始文件」 under
// Its style). The long press stays for whoever knows it.
test('Settings says how to change its style in the chat, and nothing about raw files', async () => {
  for (const lang of ['zh', 'en']) {
    const app = await open('./App.tsx', { storage: { ...paired, lang }, network: { [`GET ${ORIGIN}/me`]: { body: meBody('Nori') }, [`GET ${ORIGIN}/threads`]: { body: threads } } })
    await app.press(lang === 'zh' ? 'label:设置' : 'label:Settings')
    await app.waitFor(lang === 'zh' ? 'text:/简短一点/' : 'text:/be brief/')
    expect(app.texts().some((x) => /原始文件|raw files|SOUL\.md/i.test(x))).toBe(false)
  }
})

// What the assistant hands over shows in the thread: an image inline, fetched from the computer's library with the
// device's token, any other file as a card; a tap opens the file's page. Markdown images that point at the
// computer's files come the same way. The owner saw blank space where three charts were (Android APK, 2026-10-27).
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
test('files the assistant presents: an image in the thread, a file as a card; markdown images from the computer too', async () => {
  const img = (p: string) => `GET ${ORIGIN}/library/file?path=${encodeURIComponent(p)}&format=json`
  const app = await chatApp({
    [img('/data/workspace/charts/intc.png')]: { body: { path: '/data/workspace/charts/intc.png', kind: 'image', mime: 'image/png', size: 70, truncated: false, base64: PNG } },
    [img('charts/hood.png')]: { body: { path: 'charts/hood.png', kind: 'image', mime: 'image/png', size: 70, truncated: false, base64: PNG } },
    [img('/data/workspace/report.pdf')]: { body: { path: '/data/workspace/report.pdf', kind: 'binary', mime: 'application/pdf', size: 2048, truncated: false } },
  })
  await app.waitFor('id:composer')
  await app.host.send('thread', [snapshot([
    you('Charts please'),
    { kind: 'file', id: 'c7:0', path: '/data/workspace/charts/intc.png', name: 'intc.png', description: 'INTC daily', image: true, at: AT },
    { kind: 'file', id: 'c7:1', path: '/data/workspace/report.pdf', name: 'report.pdf', description: 'The report', image: false, at: AT },
    them('And HOOD:\n\n![HOOD daily](charts/hood.png)'),
  ])])
  await app.waitFor('id:file-c7:0-image')
  await app.waitUntil(() => app.requests().some((r) => r.url === img('charts/hood.png').slice(4)))
  expect(app.requests().find((r) => r.url === img('/data/workspace/charts/intc.png').slice(4))!.headers.authorization).toBe(`Bearer ${TOKEN}`)
  expect(app.shows('id:file-c7:1')).toBe(true)
  expect(app.shows('text:report.pdf')).toBe(true)
  expect(app.shows('text:The report')).toBe(true)
  await app.press('id:file-c7:1')
  await app.waitFor('id:delete-file')
  await app.back()
  await app.press('id:file-c7:0-image')
  await app.waitFor('id:delete-file')
})

// "Write me a haiku and save it as haiku.md": the haiku showed in the reply and nothing in the thread opened the file
// (side-by-side run against DS-Bot, 2026-10-27). The bot now cards each workspace file a turn wrote or changed
// (src/fold.ts); the card says whether the file is new or changed, never its path, and opens the file's page.
test('a file the assistant wrote is a card under the reply that opens the file; it says new or edited, never the path', async () => {
  const file = (p: string) => `GET ${ORIGIN}/library/file?path=${encodeURIComponent(p)}&format=json`
  for (const [lng, made, changed] of [['en', 'New file', 'Edited'], ['zh', '新文件', '已修改']] as const) {
    const app = await open('./App.tsx', { storage: { ...paired, lang: lng }, network: {
      [`GET ${ORIGIN}/me`]: { body: meBody('Nori') }, [`GET ${ORIGIN}/threads`]: { body: threads },
      [file('/data/workspace/haiku.md')]: { body: { path: '/data/workspace/haiku.md', kind: 'text', mime: 'text/markdown; charset=utf-8', size: 40, truncated: false, text: 'Old pond, a frog jumps in' } },
    } })
    await app.waitFor('id:composer')
    await app.host.send('thread', [snapshot([
      you('write me a haiku and save it as haiku.md'),
      them('Old pond, a frog jumps in. Saved it.'),
      { kind: 'file', id: 'changed:1:/data/workspace/haiku.md', path: '/data/workspace/haiku.md', name: 'haiku.md', image: false, change: 'new', at: AT },
      { kind: 'file', id: 'changed:1:/data/workspace/notes/plan.md', path: '/data/workspace/notes/plan.md', name: 'plan.md', image: false, change: 'edited', at: AT },
    ])])
    await app.waitFor('id:file-changed:1:/data/workspace/haiku.md')
    expect(app.shows(`id:file-changed:1:/data/workspace/haiku.md >> text:${made}`)).toBe(true)
    expect(app.shows(`id:file-changed:1:/data/workspace/notes/plan.md >> text:${changed}`)).toBe(true)
    expect(app.texts().some((x) => x.includes('/data/'))).toBe(false)
    await app.press('id:file-changed:1:/data/workspace/haiku.md')
    await app.waitFor('text:Old pond, a frog jumps in')
    expect(app.shows('id:delete-file')).toBe(true)
    app.dispose()
  }
})

// On the Android APK a reply's markdown images of the computer's files drew nothing: the reply said 「三张都画好了…：」,
// then a screen of blank space, then its last line (hosted, zh, dark, 2026-10-27), although the same three charts as
// presented file rows drew above it. NSH's markdown view on Android keeps the room of a view drawn in an image's place
// but does not show it. Those images are drawn under the reply's words instead, as views of their own, and one the
// assistant also presented in this thread is not drawn a second time.
test('a reply\'s images of the computer\'s files show under its words; one it also presented shows once', async () => {
  const img = (p: string) => `GET ${ORIGIN}/library/file?path=${encodeURIComponent(p)}&format=json`
  const body = (p: string) => ({ body: { path: p, kind: 'image', mime: 'image/png', size: 70, truncated: false, base64: PNG } })
  const app = await chatApp({ [img('/data/workspace/charts/intc.png')]: body('/data/workspace/charts/intc.png'), [img('charts/hood.png')]: body('charts/hood.png') })
  await app.waitFor('id:composer')
  await app.host.send('thread', [snapshot([
    you('Charts please'),
    { kind: 'file', id: 'c7:0', path: '/data/workspace/charts/intc.png', name: 'intc.png', description: 'INTC daily', image: true, at: AT },
    them('All drawn:\n\n![INTC](charts/intc.png)\n\n![HOOD daily](charts/hood.png)\n\nThe script is make.py.'),
  ])])
  await app.waitFor('id:md-image-a1-0')
  expect(app.shows('label:HOOD daily')).toBe(true)
  expect(app.count('id:md-image-a1-1')).toBe(0)
  expect(app.count('label:INTC')).toBe(0) // presented above: not again
  expect(app.shows('id:file-c7:0-image')).toBe(true)
  expect(app.shows('text:/The script is make.py/')).toBe(true)
  await app.press('id:md-image-a1-0')
  await app.waitFor('id:delete-file')
})

// The device is named for what it is: an Android phone said "Phone" in the Devices list (QA pass, 2026-10-27).
test('pairing names the device: Android on Android, iPhone on iOS', async () => {
  for (const [platform, name] of [['android', 'Android'], ['ios', 'iPhone']] as const) {
    const app = await open('./App.tsx', { platform, network: { [`POST ${ORIGIN}/pair`]: { body: { token: TOKEN } }, [`GET ${ORIGIN}/me`]: { body: meBody('') } } })
    await app.press('id:own-computer')
    await app.type('id:address', `${ORIGIN}/pair?code=123456`)
    await app.press('id:connect')
    await app.waitUntil(() => app.requests().some((r) => r.url.endsWith('/pair')))
    expect(JSON.parse(String(app.requests().find((r) => r.url.endsWith('/pair'))!.body)).name).toBe(name)
  }
})

test('a standing rule\'s notice names what it did in words, not the tool', async () => {
  const app = await open('./App.tsx', { storage: { ...paired, lang: 'zh' }, network: { [`GET ${ORIGIN}/me`]: { body: meBody('Nori') }, [`GET ${ORIGIN}/threads`]: { body: threads } } })
  await app.waitFor('id:composer')
  await app.host.send('event', { type: 'auto-approved', eventId: 'e9', sessionId: 'main', toolName: 'bash' })
  await app.waitFor('text:已按规则允许执行命令')
  expect(app.texts().some((x) => /bash/.test(x))).toBe(false)
})

// Settings says where it is connected in words: a computer the host made is "your computer in the cloud"; only a
// computer the person runs themselves is named by its address (Android showed "已连接 example-sandbox.fly.dev").
test('settings names a hosted computer in words, never its address', async () => {
  const SB = 'https://sb-1.cloud.example.dev'
  const app = await open('./App.tsx', { storage: { origin: SB, token: TOKEN, lang: 'zh', hostedBy: 'https://host.example.dev' }, network: { [`GET ${SB}/me`]: { body: meBody('Nori') }, [`GET ${SB}/threads`]: { body: threads } } })
  await app.waitFor('label:设置')
  await app.press('label:设置')
  await app.waitFor('text:云端电脑')
  expect(app.texts().some((x) => x.includes('sb-1'))).toBe(false)
})

test('a hosted computer paired before the app remembered it: same parent domain as the build\'s host', () => {
  expect(isHostedOrigin('https://example-sandbox.fly.dev', null, 'https://example-host.fly.dev')).toBe(true)
  expect(isHostedOrigin('https://abc.trycloudflare.com', null, 'https://example-host.fly.dev')).toBe(false)
  expect(isHostedOrigin('http://192.168.1.20:3850', null, null)).toBe(false)
  expect(isHostedOrigin('http://192.168.1.20:3850', 'https://host.example.dev', null)).toBe(true)
})

// A card that waits for the person takes the room the keyboard had: on a small phone with the keyboard up, the
// approval card slid under the header (Android emulator, 2026-10-27).
test('a new approval or question puts the keyboard down', async () => {
  const app = await chatApp()
  await app.waitFor('id:composer')
  await app.type('id:composer', 'hi')
  await app.host.send('asks', [{ kind: 'approval', eventId: 'e1', sessionId: 'main', request: { toolName: 'bash', reason: 'x' }, at: 1 }])
  await app.waitFor('id:ask-e1')
  await app.keyboard.press('y')
  expect(app.value('id:composer')).toBe('hi')
})

// Opening the app never flashes the naming screen while /me loads (its field took the focus and brought the keyboard
// up on Android, 2026-10-27): the last known assistant shows at once, and with nothing known yet, nothing does.
test('launch: no naming screen while /me loads; the last known assistant shows at once', async () => {
  const slow = { [`GET ${ORIGIN}/me`]: { body: meBody('Nori'), delay: 1500 }, [`GET ${ORIGIN}/threads`]: { body: threads } }
  // manual clocks: /me (1.5 s) has not answered until the test moves the clock
  const first = await open('./App.tsx', { storage: paired, network: slow, clock: {} })
  await first.wait(500)
  expect(first.shows('text:What will you call your assistant?')).toBe(false)
  await first.wait(1500)
  await first.waitFor('id:composer')
  // the app remembered who it is: the next launch draws the chat before /me answers
  await first.waitUntil(() => Boolean(first.storage().me))
  const again = await open('./App.tsx', { storage: first.storage(), network: slow, clock: {} })
  await again.wait(1000)
  expect(again.shows('id:composer')).toBe(true)
  expect(again.shows('text:What will you call your assistant?')).toBe(false)
})

// With no thread to post to yet (the computer did not answer), Send keeps the words and says why; it never clears
// them into nothing (Android emulator against an unreachable computer, 2026-10-27).
test('send before the thread is open keeps the text and says it is not connected', async () => {
  const app = await open('./App.tsx', { storage: paired, network: { [`GET ${ORIGIN}/me`]: { body: { ...meBody('Nori'), mainSessionId: null } }, [`POST ${ORIGIN}/sessions/main`]: { error: 'connection refused' } } })
  await app.waitFor('id:composer')
  await app.type('id:composer', 'hello there')
  await app.press('id:send')
  await app.waitFor('text:Could not reach the assistant.')
  expect(app.value('id:composer')).toBe('hello there')
})

// The keyboard belongs to the composer: leaving the chat (a pushed page, the other tab) takes it down, so no
// other screen opens with the keyboard over it (Android, 2026-10-27). A key typed after leaving reaches no input.
test('leaving the chat dismisses the keyboard: a pushed page and the other tab', async () => {
  const app = await chatApp({ [`GET ${ORIGIN}/goals`]: { body: [] }, [`GET ${ORIGIN}/schedules`]: { body: [] }, [`GET ${ORIGIN}/activity`]: { body: [] }, [`GET ${ORIGIN}/ideas`]: { body: [] }, [`POST ${ORIGIN}/api/session/list`]: { body: { result: { ok: true, value: { items: [] } } } } })
  await app.waitFor('id:composer')
  await app.type('id:composer', 'hi')
  await app.press('label:Menu')
  await app.keyboard.press('y')
  await app.back()
  expect(app.value('id:composer')).toBe('hi')
  await app.type('id:composer', '!')
  await app.press('label:Settings')
  await app.keyboard.press('y')
  await app.back()
  expect(app.value('id:composer')).toBe('hi!')
  await app.type('id:composer', '?')
  await app.host.send('tab', 1)
  await app.keyboard.press('z')
  await app.host.send('tab', 0)
  expect(app.value('id:composer')).toBe('hi!?')
})
