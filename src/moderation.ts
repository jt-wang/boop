// Filtering objectionable material.
// Two layers:
//   1. The model provider's own review. SiliconFlow (api.siliconflow.cn, the hosted default) states it runs
//      "automated security reviews of your input prompts and output content to identify and intercept illegal and
//      non-compliant content" (its privacy policy, fetched 2026-10-27).
//   2. This step, when the operator turns it on: every finished reply and every interface the assistant builds is
//      checked with an OpenAI-compatible moderation endpoint (default OpenAI's omni-moderation-latest, "free to use"
//      per its guide, fetched 2026-10-27). A flagged reply is replaced in the thread by a notice (the person can
//      still report it); a flagged interface is not built. A check that fails lets the text through (layer 1 still
//      applies) and is logged.
// Env: DEEPSEEK_BOT_MODERATION_KEY (on), DEEPSEEK_BOT_MODERATION_URL, DEEPSEEK_BOT_MODERATION_MODEL, DEEPSEEK_BOT_MODERATION_NAME.

export interface Verdict { flagged: boolean; categories: string[] }
export interface Moderator { /** Who checks, as the consent screen and the privacy policy name it. */ name: string; check(text: string): Promise<Verdict> }

export function openAiModerator(o: { key: string; url?: string; model?: string; name?: string; fetchImpl?: typeof fetch; timeoutMs?: number }): Moderator {
  const url = o.url ?? 'https://api.openai.com/v1/moderations'
  return {
    name: o.name ?? 'OpenAI',
    async check(text: string): Promise<Verdict> {
      const r = await (o.fetchImpl ?? fetch)(url, { method: 'POST', headers: { authorization: `Bearer ${o.key}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: o.model ?? 'omni-moderation-latest', input: text.slice(0, 32_000) }), signal: AbortSignal.timeout(o.timeoutMs ?? 15_000) })
      if (!r.ok) throw new Error(`moderation answered ${r.status}`)
      const body = await r.json() as { results?: { flagged?: boolean; categories?: Record<string, boolean> }[] }
      const res = body.results ?? []
      return { flagged: res.some((x) => x.flagged === true), categories: [...new Set(res.flatMap((x) => Object.entries(x.categories ?? {}).filter(([, v]) => v).map(([k]) => k)))] }
    },
  }
}

export function moderatorFromEnv(env: NodeJS.ProcessEnv = process.env): Moderator | null {
  const key = env.DEEPSEEK_BOT_MODERATION_KEY
  if (!key) return null
  return openAiModerator({ key, url: env.DEEPSEEK_BOT_MODERATION_URL || undefined, model: env.DEEPSEEK_BOT_MODERATION_MODEL || undefined, name: env.DEEPSEEK_BOT_MODERATION_NAME || undefined })
}

type Row = { kind: string; id: string; text?: string; streaming?: boolean; filtered?: boolean }
type Frame = { type: string; sessionId?: string; rows?: Row[] }

/**
 * Checks the assistant's finished replies on their way to the phone. A reply goes out as it streams (as ChatGPT's
 * does); once it is complete it is checked, and a flagged one is sent again as `{ ...row, text: '', filtered: true }`.
 * Verdicts are kept per row and text, so a snapshot after a reconnect hides it at once.
 */
export class ReplyFilter {
  private readonly verdicts = new Map<string, { text: string; flagged: boolean }>()
  private readonly mod: Moderator
  constructor(mod: Moderator) { this.mod = mod }

  private hide(r: Row): Row { return { ...r, text: '', filtered: true } }

  /** `emit` gets the frame now (flagged rows already known hidden) and a `rows` frame later for any row the check flags. */
  pass(f: Frame, emit: (f: Frame) => void): void {
    if ((f.type !== 'snapshot' && f.type !== 'rows') || !f.rows) { emit(f); return }
    const check: Row[] = []
    const rows = f.rows.map((r) => {
      if (r.kind !== 'them' || r.streaming || !r.text?.trim()) return r
      const v = this.verdicts.get(r.id)
      if (v && v.text === r.text) return v.flagged ? this.hide(r) : r
      check.push(r)
      return r
    })
    emit({ ...f, rows })
    for (const r of check) {
      this.mod.check(r.text!).then((v) => {
        this.verdicts.set(r.id, { text: r.text!, flagged: v.flagged })
        if (v.flagged) { console.log(`[bot] a reply was hidden by the content filter (${v.categories.join(', ') || 'flagged'})`); emit({ type: 'rows', sessionId: f.sessionId, rows: [this.hide(r)] }) }
      }).catch((e) => console.error('[bot] content filter unavailable; the reply stays:', (e as Error).message))
    }
  }
}

/** The text of an interface a filter reads: its title and the string literals and JSX text of its source. */
export function interfaceText(title: string, source: string): string {
  const literals = source.match(/(["'`])(?:\\.|(?!\1)[^\\])*\1/g) ?? []
  const jsx = source.match(/>([^<>{}]+)</g)?.map((s) => s.slice(1, -1)) ?? []
  // literals that look like identifiers, paths or class names say nothing; JSX text is always read
  const words = [...literals.map((s) => s.slice(1, -1).trim()).filter((s) => s && !/^[\w./:-]*$/.test(s)), ...jsx.map((s) => s.trim()).filter(Boolean)]
  return [title.trim(), ...words].join('\n').slice(0, 32_000)
}
