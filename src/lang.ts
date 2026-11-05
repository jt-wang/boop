import { LANGS, SERVER_WORDS, type Lang } from './locales/index.ts'
import type { ServerWords } from './locales/en.ts'

export { LANGS, type Lang }

// The person's language, from what the bot can know, and the lines the bot
// writes itself (activity entries, notification titles) in it. Order: the phone's locale (the app
// sends it on connect), else the language of what they write, else the `language` setting, else English.

/** Common characters written differently in traditional Chinese; shared characters (里斯本) say nothing. */
const TRADITIONAL = /[們這個來時會過還點開發為對說話語讀寫讓請設軟網絡視帳鐘間現實經動從進見關邊長門問題無樣選擇務電腦錄認證顯圖輸連記憶標籤詢習慣]/
const SPANISH = /\b(?:hola|gracias|necesito|quiero|puedes|por favor|buenos d[ií]as|mañana|hoy|ayuda)\b/i

/** The language a message is written in, by script; null when there is too little to tell. */
export function writtenLanguage(text: string): string | null {
  if (/[぀-ヿ]/.test(text)) return 'ja'
  if (/[가-힯]/.test(text)) return 'ko'
  if (/[Ѐ-ӿ]/.test(text)) return 'ru'
  if (/[一-鿿]/.test(text)) return TRADITIONAL.test(text) ? 'zh-Hant' : 'zh'
  if (/[¿¡ñÑ]/.test(text) || SPANISH.test(text)) return 'es'
  if ((text.match(/[A-Za-z]/g) ?? []).length >= 6) return 'en'
  return null
}

export interface LanguageSignals { language?: string; spokenLanguage?: string; person?: { locale?: string } }

/** A BCP 47 tag for the person's language. */
export function personLanguage(st: LanguageSignals): string {
  return st.person?.locale || st.spokenLanguage || (st.language && st.language !== 'auto' ? st.language : '') || 'en'
}

/** Which of the seven languages a tag means; anything else is English. */
export function uiLang(tag: string): Lang {
  const t = tag.replace(/_/g, '-').toLowerCase()
  if (/^zh(-|$)/.test(t)) return /-(hant|tw|hk|mo)(-|$)/.test(t) ? 'zh-Hant' : 'zh'
  const base = t.split('-')[0]
  return base === 'es' || base === 'ko' || base === 'ja' || base === 'ru' ? base : 'en'
}

/** "Chinese (China), zh-CN" — how a prompt names the language for the model. */
export function languageName(tag: string): string {
  try { const n = new Intl.DisplayNames(['en'], { type: 'language' }).of(tag); return n && n !== tag ? `${n}, ${tag}` : tag } catch { return tag }
}

export function words(l: Lang) { return SERVER_WORDS[l].lines }
/** Words for the person, from settings. */
export const wordsFor = (st: LanguageSignals) => words(uiLang(personLanguage(st)))

type Words = ServerWords['lines']
export type LineKey = { [K in keyof Words]: Words[K] extends (...a: never[]) => string ? K : never }[keyof Words]
/** A templated line: stored with its key and arguments so it can be said again in another language. */
export interface Line { key: LineKey; args: unknown[] }
export function render(l: Line, lang: Lang): string { return (words(lang)[l.key] as (...a: unknown[]) => string)(...l.args) }
/** `{ text, line }` for an activity entry: the text in `lang` now, the template for later. */
export function line<K extends LineKey>(lang: Lang, key: K, ...args: Parameters<Words[K]>): { text: string; line: Line } {
  const l = { key, args } as Line
  return { text: render(l, lang), line: l }
}
/** Activity entries as the app reads them: templated lines said again in the person's language now; the template stays on disk. */
export function activityView<T extends { text: string; line?: Line }>(entries: T[], lang: Lang): Omit<T, 'line'>[] {
  return entries.map(({ line: l, ...rest }) => (l ? { ...rest, text: render(l, lang) } : rest))
}
