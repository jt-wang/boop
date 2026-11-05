// What a notification says and where a tap on it lands. Titles are in the person's language;
// an approval's body is the agent's own reason; the url is a place in the app:
//   /threads/<id>                 a thread (a turn ended, a reminder, the assistant's own notify)
//   /threads/<id>/asks/<eventId>  an approval or question card in that thread
//   /discover                     the morning ideas
import { toolWord } from './fold.ts'
import { SERVER_WORDS, type Lang } from './locales/index.ts'

export const threadUrl = (sessionId: string) => `/threads/${encodeURIComponent(sessionId)}`
export const askUrl = (sessionId: string, eventId: string) => `${threadUrl(sessionId)}/asks/${encodeURIComponent(eventId)}`

/** A language whose reader reads this one better than English. */
const NEAREST: Partial<Record<Lang, Lang>> = { 'zh-Hant': 'zh' }

/** An approval's body: the reason as the agent wrote it, never translated or edited (mobile/src/asks.tsx); when it gave none, what it wants to do. */
export function approvalBody(request: { toolName?: unknown; reason?: unknown; displayReason?: unknown }, l: Lang): string {
  const given = request.displayReason as Record<string, string> | undefined
  const near = NEAREST[l]
  return oneLine(given?.[l] || (near && given?.[near]) || given?.en || toolWord(String(request.toolName ?? ''), l), 120)
}

/** Markdown and line breaks out, cut to `max` characters: what a lock screen shows. */
export function oneLine(text: string, max = 160): string {
  const plain = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|\*|_|`|~~)(?=\S)([^\n]*?\S)\1/g, '$2')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
  return plain.length > max ? plain.slice(0, max - 1) + '…' : plain
}
