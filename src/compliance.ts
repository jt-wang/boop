// What the app stores promise people, on the bot's side:
//   - Nothing reaches the AI provider before the person, having said they are 18 or older, agreed to send it
//     there (App Review 5.1.2(i), Google Play's prominent disclosure). The agreement names the provider; a
//     different provider asks again; withdrawing closes the gate (`gate()`).
//   - Reports on a reply or an interface are kept here and, on a hosted computer, sent to the people who run the
//     host (App Review 1.2, Google Play's AI-Generated Content policy). The host answers within 24 hours.
//   - Each interface has a link that opens it in the app (universal link / App Link on the host, the app's own
//     scheme for a self-paired computer).
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { ModelConfig } from './home.ts'
import type { Settings } from './server.ts'
import type { Moderator } from './moderation.ts'
import { writeAtomic } from './atomic.ts'

/** What an interface may ask for beyond its own screen; the person allows each one per interface. */
export const PERMISSIONS = ['openUrl', 'clipboard', 'picker'] as const
export type Permission = (typeof PERMISSIONS)[number]
export const isPermission = (p: unknown): p is Permission => typeof p === 'string' && (PERMISSIONS as readonly string[]).includes(p)

export const REPORT_REASONS = ['harmful', 'sexual', 'hate', 'violence', 'false', 'other'] as const
export type ReportReason = (typeof REPORT_REASONS)[number]

export interface Report {
  id: string
  at: string
  kind: 'reply' | 'interface'
  reason: ReportReason
  note?: string
  /** The reported words (a reply), capped. */
  excerpt?: string
  sessionId?: string
  rowId?: string
  moduleId?: string
  /** `sent`: kept here; `forwarded`: the host has it too. */
  status: 'sent' | 'forwarded'
}

export interface AiProvider { key: string; model: string; company: string; policyUrl: string | null }
export type Gate = null | 'ai-consent' | 'age'

const COMPANIES: [RegExp, string, string | null][] = [
  // links verified 2026-10-27
  [/(^|\.)siliconflow\.cn$/, 'SiliconFlow', 'https://docs.siliconflow.cn/docs/legals/privacy-policy'],
  [/(^|\.)siliconflow\.com$/, 'SiliconFlow', 'https://docs.siliconflow.com/en/legals/privacy-policy'],
  [/(^|\.)deepseek\.com$/, 'DeepSeek', 'https://cdn.deepseek.com/policies/en-US/deepseek-privacy-policy.html'],
  [/(^|\.)openrouter\.ai$/, 'OpenRouter', 'https://openrouter.ai/privacy'],
]

/** "deepseek-ai/DeepSeek-V4.1-Flash" → "DeepSeek V4.1 Flash"; the company from the address the bot sends to. */
export function aiProvider(m: ModelConfig): AiProvider {
  let host = m.provider === 'deepseek-official' ? 'api.deepseek.com' : ''
  if (m.baseURL) { try { host = new URL(m.baseURL).hostname } catch {} }
  if (!host) host = m.provider
  const last = m.model.split('/').pop() ?? m.model
  const model = last.split(/[-_ ]+/).filter(Boolean).map((w) => (/^deepseek$/i.test(w) ? 'DeepSeek' : w[0].toUpperCase() + w.slice(1))).join(' ')
  const hit = COMPANIES.find(([re]) => re.test(host))
  // an address on this computer or its network names no one: the provider the person configured does (QA 2026-10-28 #3)
  const local = /^(localhost|127\.\d+\.\d+\.\d+|::1|\[::1\]|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$/.test(host)
  return { key: `${host}|${m.model}`, model, company: hit ? hit[1] : local && m.provider ? m.provider : host, policyUrl: hit ? hit[2] : null }
}

/** The link that opens one interface in the app: on a hosted computer the host's /open/<sandbox>/ui/<id> (a universal link / App Link); else deepseekbot://ui/<id>?origin=… */
export function moduleLink(o: { id: string; publicUrl?: string; origin: string }): string {
  const m = o.publicUrl ? /^(https?:\/\/[^/]+)\/s\/([a-z0-9][a-z0-9-]{2,40})\/?$/.exec(o.publicUrl) : null
  if (m) return `${m[1]}/open/${m[2]}/ui/${o.id}`
  return `deepseekbot://ui/${o.id}?origin=${encodeURIComponent(o.origin)}`
}

export interface ComplianceOptions {
  settings: { get(): Promise<Settings>; set(p: Partial<Settings>): Promise<Settings> }
  model: ModelConfig | (() => ModelConfig)
  /** A hosted computer: where reports go (the host) and the shared secret it trusts. */
  relay?: { url: string; secret: string }
  /** DEEPSEEK_BOT_PUBLIC_URL: `<host>/s/<sandbox>` on a hosted computer. */
  publicUrl?: string
  /** Where a phone reaches this computer (LAN or tunnel) when it is not hosted. */
  origin: () => string
  fetchImpl?: typeof fetch
  /** The extra content filter (src/moderation.ts), when the operator turned one on. */
  moderator?: Moderator | null
}

export class Compliance {
  private rows: Report[] = []
  private readonly path: string
  private readonly o: ComplianceOptions
  private constructor(path: string, o: ComplianceOptions) { this.path = path; this.o = o }

  static async open(root: string, o: ComplianceOptions) {
    const c = new Compliance(join(root, 'reports.json'), o)
    try { c.rows = JSON.parse(await readFile(c.path, 'utf8')) } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
    return c
  }

  get moderator(): Moderator | null { return this.o.moderator ?? null }

  provider(): AiProvider { return aiProvider(typeof this.o.model === 'function' ? this.o.model() : this.o.model) }

  /** For GET /me: the provider in words, and whether the person agreed to it. */
  async state() {
    const st = await this.o.settings.get()
    const p = this.provider()
    const c = st.aiConsent && st.aiConsent.provider === p.key ? { at: st.aiConsent.at } : null
    return { ai: { model: p.model, company: p.company, policyUrl: p.policyUrl, filter: this.o.moderator?.name ?? null, consent: c }, age: st.age ?? null }
  }

  /** Why nothing may go to the model now, or null when it may. */
  async gate(): Promise<Gate> {
    const s = await this.state()
    if (s.age === 'minor') return 'age'
    if (!s.ai.consent || s.age !== 'adult') return 'ai-consent'
    return null
  }

  async setConsent(b: { ai?: unknown; age?: unknown }) {
    const patch: Partial<Settings> = {}
    if (b.age !== undefined) {
      if (b.age !== 'adult' && b.age !== 'minor') throw new Error('age must be adult or minor')
      patch.age = b.age
    }
    if (b.ai !== undefined) {
      if (typeof b.ai !== 'boolean') throw new Error('ai must be true or false')
      patch.aiConsent = b.ai ? { provider: this.provider().key, at: new Date().toISOString() } : null
    }
    await this.o.settings.set(patch)
    return this.state()
  }

  link(id: string) { return moduleLink({ id, publicUrl: this.o.publicUrl, origin: this.o.origin() }) }

  reports(): Report[] { return this.rows.map((r) => ({ ...r })).reverse() }

  /** Keep a report and, on a hosted computer, send it to the host with what was reported. */
  async report(b: Record<string, unknown>, extra: { moduleTitle?: string; moduleSource?: string } = {}): Promise<{ report: Report; forwarded: boolean }> {
    if (b.kind !== 'reply' && b.kind !== 'interface') throw new Error('kind must be reply or interface')
    if (!(REPORT_REASONS as readonly string[]).includes(String(b.reason))) throw new Error('unknown reason')
    const s = (v: unknown, n: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : undefined)
    const id = (v: unknown) => (typeof v === 'string' && /^[\w:-]{1,120}$/.test(v) ? v : undefined)
    if (b.kind === 'interface' && !id(b.moduleId)) throw new Error('moduleId is required')
    const report: Report = { id: `r${randomBytes(6).toString('hex')}`, at: new Date().toISOString(), kind: b.kind, reason: b.reason as ReportReason, note: s(b.note, 1000), excerpt: s(b.excerpt, 4000), sessionId: id(b.sessionId), rowId: id(b.rowId), moduleId: id(b.moduleId), status: 'sent' }
    for (const k of Object.keys(report) as (keyof Report)[]) if (report[k] === undefined) delete report[k]
    this.rows.push(report)
    let forwarded = false
    if (this.o.relay) {
      const sandbox = this.o.publicUrl ? /\/s\/([a-z0-9][a-z0-9-]{2,40})\/?$/.exec(this.o.publicUrl)?.[1] : undefined
      try {
        const r = await (this.o.fetchImpl ?? fetch)(`${this.o.relay.url.replace(/\/$/, '')}/host/reports`, {
          method: 'POST', headers: { authorization: `Bearer ${this.o.relay.secret}`, 'content-type': 'application/json' },
          body: JSON.stringify({ ...report, sandbox, moduleTitle: extra.moduleTitle, moduleSource: extra.moduleSource?.slice(0, 20_000) }), signal: AbortSignal.timeout(10_000),
        })
        forwarded = r.ok
      } catch (e) { console.error('[bot] report not forwarded:', (e as Error).message) }
      if (forwarded) report.status = 'forwarded'
    }
    await this.persist()
    return { report: { ...report }, forwarded }
  }

  private async persist() {
    await writeAtomic(this.path, () => JSON.stringify(this.rows, null, 2) + '\n')
  }
}

/** The bot's own background calls to the model (memory reflection, ideas) wait for the same consent as the person's messages. */
export function gateLlm<T extends { chat(...a: never[]): Promise<string> }>(llm: T, gate: () => Promise<Gate>): T {
  const chat = llm.chat.bind(llm) as (...a: unknown[]) => Promise<string>
  ;(llm as unknown as { chat: (...a: unknown[]) => Promise<string> }).chat = async (...a: unknown[]) => {
    const why = await gate()
    if (why) throw new Error(`not sent to the model: ${why}`)
    return chat(...a)
  }
  return llm
}
