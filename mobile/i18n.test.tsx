// The seven languages (asked for 2026-11-02): every string the app shows exists in each, with the same blanks;
// dates, times, numbers and separators the way each language writes them (written by hand in src/locale.ts:
// NSH's runtimes have no Intl.ListFormat, RelativeTimeFormat or PluralRules, measured 2026-11-02, and their
// DateTimeFormat gives Russian "2.11" for a short month).
import { expect, open, test } from 'nsh/test'
import { LANGS, LANG_NAMES, formatDate, formatDateTime, formatNumber, formatTime, labelSeparator, listOf, listSeparator, normalizeLang, pluralRu, type Lang } from './src/locale.ts'
import { ALL, STRINGS, STOP_STRINGS, MAIN_STRINGS, CARD_STRINGS, CHAT_STRINGS, MODULE_STRINGS } from './src/i18n.ts'
import { COMPLIANCE_STRINGS } from './src/i18n-compliance.ts'
import { TRY_STRINGS } from './src/i18n-try.ts'
import { CM, SERVICES, serviceFor } from './src/i18n-cm.ts'
import { PLAIN, activityText } from './src/plain.ts'
import { TOOL_WORDS, toolWord } from './src/fold.ts'

const SEVEN = ['en', 'zh', 'zh-Hant', 'es', 'ko', 'ja', 'ru'] as const
const S = 'XQ'
/** Sample arguments where a blank is not a plain string. */
const ARGS: Record<string, unknown[]> = {
  every: [7200], morningBriefHint: [8], agoMin: [37], agoHour: [37], agoDay: [37], exported: [37], didThings: [37, 12],
  memCount: [37], memShowMore: [37], memNoted: [37], svcUsed: [37], memChanged: [37],
  weekly: [`${S}1`, [1, 3]], ideas: ['37', `${S}2`], presetText: ['notion'], forgot: [37, `${S}1`],
}
const argsOf = (key: string, fn: (...a: never[]) => unknown) => ARGS[key] ?? Array.from({ length: fn.length }, (_, i) => `${S}${i + 1}`)
const blanks = (s: unknown) => (String(s).match(/XQ\d|(?<!\d)37(?!\d)|(?<!\d)12(?!\d)/g) ?? []).sort().join()

function compare(a: unknown, b: unknown, path: string, out: string[]) {
  if (typeof a === 'function') {
    if (typeof b !== 'function') return void out.push(`${path}: missing`)
    const key = path.split('.').at(-1)!
    if (key === 'presetText') return
    const args = argsOf(key, a as never)
    const x = (a as (...v: unknown[]) => unknown)(...args), y = (b as (...v: unknown[]) => unknown)(...args)
    if (blanks(x) !== blanks(y)) out.push(`${path}: blanks ${blanks(x)} vs ${blanks(y)}`)
  } else if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) out.push(`${path}: not the same list`)
  } else if (a && typeof a === 'object') {
    if (!b || typeof b !== 'object') return void out.push(`${path}: missing`)
    for (const k of Object.keys(a)) compare((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`, out)
    for (const k of Object.keys(b)) if (!(k in (a as object))) out.push(`${path}.${k}: not in English`)
  } else if (typeof a === 'string' && (typeof b !== 'string' || (a && !b))) out.push(`${path}: missing`)
}
const TABLES: [string, Record<string, unknown>][] = [['try', TRY_STRINGS], ['base', STRINGS], ['stop', STOP_STRINGS], ['main', MAIN_STRINGS], ['card', CARD_STRINGS], ['chat', CHAT_STRINGS], ['module', MODULE_STRINGS], ['compliance', COMPLIANCE_STRINGS], ['cm', CM], ['services', SERVICES], ['plain', PLAIN], ['tools', TOOL_WORDS]]

test('every string in all seven, the same blanks, no list shorter', () => {
  expect([...LANGS]).toEqual([...SEVEN])
  const out: string[] = []
  for (const [name, table] of TABLES) for (const l of SEVEN) compare(table.en, table[l], `${name}.${l}`, out)
  expect(out).toEqual([])
})

/** Names and words that stay the same in another language. */
const SAME = /^(Boop|OK|GitHub|Notion|Linear|Slack|Gmail|Google Drive|Google Calendar|Jira and Confluence|Chat|Chats|Idea|Ideas|Interfaces|No|Error|Local|Personal|Total|Plan|Menu|Web|Normal|Editor|Email|—|\s*|.*\.\.\.)$/
test('nothing is left in English in the other six', () => {
  const out: string[] = []
  const walk = (a: unknown, b: unknown, path: string) => {
    if (typeof a === 'function') {
      const key = path.split('.').at(-1)!
      if (key === 'presetText') return
      const args = argsOf(key, a as never)
      return walk((a as (...v: unknown[]) => unknown)(...args), (b as (...v: unknown[]) => unknown)(...args), path)
    }
    if (Array.isArray(a)) return a.forEach((v, i) => walk(v, (b as unknown[])[i], `${path}.${i}`))
    if (a && typeof a === 'object') { for (const k of Object.keys(a)) walk((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`); return }
    if (typeof a === 'string' && a === b && /[a-z]{2}/i.test(a) && !SAME.test(a)) out.push(`${path}: ${a.slice(0, 40)}`)
  }
  for (const [name, table] of TABLES) for (const l of SEVEN) if (l !== 'en') walk(table.en, table[l], `${name}.${l}`)
  expect(out).toEqual([])
})

const allText = (l: Lang) => JSON.stringify(TABLES.map(([, t]) => t[l]))
test('traditional Chinese is written for its readers: no simplified characters, no mainland vocabulary', () => {
  const found = (re: RegExp) => [...new Set(allText('zh-Hant').match(re) ?? [])]
  expect(found(/[们这个来时会过还点开发为对说话语读写让请设软网络视账钟间现实经动从进见关边长门问题无样选择务电脑录认证显图输连记忆标签询习惯]/g)).toEqual([])
  expect(found(/軟件|文件夾|設置|網絡|信息|默認|視頻|登錄|鏈接|服務器|內存|點擊/g)).toEqual([])
})

test('Japanese has no simplified characters; Korean and Russian are in their own scripts', () => {
  expect([...new Set(allText('ja').match(/[们这个时过还开发为对说话语读让请设软网络视账钟间现实经动从进见关边长门问题无样选择务电脑录认证显图输连记忆标签询习惯]/g) ?? [])]).toEqual([]) // 会 点 写 来 are Japanese too
  expect(/[가-힯]/.test(String(STRINGS.ko.start))).toBe(true)
  expect(/[ぁ-ヿ一-鿿]/.test(String(STRINGS.ja.start))).toBe(true)
  expect(/[Ѐ-ӿ]/.test(String(STRINGS.ru.start))).toBe(true)
})

test('every tag a phone says lands on one of the seven', () => {
  const cases: [string, Lang][] = [['en-US', 'en'], ['fr-FR', 'en'], ['', 'en'], ['zh', 'zh'], ['zh-CN', 'zh'], ['zh-Hans-CN', 'zh'], ['zh_CN', 'zh'], ['zh-TW', 'zh-Hant'], ['zh-HK', 'zh-Hant'], ['zh-MO', 'zh-Hant'], ['zh-Hant', 'zh-Hant'], ['zh-Hant-TW', 'zh-Hant'], ['es', 'es'], ['es-MX', 'es'], ['es-419', 'es'], ['ko-KR', 'ko'], ['ja-JP', 'ja'], ['ru-RU', 'ru']]
  for (const [tag, want] of cases) expect(`${tag} ${normalizeLang(tag)}`).toBe(`${tag} ${want}`)
  expect(LANG_NAMES).toEqual({ en: 'English', zh: '简体中文', 'zh-Hant': '繁體中文', es: 'Español', ko: '한국어', ja: '日本語', ru: 'Русский' })
})

test('dates, times, numbers and separators as each language writes them', () => {
  const at = new Date(2026, 10, 2, 18, 5).getTime(), morning = new Date(2026, 0, 9, 9, 7).getTime()
  const want: Record<Lang, [string, string, string, string, string]> = {
    en: ['Nov 2', 'Nov 2, 2026', '6:05 PM', '9:07 AM', 'Nov 2, 6:05 PM'],
    zh: ['11月2日', '2026年11月2日', '18:05', '09:07', '11月2日 18:05'],
    'zh-Hant': ['11月2日', '2026年11月2日', '下午6:05', '上午9:07', '11月2日 下午6:05'],
    es: ['2 nov', '2 nov 2026', '18:05', '9:07', '2 nov, 18:05'],
    ko: ['11월 2일', '2026년 11월 2일', '오후 6:05', '오전 9:07', '11월 2일 오후 6:05'],
    ja: ['11月2日', '2026年11月2日', '18:05', '9:07', '11月2日 18:05'],
    ru: ['2 нояб.', '2 нояб. 2026 г.', '18:05', '09:07', '2 нояб., 18:05'],
  }
  for (const l of SEVEN) expect([formatDate(at, l), formatDate(at, l, true), formatTime(at, l), formatTime(morning, l), formatDateTime(at, l)]).toEqual(want[l])
  expect(listOf(['A', 'B', 'C'], 'en')).toBe('A, B and C')
  expect(listOf(['A', 'B', 'C'], 'zh')).toBe('A、B和C')
  expect(listOf(['A', 'B', 'C'], 'zh-Hant')).toBe('A、B和C')
  expect(listOf(['A', 'B', 'C'], 'es')).toBe('A, B y C')
  expect(listOf(['A', 'B', 'C'], 'ko')).toBe('A, B, C')
  expect(listOf(['A', 'B', 'C'], 'ja')).toBe('A、B、C')
  expect(listOf(['A', 'B', 'C'], 'ru')).toBe('A, B и C')
  expect(listOf(['A'], 'ru')).toBe('A')
  expect(SEVEN.map((l) => listSeparator(l))).toEqual([', ', '，', '，', ', ', ', ', '、', ', '])
  expect(SEVEN.map((l) => labelSeparator(l))).toEqual([': ', '：', '：', ': ', ': ', '：', ': '])
  expect(SEVEN.map((l) => formatNumber(1234567, l))).toEqual(['1,234,567', '1,234,567', '1,234,567', '1.234.567', '1,234,567', '1,234,567', '1 234 567'])
  expect(formatNumber(1234, 'es')).toBe('1234') // Spanish groups from five digits
})

test('Russian counts take the right form: 1, 2–4, 5+, and 11–14 are not 1–4', () => {
  const w = (n: number) => pluralRu(n, 'дело', 'дела', 'дел')
  expect([1, 21, 101].map(w)).toEqual(['дело', 'дело', 'дело'])
  expect([2, 3, 4, 22].map(w)).toEqual(['дела', 'дела', 'дела', 'дела'])
  expect([0, 5, 11, 12, 14, 25, 111].map(w)).toEqual(['дел', 'дел', 'дел', 'дел', 'дел', 'дел', 'дел'])
  const form = (s: string) => s.replace(/\d+/g, '#')
  for (const f of [CHAT_STRINGS.ru.didThings as (n: number, s: number) => string]) {
    expect(form(f(1, 0))).toBe(form(f(21, 0)))
    expect(form(f(1, 0)) === form(f(2, 0))).toBe(false)
    expect(form(f(2, 0)) === form(f(5, 0))).toBe(false)
    expect(form(f(5, 0))).toBe(form(f(11, 0)))
  }
  const c = CM.ru.memCount as (n: number) => string
  expect(form(c(1)) === form(c(5))).toBe(false); expect(form(c(2)) === form(c(5))).toBe(false)
})

test('activity lines, tools and permission words in each language', () => {
  for (const l of SEVEN) {
    if (l === 'en') continue
    expect(activityText('Remembered: X', l) === 'Remembered: X').toBe(false)
    expect(activityText('Remembered: X', l).includes('X')).toBe(true)
    expect(activityText('Deleted reminder 3f2a', l) === 'Removed a reminder').toBe(false)
    expect(toolWord('bash', l) === toolWord('bash', 'en')).toBe(false)
    expect(toolWord('mcp__acme-pages__x', l).includes('Acme Pages')).toBe(true)
    expect(toolWord('mystery', l) === toolWord('mystery', 'en')).toBe(false)
    expect(serviceFor('acme', 'Acme', 'Your stuff', l).can.join(' ').includes('Acme')).toBe(true)
  }
})

const ORIGIN = 'http://127.0.0.1:3850'
const TOKEN = 'tok_abcdefghijklmnopqrstuvwxyz0123456789'
const me = { device: { id: 'd1', name: 'Phone' }, assistant: { name: 'Nori' }, mainSessionId: 'main', connected: true, pushPublicKey: null }

test('the first screen is in the phone\'s language, for each of the seven', async () => {
  for (const [tag, l] of [['zh-Hant-TW', 'zh-Hant'], ['es-MX', 'es'], ['ko-KR', 'ko'], ['ja-JP', 'ja'], ['ru-RU', 'ru']] as const) {
    const app = await open('./App.tsx', { locale: tag })
    await app.waitFor('id:start')
    expect(app.shows(`text:${STRINGS[l].start}`)).toBe(true)
    await app.close?.()
  }
})

test('a language chosen in the app sticks, and the bot is told, so notifications and replies follow it', async () => {
  const app = await open('./App.tsx', { locale: 'en-US', storage: { origin: ORIGIN, token: TOKEN, lang: 'ru' }, network: {
    [`GET ${ORIGIN}/me`]: { body: me }, [`GET ${ORIGIN}/threads`]: { body: [] }, [`PUT ${ORIGIN}/me/context`]: { body: { ok: true } },
  } })
  await app.waitUntil(() => app.requests().some((r) => r.url.endsWith('/me/context')))
  const body = JSON.parse(String(app.requests().find((r) => r.url.endsWith('/me/context'))!.body)) as { locale: string }
  expect(body.locale).toBe('ru')
})

test('every table calls the product Boop, and no table names one phone system', () => {
  for (const l of LANGS) {
    const text = allText(l) + STRINGS[l].setEnvHint('X')
    expect(text.match(/deepseek[- ]bot/gi) ?? []).toEqual([])
    expect(STRINGS[l].notificationsDenied.includes('iOS')).toBe(false)
  }
})
