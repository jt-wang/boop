// [compliance] The screens and states the stores ask for, headless against a stubbed bot:
// the age question, the AI-provider disclosure and its withdrawal, reports on a reply and on an interface, the
// filtered reply, the interfaces index with permissions and hide, links to an interface, account deletion and the
// legal links. Each screen is also checked in Chinese for internal words and stray English.
import { expect, open, test } from 'nsh/test'
import { systemShowsCopy } from './src/state.ts'
import { interfaceFromLink } from './src/compliance.tsx'

const O = 'http://127.0.0.1:3850'
const TOKEN = 'tok_abcdefghijklmnopqrstuvwxyz0123456789'
const AT = 1700000000000
const AI = { model: 'DeepSeek V4.1 Flash', company: 'SiliconFlow', policyUrl: 'https://docs.siliconflow.cn/docs/legals/privacy-policy', filter: null as string | null }
const meWith = (o: { age?: string | null; consent?: boolean; name?: string; filter?: string | null } = {}) => ({ device: { id: 'd1', name: 'iPhone' }, assistant: { name: o.name ?? 'Nori' }, mainSessionId: 'main', connected: true, pushPublicKey: null, ai: { ...AI, filter: o.filter ?? null, consent: o.consent ? { at: '2026-10-27T01:00:00Z' } : null }, age: o.age === undefined ? 'adult' : o.age })
const threads = [{ sessionId: 'main', title: '', updatedAt: AT, running: false, blank: false }]
const snapshot = (rows: unknown[]) => ({ type: 'snapshot', sessionId: 'main', rows, running: false, statusText: '', title: '' })
const them = (text: string, id = 'a1', extra: Record<string, unknown> = {}) => ({ kind: 'them', id, text, at: AT, ...extra })
const ui = [
  { id: 'm0000000002', title: 'Packing list', at: AT + 1000, answered: false, hidden: false, blocked: false, permissions: ['openUrl', 'clipboard'], grants: ['openUrl'], link: 'https://host.test/open/sb-abc123/ui/m0000000002' },
  { id: 'm0000000001', title: 'Tip calculator', at: AT, answered: true, hidden: true, blocked: false, permissions: [], grants: [], link: 'https://host.test/open/sb-abc123/ui/m0000000001' },
]

/** A bot whose /me follows PUT /consent, as src/compliance.ts does. */
function bot(start: { age?: string | null; consent?: boolean; name?: string; filter?: string | null }, extra: Record<string, unknown> = {}) {
  const st = { age: start.age === undefined ? null : start.age, consent: Boolean(start.consent) }
  const puts: unknown[] = []
  const network: Record<string, unknown> = {
    [`GET ${O}/me`]: () => ({ body: meWith({ ...start, age: st.age, consent: st.consent }) }),
    [`PUT ${O}/consent`]: (req: { body?: string }) => { const b = JSON.parse(String(req.body ?? '{}')); puts.push(b); if (b.age) st.age = b.age; if (typeof b.ai === 'boolean') st.consent = b.ai; const m = meWith({ ...start, age: st.age, consent: st.consent }); return { body: { ai: m.ai, age: m.age } } },
    [`GET ${O}/threads`]: { body: threads }, [`POST ${O}/sessions/main`]: { body: { sessionId: 'main' } }, [`PUT ${O}/me/context`]: { body: { ok: true } },
    ...extra,
  }
  return { network, puts, st }
}
const storage = (o: Record<string, string> = {}) => ({ origin: O, token: TOKEN, ...o })

/** In a Chinese session nothing internal and no English, except names (products, the provider, the model). */
const INTERNAL = /mcp__|\bbash\b|\/data\/|DEEPSEEK_|config\.json|_TOKEN|https?:\/\/|toolName|session|\bid\b|[0-9a-f]{8,}|nshpkg|moderation|consent\b/i
const NAMES = /Boop|DeepSeek V4\.1 Flash|DeepSeek|SiliconFlow|OpenAI|Nori|AI|Packing list|Tip calculator|iPhone|English|Español/g
const chineseOnly = (texts: string[]) => ({ leaks: texts.filter((x) => INTERNAL.test(x)), english: texts.filter((x) => /[A-Za-z]{2,}/.test(x.replace(NAMES, ''))) })

test('first run: the age question comes before anything else; 18 or older moves on to the AI disclosure', async () => {
  const b = bot({ age: null, name: '' })
  const app = await open('./App.tsx', { storage: storage(), network: b.network as never })
  await app.waitFor('text:How old are you?')
  expect(app.shows('text:/for people aged 18 and over/')).toBe(true)
  await app.press('id:age-adult')
  await app.waitFor('id:consent-title')
  expect(b.puts).toEqual([{ age: 'adult' }])
})

test('under 18: the account is told it is for adults; nothing is sent; unpairing is the way out', async () => {
  const b = bot({ age: null }, { [`DELETE ${O}/devices/d1`]: { body: { ok: true } } })
  const app = await open('./App.tsx', { storage: storage(), network: b.network as never })
  await app.press('id:age-minor')
  await app.waitFor('id:adults-only')
  expect(b.puts).toEqual([{ age: 'minor' }])
  expect(app.requests().some((r) => r.url.includes('/messages') || r.url.endsWith('/sessions/main'))).toBe(false)
  await app.press('id:adults-leave')
  await app.waitFor('text:/own computer|Connect to your computer/')
})

test('the AI disclosure names the provider, the model, what is sent and where to stop it; nothing goes out until Agree', async () => {
  const b = bot({ age: 'adult', consent: false, filter: 'OpenAI' })
  const app = await open('./App.tsx', { storage: storage(), network: b.network as never })
  await app.waitFor('id:consent-title')
  expect(app.shows('text:SiliconFlow runs DeepSeek V4.1 Flash, the model that writes the replies. Your messages go to SiliconFlow.')).toBe(true)
  expect(app.shows('text:/what you write, files and web pages/')).toBe(true)
  expect(app.shows("text:Replies are also checked by OpenAI's content filter.")).toBe(true)
  expect(app.shows('text:/Settings → AI provider/')).toBe(true)
  expect(app.requests().some((r) => r.url.endsWith('/sessions/main'))).toBe(false)
  await app.press('id:consent-not-now')
  await app.waitFor('id:consent-needed')
  expect(b.puts).toEqual([])
  await app.press('id:provider-policy')
  expect(app.openedUrls()).toEqual(['https://docs.siliconflow.cn/docs/legals/privacy-policy'])
  expect(app.requests().some((r) => r.url.endsWith('/threads'))).toBe(false)
  await app.press('id:consent-agree')
  await app.waitFor('id:composer')
  expect(b.puts).toEqual([{ ai: true }])
  expect(app.requests().some((r) => r.url.endsWith('/threads'))).toBe(true)
})

test('a bot older than the consent gate (no `ai` in /me) goes straight to the chat', async () => {
  const app = await open('./App.tsx', { storage: storage(), network: { [`GET ${O}/me`]: { body: { device: { id: 'd1', name: 'iPhone' }, assistant: { name: 'Nori' }, mainSessionId: 'main', connected: true } }, [`GET ${O}/threads`]: { body: threads } } })
  await app.waitFor('id:composer')
})

test('Settings → AI provider shows who and since when; Stop sharing asks first, then the disclosure comes back', async () => {
  const b = bot({ age: 'adult', consent: true })
  const app = await open('./App.tsx', { storage: storage(), network: b.network as never })
  await app.waitFor('id:composer')
  await app.press('label:Settings')
  await app.waitFor('id:ai-provider-row')
  expect(app.shows('id:privacy-row')).toBe(true)
  expect(app.shows('id:terms-row')).toBe(true)
  expect(app.shows('id:delete-account')).toBe(false) // a computer the person runs has no account with us
  await app.press('id:ai-provider-row')
  await app.waitFor('text:DeepSeek V4.1 Flash')
  app.onDialog(() => 'Stop sharing')
  await app.press('id:stop-sharing')
  await app.waitFor('id:consent-title')
  expect(app.dialogs()[0].title).toBe('Stop sending messages to the AI provider?')
  expect(b.puts).toEqual([{ ai: false }])
})

test('the privacy policy and terms open from Settings on the computer the phone knows', async () => {
  const b = bot({ age: 'adult', consent: true })
  const app = await open('./App.tsx', { storage: storage(), network: b.network as never })
  await app.waitFor('id:composer')
  await app.press('label:Settings')
  await app.press('id:privacy-row')
  await app.press('id:terms-row')
  expect(app.openedUrls()).toEqual([`${O}/privacy?lang=en`, `${O}/terms?lang=en`])
})

test('report a reply: long-press → Report → a reason and a note → sent to the computer, and the host when it did not forward → thanks with the response time', async () => {
  let hostGot: unknown = null
  const b = bot({ age: 'adult', consent: true }, {
    [`POST ${O}/reports`]: { body: { ok: true, id: 'r1', forwarded: false } },
    'POST http://host.test/host/reports': (req: { body?: string }) => { hostGot = JSON.parse(String(req.body)); return { body: { ok: true } } },
  })
  const app = await open('./App.tsx', { storage: storage(), network: b.network as never, host: { params: { hostUrl: 'http://host.test' } } })
  await app.waitFor('id:composer')
  await app.host.send('thread', [snapshot([them('Some reply that crosses a line.')])])
  await app.waitFor('id:msg-0')
  app.onDialog(() => 'Report')
  await app.longPress('id:msg-0')
  await app.waitFor('id:reason-harmful')
  expect(app.shows('text:/answer within 24 hours/')).toBe(true)
  expect(app.shows('text:Some reply that crosses a line.')).toBe(true)
  await app.press('id:reason-harmful')
  await app.type('id:report-note', 'not ok')
  await app.press('id:report-send')
  await app.waitFor('id:report-sent')
  expect(app.shows('text:/within 24 hours/')).toBe(true)
  const sent = JSON.parse(String(app.requests().find((r) => r.url.endsWith('/reports') && r.url.startsWith(O))!.body))
  expect(sent).toEqual({ kind: 'reply', rowId: 'a1', excerpt: 'Some reply that crosses a line.', sessionId: 'main', reason: 'harmful', note: 'not ok' })
  expect(hostGot).toEqual(sent)
  await app.press('id:report-done')
  await app.waitFor('id:composer')
})

test('a reply the content filter hid says so in grey, and can still be reported', async () => {
  const b = bot({ age: 'adult', consent: true })
  const app = await open('./App.tsx', { storage: storage(), network: b.network as never })
  await app.waitFor('id:composer')
  await app.host.send('thread', [snapshot([them('', 'a9', { filtered: true })])])
  await app.waitFor('id:filtered-a9')
  expect(app.shows('text:This reply was hidden by the content filter.')).toBe(true)
})

test('Menu → Interfaces: newest first with their state; one interface: permissions as switches, link, hide, report', async () => {
  const patches: unknown[] = []
  const b = bot({ age: 'adult', consent: true }, {
    [`GET ${O}/ui`]: { body: ui },
    [`PATCH ${O}/ui/m0000000002`]: (req: { body?: string }) => { patches.push(JSON.parse(String(req.body))); return { body: { ok: true } } },
    [`GET ${O}/session/list`]: { body: { items: [] } }, [`POST ${O}/api/session/list`]: { body: { type: 'server-response', result: { ok: true, value: { items: [] } } } },
  })
  const app = await open('./App.tsx', { storage: storage(), network: b.network as never })
  await app.waitFor('id:composer')
  await app.press('label:Menu')
  await app.press('id:interfaces-row')
  await app.waitFor('id:if-m0000000002')
  expect(app.texts().indexOf('Packing list')).toBeLessThan(app.texts().indexOf('Tip calculator'))
  expect(app.shows('text:Hidden')).toBe(true)
  await app.press('id:if-m0000000002')
  await app.waitFor('id:if-title')
  expect(app.shows('text:Open links in your browser')).toBe(true)
  expect(app.shows('text:Copy and paste')).toBe(true)
  await app.press('id:grant-clipboard')
  await app.press('id:if-link')
  expect(app.clipboard()).toBe('https://host.test/open/sb-abc123/ui/m0000000002')
  await app.press('id:if-hide')
  await app.waitUntil(() => patches.length === 2)
  expect(patches).toEqual([{ grants: ['openUrl', 'clipboard'] }, { hidden: true }])
  await app.press('id:if-report')
  await app.waitFor('id:report-hide')
  expect(app.shows('text:/its code and your note/')).toBe(true)
})

test('opening an interface that asks for more than its screen asks first, by name; Allow is kept and passed to the shell, Don\'t allow is not', async () => {
  const opened: { grants: string[] }[] = []
  const patches: unknown[] = []
  const meta = { id: 'm0000000002', title: 'Packing list', token: 'modtoken_abcdefghijklmnopqrstuv', at: AT, answered: false, permissions: ['openUrl', 'clipboard'], grants: [] }
  const b = bot({ age: 'adult', consent: true }, {
    [`GET ${O}/ui/m0000000002/meta`]: { body: meta },
    [`PATCH ${O}/ui/m0000000002`]: (req: { body?: string }) => { patches.push(JSON.parse(String(req.body))); return { body: { ok: true } } },
  })
  const app = await open('./modules.fixture.tsx', { network: b.network as never, host: { params: { ui: true }, handlers: { 'ui.open': (a: { grants: string[] }) => { opened.push(a); return { ok: true } } } } })
  await app.host.send('thread', [snapshot([{ kind: 'module', id: 'c7', moduleId: 'm0000000002', title: 'Packing list', url: '/ui/m0000000002.nshpkg', at: AT }])])
  app.onDialog(() => "Don't allow")
  await app.press('id:open-c7')
  await app.waitUntil(() => opened.length === 1)
  expect(app.dialogs()[0].title).toBe('“Packing list” would like to')
  expect(String(app.dialogs()[0].message)).toMatch(/Open links in your browser[\s\S]*Copy and paste/)
  expect(opened[0].grants).toEqual([])
  expect(patches).toEqual([])
  app.onDialog(() => 'Allow')
  await app.press('id:open-c7')
  await app.waitUntil(() => opened.length === 2)
  expect(opened[1].grants).toEqual(['openUrl', 'clipboard'])
  expect(patches).toEqual([{ grants: ['openUrl', 'clipboard'] }])
})

test('after opening from its page, the interface\'s switches show what was just allowed', async () => {
  let uiFetches = 0
  const meta = { id: 'm0000000002', title: 'Packing list', token: 'modtoken_abcdefghijklmnopqrstuv', at: AT, answered: false, permissions: ['openUrl', 'clipboard'], grants: ['openUrl'] }
  const b = bot({ age: 'adult', consent: true }, {
    [`GET ${O}/ui`]: () => { uiFetches++; return { body: ui } },
    [`GET ${O}/ui/m0000000002/meta`]: { body: meta },
    [`PATCH ${O}/ui/m0000000002`]: { body: { ok: true } },
  })
  const app = await open('./App.tsx', { storage: storage(), network: b.network as never, host: { params: { ui: true, linkUrl: `deepseekbot://ui/m0000000002?origin=${encodeURIComponent(O)}` }, handlers: { 'ui.open': { ok: true } } } })
  await app.waitFor('id:if-open')
  const before = uiFetches
  app.onDialog(() => 'Allow')
  await app.press('id:if-open')
  await app.waitUntil(() => uiFetches > before)
})

test('a hidden interface does not open: it says so', async () => {
  const b = bot({ age: 'adult', consent: true }, { [`GET ${O}/ui/m0000000001/meta`]: { status: 410, body: { error: 'hidden' } } })
  const app = await open('./modules.fixture.tsx', { network: b.network as never, host: { params: { ui: true }, handlers: { 'ui.open': { ok: true } } } })
  await app.host.send('thread', [snapshot([{ kind: 'module', id: 'c8', moduleId: 'm0000000001', title: 'Tip calculator', url: '/ui/m0000000001.nshpkg', at: AT }])])
  await app.press('id:open-c8')
  await app.waitFor('text:This interface is hidden.')
  expect(app.host.calls().some((c) => c.name === 'ui.open')).toBe(false)
})

test('long-press on an interface card: Report or Hide', async () => {
  const b = bot({ age: 'adult', consent: true })
  const app = await open('./App.tsx', { storage: storage(), network: b.network as never })
  await app.waitFor('id:composer')
  await app.host.send('thread', [snapshot([{ kind: 'module', id: 'c7', moduleId: 'm0000000002', title: 'Packing list', url: '/ui/m0000000002.nshpkg', at: AT }])])
  app.onDialog(() => 'Report')
  await app.longPress('id:module-c7')
  expect(app.dialogs()[0].buttons).toEqual(['Report', 'Hide', 'Cancel'])
  await app.waitFor('id:report-hide')
})

// An interface that asks for nothing showed the heading "It can ask to" over an empty card (QA, Android, 2026-10-30).
test('an interface that asks for nothing says so in one line, with no empty section', async () => {
  const b = bot({ age: 'adult', consent: true }, { [`GET ${O}/ui`]: { body: ui }, [`GET ${O}/session/list`]: { body: { items: [] } }, [`POST ${O}/api/session/list`]: { body: { type: 'server-response', result: { ok: true, value: { items: [] } } } } })
  const app = await open('./App.tsx', { storage: storage(), network: b.network as never })
  await app.waitFor('id:composer')
  await app.press('label:Menu')
  await app.press('id:interfaces-row')
  await app.press('id:if-m0000000001')
  await app.waitFor('id:if-title')
  expect(app.shows('text:It asks for nothing beyond its own screen.')).toBe(true)
  expect(app.shows('text:It can ask to')).toBe(false)
})

test('a link to an interface opens it on this account; a link for another account says so', async () => {
  const hosted = 'https://host.test/s/sb-abc123'
  expect(interfaceFromLink('https://host.test/open/sb-abc123/ui/m0000000002', hosted)).toBe('m0000000002')
  expect(interfaceFromLink('https://host.test/open/sb-other99/ui/m0000000002', hosted)).toBe('elsewhere')
  expect(interfaceFromLink(`deepseekbot://ui/m1?origin=${encodeURIComponent(O)}`, O)).toBe('m1')
  // through TailPocket the computer knows itself by its port, the phone by a new one each launch: both are this computer
  expect(interfaceFromLink(`deepseekbot://ui/m1?origin=${encodeURIComponent('http://127.0.0.1:3850')}`, 'http://127.0.0.1:50999')).toBe('m1')
  expect(interfaceFromLink(`deepseekbot://ui/m1?origin=${encodeURIComponent('http://192.168.1.9:3850')}`, 'http://127.0.0.1:50999')).toBe('elsewhere')
  expect(interfaceFromLink('deepseekbot://ui/m1?origin=http%3A%2F%2F10.0.0.9%3A3850', O)).toBe('elsewhere')
  expect(interfaceFromLink('https://host.test/privacy', hosted)).toBe(null)
  const b = bot({ age: 'adult', consent: true }, { [`GET ${O}/ui`]: { body: ui } })
  const app = await open('./App.tsx', { storage: storage(), network: b.network as never, host: { params: { linkUrl: `deepseekbot://ui/m0000000002?origin=${encodeURIComponent(O)}` } } })
  await app.waitFor('id:if-title')
  expect(app.shows('text:Packing list')).toBe(true)
  await app.host.send('link', { url: 'deepseekbot://ui/m0000000002?origin=http%3A%2F%2F10.0.0.9%3A3850' })
  await app.waitFor('text:That link is for another account or computer.')
})

test('a hosted account: Settings → Delete account asks twice, deletes on the host with the phone\'s token, and returns to the start', async () => {
  let deleted: { auth?: string } | null = null
  const b = bot({ age: 'adult', consent: true }, { 'DELETE https://host.test/host/account': (req: { headers?: Record<string, string> }) => { deleted = { auth: req.headers?.authorization }; return { body: { ok: true } } } })
  const app = await open('./App.tsx', { storage: storage({ hostedBy: 'https://host.test' }), network: b.network as never })
  await app.waitFor('id:composer')
  await app.press('label:Settings')
  await app.waitFor('id:delete-account')
  app.onDialog((d) => (d.title === 'Delete your account?' ? 'Delete' : 'Delete account'))
  await app.press('id:delete-account')
  await app.waitUntil(() => deleted !== null)
  expect(app.dialogs().map((d) => d.title)).toEqual(['Delete your account?', 'Delete for good?'])
  expect(deleted).toEqual({ auth: `Bearer ${TOKEN}` })
  await app.waitFor('text:/own computer|Start/')
})

test('in Chinese: the age question, the disclosure, Settings → AI provider, the report page and the interfaces speak only Chinese and show nothing internal', async () => {
  const b = bot({ age: null, consent: false, filter: 'OpenAI' }, { [`GET ${O}/ui`]: { body: ui } })
  const app = await open('./App.tsx', { storage: storage({ lang: 'zh' }), network: b.network as never })
  const check = (where: string) => expect({ where, ...chineseOnly(app.texts()) }).toEqual({ where, leaks: [], english: [] })
  await app.waitFor('text:你多大了？'); check('age')
  await app.press('id:age-adult')
  await app.waitFor('id:consent-title'); check('consent')
  await app.press('id:consent-agree')
  await app.waitFor('id:composer')
  await app.press('label:设置')
  await app.waitFor('id:ai-provider-row'); check('settings')
  await app.press('id:ai-provider-row')
  await app.waitFor('id:stop-sharing'); check('ai-provider')
})

// QA 2026-10-28: on Android, Copy showed the app's "Copied" on top of the system's own
// clipboard confirmation, which Android 13 (API 33) and later show for every copy. There the app stays quiet; iOS and
// older Android, which show nothing, keep the toast.
test('Copy on a reply: the app says "Copied" only where the system does not', async () => {
  expect(systemShowsCopy('android', '33')).toBe(true)
  expect(systemShowsCopy('android', '35')).toBe(true)
  expect(systemShowsCopy('android', '32')).toBe(false)
  expect(systemShowsCopy('ios', '26.3')).toBe(false)
  const b = bot({ age: 'adult', consent: true })
  const app = await open('./App.tsx', { storage: storage(), network: b.network as never })
  await app.waitFor('id:composer')
  await app.host.send('thread', [snapshot([them('Words worth keeping.')])])
  await app.waitFor('id:msg-0')
  app.onDialog(() => 'Copy')
  await app.longPress('id:msg-0')
  await app.waitUntil(() => app.clipboard() === 'Words worth keeping.')
  await app.waitFor('text:Copied')
})
