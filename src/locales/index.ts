// Every language the bot writes in. The app's own tables are in mobile/src/locales/.
import { en, type ServerWords } from './en.ts'
import { zh } from './zh.ts'
import { zhHant } from './zh-Hant.ts'
import { es } from './es.ts'
import { ko } from './ko.ts'
import { ja } from './ja.ts'
import { ru } from './ru.ts'

export const LANGS = ['en', 'zh', 'zh-Hant', 'es', 'ko', 'ja', 'ru'] as const
export type Lang = (typeof LANGS)[number]
export const LANG_NAMES: Record<Lang, string> = { en: 'English', zh: '简体中文', 'zh-Hant': '繁體中文', es: 'Español', ko: '한국어', ja: '日本語', ru: 'Русский' }
/** The tag for a page's `lang` attribute. */
export const HTML_LANG: Record<Lang, string> = { en: 'en', zh: 'zh-CN', 'zh-Hant': 'zh-Hant', es: 'es', ko: 'ko', ja: 'ja', ru: 'ru' }
/** The locale dates are written in on this side (Node's Intl has them all). */
export const INTL_LOCALE: Record<Lang, string> = { en: 'en-US', zh: 'zh-CN', 'zh-Hant': 'zh-TW', es: 'es-ES', ko: 'ko-KR', ja: 'ja-JP', ru: 'ru-RU' }
export const SERVER_WORDS: Record<Lang, ServerWords> = { en, zh, 'zh-Hant': zhHant, es, ko, ja, ru }
