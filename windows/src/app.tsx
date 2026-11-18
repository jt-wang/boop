// The app: starts the bot through the supervisor, draws the QR once the bot prints its
// pairing link, and stops the bot on Quit. `locate` returns the directory of Boop.exe,
// with nsh\ and bot\ beside it (App.tsx: the app this process runs from).
//
// The window UI, the QR decoder and the supervisor are the Mac app's (mac/src), since
// NSH ships only files inside the app's own directory: the two apps share modules, and
// each keeps its own assets. This app's nsh.json declares no capabilities, so it may run
// the bundled node.exe and read the clipboard (an app without capabilities may do
// everything, nsh.dev/docs/sandbox-and-capabilities, read 2026-11-18).
import { signal } from 'nsh'
import process from 'process'
import { exists, writeFile } from 'fs/promises'
import mark from '../assets/mark.png'
import { Window } from '../../mac/src/window.tsx'
import { parseMatrix } from '../../mac/src/qr.tsx'
import { createSupervisor, errorText, type BotState } from '../../mac/src/supervisor.ts'
import { homeFromProfile, windowsLaunch } from './paths.ts'
import { initLog, log } from './log.ts'

const launchedAt = Date.now()

// NSH has no documented API for the app's own directory (nsh.dev docs v0.5.1, 2026-11-18),
// and process.run takes an executable name or an absolute path. PowerShell started by this
// process has Boop.exe as its parent, so its parent's path gives the directory of Boop.exe.
// The second line is USERPROFILE: a child's environment is a fixed set of names
// (PATH, HOME, USERPROFILE, SystemRoot, TEMP, …), never the whole host environment, and
// LOCALAPPDATA is not in it (nsh .nsh/types/process.d.ts:57).
const FIND = '$p = (Get-CimInstance Win32_Process -Filter "ProcessId=$PID").ParentProcessId; (Get-CimInstance Win32_Process -Filter "ProcessId=$p").ExecutablePath; $env:USERPROFILE'

// The bot's home: set by locate() before the PowerShell call, and read by launch().
let home = ''

export async function bundleResources(): Promise<string> {
  // Derive the home from USERPROFILE first, so the log exists even when locate fails.
  home = homeFromProfile(process.env.USERPROFILE ?? '')
  const logPath = await initLog(home)
  log(`start platform=${process.platform} arch=${process.arch} dataDir=${process.dataDir ?? '(null)'} log=${logPath || '(none)'}`)
  log(`env USERPROFILE=${process.env.USERPROFILE ?? '(empty)'} HOME=${process.env.HOME ?? '(empty)'} TEMP=${process.env.TEMP ?? '(empty)'} TMP=${process.env.TMP ?? '(empty)'} SystemRoot=${process.env.SystemRoot ?? '(empty)'}`)
  try {
    const r = await process.run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', FIND], { timeoutMs: 20_000 })
    log(`locate powershell code=${String(r.code)} stdout=${JSON.stringify(r.stdout)} stderr=${JSON.stringify(r.stderr)}`)
    const lines = r.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    const exe = lines[0] ?? ''
    const childProfile = lines[1] ?? ''
    if (r.code !== 0 || !exe.includes('\\')) throw new Error(`cannot find Boop.exe (code=${String(r.code)}, stdout=${JSON.stringify(r.stdout)})`)
    const dir = exe.slice(0, exe.lastIndexOf('\\'))
    if (!(await exists(`${dir}\\bot\\node.exe`))) throw new Error(`the bundle has no bot\\node.exe in ${dir}`)
    // Prefer the app's USERPROFILE; the child's is the fallback (both come from the host).
    if (!home) home = homeFromProfile(childProfile)
    log(`home=${home || '(empty)'}`)
    if (!home) throw new Error('USERPROFILE is empty: cannot derive the bot home')
    return dir
  } catch (e) {
    log(`locate failed: ${errorText(e)}`)
    throw e
  }
}

export function App(props: { locate: () => Promise<string> }) {
  const state = signal<BotState>({ phase: 'starting', pairUrl: null, code: null, port: 3850, failures: 0, restarts: 0 })
  const matrix = signal<number[][] | null>(null)
  let dir = ''
  let shownUrl: string | null = null

  const showQr = async (url: string) => {
    try {
      const r = await process.run(`${dir}\\bot\\node.exe`, [`${dir}\\bot\\qr.mjs`, url], { timeoutMs: 15_000 })
      log(`qr code=${String(r.code)}`)
      for (const line of r.stdout.split(/\r?\n/).filter(Boolean)) log(`qr stdout ${line}`)
      if (r.stderr) for (const line of r.stderr.split(/\r?\n/).filter(Boolean)) log(`qr stderr ${line}`)
      if (shownUrl !== url) return
      matrix.set(parseMatrix(r.stdout))
      // For docs/windows.md: how long from launch to the code on screen. Not shown in the window.
      const dd = process.dataDir
      if (dd) writeFile(`${dd}/last-start.json`, JSON.stringify({ launchedAt, qrAt: Date.now(), ms: Date.now() - launchedAt, port: state().port, restarts: state().restarts }) + '\n').catch(() => {})
    } catch (e) {
      log(`qr failed: ${errorText(e)}`)
    }
  }

  const sup = createSupervisor({
    locate: async () => (dir = await props.locate()),
    // No shell and no run.sh on Windows: node.exe starts the bot directly. --supervised replaces
    // DEEPSEEK_BOT_SUPERVISED, which spawn cannot set (spawn has no env option), so a model change
    // still exits and the window starts the bot again.
    launch: (res, port) => windowsLaunch(res, home, port),
    spawn: (command, args) => process.spawn(command, args, { lines: true }),
    log,
    onChange: (s) => {
      state.set(s)
      if (s.pairUrl !== shownUrl) { shownUrl = s.pairUrl; matrix.set(null); if (s.pairUrl) showQr(s.pairUrl).catch(() => {}) }
    },
  })
  sup.start().catch((e) => {
    const reason = errorText(e)
    log(`start rejected: ${reason}`)
    state.set({ ...state(), phase: 'failed', reason })
  })

  // The title and the 520 × 860 frame come from nsh.json's `window`.
  return <Window mark={mark} state={state} matrix={matrix} onQuit={() => { sup.stop(); process.exit(0) }} />
}
