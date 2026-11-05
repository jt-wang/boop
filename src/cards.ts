// Generative UI, first layer: cards. The assistant calls the `show` tool with
// one of these shapes; the app renders it with native controls; the person's
// tap goes back as a user message built by cardAnswerPrompt(). Shared by the
// tool (validation), the fold (rows) and the server (the answer route).
import { z } from 'zod'

const label = z.string().min(1).max(120)
// DeepSeek V4.1 Flash (Magpie) sent a card's lists and flags as JSON text: `columns: '["Way","Time"]'`, `pick: 'true'`
// (QA, iOS, 2026-10-30); every table was refused and none showed. Text that parses as JSON is taken as that JSON.
const json = <T extends z.ZodTypeAny>(schema: T) => z.preprocess((v) => { if (typeof v !== 'string') return v; try { return JSON.parse(v) } catch { return v } }, schema)
const Choices = z.object({ kind: z.literal('choices'), title: label, detail: z.string().max(400).optional(), options: json(z.array(z.object({ label, detail: z.string().max(200).optional() })).min(1).max(8)), multiple: json(z.boolean()).optional() })
const Field = z.object({ name: z.string().regex(/^[\w-]{1,40}$/), label, type: z.enum(['text', 'number', 'date', 'time', 'toggle', 'select']).default('text'), placeholder: z.string().max(80).optional(), value: z.string().max(400).optional(), options: json(z.array(label).max(12)).optional(), required: json(z.boolean()).optional() })
const Form = z.object({ kind: z.literal('form'), title: label, detail: z.string().max(400).optional(), fields: json(z.array(Field).min(1).max(10)), submit: z.string().max(30).optional() })
const Confirm = z.object({ kind: z.literal('confirm'), title: label, detail: z.string().max(600).optional(), yes: z.string().max(30).optional(), no: z.string().max(30).optional() })
const Table = z.object({ kind: z.literal('table'), title: label, columns: json(z.array(label).min(1).max(6)), rows: json(z.array(z.array(z.string().max(120))).min(1).max(30)), pick: json(z.boolean()).optional().describe('true: a comparison the person answers by tapping a row; the first cell of that row is their answer') })
const Progress = z.object({ kind: z.literal('progress'), title: label, items: json(z.array(z.object({ label, state: z.enum(['done', 'doing', 'todo']) })).min(1).max(20)) })
const Summary = z.object({ kind: z.literal('summary'), title: label, items: json(z.array(z.object({ label, value: z.string().max(200) })).min(1).max(20)), link: z.string().url().optional() })
// [agent:connectors] "Connect Notion": one button that starts the same sign-in the Connectors page does (mobile/src/connectors.tsx). `service` is a catalog id.
const Connect = z.object({ kind: z.literal('connect'), title: label, detail: z.string().max(400).optional(), service: z.string().regex(/^[a-z0-9-]{1,32}$/) })

export const CardSchema = z.discriminatedUnion('kind', [Choices, Form, Confirm, Table, Progress, Summary, Connect])
export type Card = z.infer<typeof CardSchema>
export type CardAnswer = Record<string, unknown>

/** Cards the person can act on; the others are display only. */
export const answerable = (c: Card) => c.kind === 'choices' || c.kind === 'form' || c.kind === 'confirm' || (c.kind === 'table' && c.pick === true)

/** The words the person would have typed. This is what the assistant reads and what the thread shows. */
export function answerText(card: Card, value: CardAnswer): string {
  switch (card.kind) {
    case 'choices':
      if (Array.isArray(value.choices)) return (value.choices as unknown[]).map(String).join(', ')
      return String(value.choice ?? '')
    case 'confirm': return value.ok ? (card.yes ?? 'Yes') : (card.no ?? 'No')
    case 'table': return card.pick ? String(value.choice ?? '') : ''
    case 'form':
      return card.fields.filter((f) => value[f.name] !== undefined && value[f.name] !== '' && value[f.name] !== null).map((f) => `${f.label}: ${f.type === 'toggle' ? (value[f.name] ? 'yes' : 'no') : String(value[f.name])}`).join('\n')
    default: return ''
  }
}

const INJECT = '⟦bot⟧ '
const ANSWER = /^⟦bot⟧ card ([\w-]+)\n([\s\S]*)$/

/** The user-role message that carries an answer: hidden marker line, then the person's words. */
export const cardAnswerPrompt = (cardId: string, text: string) => `${INJECT}card ${cardId}\n${text}`

export function parseCardAnswer(text: string): { cardId: string; text: string } | null {
  const m = ANSWER.exec(text)
  return m ? { cardId: m[1], text: m[2] } : null
}

// Second layer (src/ui.ts): a module the assistant wrote posted its result.
// Same shape as a card answer, keyed on the module id so the fold can mark the
// module row answered.
const MODULE_ANSWER = /^⟦bot⟧ module ([\w-]+)\n([\s\S]*)$/
export const moduleAnswerPrompt = (moduleId: string, text: string) => `${INJECT}module ${moduleId}\n${text}`
export function parseModuleAnswer(text: string): { moduleId: string; text: string } | null {
  const m = MODULE_ANSWER.exec(text)
  return m ? { moduleId: m[1], text: m[2] } : null
}
export { INJECT }
