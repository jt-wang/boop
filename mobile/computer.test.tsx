// The Computer section of Settings: the phone says which way it
// actually reaches the computer, worked out from the address it uses, and only says "encrypted" for what is.
import { expect, open, test } from 'nsh/test'
import { routeOf } from './src/route.ts'
import { APP_VERSION } from './src/version.ts'
import { STRINGS } from './src/i18n.ts'

const meBody = (computer?: { name: string; version: string }) => ({ device: { id: 'd1', name: 'iPhone' }, assistant: { name: 'Nori' }, mainSessionId: 'main', connected: true, pushPublicKey: null, age: 'adult', ai: { model: 'm', company: 'c', policyUrl: null, filter: null, consent: { at: '2026-11-03' } }, computer })
const settings = async (origin: string, opts: { hostedBy?: string; lang?: string; computer?: { name: string; version: string } | null } = {}) => {
  const app = await open('./App.tsx', {
    storage: { origin, token: 'tok_abcdefghijklmnopqrstuvwxyz0123456789', ...(opts.hostedBy ? { hostedBy: opts.hostedBy } : {}), ...(opts.lang ? { lang: opts.lang } : {}) },
    network: {
      [`GET ${origin}/me`]: { body: meBody(opts.computer === null ? undefined : opts.computer ?? { name: 'Studio Mac', version: '9.8.7' }) },
      [`GET ${origin}/threads`]: { body: [{ sessionId: 'main', title: '', updatedAt: 1700000000000, running: false, blank: false }] },
    },
  })
  const label = { ru: 'Настройки' }[opts.lang ?? ''] ?? 'Settings'
  await app.waitFor(`label:${label}`)
  await app.press(`label:${label}`)
  await app.waitFor('id:computer-status')
  return app
}
const online = (app: Awaited<ReturnType<typeof settings>>) => app.host.send('event', { type: 'hello', connected: true, asks: [] })

test('the way there comes from the address: a private address is the local network', () => {
  for (const o of ['http://192.168.1.20:3850', 'http://10.0.0.5:3850', 'http://172.16.0.1:3850', 'http://172.31.255.1:3850', 'http://169.254.0.9:3850', 'http://127.0.0.1:3850', 'http://studio.local:3850', 'http://[fd00::1]:3850', 'http://[fe80::1]:3850', 'http://[::1]:3850']) {
    const r = routeOf(o, false)
    expect(r?.via).toBe('lan')
    expect(r?.encrypted).toBe(false)
  }
  expect(routeOf('http://192.168.1.20:3850', false)?.host).toBe('192.168.1.20:3850')
})

test('http to any other address is plain over the internet; the look-alikes of a private address are not private', () => {
  for (const o of ['http://203.0.113.5:3850', 'http://172.32.0.1:3850', 'http://192.169.1.1:3850', 'http://11.0.0.1:3850', 'http://bot.example.com']) {
    expect(routeOf(o, false)).toEqual({ encrypted: false, via: 'internet', host: new URL(o).host })
  }
})

test('https: a quick tunnel goes through Cloudflare, a hosted computer through the host, anything else straight to that name', () => {
  expect(routeOf('https://abc-def.trycloudflare.com', false)).toEqual({ encrypted: true, via: 'cloudflare', host: 'abc-def.trycloudflare.com' })
  expect(routeOf('https://evil-trycloudflare.com', false)?.via).toBe('internet')
  expect(routeOf('https://trycloudflare.com.example.net', false)?.via).toBe('internet')
  expect(routeOf('https://host.example.dev/s/abc', true)).toEqual({ encrypted: true, via: 'hosted', host: 'host.example.dev' })
  expect(routeOf('https://bot.example.com', false)).toEqual({ encrypted: true, via: 'internet', host: 'bot.example.com' })
  expect(routeOf('http://192.168.1.20:3850', true)?.encrypted).toBe(false) // the scheme decides, not who made the computer
})

test('no address, no way there', () => {
  expect(routeOf('', false)).toBe(null)
  expect(routeOf('not a url', false)).toBe(null)
})

test('a computer on the local network: its name, plain http said plainly, both versions', async () => {
  const app = await settings('http://192.168.1.20:3850')
  await online(app)
  await app.waitFor('text:Direct to your computer over the local network (192.168.1.20:3850)')
  expect(app.shows('text:Computer')).toBe(true)
  expect(app.shows('text:Studio Mac')).toBe(true)
  expect(app.shows('text:Connected')).toBe(true)
  expect(app.shows('text:Not encrypted')).toBe(true)
  expect(app.shows('text:/Anyone on the network/')).toBe(true)
  expect(app.shows('text:/Encrypted/')).toBe(false)
  expect(app.shows(`text:${APP_VERSION}`)).toBe(true)
  expect(app.shows('text:9.8.7')).toBe(true)
  expect(app.shows('text:/new pairing code/')).toBe(true)
})

test('a quick tunnel says Cloudflare is on the way and can read it', async () => {
  const app = await settings('https://abc-def.trycloudflare.com')
  await online(app)
  await app.waitFor('text:Through a Cloudflare tunnel to your computer')
  expect(app.shows('text:Encrypted in transit (HTTPS)')).toBe(true)
  expect(app.shows('text:/^Cloudflare can read/')).toBe(true)
})

test('a hosted computer: no machine id for a name, the host can read it, signing in again brings it back', async () => {
  const app = await settings('https://host.example.dev/s/abc', { hostedBy: 'https://host.example.dev', computer: { name: '3d8d9e1a', version: '9.8.7' } })
  await online(app)
  await app.waitFor('text:Through the hosting service to your cloud computer')
  expect(app.shows('text:Cloud computer')).toBe(true)
  expect(app.shows('text:3d8d9e1a')).toBe(false)
  expect(app.shows('text:/^The hosting service can read/')).toBe(true)
  expect(app.shows('text:/sign in again/')).toBe(true)
  expect(app.shows('text:/new pairing code/')).toBe(false)
})

test('your own server: named by its address, encrypted to it, and no line about a third party', async () => {
  const app = await settings('https://bot.example.com', { computer: { name: 'a3f1b2c9d0e4', version: '9.8.7' } })
  await online(app)
  await app.waitFor('text:Over the internet to bot.example.com')
  expect(app.shows('text:bot.example.com')).toBe(true)
  expect(app.shows('text:a3f1b2c9d0e4')).toBe(false)
  expect(app.shows('text:Encrypted in transit (HTTPS)')).toBe(true)
  expect(app.shows('text:/can read/')).toBe(false)
})

test('not connected: the state says so and the way there is not claimed', async () => {
  const app = await settings('http://192.168.1.20:3850')
  await app.host.send('event', { type: 'reset' })
  await app.waitFor('text:Finding the route…')
  expect(app.shows('text:Reconnecting')).toBe(true)
  expect(app.shows('text:/Direct to your computer/')).toBe(false)
  expect(app.shows('text:Not encrypted')).toBe(true) // the address it will try again is still plain
})

test('a bot older than this section: no name or version row rather than an empty one', async () => {
  const app = await settings('http://192.168.1.20:3850', { computer: null })
  expect(app.shows('text:Computer version')).toBe(false)
  expect(app.shows(`text:${APP_VERSION}`)).toBe(true)
})

test('unpairing a hosted computer warns about signing in, not a pairing code', async () => {
  const origin = 'https://host.example.dev/s/abc'
  const app = await settings(origin, { hostedBy: 'https://host.example.dev' })
  app.onDialog((d) => d.buttons.find((b) => b === 'Cancel') ?? null)
  await app.press('id:unpair')
  expect(String(app.dialogs().at(-1)?.description ?? app.dialogs().at(-1)?.message)).toMatch(/sign in again/)
})

test('in all seven languages, and "end-to-end" is in none of the routes that are not TailPocket', async () => {
  const words: Record<string, RegExp> = { en: /end.to.end|e2e/i, zh: /端到端/, 'zh-Hant': /端到端|端對端/, es: /extremo a extremo/i, ko: /종단/, ja: /エンドツーエンド/, ru: /сквозн/i }
  for (const l of Object.keys(words)) {
    const s = STRINGS[l as keyof typeof STRINGS]
    const keys = ['computer', 'connectionStatus', 'connectionLabel', 'stateOnline', 'stateReconnecting', 'stateOffline', 'connPlain', 'connTls', 'pathCloudflare', 'pathHosted', 'pathUnknown', 'notePlain', 'noteCloudflare', 'noteHosted', 'cloudComputer', 'appVersion', 'computerVersion', 'unpairBodyHosted'] as const
    for (const k of keys) {
      expect(String(s[k]).length > 0).toBe(true)
      expect(words[l]!.test(String(s[k]))).toBe(false)
    }
    expect(s.pathLan('H:1')).toContain('H:1')
    expect(s.pathInternet('H:1')).toContain('H:1')
  }
})

test('Russian on screen: the section is translated, the address is left alone', async () => {
  const app = await settings('http://192.168.1.20:3850', { lang: 'ru' })
  await online(app)
  await app.waitFor('text:/по локальной сети \\(192\\.168\\.1\\.20:3850\\)/')
  expect(app.shows('text:Компьютер')).toBe(true)
  expect(app.shows('text:Без шифрования')).toBe(true)
})
