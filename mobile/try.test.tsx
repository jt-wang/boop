// Try it: the app on made-up data, for someone with no computer yet. Nothing leaves the phone and
// nothing is kept. Privacy and reports on a computer the person runs: nothing here promises what no one does.
import { expect, open, test } from 'nsh/test'

const fresh = (extra: Record<string, string> = {}) => open('./App.tsx', { storage: { lang: 'en', ...extra }, network: {} })
async function intoSample() {
  const app = await fresh()
  await app.press('id:own-computer')
  await app.press('id:try-it')
  await app.waitFor('id:composer')
  return app
}

test('the connect screen offers Try it, which opens the app on made-up data with no question, no request and no pairing kept', async () => {
  const app = await intoSample()
  expect(app.shows('text:/This is demo mode/')).toBe(true)
  expect(app.shows('text:/call the dentist/')).toBe(true)
  expect(app.shows('text:Demo mode')).toBe(true)
  expect(app.shows('text:How old are you?')).toBe(false)
  expect(app.requests()).toEqual([])
  expect(app.storage().origin).toBe(undefined)
  expect(app.storage().token).toBe(undefined)
})

test('a message gets a sample reply and an approval card can be answered, with no request', async () => {
  const app = await intoSample()
  await app.waitFor('text:/Delete 3 old files/')
  await app.press('text:Allow once')
  await app.waitFor('text:/how asking works/')
  await app.type('id:composer', 'Book me a table')
  await app.press('label:Send')
  await app.waitFor('text:/demo reply/', { timeout: 5000 })
  expect(app.shows('text:Book me a table')).toBe(true)
  expect(app.requests()).toEqual([])
})

test('every page has something to show and asks no one for anything', async () => {
  const app = await intoSample()
  await app.host.send('tab', 1)
  await app.waitFor('text:/Run 10 km/')
  await app.host.send('tab', 0)
  await app.press('label:Settings')
  await app.waitFor('id:demo-leave')
  expect(app.shows('id:unpair')).toBe(false)
  expect(app.shows('text:Demo computer')).toBe(true)
  expect(app.requests()).toEqual([])
})

// 2026-11-06: the header's "Sample" and one grey line at the top of the thread were not enough for people to tell
// the made-up app from their own. The button says demo before it is pressed, and every page says demo mode.
test('the button says demo before it is pressed', async () => {
  const app = await fresh()
  await app.press('id:own-computer')
  await app.waitFor('id:try-it')
  expect(app.shows('text:Try a demo, no computer needed')).toBe(true)
})

const demoBar = (app: Awaited<ReturnType<typeof open>>) => {
  expect(app.shows('id:demo-bar')).toBe(true)
  expect(app.shows('text:Demo mode')).toBe(true)
  expect(app.shows('text:/Everything here is made up\\. Nothing is really done\\./')).toBe(true)
}

test('every page says demo mode, that it is made up and that nothing is really done: the chat, Discover, memory, the library, Settings', async () => {
  const app = await intoSample()
  demoBar(app)
  await app.host.send('tab', 1)
  await app.waitFor('text:/Run 10 km/')
  demoBar(app)
  await app.host.send('tab', 0)
  await app.press('label:Menu')
  await app.press('text:Library')
  await app.waitFor('text:lisbon.md')
  demoBar(app)
  await app.host.send('tab', 0)
  await app.press('label:Settings')
  await app.waitFor('id:demo-leave')
  demoBar(app)
  await app.press('id:memory-row')
  await app.waitFor('text:Likes short answers')
  demoBar(app)
})

test('in Chinese: 演示模式 on the button, the header and every page', async () => {
  const app = await open('./App.tsx', { storage: { lang: 'zh' }, network: {} })
  await app.press('id:own-computer')
  await app.waitFor('text:先看演示，不用连电脑')
  await app.press('id:try-it')
  await app.waitFor('id:composer')
  expect(app.shows('id:demo-bar')).toBe(true)
  expect(app.shows('text:/内容都是编的，不会真的去做/')).toBe(true)
  expect(app.shows('text:/这是演示模式/')).toBe(true)
  await app.press('label:设置')
  await app.waitFor('id:demo-leave')
  expect(app.shows('text:演示模式')).toBe(true)
  expect(app.shows('text:演示电脑')).toBe(true)
})

test('leaving goes back to the connect screen and keeps nothing; a new launch starts at the welcome screen', async () => {
  const app = await intoSample()
  await app.press('label:Settings')
  await app.press('id:demo-leave')
  await app.waitFor('id:try-it')
  expect(app.shows('id:demo-bar')).toBe(false)
  expect(app.dialogs()).toEqual([])
  const kept = app.storage()
  expect(Object.keys(kept).filter((k) => k === 'origin' || k === 'token' || k === 'me' || k.startsWith('thread:'))).toEqual([])
  const again = await open('./App.tsx', { storage: kept, network: {} })
  await again.waitFor('id:own-computer')
})

test('the seven languages: the sample speaks the language of the interface', async () => {
  const app = await open('./App.tsx', { storage: { lang: 'zh' }, network: {} })
  await app.press('id:own-computer')
  await app.press('id:try-it')
  await app.waitFor('id:composer')
  expect(app.shows('text:/牙医/')).toBe(true)
})

test('the privacy policy opens from the connect screen and from the sample, on the public page', async () => {
  const app = await fresh()
  await app.press('id:own-computer')
  await app.press('id:connect-privacy')
  await app.press('id:try-it')
  await app.waitFor('id:composer')
  await app.press('label:Settings')
  await app.press('id:privacy-row')
  await app.press('id:terms-row')
  expect(app.openedUrls()).toEqual(['https://boop.jingtao.io/privacy/', 'https://boop.jingtao.io/privacy/', 'https://boop.jingtao.io/terms/'])
})

test('a report on a computer the person runs says it stays there and offers GitHub, with no promise of an answer in 24 hours', async () => {
  const app = await intoSample()
  app.onDialog(() => 'Report')
  await app.longPress('text:/I will remind you/')
  await app.waitFor('text:/stays on your computer/')
  expect(app.shows('text:/24 hours/')).toBe(false)
  await app.press('text:Harmful or unsafe')
  await app.press('id:report-send')
  await app.waitFor('id:report-issue')
  expect(app.shows('text:/24 hours/')).toBe(false)
  await app.press('id:report-issue')
  expect(app.openedUrls()).toEqual(['https://github.com/jt-wang/boop/issues'])
})

test('a report on a hosted computer still goes to the people who run it, who answer within 24 hours', async () => {
  const O = 'https://host.test/s/abc'
  const app = await open('./App.tsx', {
    storage: { lang: 'en', origin: O, token: 'tok', hostedBy: 'https://host.test' },
    network: {
      [`GET ${O}/me`]: { body: { device: { id: 'd1', name: 'iPhone' }, assistant: { name: 'Nori' }, mainSessionId: 'main', connected: true, pushPublicKey: null } },
      [`GET ${O}/threads`]: { body: [{ sessionId: 'main', title: '', updatedAt: 1, running: false, blank: false }] },
      [`POST ${O}/ws-ticket`]: { body: { ticket: 't' } },
      [`POST ${O}/reports`]: { body: { ok: true, forwarded: true } },
    },
  })
  await app.waitFor('id:composer')
  expect(app.shows('id:demo-bar')).toBe(false)
  await app.host.send('thread', [{ type: 'snapshot', sessionId: 'main', rows: [{ kind: 'them', id: 'a1', text: 'Some reply', at: 1 }], running: false, statusText: '', title: '' }])
  app.onDialog(() => 'Report')
  await app.longPress('text:Some reply')
  await app.waitFor('text:/24 hours/')
  await app.press('text:Harmful or unsafe')
  await app.press('id:report-send')
  await app.waitFor('id:report-sent')
  expect(app.shows('id:report-issue')).toBe(false)
})
