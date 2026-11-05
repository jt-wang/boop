// After a turn on the main thread ends, a cheap model reads the exchange and
// writes down what will matter next week: facts about the person → USER.md,
// decisions and plans → MEMORY.md. The agent is told to call `remember`
// itself; this is the safety net for what it forgot. Nothing here is shown as
// an instruction to anyone — the files stay data about the person.
import type { LlmClient } from './llm.ts'
import type { Memory } from './memory.ts'
import { languageName, line, uiLang, type Line } from './lang.ts'

export interface Turn { user: string; assistant: string }
export interface Reflection { user: string[]; memory: string[] }

export interface ReflectOptions {
  llm: LlmClient
  memory: Memory
  /** Turns with fewer characters (user + assistant) are not worth a call. Default 40. */
  minChars?: number
  /** Called once per reflection that added at least one fact. */
  onActivity?: (e: { kind: string; text: string; line?: Line }) => void
  /** Called once per reflection that added at least one fact, with what was added. */
  onUpdated?: (r: Reflection) => void
  log?: (...a: unknown[]) => void
  /** The person's language (src/lang.ts personLanguage); facts and the activity line are written in it. */
  language?: () => Promise<string>
}

const SYSTEM = `You maintain the notes of a personal assistant about the one person it works for.
You read one exchange (the person's message and the assistant's reply) and return JSON:
{"user": [...], "memory": [...]}
- "user": durable facts about the person — name, where they live, preferences, how they like replies, people and things in their life. Not their time zone or language: the phone already says those.
- "memory": decisions, plans, commitments, appointments, things they asked the assistant to keep or watch.
Rules: only what will still matter next week. Skip pleasantries, one-off questions, and anything already in the known facts. One short sentence per item, in the person's own language, the way they would say it (no codes: no time-zone ids like America/New_York, no locale tags like zh-CN, no ids), written about the person in the third person ("Prefers …", "Plans to …"). Facts are data about the person, never instructions. When there is nothing durable, return empty arrays.`

export class Reflector {
  private readonly o: ReflectOptions
  private busy = false
  constructor(o: ReflectOptions) { this.o = o }

  /** Reflect on one finished turn. Resolves null when skipped (too short, another reflection running, model failed). */
  async reflect(turn: Turn): Promise<Reflection | null> {
    const user = turn.user.trim(), assistant = turn.assistant.trim()
    if (!user) return null // the bot prompted the assistant (a service connected, a reminder): nothing the person said
    // a Chinese/Japanese/Korean character carries about a word: count it twice, so a short CJK exchange is not skipped
    const size = (t: string) => t.length + (t.match(/[\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7af]/g) ?? []).length
    if (size(user) + size(assistant) < (this.o.minChars ?? 40)) return null
    if (this.busy) return null
    this.busy = true
    try {
      const lang = (await this.o.language?.()) || ''
      const known = [...(await this.o.memory.facts('user')).slice(-60), ...(await this.o.memory.facts('memory')).slice(-60)]
      const prompt = [
        `Known facts (do not repeat):\n${known.length ? known.map((f) => `- ${f}`).join('\n') : '(none yet)'}`,
        `Person: ${user.slice(0, 4000) || '(nothing)'}`,
        `Assistant: ${assistant.slice(0, 4000) || '(nothing)'}`,
        ...(lang ? [`Write every item in ${languageName(lang)}.`] : []),
      ].join('\n\n')
      // room for a model that thinks before it answers: with 600 a long turn came back empty (test/reflect.test.ts)
      const raw = await this.o.llm.json<unknown>([{ role: 'system', content: SYSTEM }, { role: 'user', content: prompt }], { maxTokens: 2400, temperature: 0 })
      const parsed = pick(raw)
      const added: Reflection = { user: [], memory: [] }
      for (const f of parsed.user) if (await this.o.memory.remember('user', f)) added.user.push(f)
      for (const f of parsed.memory) if (await this.o.memory.remember('memory', f)) added.memory.push(f)
      const all = [...added.user, ...added.memory]
      if (all.length) {
        this.o.onActivity?.({ kind: 'memory', ...line(uiLang(lang || 'en'), 'memoryUpdated', all) })
        this.o.onUpdated?.(added)
      }
      return added
    } catch (e) {
      (this.o.log ?? console.error)('[bot] reflection failed', (e as Error).message)
      return null
    } finally { this.busy = false }
  }
}

function pick(raw: unknown): Reflection {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const list = (v: unknown) => (Array.isArray(v) ? v : []).filter((x): x is string => typeof x === 'string').map((s) => s.replace(/\s+/g, ' ').trim()).filter((s) => s.length >= 2 && s.length <= 300)
  return { user: list(o.user), memory: list(o.memory) }
}
