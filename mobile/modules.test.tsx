// Headless tests for module rows (`nsh test modules.test.tsx`): the second
// layer of generated interfaces. The bot and the shell's `ui.open` are mocked.
import { expect, open, test } from 'nsh/test'

const ORIGIN = 'http://127.0.0.1:3850'
const AT = 1700000000000
const ROOT = 'qeSZ4A8ccVkQpS9LePmiE4t2+onx07jb+ea5W4xhuK0='
const me = { device: { id: 'd1', name: 'iPhone' }, assistant: { name: 'Nori' }, mainSessionId: 'main', connected: true, pushPublicKey: null, uiRootPublicKey: ROOT }
const threads = [{ sessionId: 'main', title: '', updatedAt: AT, running: false, blank: false }]
const moduleRow = (id: string, moduleId: string, answer?: string) => ({ kind: 'module', id, moduleId, title: 'Tip calculator', url: `/ui/${moduleId}.nshpkg`, at: AT, ...(answer === undefined ? {} : { answer }) })
const snapshot = (rows: unknown[]) => ({ type: 'snapshot', sessionId: 'main', rows, running: false, statusText: '', title: '' })
const rowsFrame = (rows: unknown[]) => ({ type: 'rows', sessionId: 'main', rows })

const openModules = async (rows: unknown[], host?: Record<string, unknown>, storage: Record<string, string> = {}) => {
  const app = await open('./modules.fixture.tsx', { storage, network: { [`GET ${ORIGIN}/me`]: { body: me }, [`GET ${ORIGIN}/threads`]: { body: threads }, [`GET ${ORIGIN}/ui/m0123456789/meta`]: { body: { id: 'm0123456789', title: 'Tip calculator', token: 'modtoken_abcdefghijklmnopqrstuv', at: AT, answered: false } } }, ...(host ? { host } : {}) })
  await app.host.send('thread', [snapshot(rows)])
  return app
}

test('a module row shows its title and Open; tapping fetches the one-time token and asks the shell to open the signed package with the root key', async () => {
  const calls: unknown[] = []
  const app = await openModules([moduleRow('c7', 'm0123456789')], { params: { ui: true }, handlers: { 'ui.open': (args: unknown) => { calls.push(args); return { ok: true } } } })
  await app.waitFor('text:Tip calculator')
  expect(app.shows('text:An interface it built for you.')).toBe(true)
  await app.press('id:open-c7')
  await app.waitUntil(() => app.host.calls().some((c) => c.name === 'ui.open'))
  expect(app.requests().some((r) => r.url.endsWith('/ui/m0123456789/meta'))).toBe(true)
  expect(calls[0]).toEqual({
    url: `${ORIGIN}/ui/m0123456789.nshpkg?session=main`,
    bundleUrl: `${ORIGIN}/ui/m0123456789/bundle.nshc`,
    auth: 'tok_test',
    token: 'modtoken_abcdefghijklmnopqrstuv',
    title: 'Tip calculator',
    rootKey: ROOT,
    origin: ORIGIN,
    moduleId: 'm0123456789',
    grants: [],
  })
})

test('after the module posted its result, the rows frame shows "Answered: …" and Open is gone', async () => {
  const app = await openModules([moduleRow('c7', 'm0123456789')], { params: { ui: true }, handlers: { 'ui.open': { ok: true } } })
  await app.waitFor('id:open-c7')
  await app.host.send('thread', [rowsFrame([moduleRow('c7', 'm0123456789', 'Tip €6.30 (15%)')])])
  await app.waitFor('id:module-c7-answered')
  expect(app.shows('text:Answered: Tip €6.30 (15%)')).toBe(true)
  expect(app.shows('id:open-c7')).toBe(false)
})

test('the shell refusing the package (bad signature, download failed) shows a toast; nothing else changes', async () => {
  const app = await openModules([moduleRow('c7', 'm0123456789')], { params: { ui: true }, handlers: { 'ui.open': () => { throw new Error('signed by key cba1, which is not trusted') } } })
  await app.press('id:open-c7')
  await app.waitFor('text:Could not open it.')
  expect(app.shows('id:open-c7')).toBe(true)
})

test('offline: Open says not connected and asks the shell nothing', async () => {
  const app = await openModules([moduleRow('c7', 'm0123456789')], { params: { ui: true }, handlers: { 'ui.open': { ok: true } } }, { offline: '1' })
  await app.press('id:open-c7')
  await app.waitFor('text:Not connected')
  expect(app.host.calls().length).toBe(0)
})

// An app with no native shell (the APK `nsh package` makes, without android/) cannot run a package itself: Open asks
// the computer for a one-time play page and runs it in a sheet inside the app, a web view under a bar with the title
// and Done. It said 「请在手机 App 里打开。」 (the owner's APK, 2026-10-27); then it left the app for the browser.
test('no shell (Android): Open gets a one-time play page for this thread and runs it in a sheet in the app', async () => {
  const PLAY = `/ui/m0123456789/play?ticket=tkt_abcdefghijklmnopqrstuvwxyz`
  const app = await open('./modules.fixture.tsx', { network: {
    [`GET ${ORIGIN}/me`]: { body: me }, [`GET ${ORIGIN}/threads`]: { body: threads },
    [`POST ${ORIGIN}/ui/m0123456789/play`]: { body: { url: PLAY } },
    [`GET ${ORIGIN}/ui/m0123456789/meta`]: { body: { id: 'm0123456789', title: 'Tip calculator', token: 'modtoken_abcdefghijklmnopqrstuv', at: AT, answered: false } },
  } })
  await app.host.send('thread', [snapshot([moduleRow('c7', 'm0123456789')])])
  await app.press('id:open-c7')
  await app.waitFor('id:module-web')
  expect(app.openedUrls()).toEqual([])
  expect(JSON.parse(String(app.requests().find((r) => r.url.endsWith('/play'))!.body))).toEqual({ session: 'main' })
  expect(app.count('text:Tip calculator')).toBe(2) // the card, and the sheet's bar
  expect(app.shows('text:/phone app/')).toBe(false)
  await app.press('id:module-done')
  await app.waitFor('id:module-web', { state: 'gone' })
  expect(app.shows('id:open-c7')).toBe(true)
})

// The Android shell (android/, UiBridge.java) runs modules in the app as the iOS shell does, and says so the same way
// (`host.params.ui`). On a Chinese Android phone 打开 then asks the shell, never the browser's play page.
test('Android shell that runs modules: 打开 calls ui.open; no browser, no play page', async () => {
  const calls: unknown[] = []
  const app = await open('./modules.fixture.tsx', {
    platform: 'android', storage: { lang: 'zh' },
    network: {
      [`GET ${ORIGIN}/me`]: { body: me }, [`GET ${ORIGIN}/threads`]: { body: threads },
      [`GET ${ORIGIN}/ui/m0123456789/meta`]: { body: { id: 'm0123456789', title: 'Tip calculator', token: 'modtoken_abcdefghijklmnopqrstuv', at: AT, answered: false } },
      [`POST ${ORIGIN}/ui/m0123456789/play`]: { body: { url: '/ui/m0123456789/play?ticket=tkt_abcdefghijklmnopqrstuvwxyz' } },
    },
    host: { params: { ui: true }, handlers: { 'ui.open': (args: unknown) => { calls.push(args); return { ok: true } } } },
  })
  await app.host.send('thread', [snapshot([moduleRow('c7', 'm0123456789')])])
  await app.waitFor('text:打开')
  await app.press('id:open-c7')
  await app.waitUntil(() => calls.length === 1)
  expect((calls[0] as { url: string }).url).toBe(`${ORIGIN}/ui/m0123456789.nshpkg?session=main`)
  expect((calls[0] as { rootKey: string }).rootKey).toBe(ROOT)
  expect(app.openedUrls()).toEqual([])
  expect(app.requests().some((r) => r.url.endsWith('/play'))).toBe(false)
})

// Inside the thread (2026-11-02): a shell that says `inlineUi` (the Android shell's InlineModule) runs the interface
// where the card is, from the same signed package with the same one-time token and the grants the person gave before
// (none asked here: asking is for opening it full screen). Full screen stays one tap away.
test('a shell that runs interfaces inline gets the package where the card is; full screen is one tap away', async () => {
  const app = await openModules([moduleRow('c7', 'm0123456789')], { params: { ui: true, inlineUi: true }, handlers: { 'ui.open': { ok: true } } })
  await app.waitFor('id:module-inline-c7')
  expect(app.requests().some((r) => r.url.endsWith('/ui/m0123456789/meta'))).toBe(true)
  expect(app.shows('id:open-c7')).toBe(false)
  await app.press('id:expand-c7')
  await app.waitUntil(() => app.host.calls().some((c) => c.name === 'ui.open'))
})

test('a shell without inline interfaces keeps the card with Open', async () => {
  const app = await openModules([moduleRow('c7', 'm0123456789')], { params: { ui: true }, handlers: { 'ui.open': { ok: true } } })
  await app.waitFor('id:open-c7')
  expect(app.shows('id:module-inline-c7')).toBe(false)
})
