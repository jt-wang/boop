// The one window of DeepSeek Bot for Mac, headless (`cd mac && nsh test App.test.tsx`).
// The supervisor is replaced by a state in storage (window.fixture.tsx).
import { expect, open, test } from 'nsh/test'
import { MAC, macLang } from './src/strings.ts'

const URL = 'http://192.168.1.23:3851/pair?code=654321'
const running = JSON.stringify({ phase: 'running', pairUrl: URL, code: '654321', port: 3851, failures: 0, restarts: 0 })
const state = (phase: string, extra: Record<string, unknown> = {}) => JSON.stringify({ phase, pairUrl: null, code: null, port: 3850, failures: 0, restarts: 0, ...extra })

test('while starting: the status, no QR, no link, and a Quit button', async () => {
  const app = await open('./window.fixture.tsx', { storage: { state: state('starting') } })
  await app.waitFor('text:Starting your assistant…')
  expect(app.shows('id:qr')).toBe(false)
  expect(app.shows('id:copy')).toBe(false)
  expect(app.shows('id:quit')).toBe(true)
})

test('running: the QR, the link, the code, and the scan instructions', async () => {
  const app = await open('./window.fixture.tsx', { storage: { state: running } })
  await app.waitFor('id:qr')
  await app.waitFor(`text:${URL}`)
  await app.waitFor('text:Code 654321')
  await app.waitFor('text:Scan with your phone')
  await app.waitFor('text:Your assistant is running on this Mac.')
})

test('Copy link puts the pairing link on the clipboard and says Copied', async () => {
  const app = await open('./window.fixture.tsx', { storage: { state: running } })
  await app.waitFor('id:copy')
  await app.press('id:copy')
  await app.waitFor('text:Copied')
  expect(app.clipboard()).toBe(URL)
})

test('a TailPocket code: the phone scans it from inside Boop; the code is too long to show, and can be copied', async () => {
  const invite = 'tailpocket1:eNo_synthetic-invite'
  const app = await open('./window.fixture.tsx', { storage: { state: JSON.stringify({ phase: 'running', pairUrl: invite, code: null, port: 3850, failures: 0, restarts: 0 }) } })
  await app.waitFor('id:qr')
  await app.waitFor('text:Open Boop on your phone and tap Scan the code. You pair once; after that it works from any network.')
  expect(app.shows(`text:${invite}`)).toBe(false)
  expect(app.shows('id:code')).toBe(false)
  await app.press('id:copy')
  await app.waitFor('text:Copied')
  expect(app.clipboard()).toBe(invite)
})

test('restarting and failed are said in plain words', async () => {
  const a = await open('./window.fixture.tsx', { storage: { state: state('restarting', { restarts: 1 }) } })
  await a.waitFor('text:Your assistant stopped. Starting it again…')
  const b = await open('./window.fixture.tsx', { storage: { state: state('failed', { failures: 5 }) } })
  await b.waitFor('text:Your assistant could not start. Quit and open Boop again.')
  expect(b.shows('id:qr')).toBe(false)
})

test('Quit asks the app to quit', async () => {
  const app = await open('./window.fixture.tsx', { storage: { state: running } })
  await app.waitFor('id:quit')
  await app.press('id:quit')
  await app.waitUntil(() => app.storage().quit === '1')
})

test('in Chinese the window speaks Chinese', async () => {
  const app = await open('./window.fixture.tsx', { storage: { state: running }, locale: 'zh-CN' })
  await app.waitFor('text:用手机扫一下')
  await app.waitFor('text:复制链接')
  await app.waitFor('text:退出')
})

test('nothing developer-facing: no path, no command, no port on its own', async () => {
  const app = await open('./window.fixture.tsx', { storage: { state: running } })
  await app.waitFor('id:qr')
  const texts = app.texts().filter((t) => t !== URL)
  for (const t of texts) {
    expect(t.includes('/Users/')).toBe(false)
    expect(t.includes('node ')).toBe(false)
    expect(t.includes('3851')).toBe(false)
    expect(t.includes('npm')).toBe(false)
  }
})

// The seven languages (2026-11-02): the Mac window's every line in each, and a system tag picks one.
test('the Mac window speaks the seven languages', () => {
  const langs = Object.keys(MAC) as (keyof typeof MAC)[]
  expect(langs.length).toBe(7)
  for (const l of langs) for (const k of Object.keys(MAC.en) as (keyof typeof MAC.en)[]) {
    expect(`${l} ${k} ${Boolean(MAC[l]?.[k])}`).toBe(`${l} ${k} true`)
    if (l !== 'en' && /[a-z]{3}/i.test(MAC.en[k])) expect(`${l} ${k} ${MAC[l][k] !== MAC.en[k]}`).toBe(`${l} ${k} true`)
  }
  for (const l of langs) expect(JSON.stringify(MAC[l]).match(/deepseek[- ]bot/gi) ?? []).toEqual([])
  expect(['zh-TW', 'zh-Hans-CN', 'es-MX', 'ko-KR', 'ja-JP', 'ru-RU', 'fr-FR'].map(macLang)).toEqual(['zh-Hant', 'zh-Hans', 'es', 'ko', 'ja', 'ru', 'en'])
})
