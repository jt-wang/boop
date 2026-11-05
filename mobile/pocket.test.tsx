// Local use reaches the computer through TailPocket: scan once, then the phone
// asks the native bridge for a loopback address at every launch, because its port changes each time.
import { expect, open, test } from 'nsh/test'

const invite = 'tailpocket1:synthetic'
const link = { address: 'fd7a:115c:a1e0::1', port: 48931, name: 'Studio Mac', payload: '123456', key: 'privkey:synthetic' }
const tunnel = (port: number) => ({ handle: port, port, baseUrl: `http://127.0.0.1:${port}` })
const body = { device: { id: 'd1', name: 'iPhone' }, assistant: { name: 'Nori' }, mainSessionId: 'main', computer: { name: 'Studio Mac', version: '9.8.7' } }
const reachable = (port: number) => ({
  [`GET http://127.0.0.1:${port}/me`]: { body },
  [`GET http://127.0.0.1:${port}/threads`]: { body: [{ sessionId: 'main', title: '', updatedAt: 1700000000000, running: false, blank: false }] },
  [`POST http://127.0.0.1:${port}/ws-ticket`]: { body: { ticket: 't' } },
})
const toConnect = async (app: Awaited<ReturnType<typeof open>>) => { await app.waitFor('id:own-computer'); await app.press('id:own-computer'); await app.waitFor('id:connect') }

test('scan the code: pairs, spends the code that came inside the tunnel, and is in', async () => {
  let paired: { invite?: string; save?: boolean } = {}
  let claimed: { code?: string } = {}
  const app = await open('./App.tsx', {
    host: { handlers: { 'tailPocket.scan': invite, 'tailPocket.pair': (d: typeof paired) => { paired = d; return link }, 'tailPocket.connect': tunnel(50123) } },
    network: { ...reachable(50123), 'POST http://127.0.0.1:50123/pair': (req: { body: string }) => { claimed = JSON.parse(req.body); return { body: { token: 'tok_abcdefghijklmnopqrstuvwxyz0123456789' } } } },
  })
  await toConnect(app)
  await app.press('id:scan')
  await app.waitFor('label:Settings')
  expect(paired.invite).toBe(invite)
  expect(paired.save).toBe(true)
  expect(claimed.code).toBe('123456')
  expect(app.storage().pocket).toBe('1')
})

test('the code on the computer can be pasted: where there is no camera, or from a link', async () => {
  let paired: { invite?: string } = {}
  const app = await open('./App.tsx', {
    host: { handlers: { 'tailPocket.pair': (d: typeof paired) => { paired = d; return link }, 'tailPocket.connect': tunnel(50123) } },
    network: { ...reachable(50123), 'POST http://127.0.0.1:50123/pair': { body: { token: 'tok_abcdefghijklmnopqrstuvwxyz0123456789' } } },
  })
  await toConnect(app)
  expect(app.shows('id:code')).toBe(true)
  await app.type('id:address', invite)
  await app.waitUntil(() => !app.shows('id:code')) // the code comes inside the tunnel: nothing else to type
  expect(app.shows('text:Six digits, shown next to the QR code on the computer.')).toBe(false)
  await app.press('id:connect')
  await app.waitFor('label:Settings')
  expect(paired.invite).toBe(invite)
})

for (const [code, words] of [['expired', 'This code has expired. Make a new one on the computer.'], ['invalid-invite', 'That is not a Boop pairing code.'], ['unreachable', 'The computer did not answer. Check that Boop is running on it.'], ['denied', 'The computer said no.']] as const) {
  test(`a failed pairing says why: ${code}`, async () => {
    const app = await open('./App.tsx', { host: { handlers: { 'tailPocket.scan': invite, 'tailPocket.pair': () => { throw new Error(code) } } } })
    await toConnect(app)
    await app.press('id:scan')
    await app.waitFor(`text:${words}`)
    expect(app.storage().token).toBe(undefined)
  })
}

test('closing the scanner is no error', async () => {
  const app = await open('./App.tsx', { host: { handlers: { 'tailPocket.scan': () => { throw new Error('cancelled') } } } })
  await toConnect(app)
  await app.press('id:scan')
  await app.waitFor('id:scan')
  expect(app.shows('id:connect-error')).toBe(false)
})

test('the next launch opens the tunnel again and uses the new port, not the saved one', async () => {
  let opened = 0
  const app = await open('./App.tsx', {
    storage: { origin: 'http://127.0.0.1:50123', token: 'tok_abcdefghijklmnopqrstuvwxyz0123456789', pocket: '1' },
    host: { handlers: { 'tailPocket.connect': () => { opened++; return tunnel(50999) } } },
    network: reachable(50999),
  })
  await app.waitFor('label:Settings')
  expect(opened).toBe(1)
  expect(app.storage().origin).toBe('http://127.0.0.1:50999')
})

test('a tunnel that stopped answering is opened again', async () => {
  let opened = 0
  const app = await open('./App.tsx', {
    storage: { origin: 'http://127.0.0.1:50123', token: 'tok_abcdefghijklmnopqrstuvwxyz0123456789', pocket: '1' },
    host: { handlers: { 'tailPocket.connect': () => tunnel(++opened === 1 ? 50100 : 50200) } },
    network: reachable(50200),
  })
  await app.waitFor('label:Settings', { timeout: 15000 })
  expect(opened > 1).toBe(true)
  expect(app.storage().origin).toBe('http://127.0.0.1:50200')
})

test('a phone whose saved link is gone goes back to pairing', async () => {
  const app = await open('./App.tsx', {
    storage: { origin: 'http://127.0.0.1:50123', token: 'tok_abcdefghijklmnopqrstuvwxyz0123456789', pocket: '1' },
    host: { handlers: { 'tailPocket.connect': () => { throw new Error('not-paired') } } },
  })
  await app.waitFor('id:own-computer')
  expect(app.storage().token).toBe(undefined)
  expect(app.storage().pocket).toBe(undefined)
})

const settings = async (path?: () => { kind: string; relay?: string }) => {
  const app = await open('./App.tsx', {
    storage: { origin: 'http://127.0.0.1:50999', token: 'tok_abcdefghijklmnopqrstuvwxyz0123456789', pocket: '1' },
    host: { handlers: { 'tailPocket.connect': tunnel(50999), ...(path ? { 'tailPocket.path': path } : {}) } },
    network: reachable(50999),
  })
  await app.waitFor('label:Settings')
  await app.press('label:Settings')
  await app.waitFor('id:computer-status')
  await app.host.send('event', { type: 'hello', connected: true, asks: [] })
  return app
}

test('Settings: through TailPocket the connection is end-to-end encrypted, and a loopback address is not called the local network', async () => {
  const app = await settings()
  expect(app.shows('text:End-to-end encrypted')).toBe(true)
  expect(app.shows('text:Not encrypted')).toBe(false)
  expect(app.shows('text:Through TailPocket to your computer')).toBe(true)
  expect(app.texts().join(' ')).not.toContain('local network')
})

// Waits for TailPocket's connection.path() (its bridge has no such call yet); until then Settings names neither.
test.skip('Settings: the way there is what TailPocket reports, direct or relay', async () => {
  const direct = await settings(() => ({ kind: 'direct' }))
  await direct.waitFor('text:Directly to your computer, through TailPocket')
  const relay = await settings(() => ({ kind: 'relay', relay: 'tok' }))
  await relay.waitFor('text:Through a relay (tok) to your computer. The relay cannot read it.')
})

test('pairing again after unpairing opens the chat, not the Settings page the unpairing was done from', async () => {
  const app = await open('./App.tsx', {
    storage: { origin: 'http://127.0.0.1:50999', token: 'tok_abcdefghijklmnopqrstuvwxyz0123456789', pocket: '1' },
    host: { handlers: { 'tailPocket.connect': tunnel(50999), 'tailPocket.store.deleteLink': null, 'tailPocket.disconnect': null, 'tailPocket.scan': invite, 'tailPocket.pair': link } },
    network: { ...reachable(50999), 'DELETE http://127.0.0.1:50999/devices/d1': { body: { ok: true } }, 'POST http://127.0.0.1:50999/pair': { body: { token: 'tok_abcdefghijklmnopqrstuvwxyz0123456789', device: { id: 'd2', name: 'iPhone' } } } },
  })
  await app.waitFor('label:Settings')
  await app.press('label:Settings')
  await app.waitFor('id:unpair')
  app.onDialog((d) => d.buttons.find((b) => b === 'Unpair this phone') ?? null)
  await app.press('id:unpair')
  await toConnect(app)
  await app.press('id:scan')
  await app.waitFor('label:Settings') // the chat's gear; the Settings page has none
})

test('unpairing forgets the computer on this phone too', async () => {
  let deleted = 0, closed = 0
  const app = await open('./App.tsx', {
    storage: { origin: 'http://127.0.0.1:50999', token: 'tok_abcdefghijklmnopqrstuvwxyz0123456789', pocket: '1' },
    host: { handlers: { 'tailPocket.connect': tunnel(50999), 'tailPocket.store.deleteLink': () => { deleted++; return null }, 'tailPocket.disconnect': () => { closed++; return null } } },
    network: { ...reachable(50999), 'DELETE http://127.0.0.1:50999/devices/d1': { body: { ok: true } } },
  })
  await app.waitFor('label:Settings')
  await app.press('label:Settings')
  await app.waitFor('id:unpair')
  app.onDialog((d) => d.buttons.find((b) => b === 'Unpair this phone') ?? null)
  await app.press('id:unpair')
  await app.waitFor('id:own-computer')
  expect(deleted).toBe(1)
  expect(closed).toBe(1)
  expect(app.storage().pocket).toBe(undefined)
})
