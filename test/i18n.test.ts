import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { LANGS, personLanguage, render, uiLang, words, writtenLanguage, type Lang } from '../src/lang.ts'
import { SERVER_WORDS } from '../src/locales/index.ts'
import { humanError, toolWord } from '../src/fold.ts'
import { approvalBody } from '../src/push-text.ts'
import { callbackPage, pageLang } from '../src/oauth.ts'
import { deletePage, openPage, privacyPage, termsPage } from '../src/legal.ts'

// The seven languages (asked for 2026-11-02): every line the bot itself writes to a person exists in each of them,
// with the same blanks filled.
const SEVEN = ['en', 'zh', 'zh-Hant', 'es', 'ko', 'ja', 'ru'] as const
const S = 'XQ'

/** Sample arguments by key, where a blank is not a plain string. */
const ARGS: Record<string, unknown[]> = {
  forgot: [37, `${S}1`], ideas: [[`${S}1`, `${S}2`]], memoryUpdated: [[`${S}1`, `${S}2`]],
}
const sampleArgs = (key: string, fn: (...a: never[]) => unknown) => ARGS[key] ?? Array.from({ length: fn.length }, (_, i) => `${S}${i + 1}`)
const blanks = (s: string) => (s.match(/XQ\d|(?<!\d)37(?!\d)/g) ?? []).sort().join()

function compare(a: unknown, b: unknown, path: string, out: string[]) {
  if (typeof a === 'function') {
    if (typeof b !== 'function') return void out.push(`${path}: missing`)
    if (path.includes('.legal.')) return
    const key = path.split('.').at(-1)!
    const args = sampleArgs(key, a as never)
    const want = blanks(String((a as (...x: unknown[]) => unknown)(...args))), got = blanks(String((b as (...x: unknown[]) => unknown)(...args)))
    if (want !== got) out.push(`${path}: blanks ${want} vs ${got}`)
  } else if (a && typeof a === 'object') {
    if (!b || typeof b !== 'object') return void out.push(`${path}: missing`)
    for (const k of Object.keys(a)) compare((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`, out)
    for (const k of Object.keys(b)) if (!(k in (a as object))) out.push(`${path}.${k}: not in English`)
  } else if (typeof a === 'string' && (typeof b !== 'string' || (a && !b))) out.push(`${path}: missing`)
}

test('the seven languages, and every tag a phone or a browser says lands on one', () => {
  assert.deepEqual([...LANGS], [...SEVEN])
  const cases: [string, Lang][] = [['en-US', 'en'], ['fr-FR', 'en'], ['', 'en'], ['zh', 'zh'], ['zh-CN', 'zh'], ['zh-Hans-CN', 'zh'], ['zh_CN', 'zh'], ['zh-TW', 'zh-Hant'], ['zh-HK', 'zh-Hant'], ['zh-MO', 'zh-Hant'], ['zh-Hant', 'zh-Hant'], ['zh-Hant-JP', 'zh-Hant'], ['es', 'es'], ['es-MX', 'es'], ['es-419', 'es'], ['ko-KR', 'ko'], ['ja-JP', 'ja'], ['ru-RU', 'ru'], ['ru_UA', 'ru']]
  for (const [tag, want] of cases) assert.equal(uiLang(tag), want, tag)
  assert.equal(pageLang('ru-RU,ru;q=0.9,en;q=0.8'), 'ru')
  assert.equal(pageLang('zh-TW,zh;q=0.9'), 'zh-Hant')
  assert.equal(pageLang('fr'), 'en')
  assert.equal(pageLang(undefined), 'en')
})

test('every server line exists in all seven, with the same blanks', () => {
  const out: string[] = []
  for (const l of SEVEN) compare(SERVER_WORDS.en, SERVER_WORDS[l], l, out)
  assert.deepEqual(out, [])
})

test('nothing the server says is left in English in another language', () => {
  const NAMES = /^(Boop|OK)$/
  const out: string[] = []
  const walk = (a: unknown, b: unknown, path: string) => {
    if (/\.(stepSep|goalUpdated)$/.test(path)) return // punctuation, and a template that is only its blanks
    if (typeof a === 'function' && !path.includes('.legal.')) {
      const key = path.split('.').at(-1)!, args = sampleArgs(key, a as never)
      return walk((a as (...x: unknown[]) => unknown)(...args), (b as (...x: unknown[]) => unknown)(...args), path)
    }
    if (a && typeof a === 'object') { for (const k of Object.keys(a)) walk((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`); return }
    if (typeof a === 'string' && typeof b === 'string' && a === b && a && !NAMES.test(a)) out.push(path)
  }
  for (const l of SEVEN) if (l !== 'en') walk(SERVER_WORDS.en, SERVER_WORDS[l], l)
  assert.deepEqual(out, [])
})

test('traditional Chinese is written for its readers: no simplified characters, no mainland vocabulary', () => {
  const SIMPLIFIED = /[们这个来时会过还点开发为对说话语读写让请设软网络视账钟间现实经动从进见关边长门问题无样选择务电脑录认证显图输连记忆标签询习惯]/
  const MAINLAND = /軟件|文件夾|設置|網絡|信息|默認|視頻|登錄|鏈接|服務器|內存|點擊/
  const out: string[] = []
  const strings = JSON.stringify(SERVER_WORDS['zh-Hant'].status) + JSON.stringify(SERVER_WORDS['zh-Hant'].errors) + JSON.stringify(SERVER_WORDS['zh-Hant'].tools) + JSON.stringify(SERVER_WORDS['zh-Hant'].modes) + JSON.stringify(SERVER_WORDS['zh-Hant'].oauth) + JSON.stringify(SERVER_WORDS['zh-Hant'].play) + privacyPage(INFO, 'zh-Hant') + termsPage(INFO, 'zh-Hant') + deletePage(INFO, 'zh-Hant', 'form', true)
  for (const m of strings.match(new RegExp(SIMPLIFIED, 'g')) ?? []) out.push(m)
  for (const m of strings.match(new RegExp(MAINLAND, 'g')) ?? []) out.push(m)
  assert.deepEqual(out, [])
})

test('the app and the bot word a tool the same way', async () => {
  const { TOOL_WORDS } = await import('../mobile/src/fold.ts')
  for (const l of SEVEN) assert.deepEqual(TOOL_WORDS[l].tools, SERVER_WORDS[l].tools, l)
})

const INFO = { operator: 'Acme', contact: 'help@example.com', hostUrl: 'https://h.example', hosting: 'Fly.io', ai: { company: 'SiliconFlow', model: 'DeepSeek', policyUrl: 'https://p.example' }, filter: null } as never

test('legal pages: the page says its language, names the seven, and carries the facts in each', () => {
  for (const l of SEVEN) {
    const tag = l === 'zh' ? 'zh-CN' : l
    for (const html of [privacyPage(INFO, l), termsPage(INFO, l), deletePage(INFO, l, 'form', true), deletePage(INFO, l, 'done', true), openPage(INFO, l)]) {
      assert.match(html, new RegExp(`<html lang="${tag}"`), l)
    }
    const p = privacyPage(INFO, l), t = termsPage(INFO, l)
    for (const name of ['English', '简体中文', '繁體中文', 'Español', '한국어', '日本語', 'Русский']) { assert.ok(p.includes(name), `${l} ${name}`); assert.ok(t.includes(name), `${l} ${name}`) }
    for (const fact of ['SiliconFlow', 'DeepSeek', 'Fly.io', 'https://h.example/account/delete', 'help@example.com', 'https://p.example', '18', '5']) assert.ok(p.includes(fact), `${l} privacy: ${fact}`)
    for (const fact of ['18', '24', 'help@example.com', 'https://h.example/account/delete']) assert.ok(t.includes(fact), `${l} terms: ${fact}`)
    if (l !== 'en') { assert.ok(p.includes(`/privacy?lang=${l}`) || t.includes(`/privacy?lang=${l}`), l); assert.ok(deletePage(INFO, l, 'form', true).includes(`action="/account/delete?lang=${l}"`), l) }
  }
})

test('a person in each language gets their own words: errors, tools, notifications, the browser page', () => {
  for (const l of SEVEN) {
    if (l === 'en') continue
    for (const raw of ['no api key', '401', '402', '429 busy', 'boom']) assert.notEqual(humanError(raw, l), humanError(raw, 'en'), `${l} ${raw}`)
    assert.notEqual(toolWord('bash', l), toolWord('bash', 'en'), l)
    assert.ok(toolWord('mcp__acme-pages__x', l).includes('Acme Pages'), l)
    assert.notEqual(toolWord('mystery', l), toolWord('mystery', 'en'), l)
    assert.notEqual(words(l).needsYes('N'), words('en').needsYes('N'), l)
    assert.notEqual(words(l).reminderDue, words('en').reminderDue, l)
    assert.notEqual(callbackPage({ ok: true, name: 'Notion' }, l), callbackPage({ ok: true, name: 'Notion' }, 'en'), l)
    assert.match(callbackPage({ ok: true, name: 'Notion' }, l), /Notion/)
    assert.equal(render({ key: 'renamed', args: ['N'] }, l), words(l).renamed('N'))
  }
})

test('an approval on a lock screen: what the agent wrote, unchanged; the tool in the person\'s words only when it wrote nothing', () => {
  const r = { toolName: 'bash', displayReason: { en: 'Needs danger-full-access permissions', zh: '需要 danger-full-access 权限' } }
  assert.equal(approvalBody(r, 'en'), 'Needs danger-full-access permissions')
  assert.equal(approvalBody(r, 'zh'), '需要 danger-full-access 权限')
  assert.equal(approvalBody(r, 'zh-Hant'), '需要 danger-full-access 权限', 'the version a reader of Traditional reads best, not converted')
  assert.equal(approvalBody(r, 'ru'), 'Needs danger-full-access permissions')
  assert.equal(approvalBody({ ...r, displayReason: { ...r.displayReason, ru: 'Нужен danger-full-access' } }, 'ru'), 'Нужен danger-full-access')
  assert.equal(approvalBody({ toolName: 'bash' }, 'ru'), toolWord('bash', 'ru'))
})

test('the language of what they write: scripts for ru, marks and common words for es, traditional characters for zh-Hant', () => {
  assert.equal(writtenLanguage('Привет, как дела?'), 'ru')
  assert.equal(writtenLanguage('¿Qué tiempo hace hoy?'), 'es')
  assert.equal(writtenLanguage('Hola, necesito ayuda con mi viaje'), 'es')
  assert.equal(writtenLanguage('What is the weather today'), 'en')
  assert.equal(writtenLanguage('这个时候去里斯本'), 'zh')
  assert.equal(writtenLanguage('這個時候去里斯本'), 'zh-Hant')
  assert.equal(writtenLanguage('里斯本'), 'zh', 'nothing marks it as traditional')
  assert.equal(writtenLanguage('リスボンに行きたい'), 'ja')
  assert.equal(writtenLanguage('리스본에 가고 싶어요'), 'ko')
})

test('an explicit language in settings carries through to the lines the bot writes', () => {
  assert.equal(uiLang(personLanguage({ person: { locale: 'ko-KR' } })), 'ko')
  assert.equal(uiLang(personLanguage({ language: 'zh-Hant' })), 'zh-Hant')
})

// A branch on one language is how the next language gets forgotten: the words live in the tables, in src/locales/.
test('no source branches on a single language, and no date picks its format by one language', () => {
  const walk = (d: string): string[] => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(n) ? [p] : [] })
  const hits: string[] = []
  for (const f of [...walk('src'), ...walk('mobile/src'), ...walk('mac/src')]) {
    if (/locales\//.test(f)) continue
    const s = readFileSync(f, 'utf8')
    s.split('\n').forEach((line, i) => {
      if (/(===?|!==?) ?'zh'|'zh-CN'|toLocale\w*\([^)]*'en-US'|'en' \| 'zh'|'zh' \| 'en'|startsWith\('zh'\)/.test(line) && !/^\s*(\/\/|\*)/.test(line)) hits.push(`${f}:${i + 1}`)
    })
  }
  assert.deepEqual(hits, [])
})

test('the legal links under the age question may wrap: in Russian they are wider than a 360 point phone (Android, 2026-11-02)', () => {
  const src = readFileSync('mobile/src/compliance.tsx', 'utf8')
  const row = /function LegalLinks\(\)[\s\S]*?<View class="([^"]*)"/.exec(src)?.[1] ?? ''
  assert.match(row, /\bflex-wrap\b/)
})

test('no table of words runs over what an agent wrote: the reason passes through', () => {
  assert.equal('modes' in SERVER_WORDS.en, false)
  assert.doesNotMatch(readFileSync('mobile/src/asks.tsx', 'utf8'), /plainReason|\bMODES\b/)
})
