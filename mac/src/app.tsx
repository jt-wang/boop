// The app: starts the bot through the supervisor, draws the QR once the bot prints its
// pairing link, and stops the bot on Quit. `locate` returns the bundle's Resources
// directory (App.tsx: the bundle this process runs from; a local test: a built one).
import { signal } from 'nsh'
import { Window as DesktopWindow } from 'nsh/desktop'
import process from 'process'
import { writeFile } from 'fs/promises'
import { Window } from './window.tsx'
import { parseMatrix } from './qr.tsx'
import { createSupervisor, type BotState } from './supervisor.ts'

const launchedAt = Date.now()

// The app's files: this process is `<bundle>/Contents/MacOS/<exe>`, the parent of every shell it runs.
// `process.execute` takes names or absolute paths only (not ${dataDir}, measured 2026-10-27), so the one
// executable the app declares is /bin/sh, and the bundle's run.sh does the rest.
export async function bundleResources(): Promise<string> {
  const r = await process.run('/bin/sh', ['-c', 'exe=$(ps -o comm= -p $PPID); res=$(dirname "$(dirname "$exe")")/Resources; test -f "$res/bot/run.sh" && printf %s "$res"'], { timeoutMs: 10_000 })
  if (r.code !== 0 || !r.stdout) throw new Error('the bundle has no bot/run.sh')
  return r.stdout
}

export function App(props: { locate: () => Promise<string> }) {
  const state = signal<BotState>({ phase: 'starting', pairUrl: null, code: null, port: 3850, failures: 0, restarts: 0 })
  const matrix = signal<number[][] | null>(null)
  let resources = ''
  let shownUrl: string | null = null

  const showQr = async (url: string) => {
    const r = await process.run('/bin/sh', [`${resources}/bot/run.sh`, 'qr', url], { timeoutMs: 15_000 })
    if (shownUrl !== url) return
    matrix.set(parseMatrix(r.stdout))
    // For docs/mac.md: how long from launch to the code on screen. Not shown in the window.
    const dd = process.dataDir
    if (dd) writeFile(`${dd}/last-start.json`, JSON.stringify({ launchedAt, qrAt: Date.now(), ms: Date.now() - launchedAt, port: state().port, restarts: state().restarts }) + '\n').catch(() => {})
  }

  const sup = createSupervisor({
    locate: async () => (resources = await props.locate()),
    spawn: (command, args) => process.spawn(command, args, { lines: true }),
    onChange: (s) => {
      state.set(s)
      if (s.pairUrl !== shownUrl) { shownUrl = s.pairUrl; matrix.set(null); if (s.pairUrl) showQr(s.pairUrl).catch(() => {}) }
    },
  })
  sup.start().catch(() => {})

  DesktopWindow.setTitle('Boop')
  // The content is about 800 pt tall at 520 wide (measured 2026-10-27: at 760 the mark and Quit were cut off).
  DesktopWindow.setFrame({ size: { width: 520, height: 860 } })

  return <Window state={state} matrix={matrix} onQuit={() => { sup.stop(); process.exit(0) }} />
}
