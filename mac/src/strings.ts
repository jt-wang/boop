// What the Mac window says, in English and Chinese (the system language picks).
import { locale } from 'nsh'
import { es } from './locales/es.ts'
import { ja } from './locales/ja.ts'
import { ko } from './locales/ko.ts'
import { ru } from './locales/ru.ts'
import { zhHant } from './locales/zh-Hant.ts'

const en = {
  starting: 'Starting your assistant…',
  running: 'Your assistant is running on this Mac.',
  restarting: 'Your assistant stopped. Starting it again…',
  failed: 'Your assistant could not start. Quit and open Boop again.',
  stopped: 'Stopped.',
  waiting: 'The code appears here in a moment.',
  scanTitle: 'Scan with your phone',
  scanBody: 'Point the camera at the code and open the link. Your phone and this Mac must be on the same Wi‑Fi. Then add it to your home screen.',
  code: 'Code',
  copyLink: 'Copy link',
  pocketScanBody: 'Open Boop on your phone and tap Scan the code. You pair once; after that it works from any network.',
  copyCode: 'Copy code',
  copied: 'Copied',
  keepOpen: 'Keep this window open. Closing it stops the assistant.',
  quit: 'Quit',
}

export type MacWords = typeof en
const zh: MacWords = {
  starting: '正在启动你的助理…',
  running: '你的助理正在这台 Mac 上运行。',
  restarting: '助理停了，正在重新启动…',
  failed: '助理启动不了。退出后再打开一次 Boop。',
  stopped: '已停止。',
  waiting: '二维码马上出来。',
  scanTitle: '用手机扫一下',
  scanBody: '打开相机对准二维码，点开链接。手机和这台 Mac 要在同一个 Wi‑Fi。然后把它加到主屏幕。',
  code: '配对码',
  copyLink: '复制链接',
  pocketScanBody: '在手机上打开 Boop，点「扫二维码」。只配对一次，之后换了网络也能连上。',
  copyCode: '复制配对码',
  copied: '已复制',
  keepOpen: '让这个窗口开着。关掉它，助理就停了。',
  quit: '退出',
}

export type Key = keyof typeof en
export type Lang = 'en' | 'zh-Hans' | 'zh-Hant' | 'es' | 'ko' | 'ja' | 'ru'

export const MAC: Record<Lang, MacWords> = { en, 'zh-Hans': zh, 'zh-Hant': zhHant, es, ko, ja, ru }

/** Which of the seven a system tag means; anything else is English. */
export function macLang(tag: string): Lang {
  const t = tag.replace(/_/g, '-').toLowerCase()
  if (/^zh(-|$)/.test(t)) return /-(hant|tw|hk|mo)(-|$)/.test(t) ? 'zh-Hant' : 'zh-Hans'
  const base = t.split('-')[0]
  return base === 'es' || base === 'ko' || base === 'ja' || base === 'ru' ? base : 'en'
}

export function str(key: Key): string {
  return MAC[macLang(locale())][key]
}
