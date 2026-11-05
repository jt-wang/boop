// Store obligations on the host's side: the privacy policy and terms it serves, the files
// that make /open/… links open the app (apple-app-site-association, assetlinks.json), account deletion in the
// app and on the web, and reports that reach the operator, who can block an interface or suspend an account.
// The sandboxes are real bot servers (src/server.ts) with the compliance layer, behind a fake provider.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHostServer } from '../src/host/server.ts'
import { createBotServer, type BotServer, type Settings } from '../src/server.ts'
import { MemoryDeviceStore } from '../src/devices.ts'
import { Compliance, aiProvider } from '../src/compliance.ts'
import { Ui } from '../src/ui.ts'
import type { Sandbox, SandboxProvider, SandboxStatus, CreateOptions } from '../src/sandbox/provider.ts'

const HOST_SECRET = 'host-secret-0123456789abcdef'
const ADMIN = 'admin-token-0123456789abcdef'
const CODE = 'owner-code-for-tests'
const MODEL = { provider: 'siliconflow', model: 'deepseek-ai/DeepSeek-V4.1-Flash', baseURL: 'https://api.siliconflow.cn/v1' }
const fakeHarness = { kind: 'fake', events: { on() {}, clientId: 'c' }, async createSession() { return { sessionId: 'main' } }, async listSessions() { return [] }, async prompt() {}, async answer() {}, async cancel() { return true }, async rpc() { return {} as never }, async close() {}, async follow() { return () => {} } }

/** Each sandbox is a bot with the compliance layer and one interface the assistant built. */
class FakeProvider implements SandboxProvider {
  kind = 'fake'
  rows = new Map<string, { status: SandboxStatus; env: Record<string, string>; devices: MemoryDeviceStore; bot: BotServer | null; root: string; ui?: Ui }>()
  private async boot(id: string) {
    const r = this.rows.get(id)!
    let settings: Settings = { assistantName: 'Nori', mainSessionId: 'main', language: 'auto' }
    const store = { get: async () => ({ ...settings }), set: async (p: Partial<Settings>) => { settings = { ...settings, ...p }; return { ...settings } } }
    r.ui = await Ui.open(r.root, { nsh: join(r.root, 'no-nsh') })
    const compliance = await Compliance.open(r.root, { settings: store, model: MODEL, relay: { url: r.env.DEEPSEEK_BOT_PUSH_RELAY, secret: r.env.DEEPSEEK_BOT_HOST_SECRET }, publicUrl: r.env.DEEPSEEK_BOT_PUBLIC_URL, origin: () => 'x' })
    r.bot = await createBotServer({ dsh: { origin: 'http://127.0.0.1:9', cookie: 'c=1' }, devices: r.devices, harness: fakeHarness as never, watcher: { clientId: 'c', on() {} } as never, host: '127.0.0.1', port: 0, hostSecret: r.env.DEEPSEEK_BOT_HOST_SECRET, settings: store, ui: r.ui, compliance })
    r.status = 'running'
  }
  async create(id: string, opts: CreateOptions): Promise<Sandbox> {
    const root = mkdtempSync(join(tmpdir(), `sb-${id}-`))
    mkdirSync(join(root, 'ui'), { recursive: true })
    writeFileSync(join(root, 'ui', 'modules.json'), JSON.stringify([{ id: 'm0000000009', title: 'Quiz', token: 'tok-9-abcdefghijklmnopqrstuvw', at: 1 }]))
    this.rows.set(id, { status: 'creating', env: opts.env, devices: new MemoryDeviceStore(), bot: null, root })
    await this.boot(id)
    return { id, origin: this.rows.get(id)!.bot!.origin }
  }
  async get(id: string) { const r = this.rows.get(id); return r ? { id, origin: r.bot?.origin ?? '' } : null }
  async start(id: string) { await this.boot(id) }
  async stop(id: string) { const r = this.rows.get(id)!; await r.bot?.close(); r.bot = null; r.status = 'stopped' }
  async remove(id: string) { await this.rows.get(id)?.bot?.close(); this.rows.delete(id) }
  async status(id: string) { return this.rows.get(id)?.status ?? 'missing' }
  async closeAll() { for (const r of this.rows.values()) await r.bot?.close() }
}

async function boot(extra: Partial<Parameters<typeof createHostServer>[0]> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'host-compliance-'))
  const provider = new FakeProvider()
  const host = await createHostServer({
    provider, image: 'fake:img', accountsPath: join(dir, 'accounts.json'), hostSecret: HOST_SECRET, sandboxEnv: {}, accessCode: CODE, host: '127.0.0.1', port: 0,
    adminToken: ADMIN, contact: 'help@example.com', operator: 'Example Labs', ai: aiProvider(MODEL),
    links: { appleAppIds: ['ABCDE12345.io.jingtao.boop'], androidPackage: 'io.jingtao.boop', androidCertSha256: ['AB:CD:EF'] },
    ...extra,
  })
  const signIn = async (email: string) => (await (await fetch(`${host.origin}/host/sign-in`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, code: CODE }) })).json() as { accountToken: string }).accountToken
  const ready = async (account: string) => {
    let r = await (await fetch(`${host.origin}/host/sandbox`, { method: 'POST', headers: { authorization: `Bearer ${account}` } })).json() as { state: string; origin: string; token: string; sandboxId: string }
    for (let i = 0; i < 100 && r.state !== 'ready'; i++) { await new Promise((s) => setTimeout(s, 50)); r = await (await fetch(`${host.origin}/host/sandbox`, { headers: { authorization: `Bearer ${account}` } })).json() as typeof r }
    assert.equal(r.state, 'ready')
    return r
  }
  const admin = (path: string, init: RequestInit = {}, token = ADMIN) => fetch(`${host.origin}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } })
  return { host, provider, dir, signIn, ready, admin, close: async () => { await host.close(); await provider.closeAll() } }
}

test('apple-app-site-association and assetlinks.json make /open/… links open the app; JSON, at /.well-known, no redirect', async () => {
  const s = await boot()
  try {
    const a = await fetch(`${s.host.origin}/.well-known/apple-app-site-association`, { redirect: 'manual' })
    assert.equal(a.status, 200)
    assert.match(a.headers.get('content-type') ?? '', /^application\/json/)
    assert.deepEqual(await a.json(), { applinks: { details: [{ appIDs: ['ABCDE12345.io.jingtao.boop'], components: [{ '/': '/open/*', comment: 'An interface the assistant built, or the app itself' }] }] } })
    const l = await fetch(`${s.host.origin}/.well-known/assetlinks.json`, { redirect: 'manual' })
    assert.equal(l.status, 200)
    assert.match(l.headers.get('content-type') ?? '', /^application\/json/)
    assert.deepEqual(await l.json(), [{ relation: ['delegate_permission/common.handle_all_urls'], target: { namespace: 'android_app', package_name: 'io.jingtao.boop', sha256_cert_fingerprints: ['AB:CD:EF'] } }])
  } finally { await s.close() }
  const bare = await boot({ links: { appleAppIds: ['ABCDE12345.io.jingtao.boop'] } })
  try { assert.equal((await fetch(`${bare.host.origin}/.well-known/assetlinks.json`)).status, 404, 'no signing fingerprint configured: no file rather than a wrong one') } finally { await bare.close() }
})

test('an /open/… link without the app installed lands on a page that says what it is, in the browser\'s language', async () => {
  const s = await boot()
  try {
    const en = await fetch(`${s.host.origin}/open/sb-abc123/ui/m0000000009`)
    assert.equal(en.status, 200)
    const html = await en.text()
    assert.match(html, /Boop/)
    assert.doesNotMatch(html + '', /DeepSeek Bot/)
    assert.match(html, /opens in the Boop app/)
    const zh = await (await fetch(`${s.host.origin}/open/sb-abc123/ui/m0000000009`, { headers: { 'accept-language': 'zh-CN,zh;q=0.9' } })).text()
    assert.match(zh, /Boop App/)
    assert.equal((await fetch(`${s.host.origin}/open/../../etc/passwd`)).status, 404)
  } finally { await s.close() }
})

test('the privacy policy and the terms are public pages naming the operator, the contact, the AI provider and how to delete', async () => {
  const s = await boot()
  try {
    for (const path of ['/privacy', '/terms']) {
      const r = await fetch(`${s.host.origin}${path}`)
      assert.equal(r.status, 200, path)
      assert.match(r.headers.get('content-type') ?? '', /text\/html/)
    }
    const p = await (await fetch(`${s.host.origin}/privacy`)).text()
    assert.match(p, /<title>Privacy policy/)
    for (const word of ['Example Labs', 'help@example.com', 'SiliconFlow', 'DeepSeek V4.1 Flash', '/account/delete', 'Settings']) assert.ok(p.includes(word), word)
    const zh = await (await fetch(`${s.host.origin}/privacy?lang=zh`)).text()
    assert.match(zh, /隐私政策/)
    const t = await (await fetch(`${s.host.origin}/terms`)).text()
    assert.match(t, /18/)
    assert.match(t, /report/i)
  } finally { await s.close() }
})

test('DELETE /host/account deletes the account and its computer; the phone\'s own token can do it too; signing in again starts fresh', async () => {
  const s = await boot()
  try {
    const a = await s.signIn('a@example.com')
    const r = await s.ready(a)
    const before = (await (await fetch(`${s.host.origin}/host/me`, { headers: { authorization: `Bearer ${a}` } })).json() as { id: string }).id
    assert.equal((await fetch(`${s.host.origin}/host/account`, { method: 'DELETE', headers: { authorization: 'Bearer nope-nope-nope-nope' } })).status, 401)
    assert.equal((await fetch(`${s.host.origin}/host/account`, { method: 'DELETE', headers: { authorization: `Bearer ${r.token}` } })).status, 200)
    assert.equal(await s.provider.status(r.sandboxId), 'missing')
    assert.equal((await fetch(`${s.host.origin}/host/me`, { headers: { authorization: `Bearer ${a}` } })).status, 401, 'the old account token no longer works')
    assert.doesNotMatch(readFileSync(join(s.dir, 'accounts.json'), 'utf8'), /a@example\.com/)
    const again = await s.signIn('a@example.com')
    const after = (await (await fetch(`${s.host.origin}/host/me`, { headers: { authorization: `Bearer ${again}` } })).json() as { id: string }).id
    assert.notEqual(after, before)
  } finally { await s.close() }
})

test('the web deletion page: a form that asks what sign-in asks; a wrong code deletes nothing; the right one deletes the account and its computer', async () => {
  const s = await boot()
  try {
    const a = await s.signIn('b@example.com')
    const r = await s.ready(a)
    const page = await (await fetch(`${s.host.origin}/account/delete`)).text()
    assert.match(page, /<form[^>]+method="post"/)
    assert.match(page, /name="email"/)
    assert.match(page, /name="code"/)
    const post = (body: string) => fetch(`${s.host.origin}/account/delete`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body })
    const wrong = await post('email=b%40example.com&code=nope')
    assert.equal(wrong.status, 403)
    assert.equal(await s.provider.status(r.sandboxId), 'running')
    const ok = await post(`email=B%40example.com&code=${CODE}`)
    assert.equal(ok.status, 200)
    assert.match(await ok.text(), /deleted/i)
    assert.equal(await s.provider.status(r.sandboxId), 'missing')
    const none = await post(`email=nobody%40example.com&code=${CODE}`)
    assert.equal(none.status, 200, 'the same answer whether or not the email had an account')
  } finally { await s.close() }
})

test('a report from the phone reaches the operator through the sandbox; the operator blocks the interface and suspends the account', async () => {
  const s = await boot()
  try {
    const a = await s.signIn('c@example.com')
    const r = await s.ready(a)
    const rep = await fetch(`${s.host.origin}/s/${r.sandboxId}/reports`, { method: 'POST', headers: { authorization: `Bearer ${r.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'interface', reason: 'violence', moduleId: 'm0000000009', note: 'scary' }) })
    assert.equal(rep.status, 200)
    assert.equal(((await rep.json()) as { forwarded: boolean }).forwarded, true)
    assert.equal((await s.admin('/host/admin/reports', {}, 'wrong')).status, 401)
    assert.equal((await s.admin('/host/admin/reports', {}, HOST_SECRET)).status, 401, 'the sandboxes\' shared secret is not the admin token')
    const list = await (await s.admin('/host/admin/reports')).json() as { id: string; account: string; sandbox: string; kind: string; moduleTitle: string; status: string; dueBy: string }[]
    assert.equal(list.length, 1)
    assert.equal(list[0].sandbox, r.sandboxId)
    assert.equal(list[0].moduleTitle, 'Quiz')
    assert.equal(list[0].status, 'open')
    assert.equal(Date.parse(list[0].dueBy) - Date.now() > 23 * 3600_000, true, 'answered within 24 hours')
    const act = await s.admin(`/host/admin/reports/${list[0].id}`, { method: 'PATCH', body: JSON.stringify({ status: 'resolved', action: 'block-interface', note: 'graphic' }) })
    assert.equal(act.status, 200, await act.clone().text())
    assert.equal(s.provider.rows.get(r.sandboxId)!.ui!.module('m0000000009')!.blocked, true)
    const after = await (await s.admin('/host/admin/reports')).json() as { status: string; action: string }[]
    assert.equal(after[0].status, 'resolved')
    assert.equal(after[0].action, 'block-interface')
    // suspending the account: its computer is closed to it and it cannot sign in
    const sus = await s.admin(`/host/admin/reports/${list[0].id}`, { method: 'PATCH', body: JSON.stringify({ status: 'resolved', action: 'suspend-account' }) })
    assert.equal(sus.status, 200)
    assert.equal((await fetch(`${s.host.origin}/s/${r.sandboxId}/me`, { headers: { authorization: `Bearer ${r.token}` } })).status, 403)
    assert.equal((await fetch(`${s.host.origin}/host/sign-in`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'c@example.com', code: CODE }) })).status, 403)
  } finally { await s.close() }
})

test('a phone paired with its own computer reports to the host directly; a flood from one address is refused', async () => {
  const s = await boot()
  try {
    const send = () => fetch(`${s.host.origin}/host/reports`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'reply', reason: 'hate', excerpt: 'bad words' }) })
    assert.equal((await send()).status, 200)
    const list = await (await s.admin('/host/admin/reports')).json() as { source: string; excerpt: string }[]
    assert.equal(list[0].source, 'app')
    assert.equal(list[0].excerpt, 'bad words')
    let last = 200
    for (let i = 0; i < 25; i++) last = (await send()).status
    assert.equal(last, 429)
    assert.equal((await fetch(`${s.host.origin}/host/reports`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'reply', reason: 'nonsense' }) })).status, 400)
  } finally { await s.close() }
})
