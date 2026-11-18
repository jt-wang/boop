// The connect screen: scan the computer's QR code, or paste the code the
// Boop window copies (Copy code → `tailpocket1:…`). The address and six-digit code of a server the person runs
// themselves sit behind one small "Connect to a server address" link.
import { expect, open, test } from 'nsh/test'

const invite = 'tailpocket1:synthetic'
const ORIGIN = 'http://127.0.0.1:3850'
const TOKEN = 'tok_abcdefghijklmnopqrstuvwxyz0123456789'
const link = { address: '2001:db8::1', port: 48931, name: 'Studio Mac', payload: '123456', key: 'privkey:synthetic' }
const tunnel = (port: number) => ({ handle: port, port, baseUrl: `http://127.0.0.1:${port}` })
const body = { device: { id: 'd1', name: 'iPhone' }, assistant: { name: 'Nori' }, mainSessionId: 'main', computer: { name: 'Studio Mac', version: '9.8.7' } }
const reachable = (port: number) => ({
  [`GET http://127.0.0.1:${port}/me`]: { body },
  [`GET http://127.0.0.1:${port}/threads`]: { body: [{ sessionId: 'main', title: '', updatedAt: 1700000000000, running: false, blank: false }] },
  [`POST http://127.0.0.1:${port}/ws-ticket`]: { body: { ticket: 't' } },
  [`POST http://127.0.0.1:${port}/pair`]: { body: { token: TOKEN } },
})
const toConnect = async (app: Awaited<ReturnType<typeof open>>) => { await app.waitFor('id:own-computer'); await app.press('id:own-computer'); await app.waitFor('id:scan') }

test('the connect screen offers two ways in: scan, or paste the code; no address or six-digit code', async () => {
  const app = await open('./App.tsx', { host: { handlers: {} } })
  await toConnect(app)
  expect(app.shows('id:paste-code')).toBe(true)
  expect(app.shows('id:invite')).toBe(false)
  expect(app.shows('id:address')).toBe(false)
  expect(app.shows('id:code')).toBe(false)
  expect(app.shows('id:connect-server')).toBe(true)
})

test('pasting the code from the Boop window pairs through TailPocket', async () => {
  let paired: { invite?: string } = {}
  const app = await open('./App.tsx', {
    host: { handlers: { 'tailPocket.pair': (d: typeof paired) => { paired = d; return link }, 'tailPocket.connect': tunnel(50123) } },
    network: reachable(50123),
  })
  await toConnect(app)
  await app.press('id:paste-code')
  await app.waitFor('id:invite')
  await app.waitFor('text:/Copy code/')
  await app.type('id:invite', invite)
  await app.press('id:connect')
  await app.waitFor('label:Settings')
  expect(paired.invite).toBe(invite)
})

test('something that is not a Boop code is explained, and nothing is sent', async () => {
  let asked = 0
  const app = await open('./App.tsx', { host: { handlers: { 'tailPocket.pair': () => { asked++; return link } } } })
  await toConnect(app)
  await app.press('id:paste-code')
  await app.type('id:invite', 'hello')
  await app.press('id:connect')
  await app.waitFor('text:That is not a Boop pairing code.')
  expect(asked).toBe(0)
})

test('a server address and its six-digit code are behind "Connect to a server address"', async () => {
  const app = await open('./App.tsx', { host: { handlers: {} }, network: { [`POST ${ORIGIN}/pair`]: { body: { token: TOKEN } }, [`GET ${ORIGIN}/me`]: { body: { ...body, assistant: { name: '' } } } } })
  await toConnect(app)
  await app.press('id:connect-server')
  await app.waitFor('id:address')
  await app.type('id:address', ORIGIN)
  await app.type('id:code', '123456')
  await app.press('id:connect')
  await app.waitFor('text:What will you call your assistant?')
  expect(JSON.parse(String(app.requests().find((r) => r.url === `${ORIGIN}/pair`)!.body)).code).toBe('123456')
})

test('a deepseekbot://pair?invite= link opens the pasted code filled in; Connect pairs', async () => {
  let paired: { invite?: string } = {}
  const app = await open('./App.tsx', {
    host: { params: { pairUrl: invite }, handlers: { 'tailPocket.pair': (d: typeof paired) => { paired = d; return link }, 'tailPocket.connect': tunnel(50123) } },
    network: reachable(50123),
  })
  await app.waitFor('id:invite')
  expect(app.value('id:invite')).toBe(invite)
  await app.press('id:connect')
  await app.waitFor('label:Settings')
  expect(paired.invite).toBe(invite)
})

test('a server pairing link opens the server address filled in', async () => {
  const app = await open('./App.tsx', { host: { params: { pairUrl: `${ORIGIN}/pair?code=654321` } } })
  await app.waitFor('id:address')
  expect(app.value('id:address')).toBe(ORIGIN)
  expect(app.value('id:code')).toBe('654321')
})

test('in the browser, with no camera to scan, the address and code show at once', async () => {
  const app = await open('./App.tsx', { platform: 'web' })
  await app.waitFor('id:own-computer')
  await app.press('id:own-computer')
  await app.waitFor('id:address')
  expect(app.shows('id:scan')).toBe(false)
  expect(app.shows('id:paste-code')).toBe(false)
})
