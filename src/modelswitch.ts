// Bring your own key, from the app. The key lives in `<home>/secrets.env`
// (mode 0600) and is loaded into the environment at start; config.json keeps
// only the provider row (never a key). dsh reads its provider at launch, so a
// change takes effect at the next start: under a supervisor (launchd, systemd,
// a container with a restart policy — DEEPSEEK_BOT_SUPERVISED=1) the bot exits
// and comes back; otherwise it answers `restartNeeded`.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ConfigFile } from './config.ts'
import type { ModelConfig } from './home.ts'
import { writeAtomic } from './atomic.ts'

export interface ModelChange { provider: string; model: string; baseURL?: string; apiKey?: string }

const KEY_RE = /^[A-Za-z0-9._:+/=-]{8,512}$/

export async function loadSecrets(home: string, env: Record<string, string | undefined> = process.env) {
  let text = ''
  try { text = await readFile(join(home, 'secrets.env'), 'utf8') } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; return }
  for (const line of text.split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
    if (m && !env[m[1]]) env[m[1]] = m[2]
  }
}

export class ModelSwitch {
  private readonly o: { home: string; config: ConfigFile; supervised: boolean; exit: (code: number) => void; exitDelayMs?: number; checkBaseURL?: (url: string) => Promise<void> }
  constructor(o: { home: string; config: ConfigFile; supervised: boolean; exit: (code: number) => void; exitDelayMs?: number; checkBaseURL?: (url: string) => Promise<void> }) { this.o = o }

  /** What the app may show: the row, and whether a key is on file — never the key. */
  describe() {
    const m = this.o.config.get().model
    return { provider: m.provider, model: m.model, baseURL: m.baseURL, hasKey: Boolean(process.env.DEEPSEEK_API_KEY || process.env.DEEPSEEK_BOT_MODEL_KEY || this.lastKeyWritten) }
  }
  private lastKeyWritten = false

  async set(c: ModelChange): Promise<{ restarting: true } | { restartNeeded: true }> {
    if (!c.provider || !c.model) throw new Error('provider and model are required')
    if (c.provider !== 'deepseek-official' && !/^https?:\/\//.test(c.baseURL ?? '')) throw new Error('a custom provider needs a baseURL')
    if (c.provider !== 'deepseek-official') await this.o.checkBaseURL?.(c.baseURL!)
    if (c.apiKey !== undefined && !KEY_RE.test(c.apiKey)) throw new Error('that does not look like an API key')
    const official = c.provider === 'deepseek-official'
    const row: ModelConfig = official ? { provider: 'deepseek-official', model: c.model } : { provider: c.provider, model: c.model, baseURL: c.baseURL, apiKeyEnv: 'DEEPSEEK_BOT_MODEL_KEY' }
    if (c.apiKey) {
      const name = official ? 'DEEPSEEK_API_KEY' : 'DEEPSEEK_BOT_MODEL_KEY'
      const path = join(this.o.home, 'secrets.env')
      const key = c.apiKey
      await writeAtomic(path, async () => {
        let lines: string[] = []
        try { lines = (await readFile(path, 'utf8')).split('\n').filter((l) => l.trim() && !l.startsWith(`${name}=`)) } catch {}
        lines.push(`${name}=${key}`)
        return lines.join('\n') + '\n'
      })
      this.lastKeyWritten = true
    }
    await this.o.config.setModel(row)
    if (!this.o.supervised) return { restartNeeded: true }
    setTimeout(() => this.o.exit(0), this.o.exitDelayMs ?? 400)
    return { restarting: true }
  }
}
