// Local use reaches the computer through TailPocket: scan once, then the phone
// asks the native bridge for a loopback address at every launch, because its port changes each time.
import { expect, open, test } from 'nsh/test'

const invite = 'tailpocket1:synthetic'
const link = { address: 'fd7a:115c:a1e0::1', port: 48931, name: 'Studio Mac', payload: '123456', key: 'privkey:synthetic' }
// as TailPocket v0.3.0-pre.4 answers connect: the forward lets through only requests under `baseUrl`, which carries its token
const base = (port: number) => `http://127.0.0.1:${port}/_tailpocket/fwd${port}`
const tunnel = (port: number) => ({ handle: port, port, baseUrl: base(port), token: `fwd${port}` })
const body = { device: { id: 'd1', name: 'iPhone' }, assistant: { name: 'Nori' }, mainSessionId: 'main', computer: { name: 'Studio Mac', version: '9.8.7' } }
const reachable = (port: number) => ({
  [`GET ${base(port)}/me`]: { body },
  [`GET ${base(port)}/threads`]: { body: [{ sessionId: 'main', title: '', updatedAt: 1700000000000, running: false, blank: false }] },
  [`POST ${base(port)}/ws-ticket`]: { body: { ticket: 't' } },
})
const toConnect = async (app: Awaited<ReturnType<typeof open>>) => { await app.waitFor('id:own-computer'); await app.press('id:own-computer'); await app.waitFor('id:scan') }

test('scan the code: pairs, spends the code that came inside the tunnel, and is in', async () => {
  let paired: { invite?: string; save?: boolean } = {}
  let claimed: { code?: string } = {}
  const app = await open('./App.tsx', {
    host: { handlers: { 'tailPocket.scan': invite, 'tailPocket.pair': (d: typeof paired) => { paired = d; return link }, 'tailPocket.connect': tunnel(50123) } },
    network: { ...reachable(50123), [`POST ${base(50123)}/pair`]: (req) => { claimed = JSON.parse(String(req.body)); return { body: { token: 'tok_abcdefghijklmnopqrstuvwxyz0123456789' } } } },
  })
  await toConnect(app)
  await app.press('id:scan')
  await app.waitFor('label:Settings')
  expect(paired.invite).toBe(invite)
  expect(paired.save).toBe(true)
  expect(claimed.code).toBe('123456')
  expect(app.storage().pocket).toBe('1')
  expect(app.storage().origin).toBe('http://127.0.0.1:50123') // the forward token stays in memory
})

test('the code can also go in the server address field: the six-digit field then goes away', async () => {
  let paired: { invite?: string } = {}
  const app = await open('./App.tsx', {
    host: { handlers: { 'tailPocket.pair': (d: typeof paired) => { paired = d; return link }, 'tailPocket.connect': tunnel(50123) } },
    network: { ...reachable(50123), [`POST ${base(50123)}/pair`]: { body: { token: 'tok_abcdefghijklmnopqrstuvwxyz0123456789' } } },
  })
  await toConnect(app)
  await app.press('id:connect-server')
  expect(app.shows('id:code')).toBe(true)
  await app.type('id:address', invite)
  await app.waitUntil(() => !app.shows('id:code')) // the code comes inside the tunnel: nothing else to type
  expect(app.shows('text:Six digits, shown next to the QR code on the computer.')).toBe(false)
  await app.press('id:connect')
  await app.waitFor('label:Settings')
  expect(paired.invite).toBe(invite)
})

for (const [code, words] of [['expired', 'This code has expired. Make a new one on the computer.'], ['invalid-invite', 'That is not a Boop pairing code.'], ['unreachable', 'The computer did not answer. Check that Boop is running on it.'], ['denied', 'The computer said no.'], ['unauthorized', 'The computer did not pair this phone, or the code was already used. Show a new code on the computer and scan again.']] as const) {
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

// TailPocket v0.3: a link from before it has no `pk`. The new app registers its key once over Tailcat; no new QR.
const launch = (handlers: Record<string, unknown>) => open('./App.tsx', {
  storage: { origin: 'http://127.0.0.1:50999', token: 'tok_abcdefghijklmnopqrstuvwxyz0123456789', pocket: '1' },
  host: { handlers: { 'tailPocket.connect': tunnel(50999), ...handlers } },
  network: reachable(50999),
})
test('an old link without the computer\'s key syncs it once the tunnel is open', async () => {
  const synced: unknown[] = []
  const app = await launch({ 'tailPocket.link': link, 'tailPocket.sync': (d: unknown) => { synced.push(d); return { ...link, pk: 'host-noise', via: [] } } })
  await app.waitFor('label:Settings')
  await app.waitUntil(() => synced.length > 0)
  expect(synced).toEqual([{ handle: 50999 }])
})

test('a link that has the key already does not sync', async () => {
  let synced = 0, asked = 0
  const app = await launch({ 'tailPocket.link': () => { asked++; return { ...link, pk: 'host-noise' } }, 'tailPocket.sync': () => { synced++; return link } })
  await app.waitFor('label:Settings')
  await app.waitUntil(() => asked > 0)
  await new Promise((r) => setTimeout(r, 200))
  expect(synced).toBe(0)
})

test('a computer before v0.3 refuses the sync: nothing is said, the phone stays in over Tailcat', async () => {
  let synced = 0
  const app = await launch({ 'tailPocket.link': link, 'tailPocket.sync': () => { synced++; throw new Error('unreachable') }, 'tailPocket.store.deleteLink': () => { throw new Error('the link must stay') } })
  await app.waitFor('label:Settings')
  await app.waitUntil(() => synced > 0)
  await new Promise((r) => setTimeout(r, 200))
  expect(app.shows('label:Settings')).toBe(true)
  expect(app.shows('id:own-computer')).toBe(false)
  expect(app.storage().pocket).toBe('1')
  expect(app.storage().token).toBe('tok_abcdefghijklmnopqrstuvwxyz0123456789')
})

for (const [code, pairs] of [['tailpocket2:synthetic', true], ['tailpocket3:synthetic', false]] as const) {
  test(`a computer with a relay shows a tailpocket2: code; pasting ${code} ${pairs ? 'pairs' : 'is no code'}`, async () => {
    let paired: { invite?: string } = {}
    const app = await open('./App.tsx', {
      host: { handlers: { 'tailPocket.pair': (d: typeof paired) => { paired = d; return { ...link, pk: 'host-noise' } }, 'tailPocket.connect': tunnel(50123) } },
      network: { ...reachable(50123), [`POST ${base(50123)}/pair`]: { body: { token: 'tok_abcdefghijklmnopqrstuvwxyz0123456789' } } },
    })
    await toConnect(app)
    await app.press('id:paste-code')
    await app.waitFor('id:invite')
    await app.type('id:invite', code)
    await app.press('id:connect')
    if (pairs) { await app.waitFor('label:Settings'); expect(paired.invite).toBe(code) }
    else { await app.waitFor('text:That is not a Boop pairing code.'); expect(paired.invite).toBe(undefined) }
  })
}

test('a phone whose saved link is gone goes back to pairing', async () => {
  const app = await open('./App.tsx', {
    storage: { origin: 'http://127.0.0.1:50123', token: 'tok_abcdefghijklmnopqrstuvwxyz0123456789', pocket: '1' },
    host: { handlers: { 'tailPocket.connect': () => { throw new Error('not-paired') } } },
  })
  await app.waitFor('id:own-computer')
  expect(app.storage().token).toBe(undefined)
  expect(app.storage().pocket).toBe(undefined)
})

const settings = async (path?: () => unknown, more: Record<string, unknown> = {}) => {
  const app = await open('./App.tsx', {
    storage: { origin: 'http://127.0.0.1:50999', token: 'tok_abcdefghijklmnopqrstuvwxyz0123456789', pocket: '1' },
    host: { handlers: { 'tailPocket.connect': tunnel(50999), ...(path ? { 'tailPocket.path': path } : {}), ...more } },
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

// TailPocket v0.3's connection.path(): {route, relay}.
test('Settings: the way there is what TailPocket reports, direct, relay or lan', async () => {
  const direct = await settings(() => ({ route: 'direct', relay: '' }))
  await direct.waitFor('text:Directly to your computer, through TailPocket')
  const relay = await settings(() => ({ route: 'relay', relay: 'relay.example.com' }))
  await relay.waitFor('text:Through a relay (relay.example.com) to your computer. The relay cannot read it.')
  const derp = await settings(() => ({ route: 'relay', relay: '' }))
  await derp.waitFor('text:Through a relay to your computer. The relay cannot read it.')
  const lan = await settings(() => ({ route: 'lan', relay: '' }))
  await lan.waitFor('text:Straight to your computer over the local network, through TailPocket')
  expect(lan.shows('text:End-to-end encrypted')).toBe(true)
  const later = await settings(() => ({ route: 'carrier-pigeon', relay: '' }))
  await later.waitFor('text:Through TailPocket to your computer') // a route this app does not know yet is named by neither
})

test('Settings: a path that fails for another reason says nothing more and keeps the phone paired', async () => {
  let deleted = 0
  const app = await settings(() => { throw new Error('unreachable') }, { 'tailPocket.store.deleteLink': () => { deleted++; return null } })
  await app.waitFor('text:Through TailPocket to your computer')
  expect(app.shows('id:computer-status')).toBe(true)
  expect(deleted).toBe(0)
  expect(app.storage().token).toBe('tok_abcdefghijklmnopqrstuvwxyz0123456789')
})

// `revoked` is TailPocket telling this phone the computer removed it: the same as a refused token, signed out and the link gone.
test('the computer removed this phone (path rejects revoked): signed out, the link deleted, back to pairing', async () => {
  let deleted = 0, asked = 0
  const app = await open('./App.tsx', {
    storage: { origin: 'http://127.0.0.1:50999', token: 'tok_abcdefghijklmnopqrstuvwxyz0123456789', pocket: '1' },
    host: { handlers: { 'tailPocket.connect': tunnel(50999), 'tailPocket.path': () => { asked++; throw new Error('revoked') }, 'tailPocket.store.deleteLink': () => { deleted++; return null }, 'tailPocket.disconnect': null } },
    network: reachable(50999),
  })
  await app.waitFor('label:Settings')
  await app.press('label:Settings')
  await app.waitFor('id:own-computer')
  expect(asked > 0).toBe(true)
  expect(deleted).toBe(1)
  expect(app.storage().token).toBe(undefined)
  expect(app.storage().pocket).toBe(undefined)
})

test('pairing again after unpairing opens the chat, not the Settings page the unpairing was done from', async () => {
  const app = await open('./App.tsx', {
    storage: { origin: 'http://127.0.0.1:50999', token: 'tok_abcdefghijklmnopqrstuvwxyz0123456789', pocket: '1' },
    host: { handlers: { 'tailPocket.connect': tunnel(50999), 'tailPocket.store.deleteLink': null, 'tailPocket.disconnect': null, 'tailPocket.scan': invite, 'tailPocket.pair': link } },
    network: { ...reachable(50999), [`DELETE ${base(50999)}/devices/d1`]: { body: { ok: true } }, [`POST ${base(50999)}/pair`]: { body: { token: 'tok_abcdefghijklmnopqrstuvwxyz0123456789', device: { id: 'd2', name: 'iPhone' } } } },
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
    network: { ...reachable(50999), [`DELETE ${base(50999)}/devices/d1`]: { body: { ok: true } } },
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

// TailPocket v0.3.0-pre.4: a v2 pairing shows four emoji while the person at the computer compares them and confirms there.
test('a tailpocket2: pairing shows the emoji until the computer confirms, then goes on', async () => {
  let release: ((l: unknown) => void) | null = null
  const app = await open('./App.tsx', {
    host: { handlers: { 'tailPocket.scan': 'tailpocket2:synthetic', 'tailPocket.pair': () => new Promise((r) => { release = r }), 'tailPocket.connect': tunnel(50123) } },
    network: { ...reachable(50123), [`POST ${base(50123)}/pair`]: { body: { token: 'tok_abcdefghijklmnopqrstuvwxyz0123456789' } } },
  })
  await toConnect(app)
  const pressed = app.press('id:scan') // the press lasts as long as the pairing it starts
  await app.waitUntil(() => release !== null) // the bridge's pair is under way: its emoji event comes now
  await app.host.send('tailPocket.pair.emoji', { emoji: ['🐶', '🌙', '🍕', '🔑'] })
  await app.waitFor('text:🐶 🌙 🍕 🔑')
  await app.waitFor('text:Check that your computer shows the same emoji, then confirm there.')
  release!({ ...link, pk: 'host-noise' })
  await pressed
  await app.waitFor('label:Settings')
  expect(app.shows('id:pair-emoji')).toBe(false)
})

// TailPocket v0.3.2: the phone chooses its routes in Settings › Connection, and the choice reconnects at once.
test('Settings › Connection: LAN only goes to TailPocket, is kept on this phone, reconnects now, and says what it costs', async () => {
  const set: unknown[] = []; let opened = 0
  const app = await settings(() => ({ route: 'lan', relay: '' }), { 'tailPocket.setRoutes': (d: unknown) => { set.push(d); return null }, 'tailPocket.connect': () => (opened++, tunnel(50999)), 'tailPocket.disconnect': null })
  await app.waitFor('id:connection-row')
  await app.press('id:connection-row')
  await app.waitFor('id:route-all')
  for (const words of ['All routes', 'Local network only', 'Relay only', 'Tailcat only', '/Away from that network it does not connect/', '/Switching reconnects at once/', '/setup instructions on the computer/']) await app.waitFor(`text:${words}`)
  expect(app.shows('text:/npm start|--routes/')).toBe(false) // a phone's Settings names no developer command
  const before = opened
  await app.press('id:route-lan')
  await app.waitUntil(() => set.length === 1)
  expect(set[0]).toEqual({ routes: ['lan'] })
  expect(app.storage().pocketRoutes).toBe('lan')
  await app.waitUntil(() => opened > before) // an open tunnel keeps its routes: it opens again
  await app.waitFor('text:Reconnecting')
  // the events socket cannot open headless and keeps falling back to Reconnecting: say hello until the new way shows
  for (let i = 0; i < 30 && !app.shows('text:/Straight to your computer over the local network/'); i++) {
    await app.host.send('event', { type: 'hello', connected: true, asks: [] }); await new Promise((r) => setTimeout(r, 200))
  }
  expect(app.shows('text:/Straight to your computer over the local network/')).toBe(true)
  await app.press('id:route-all')
  await app.waitUntil(() => set.length === 2)
  expect(set[1]).toEqual({ routes: null }) // all routes: TailPocket's default again
})

test('Settings › Connection: a choice TailPocket refuses is neither shown nor kept, and says it failed', async () => {
  const app = await settings(undefined, { 'tailPocket.setRoutes': () => { throw new Error('invalid-routes') } })
  await app.press('id:connection-row')
  await app.waitFor('id:route-lan')
  await app.press('id:route-lan')
  await app.waitFor('text:Could not change how this phone connects. Try again.')
  expect(app.storage().pocketRoutes).toBe(undefined)
})

test('Settings: the footer says when this phone is limited to one route', async () => {
  const app = await open('./App.tsx', {
    storage: { origin: 'http://127.0.0.1:50999', token: 'tok_abcdefghijklmnopqrstuvwxyz0123456789', pocket: '1', pocketRoutes: 'relay' },
    host: { handlers: { 'tailPocket.connect': tunnel(50999), 'tailPocket.setRoutes': null } },
    network: reachable(50999),
  })
  await app.waitFor('label:Settings')
  await app.press('label:Settings')
  await app.waitFor('text:/Relay only: Only through your own relay/')
})

for (const [stored, routes] of [[{ pocketRoutes: 'lan' }, ['lan']], [{ tailcatOnly: '1' }, ['tailcat']]] as const) {
  test(`a launch sets the routes before its first tunnel (${Object.keys(stored)[0]})`, async () => {
    const order: string[] = []
    const app = await open('./App.tsx', {
      storage: { origin: 'http://127.0.0.1:50999', token: 'tok_abcdefghijklmnopqrstuvwxyz0123456789', pocket: '1', ...stored },
      host: { handlers: { 'tailPocket.setRoutes': (d: { routes: string[] | null }) => { order.push(`routes ${d.routes}`); return null }, 'tailPocket.setTailcatOnly': () => { order.push('tailcat-only'); return null }, 'tailPocket.connect': () => { order.push('connect'); return tunnel(50999) } } },
      network: reachable(50999),
    })
    await app.waitFor('label:Settings')
    expect(order.slice(0, 2)).toEqual([`routes ${routes.join(',')}`, 'connect'])
  })
}

test('a phone with every route sets none: TailPocket keeps its default', async () => {
  const order: string[] = []
  const app = await open('./App.tsx', {
    storage: { origin: 'http://127.0.0.1:50999', token: 'tok_abcdefghijklmnopqrstuvwxyz0123456789', pocket: '1' },
    host: { handlers: { 'tailPocket.setRoutes': () => { order.push('routes'); return null }, 'tailPocket.connect': () => { order.push('connect'); return tunnel(50999) } } },
    network: reachable(50999),
  })
  await app.waitFor('label:Settings')
  expect(order).toEqual(['connect'])
})

// TailPocket v0.3.4+: when the computer cannot be reached, lastFailure() says why. The reason is not authenticated: it only
// picks the words shown and offers Pair again as a button; it never unpairs, deletes the link or pairs on its own.
const offline = (failure: unknown, more: Record<string, unknown> = {}, network: NonNullable<Parameters<typeof open>[1]>["network"] = {}) => {
  const calls: string[] = []
  const app = open('./App.tsx', {
    storage: { origin: 'http://127.0.0.1:50999', token: 'tok_abcdefghijklmnopqrstuvwxyz0123456789', pocket: '1', me: JSON.stringify(body) },
    host: { handlers: { 'tailPocket.connect': tunnel(50999), 'tailPocket.lastFailure': () => failure, 'tailPocket.store.deleteLink': () => { calls.push('deleteLink'); return null }, 'tailPocket.store.saveLink': () => { calls.push('saveLink'); return null }, ...more } },
    network,
  })
  return { app, calls }
}
for (const [reason, words, repair] of [
  ['refused', "/Boop isn't running on the computer, or the computer was reset/", true],
  ['handshake-closed', "/Boop isn't running on the computer, or the computer was reset/", true],
  ['no-answer', "/Check it's on and awake; this network may block the connection/", false],
  ['relay-down', "Your relay server can't be reached.", false],
] as const) {
  test(`cannot connect (${reason}): Settings says why, offers Pair again only for a reset computer, and keeps the pairing`, async () => {
    const { app: opening, calls } = offline({ code: 'unreachable', reason, route: 'lan', routes: [{ t: 'lan', r: reason }], at: 1 })
    const app = await opening
    // the chat says the same sentence as Settings, and its status opens Settings
    await app.waitFor('id:offline-reason', { timeout: 15000 })
    await app.waitFor(`text:${words}`)
    await app.press('id:status')
    await app.waitFor('id:computer-status')
    await app.waitFor(`text:${words}`)
    await app.waitFor("text:Can't reach")
    expect(app.shows('text:Finding the route…')).toBe(false) // the Connection row follows the same state
    await app.waitFor('text:Not connected')
    expect(app.shows('id:repair')).toBe(repair)
    expect(calls.includes('deleteLink')).toBe(false)
    expect(app.storage().token).toBe('tok_abcdefghijklmnopqrstuvwxyz0123456789')
    expect(app.storage().pocket).toBe('1')
  })
}

const reset = { code: 'unreachable', reason: 'refused', route: 'lan', routes: [{ t: 'lan', r: 'refused' }], at: 1 }
const newLink = { ...link, key: 'privkey:new', payload: '654321' }
test('Pair again: only the code on your own screen; a failed pairing keeps the old link and session', async () => {
  let paired: { save?: boolean } = {}
  const { app: opening, calls } = offline(reset, {
    'tailPocket.scan': invite, 'tailPocket.pair': (d: typeof paired) => { paired = d; return newLink },
    'tailPocket.connect': (d: { link?: unknown }) => tunnel(d?.link ? 51000 : 50999), 'tailPocket.disconnect': null,
  }, { [`POST ${base(51000)}/pair`]: { status: 403, body: {} } })
  const app = await opening
  await app.waitFor('label:Settings'); await app.press('label:Settings')
  await app.waitFor('id:repair', { timeout: 15000 }); await app.press('id:repair')
  await app.waitFor("text:Scan only the code shown on your own computer's screen.")
  await app.press('id:repair-scan')
  await app.waitFor('id:repair-error')
  expect(paired.save).toBe(false) // nothing replaces the old link before Boop took this phone
  expect(calls).toEqual([])
  expect(app.storage().token).toBe('tok_abcdefghijklmnopqrstuvwxyz0123456789')
})

test('Pair again: once the computer takes this phone, the new link is saved and the app goes on with it', async () => {
  const { app: opening, calls } = offline(reset, {
    'tailPocket.scan': invite, 'tailPocket.pair': newLink,
    'tailPocket.connect': (d: { link?: unknown }) => tunnel(d?.link ? 51000 : 50999), 'tailPocket.disconnect': null,
  }, { ...reachable(51000), [`POST ${base(51000)}/pair`]: { body: { token: 'tok_new_abcdefghijklmnopqrstuvwxyz012345' } } })
  const app = await opening
  await app.waitFor('label:Settings'); await app.press('label:Settings')
  await app.waitFor('id:repair', { timeout: 15000 }); await app.press('id:repair')
  await app.press('id:repair-scan')
  await app.waitUntil(() => app.storage().token === 'tok_new_abcdefghijklmnopqrstuvwxyz012345')
  expect(calls).toEqual(['saveLink'])
  expect(app.storage().origin).toBe('http://127.0.0.1:51000')
})
