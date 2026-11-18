// The app: starts the bot through the supervisor, draws the QR once the bot prints its
// pairing link, and stops the bot on Quit. `locate` returns the directory of Boop.exe,
// with nsh\ and bot\ beside it (App.tsx: the app this process runs from).
//
// The window UI, the QR decoder and the supervisor are the Mac app's (mac/src), since
// NSH ships only files inside the app's own directory: the two apps share modules, and
// each keeps its own assets. The Mac app's sandbox is a mac-only decision; this app's
// nsh.json declares no capabilities, so it may run the bundled node.exe and read the
// clipboard (an app without capabilities may do everything, nsh.dev/docs/
// sandbox-and-capabilities, read 2026-11-18).
import { signal } from 'nsh'
import process from 'process'
import { exists, writeFile } from 'fs/promises'
import mark from '../assets/mark.png'
import { Window } from '../../mac/src/window.tsx'
import { parseMatrix } from '../../mac/src/qr.tsx'
import { createSupervisor, type BotState } from '../../mac/src/supervisor.ts'

const launchedAt = Date.now()

// NSH has no documented API for the app's own directory (nsh.dev docs v0.5.1, 2026-11-18),
// and process.run takes an executable name or an absolute path. PowerShell started by this
// process has Boop.exe as its parent, so its parent's path gives the directory of Boop.exe.
// LOCALAPPDATA comes from the same call: a child's environment is a fixed set of names
// (PATH, HOME, USERPROFILE, SystemRoot, TEMP, …), never the whole host environment, and
// LOCALAPPDATA is not in it (nsh .nsh/types/process.d.ts).
const FIND = '$p = (Get-CimInstance Win32_Process -Filter "ProcessId=$PID").ParentProcessId; (Get-CimInstance Win32_Process -Filter "ProcessId=$p").ExecutablePath; $env:LOCALAPPDATA'

// The bot's home: set by locate() from the same PowerShell call, and read by launch().
let home = ''

export async function bundleResources(): Promise<string> {
  const r = await process.run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', FIND], { timeoutMs: 20_000 })
  const lines = r.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  const exe = lines[0] ?? ''
  const localAppData = lines[1] ?? ''
  if (r.code !== 0 || !exe.includes('\\') || !localAppData) throw new Error('cannot find Boop.exe and LOCALAPPDATA')
  const dir = exe.slice(0, exe.lastIndexOf('\\'))
  if (!(await exists(`${dir}\\bot\\node.exe`))) throw new Error('the bundle has no bot\\node.exe')
  home = `${localAppData}\\DeepSeek Bot`
  return dir
}

export function App(props: { locate: () => Promise<string> }) {
  const state = signal<BotState>({ phase: 'starting', pairUrl: null, code: null, port: 3850, failures: 0, restarts: 0 })
  const matrix = signal<number[][] | null>(null)
  let dir = ''
  let shownUrl: string | null = null

  const showQr = async (url: string) => {
    const r = await process.run(`${dir}\\bot\\node.exe`, [`${dir}\\bot\\qr.mjs`, url], { timeoutMs: 15_000 })
    if (shownUrl !== url) return
    matrix.set(parseMatrix(r.stdout))
    // For docs/windows.md: how long from launch to the code on screen. Not shown in the window.
    const dd = process.dataDir
    if (dd) writeFile(`${dd}/last-start.json`, JSON.stringify({ launchedAt, qrAt: Date.now(), ms: Date.now() - launchedAt, port: state().port, restarts: state().restarts }) + '\n').catch(() => {})
  }

  const sup = createSupervisor({
    locate: async () => (dir = await props.locate()),
    // No shell and no run.sh on Windows: node.exe starts the bot directly. --supervised replaces
    // DEEPSEEK_BOT_SUPERVISED, which spawn cannot set (spawn has no env option), so a model change
    // still exits and the window starts the bot again.
    launch: (res, port) => ({ command: `${res}\\bot\\node.exe`, args: [`${res}\\bot\\src\\main.ts`, '--home', home, '--port', String(port), '--supervised'] }),
    spawn: (command, args) => process.spawn(command, args, { lines: true }),
    onChange: (s) => {
      state.set(s)
      if (s.pairUrl !== shownUrl) { shownUrl = s.pairUrl; matrix.set(null); if (s.pairUrl) showQr(s.pairUrl).catch(() => {}) }
    },
  })
  sup.start().catch(() => {})

  // The title and the 520 × 860 frame come from nsh.json's `window`.
  return <Window mark={mark} state={state} matrix={matrix} onQuit={() => { sup.stop(); process.exit(0) }} />
}
