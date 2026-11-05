// ~/.deepseek-bot/config.json — the few things a person configures.
import { readFile } from 'node:fs/promises'
import type { ModelConfig } from './home.ts'
import type { Settings } from './server.ts'
import { writeAtomic } from './atomic.ts'

export interface BotConfig {
  model: ModelConfig
  /** Model for cheap background checks; defaults to `model`. */
  cheapModel?: string
  settings: Settings
  /** `0.0.0.0` to reach the bot from the phone over Wi-Fi; `127.0.0.1` when a tunnel or proxy sits in front. */
  host: string
  port: number
  /** `cloudflared` starts a quick tunnel so the phone can reach the bot from anywhere over HTTPS. */
  tunnel: 'none' | 'cloudflared'
}

export const DEFAULT_CONFIG: BotConfig = {
  model: { provider: 'deepseek-official', model: 'deepseek-flash' },
  // [agent:proactive] morningBrief/briefHour/timeZone: the daily ideas push (off until the person turns it on; '' = this machine's zone)
  settings: { assistantName: '', mainSessionId: null, language: 'auto', morningBrief: false, briefHour: 8, timeZone: '', proactivity: 'low' },
  host: '0.0.0.0',
  port: 3850,
  tunnel: 'none',
}

export class ConfigFile {
  private readonly path: string
  private value: BotConfig
  private constructor(path: string, value: BotConfig) { this.path = path; this.value = value }

  static async open(path: string, overrides: Partial<BotConfig> = {}) {
    let stored: Partial<BotConfig> = {}
    try { stored = JSON.parse(await readFile(path, 'utf8')) } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
    const value: BotConfig = { ...DEFAULT_CONFIG, ...stored, ...overrides, settings: { ...DEFAULT_CONFIG.settings, ...(stored.settings ?? {}), ...(overrides.settings ?? {}) } }
    const c = new ConfigFile(path, value)
    await c.persist()
    return c
  }

  get(): BotConfig { return structuredClone(this.value) }

  /** The model row (never a key; keys live in secrets.env, see modelswitch.ts). */
  async setModel(m: ModelConfig) { this.value.model = m; await this.persist() }

  readonly settings = {
    get: async () => structuredClone(this.value.settings),
    set: async (patch: Partial<Settings>) => { this.value.settings = { ...this.value.settings, ...patch }; await this.persist(); return structuredClone(this.value.settings) },
  }

  private async persist() {
    await writeAtomic(this.path, () => JSON.stringify(this.value, null, 2) + '\n')
  }
}

// [agent:browser] `"browser": true` (default): the assistant gets its own headless
// Chrome (src/browser.ts). `false` switches it off on the next start.
export interface BotConfig { browser?: boolean }
DEFAULT_CONFIG.browser = true
