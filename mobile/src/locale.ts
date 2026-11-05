// The seven languages and how each writes a date, a time, a number, a list. By hand, on purpose: NSH's runtimes have no
// Intl.ListFormat, RelativeTimeFormat or PluralRules, and their DateTimeFormat differs by platform and gives Russian "2.11"
// for a short month (measured in `nsh test`, 2026-11-02). Only this file may know how a language writes these.
export const LANGS = ['en', 'zh', 'zh-Hant', 'es', 'ko', 'ja', 'ru'] as const
export type Lang = (typeof LANGS)[number]
/** Each language in its own words, for the language picker. */
export const LANG_NAMES: Record<Lang, string> = { en: 'English', zh: '简体中文', 'zh-Hant': '繁體中文', es: 'Español', ko: '한국어', ja: '日本語', ru: 'Русский' }

export const isLang = (x: unknown): x is Lang => (LANGS as readonly unknown[]).includes(x)

/** Which of the seven a tag means; anything else is English. */
export function normalizeLang(tag: string | null | undefined): Lang {
  const t = (tag ?? '').replace(/_/g, '-').toLowerCase()
  if (/^zh(-|$)/.test(t)) return /-(hant|tw|hk|mo)(-|$)/.test(t) ? 'zh-Hant' : 'zh'
  const base = t.split('-')[0]
  return base === 'es' || base === 'ko' || base === 'ja' || base === 'ru' ? base : 'en'
}

const MONTHS: Partial<Record<Lang, string[]>> = {
  en: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
  es: ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sept', 'oct', 'nov', 'dic'],
  ru: ['янв.', 'февр.', 'марта', 'апр.', 'мая', 'июня', 'июля', 'авг.', 'сент.', 'окт.', 'нояб.', 'дек.'],
}
const pad = (n: number) => String(n).padStart(2, '0')

/** "Nov 2", with the year when asked: "Nov 2, 2026". Accepts what `new Date` does; an invalid date is ''. */
export function formatDate(at: number | string | Date, l: Lang, withYear = false): string {
  const d = new Date(at)
  if (isNaN(d.getTime())) return ''
  const y = d.getFullYear(), m = d.getMonth(), day = d.getDate()
  switch (l) {
    case 'zh': case 'zh-Hant': case 'ja': return `${withYear ? `${y}年` : ''}${m + 1}月${day}日`
    case 'ko': return `${withYear ? `${y}년 ` : ''}${m + 1}월 ${day}일`
    case 'es': return `${day} ${MONTHS.es![m]}${withYear ? ` ${y}` : ''}`
    case 'ru': return `${day} ${MONTHS.ru![m]}${withYear ? ` ${y} г.` : ''}`
    default: return `${MONTHS.en![m]} ${day}${withYear ? `, ${y}` : ''}`
  }
}

/** "6:05 PM"; 24 hours where a language reads the clock that way. */
export function formatTime(at: number | string | Date, l: Lang): string {
  const d = new Date(at)
  if (isNaN(d.getTime())) return ''
  const h = d.getHours(), min = pad(d.getMinutes()), h12 = h % 12 || 12
  switch (l) {
    case 'zh': case 'ru': return `${pad(h)}:${min}`
    case 'es': case 'ja': return `${h}:${min}`
    case 'zh-Hant': return `${h < 12 ? '上午' : '下午'}${h12}:${min}`
    case 'ko': return `${h < 12 ? '오전' : '오후'} ${h12}:${min}`
    default: return `${h12}:${min} ${h < 12 ? 'AM' : 'PM'}`
  }
}

/** "Nov 2, 6:05 PM". */
export function formatDateTime(at: number | string | Date, l: Lang): string {
  const date = formatDate(at, l)
  if (!date) return ''
  return `${date}${l === 'en' || l === 'es' || l === 'ru' ? ', ' : ' '}${formatTime(at, l)}`
}

/** 1,234,567 in each language's grouping (Spanish groups from five digits, Russian with a space). */
export function formatNumber(n: number, l: Lang): string {
  const neg = n < 0, [whole, frac] = String(Math.abs(n)).split('.')
  const group = (sep: string) => whole.replace(/\B(?=(\d{3})+(?!\d))/g, sep)
  const body = l === 'es' ? (whole.length > 4 ? group('.') : whole) : l === 'ru' ? group(' ') : group(',')
  const point = l === 'es' || l === 'ru' ? ',' : '.'
  return `${neg ? '-' : ''}${body}${frac ? `${point}${frac}` : ''}`
}

/** Between loose facts in one line ("Paused, tomorrow"). */
export const listSeparator = (l: Lang) => ({ zh: '，', 'zh-Hant': '，', ja: '、' } as Partial<Record<Lang, string>>)[l] ?? ', '
/** Between a label and its value. */
export const labelSeparator = (l: Lang) => ({ zh: '：', 'zh-Hant': '：', ja: '：' } as Partial<Record<Lang, string>>)[l] ?? ': '

/** "A, B and C" as each language enumerates. */
export function listOf(items: string[], l: Lang): string {
  if (items.length < 2) return items.join('')
  const head = items.slice(0, -1), last = items[items.length - 1]
  switch (l) {
    case 'zh': case 'zh-Hant': return `${head.join('、')}和${last}`
    case 'es': return `${head.join(', ')} y ${last}`
    case 'ru': return `${head.join(', ')} и ${last}`
    case 'ja': return items.join('、')
    case 'ko': return items.join(', ')
    default: return `${head.join(', ')} and ${last}`
  }
}

/** The Russian form for a count: 1 дело, 2 дела, 5 дел; 11–14 take the last. */
export function pluralRu(n: number, one: string, few: string, many: string): string {
  const a = Math.abs(n) % 100, b = a % 10
  if (a >= 11 && a <= 14) return many
  if (b === 1) return one
  if (b >= 2 && b <= 4) return few
  return many
}
