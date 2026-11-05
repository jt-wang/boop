// Plain words for what the bot logs. The activity list is written by the bot
// in English with ids and timestamps ("Updated memory: …", "Deleted reminder
// 3f2a…", "next 2026-10-29T11:00:00.000Z"); a person reads it in their own
// language with none of that.

import { formatDateTime, type Lang } from './locale.ts'
import { es } from './locales/es.ts'
import { ja } from './locales/ja.ts'
import { ko } from './locales/ko.ts'
import { ru } from './locales/ru.ts'
import { zhHant } from './locales/zh-Hant.ts'

const plainEn = {
  remembered: (x: string) => `Remembered: ${x}`,
  forgot: (x: string) => `Forgot what it knew about “${x}”`,
  reminderSet: (x: string) => `Set a reminder: ${x}`,
  reminderChanged: (x: string, when: string) => `Changed the reminder “${x}”${when ? `, next ${when}` : ''}`,
  reminderRemoved: () => 'Removed a reminder',
  reminded: (x: string) => `Reminded you: ${x}`,
  newGoal: (x: string) => `New goal: ${x}`,
  madeScreen: (x: string) => `Made you a screen: ${x}`,
  morningIdea: (x: string) => `Morning idea: ${x}`,
  ideas: (n: string, titles: string) => `${n} new idea${n === '1' ? '' : 's'}: ${titles}`,
  connected: (x: string) => `Connected ${x}`,
}
export type PlainWords = typeof plainEn
export const PLAIN: Record<Lang, PlainWords> = {
  en: plainEn,
  zh: {
    remembered: (x) => `记下了：${x}`,
    forgot: (x) => `忘掉了关于「${x}」的事`,
    reminderSet: (x) => `设了提醒：${x}`,
    reminderChanged: (x, when) => `改了提醒「${x}」${when ? `，下次 ${when}` : ''}`,
    reminderRemoved: () => '删掉了一个提醒',
    reminded: (x) => `提醒了你：${x}`,
    newGoal: (x) => `新目标：${x}`,
    madeScreen: (x) => `做了一个界面：${x}`,
    morningIdea: (x) => `早间想法：${x}`,
    ideas: (n, titles) => `想到 ${n} 件可以做的事：${titles.replace(/; /g, '；')}`,
    connected: (x) => `连接了 ${x}`,
  },
  'zh-Hant': zhHant.plain, es: es.plain, ko: ko.plain, ja: ja.plain, ru: ru.plain,
}

const RULES: { re: RegExp; say: (w: PlainWords, m: RegExpExecArray, l: Lang) => string }[] = [
  { re: /^Remembered: (.+)$/s, say: (w, m) => w.remembered(m[1]) },
  { re: /^Updated memory: (.+)$/s, say: (w, m) => w.remembered(m[1]) },
  { re: /^Forgot (\d+) fact\(s\) matching "(.*)"$/s, say: (w, m) => w.forgot(m[2]) },
  { re: /^Scheduled "(.+)" for .*$/s, say: (w, m) => w.reminderSet(m[1]) },
  { re: /^Updated "(.+)" — next (.+)$/s, say: (w, m, l) => w.reminderChanged(m[1], formatDateTime(m[2], l)) },
  { re: /^Deleted reminder .*$/s, say: (w) => w.reminderRemoved() },
  { re: /^Reminder fired: (.+)$/s, say: (w, m) => w.reminded(m[1]) },
  { re: /^New goal: (.+)$/s, say: (w, m) => w.newGoal(m[1]) },
  { re: /^Built an interface: (.+)$/s, say: (w, m) => w.madeScreen(m[1]) },
  { re: /^Morning brief: (.+)$/s, say: (w, m) => w.morningIdea(m[1]) },
  { re: /^(\d+) new ideas?: (.+)$/s, say: (w, m) => w.ideas(m[1], m[2]) },
  { re: /^Connected (.+)$/s, say: (w, m) => w.connected(m[1]) },
]

/**
 * What a finished turn changed in memory, from its step rows (the bot's `remember` carries the fact, `forget`
 * the words to forget). A `remember` that found the fact already known, or a `forget` that matched nothing, changed nothing.
 */
export function memoryChanges(steps: { name: string; command?: string; output?: string }[]): { kind: 'remembered' | 'forgot'; text: string }[] {
  const out: { kind: 'remembered' | 'forgot'; text: string }[] = []
  for (const s of steps) {
    if (!s.command || s.output === undefined) continue
    if (/(^|__)remember$/.test(s.name) && !/already known/i.test(s.output)) out.push({ kind: 'remembered', text: s.command })
    else if (/(^|__)forget$/.test(s.name) && !/nothing matched/i.test(s.output)) out.push({ kind: 'forgot', text: s.command })
  }
  return out
}

/** One activity entry in the person's language. Unknown shapes pass through unchanged. */
export function activityText(text: string, l: Lang): string {
  for (const r of RULES) { const m = r.re.exec(text); if (m) return r.say(PLAIN[l], m, l) }
  return text
}
