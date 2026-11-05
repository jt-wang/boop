// install_browser inside the image (scripts/install-browser.sh, run by the bot:
// the agent's shell cannot install system packages). One install at a time:
// a call while one runs joins it. A call waits at most `waitMs`, so it answers
// before the harness gives up on the tool (BOT_TOOL_TIMEOUT_MS in src/home.ts;
// dsh-mcp-client's default is 60 s): on Fly an install took longer, the call
// timed out, the assistant called again and the second apt-get found the first
// one holding dpkg's lock. With 40 s calls the
// install came back "Still installing" twice and the assistant tried Chromium
// in its own shell in between (hosted re-check of 2026-10-29), so a call waits
// for the whole install. The script also takes a file lock, so even an install
// left over from before a restart is waited for, never raced.
//
// The bot mounts the browser while the call that found it installed is still
// open, and answers once its tools are there, so the turn that asked for the
// browser goes on to use it. It used to exit and come back with the browser, and
// that restart ended the turn: no reply.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

export interface BrowserInstallerOptions {
  exe: string
  script: string
  /** How long one call waits for the install before answering with where it is. */
  waitMs?: number
  /** A run that takes longer than this is stopped (its process group), and the next call starts again. */
  maxMs?: number
  /** Called once, when a call finds the install done: starts the browser and adds its tools to the profile. */
  mount: () => Promise<void>
}

type Run = { started: number; step: string; tail: string[]; done: Promise<{ ok: boolean }> }

const INSTALLED = 'Installed. The browser tools are ready.'

export function browserInstaller(o: BrowserInstallerOptions): () => Promise<string> {
  const waitMs = o.waitMs ?? 240_000
  let run: Run | null = null
  let finished: { ok: boolean; tail: string[] } | null = null
  let mounting: Promise<void> | null = null

  const installed = async () => {
    mounting ??= o.mount()
    try { await mounting } catch (e) {
      mounting = null
      console.error('[bot] browser mount failed', e)
      return `The browser is installed but did not start: ${(e as Error).message.slice(0, 300)}. Calling install_browser again tries once more.`
    }
    return INSTALLED
  }

  const start = (): Run => {
    const r: Run = { started: Date.now(), step: 'starting', tail: [], done: Promise.resolve({ ok: false }) }
    r.done = new Promise((resolve) => {
      const child = spawn('sh', [o.script], { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, DEEPSEEK_BOT_BROWSER_EXECUTABLE: o.exe } })
      const take = (chunk: Buffer) => {
        for (const raw of chunk.toString('utf8').split('\n')) {
          const line = raw.trim()
          if (!line) continue
          const step = /^step: (.+)$/.exec(line)
          if (step) r.step = step[1]
          else r.tail = [...r.tail, line].slice(-4)
        }
      }
      child.stdout.on('data', take)
      child.stderr.on('data', take)
      const cap = setTimeout(() => { r.tail.push(`stopped after ${Math.round((o.maxMs ?? 900_000) / 60_000)} minutes`); try { process.kill(-child.pid!, 'SIGTERM') } catch {} }, o.maxMs ?? 900_000)
      child.on('error', (e) => { r.tail.push(e.message) })
      child.on('close', (code) => { clearTimeout(cap); resolve({ ok: code === 0 }) })
    })
    r.done.then(({ ok }) => { finished = { ok, tail: r.tail }; run = null })
    return r
  }

  return async () => {
    if (!run && finished?.ok) return installed()
    if (!run && existsSync(o.exe)) return 'The browser is already installed.'
    if (!run) { finished = null; run = start() }
    const r = run
    const timer = new Promise<'waiting'>((resolve) => setTimeout(() => resolve('waiting'), waitMs).unref())
    const outcome = await Promise.race([r.done, timer])
    if (outcome === 'waiting') {
      const min = Math.max(1, Math.round((Date.now() - r.started) / 60_000))
      return `Still installing the browser (${r.step}; ${min} min so far). It keeps going on its own: call install_browser again in a minute to wait for it. Do not start another install or run apt yourself.`
    }
    if (outcome.ok) return installed()
    return `The browser install failed: ${r.tail.join(' ').slice(-400) || 'no output'}. Calling install_browser again tries once more.`
  }
}
