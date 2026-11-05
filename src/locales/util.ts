// Shared by the language tables in this folder.

/** Facts in one line: a fact's own full stop is dropped where the separator follows it; the last keeps its own. */
export const joinFacts = (facts: string[], sep: string) => { const t = facts.map((f) => f.trim()).filter(Boolean); return t.map((f, i) => (i < t.length - 1 ? f.replace(/[。．.；;]+$/, '') : f)).join(sep) }

/** The Russian form for a count: 1 дело, 2 дела, 5 дел; 11–14 take the last. */
export function pluralRu(n: number, one: string, few: string, many: string): string {
  const a = Math.abs(n) % 100, b = a % 10
  if (a >= 11 && a <= 14) return many
  if (b === 1) return one
  if (b >= 2 && b <= 4) return few
  return many
}

/** What a legal page's text needs filled in; every value is already escaped HTML. */
export interface LegalCtx {
  operator: string; updated: string; hostUrl: string; contact: string; company: string; model: string
  /** " (<a …>its privacy policy</a>)", or empty. */
  policy: string
  /** The moderation service's name, or empty. */
  filter: string
  hosting: string
  /** "?lang=…" for links to the other pages in this language; empty in English. */
  langQuery: string
}
