// A tiny OpenAI-compatible chat-completions client for bot's own cheap
// background calls (memory reflection, ideas). The agent itself talks to the
// model through dsh; this client only ever sends one short prompt and reads
// one answer. Config comes from the bot's ModelConfig, so the background
// calls go to the same provider the person chose.
//
// Measured 2026-10-27 against the local Magpie gateway (group/auto-deepseek-flash):
// `response_format: {type:'json_object'}` is honoured and the content comes
// back as bare JSON. A gateway that rejects the field answers 400; we then
// retry once without it and parse whatever the model wrote.
import type { ModelConfig } from './home.ts'
import type { Guard } from './guard.ts'

export interface LlmOptions {
  /** `https://api.deepseek.com/v1` or a custom gateway; no trailing slash needed. */
  baseURL: string
  /** Env var holding the key. Missing or empty → no Authorization header (local gateways). */
  apiKeyEnv?: string
  model: string
  timeoutMs?: number
  fetch?: typeof fetch
  /** Server-side outbound guard: refuse a private base URL before the key is sent. */
  guard?: Guard
  /** Waits before each new try of a call that failed for a moment (default 1 s, then 3 s). */
  retryDelaysMs?: number[]
}

/** Whether a call failed in a way the next try may not: 408, 429, 5xx, or the connection dropped (not our own timeout). */
const transient = (e: unknown) => e instanceof LlmError ? e.status === 408 || e.status === 429 || e.status >= 500 : e instanceof TypeError
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms))

export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string }
export interface ChatOptions { json?: boolean; maxTokens?: number; temperature?: number }

const OFFICIAL = { baseURL: 'https://api.deepseek.com/v1', apiKeyEnv: 'DEEPSEEK_API_KEY' }

/** Where bot's own cheap calls go, derived from the agent's model config. */
export function llmOptionsFor(model: ModelConfig, cheapModel?: string): LlmOptions {
  const official = model.provider === 'deepseek-official'
  const baseURL = (official ? OFFICIAL.baseURL : (model.baseURL ?? OFFICIAL.baseURL)).replace(/\/+$/, '')
  const apiKeyEnv = official ? OFFICIAL.apiKeyEnv : (model.apiKeyEnv ?? 'DEEPSEEK_BOT_MODEL_KEY')
  return { baseURL, apiKeyEnv, model: cheapModel ?? model.model }
}

export class LlmClient {
  private readonly o: LlmOptions
  constructor(o: LlmOptions) { this.o = { ...o, baseURL: o.baseURL.replace(/\/+$/, '') } }

  /**
   * One completion; resolves with the assistant text. A call that failed for a moment is tried again after each wait,
   * as DeepSeek's dsh-superagent prototype retries a turn on 408, 429, 5xx or a dropped connection.
   */
  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<string> {
    const waits = this.o.retryDelaysMs ?? [1_000, 3_000]
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.once(messages, opts)
      } catch (e) {
        // JSON mode not supported by this gateway → plain call, caller parses.
        if (opts.json && (e as LlmError).status === 400) return this.once(messages, { ...opts, json: false })
        if (!transient(e) || attempt >= waits.length) throw e
        await pause(waits[attempt])
      }
    }
  }

  /** A completion in JSON mode, parsed. Tolerates a ```json fence around the answer; an answer that is not JSON is asked for once more. */
  async json<T = unknown>(messages: ChatMessage[], opts: ChatOptions = {}): Promise<T> {
    const text = await this.chat(messages, { ...opts, json: true })
    try { return JSON.parse(stripFence(text)) as T } catch {
      return JSON.parse(stripFence(await this.chat(messages, { ...opts, json: true }))) as T
    }
  }

  private async once(messages: ChatMessage[], opts: ChatOptions): Promise<string> {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    const key = this.o.apiKeyEnv ? process.env[this.o.apiKeyEnv] : undefined
    if (key) headers.authorization = `Bearer ${key}`
    const body: Record<string, unknown> = { model: this.o.model, messages, stream: false }
    if (opts.json) body.response_format = { type: 'json_object' }
    if (opts.maxTokens) body.max_tokens = opts.maxTokens
    if (opts.temperature !== undefined) body.temperature = opts.temperature
    const f = this.o.fetch ?? fetch
    const url = `${this.o.baseURL}/chat/completions`
    if (this.o.guard) await this.o.guard.checkURL(url)
    let res: Response
    try {
      res = await f(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(this.o.timeoutMs ?? 60_000), ...(this.o.guard ? { redirect: 'error' as const } : {}) })
    } catch (e) {
      const name = (e as Error).name
      if (name === 'TimeoutError' || name === 'AbortError') throw new LlmError(0, `model call timed out after ${this.o.timeoutMs ?? 60_000}ms`)
      throw e
    }
    if (!res.ok) throw new LlmError(res.status, `model answered ${res.status}: ${(await res.text()).slice(0, 300)}`)
    const data = await res.json() as { choices?: { message?: { content?: string | { text?: string }[] } }[] }
    const content = data.choices?.[0]?.message?.content
    if (typeof content === 'string') return content
    if (Array.isArray(content)) return content.map((c) => c.text ?? '').join('')
    throw new LlmError(res.status, 'model answer had no content')
  }
}

export class LlmError extends Error {
  readonly status: number
  constructor(status: number, message: string) { super(message); this.status = status }
}

function stripFence(s: string) {
  const t = s.trim()
  const m = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(t)
  return m ? m[1] : t
}
