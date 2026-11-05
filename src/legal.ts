// The public pages the stores ask for, served by the host (src/host/server.ts): the privacy policy (App Review
// 5.1.1(i), Google Play User Data), the terms that define what is not allowed (Google Play UGC, App Review 1.2),
// the web page to delete an account (Google Play account deletion), and the page an /open/… link shows when the
// app is not installed. In the seven languages (src/locales/), black on white (white on black in dark mode), no scripts.
// The words state what the code does; the operator signs them off.
import type { AiProvider } from './compliance.ts'
import { HTML_LANG, LANGS, LANG_NAMES, SERVER_WORDS, type Lang } from './locales/index.ts'
import type { LegalCtx } from './locales/util.ts'

export type { Lang }
export interface LegalInfo {
  /** Who runs this host, as on the store listing. */
  operator: string
  /** An address people can write to (App Review 1.2 "published contact information"). */
  contact: string
  hostUrl: string
  ai?: AiProvider
  /** The extra moderation service replies are checked with, when one is configured. */
  filter?: string | null
  /** Where the computers run, e.g. "Fly.io". */
  hosting?: string
}
export const UPDATED = '2026-10-27'

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

function page(lang: Lang, title: string, body: string): string {
  return `<!doctype html><html lang="${HTML_LANG[lang]}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><title>${esc(title)}</title>
<style>
:root{color-scheme:light dark;--fg:#0F1115;--bg:#FFFFFF;--muted:#81858C;--card:#F5F6F7;--line:rgba(0,0,0,.08)}
@media (prefers-color-scheme:dark){:root{--fg:#F9FAFB;--bg:#151517;--muted:#979DA6;--card:#232324;--line:rgba(255,255,255,.12)}}
body{margin:0;background:var(--bg);color:var(--fg);font:17px/1.5 -apple-system,system-ui,"PingFang SC","PingFang TC","Hiragino Sans","Apple SD Gothic Neo","Noto Sans CJK SC","Segoe UI",Roboto,sans-serif}
main{max-width:680px;margin:0 auto;padding:48px 20px 64px}h1{font-size:34px;line-height:41px;margin:0 0 8px}h2{font-size:20px;margin:32px 0 8px}
p,li{margin:0 0 10px}.muted{color:var(--muted);font-size:15px}a{color:inherit}
form{background:var(--card);border-radius:20px;padding:16px;display:grid;gap:12px;margin-top:20px}
input{font:inherit;padding:12px;border-radius:12px;border:1px solid var(--line);background:var(--bg);color:var(--fg)}
button{font:inherit;font-weight:600;padding:14px;border-radius:999px;border:0;background:var(--fg);color:var(--bg)}
</style></head><body><main>${body}</main></body></html>`
}

const mail = (c: string) => (/^[^@\s]+@[^@\s]+$/.test(c) ? `<a href="mailto:${esc(c)}">${esc(c)}</a>` : esc(c))

/** Links to this page in the other languages, each named in its own. */
const languageLinks = (lang: Lang) => `<p class="muted">${LANGS.map((l) => (l === lang ? LANG_NAMES[l] : `<a href="?lang=${l}">${LANG_NAMES[l]}</a>`)).join(' · ')}</p>`
/** What keeps a link in this language; English is the default. */
const langQuery = (lang: Lang) => (lang === 'en' ? '' : `?lang=${lang}`)

function context(i: LegalInfo, lang: Lang): LegalCtx {
  const w = SERVER_WORDS[lang].legal, ai = i.ai
  return {
    operator: esc(i.operator), updated: UPDATED, hostUrl: esc(i.hostUrl), contact: mail(i.contact),
    company: esc(ai?.company ?? w.aiCompany), model: esc(ai?.model ?? w.aiModel),
    policy: ai?.policyUrl ? ` (<a href="${esc(ai.policyUrl)}">${w.itsPolicy}</a>)` : '',
    filter: i.filter ? esc(i.filter) : '', hosting: i.hosting ? esc(i.hosting) : w.hostingProvider, langQuery: langQuery(lang),
  }
}

export function privacyPage(i: LegalInfo, lang: Lang): string {
  const w = SERVER_WORDS[lang].legal
  return page(lang, `${w.privacyTitle} · Boop`, w.privacy(context(i, lang)) + languageLinks(lang))
}

export function termsPage(i: LegalInfo, lang: Lang): string {
  const w = SERVER_WORDS[lang].legal
  return page(lang, `${w.termsTitle} · Boop`, w.terms(context(i, lang)) + languageLinks(lang))
}

export type DeleteState = 'form' | 'wrong' | 'busy' | 'done'
/** The web way to delete an account (Google Play): the same email and access code sign-in asks for. */
export function deletePage(i: LegalInfo, lang: Lang, state: DeleteState, codeRequired: boolean): string {
  const w = SERVER_WORDS[lang].legal, q = langQuery(lang)
  if (state === 'done') return page(lang, w.deleteTitle, `<h1>${w.deleted}</h1><p>${w.deletedBody}</p>`)
  const note = state === 'wrong' ? `<p><b>${w.wrongCode}</b></p>` : state === 'busy' ? `<p><b>${w.tooMany}</b></p>` : ''
  return page(lang, w.deleteTitle, `<h1>${w.deleteTitle}</h1>
<p>${w.deleteBody}</p>
${note}<form method="post" action="/account/delete${q}"><input name="email" type="email" required autocomplete="email" placeholder="${w.emailPlaceholder}">${codeRequired ? `<input name="code" type="password" required placeholder="${w.codePlaceholder}">` : '<input name="code" type="hidden" value="">'}<button type="submit">${w.deleteButton}</button></form>
<p class="muted">${w.questions} ${mail(i.contact)} · <a href="/privacy${q}">${w.privacyTitle}</a></p>`)
}

/** What an /open/… link shows in a browser (the app not installed, or opened on a computer). */
export function openPage(i: LegalInfo, lang: Lang): string {
  const w = SERVER_WORDS[lang].legal
  return page(lang, 'Boop', `<h1>Boop</h1><p>${w.openBody}</p>
<p class="muted"><a href="${esc(i.hostUrl)}/">${w.openInBrowser}</a> · <a href="/privacy${langQuery(lang)}">${w.privacyTitle}</a></p>`)
}
