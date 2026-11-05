// Keeps the bot running under the Mac window: starts it from the app bundle,
// reads the pairing link off its stdout, starts it again when it dies, steps to
// the next port when the one it wants is taken. No NSH imports: the tests
// (mac/supervisor.test.ts) inject `spawn`, since headless `nsh test` has no
// `process` module (measured 2026-10-27: "process is available on desktop hosts").

export type Phase = 'starting' | 'running' | 'restarting' | 'failed' | 'stopped'

export interface BotState {
  phase: Phase
  /** What the QR holds while the bot runs: the pairing link it printed, or a TailPocket code. */
  pairUrl: string | null
  /** The six digits in that link; a TailPocket code carries its own inside the tunnel. */
  code: string | null
  /** The port the bot was asked to listen on. */
  port: number
  /** Starts in a row that died before printing a pairing link. */
  failures: number
  /** Starts after the first. */
  restarts: number
}

/** The part of NSH's `ChildProcess` the supervisor uses. */
export interface ChildLike {
  pid?: number
  on(event: 'stdout' | 'stderr', handler: (text: string) => void): ChildLike
  on(event: 'exit', handler: (result: { code?: number | null; signal?: string | null; error?: string | null }) => void): ChildLike
  kill(): void
}

export interface Deps {
  /** The bundle's `Contents/Resources`, or a rejection when the app's files are not where they should be. */
  locate(): Promise<string>
  /** `process.spawn` with `lines: true`. */
  spawn(command: string, args: string[]): ChildLike
  setTimeout?: (fn: () => void, ms: number) => unknown
  clearTimeout?: (handle: unknown) => void
  onChange(state: BotState): void
}

export const FIRST_PORT = 3850
/** Starts that died before pairing, in a row, before the window gives up. */
export const MAX_FAILURES = 5

/** The bot's line `  http://192.168.1.23:3850/pair?code=123456` (src/main.ts printPairing), or `  tailpocket1:…` (printPocketPairing). */
export function parsePairing(line: string): { url: string; code: string | null } | null {
  const invite = /^\s*(tailpocket1:[A-Za-z0-9_-]+)\s*$/.exec(line)
  if (invite) return { url: invite[1], code: null }
  const m = /(https?:\/\/\S+\/pair\?code=(\d{6}))/.exec(line)
  return m ? { url: m[1], code: m[2] } : null
}

/** `…/Boop.app/Contents/MacOS/<exe>` → `…/Boop.app/Contents/Resources`. */
export function resourcesDir(executable: string): string {
  const macos = executable.slice(0, executable.lastIndexOf('/'))
  const contents = macos.slice(0, macos.lastIndexOf('/'))
  return `${contents}/Resources`
}

/** 1 s, 2 s, 4 s … 30 s between tries. */
export function backoffMs(failures: number): number {
  return Math.min(1000 * 2 ** Math.max(0, failures - 1), 30_000)
}

export function createSupervisor(deps: Deps) {
  const setTimer = deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = deps.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))
  let state: BotState = { phase: 'starting', pairUrl: null, code: null, port: FIRST_PORT, failures: 0, restarts: 0 }
  let resources = ''
  let child: ChildLike | null = null
  let timer: unknown = null
  let stderrTail = ''

  const set = (patch: Partial<BotState>) => { state = { ...state, ...patch }; deps.onChange(state) }

  const spawnBot = () => {
    stderrTail = ''
    const c = deps.spawn('/bin/sh', [`${resources}/bot/run.sh`, 'bot', '--port', String(state.port)])
    child = c
    c.on('stdout', (line) => {
      if (child !== c) return
      const p = parsePairing(line)
      if (p) set({ phase: 'running', pairUrl: p.url, code: p.code, failures: 0 })
    })
    c.on('stderr', (line) => {
      if (child !== c) return
      stderrTail = (stderrTail + line + '\n').slice(-4000)
      // src/main.ts: the bot stays up, but no phone can reach it and no code will come.
      if (line.includes('TailPocket did not start')) set({ phase: 'failed', pairUrl: null, code: null })
    })
    c.on('exit', () => {
      if (child !== c || state.phase === 'stopped') return
      child = null
      const wasRunning = state.phase === 'running'
      if (/EADDRINUSE/.test(stderrTail)) { set({ phase: 'restarting', pairUrl: null, code: null, port: state.port + 1 }); return schedule(0) }
      const failures = wasRunning ? 0 : state.failures + 1
      if (failures >= MAX_FAILURES) return set({ phase: 'failed', pairUrl: null, code: null, failures })
      set({ phase: 'restarting', pairUrl: null, code: null, failures })
      schedule(wasRunning ? 1000 : backoffMs(failures))
    })
  }

  const schedule = (ms: number) => {
    timer = setTimer(() => { timer = null; if (state.phase === 'stopped') return; set({ phase: 'starting', restarts: state.restarts + 1 }); spawnBot() }, ms)
  }

  return {
    get state() { return state },
    async start() {
      deps.onChange(state)
      try { resources = await deps.locate() } catch { return set({ phase: 'failed' }) }
      spawnBot()
    },
    stop() {
      if (timer !== null) { clearTimer(timer); timer = null }
      set({ phase: 'stopped', pairUrl: null, code: null })
      const c = child; child = null
      c?.kill()
    },
  }
}
