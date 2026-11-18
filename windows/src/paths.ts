// Pure, nsh-free pieces of the Windows launch, so Node tests can check paths that contain
// spaces and Japanese characters. NSH's `spawn` takes (command, args[]) and never a shell:
// each path is one argv entry and must NOT be quoted by hand (that would become part of the
// path). src/main.ts reads `--home` with argv.indexOf, so a spaced value stays one arg.
import type { Command } from '../../mac/src/supervisor.ts'

/** `bot\node.exe bot\src\main.ts --home <home> --port <port> --supervised`, all absolute. */
export function windowsLaunch(resources: string, home: string, port: number): Command {
  return {
    command: `${resources}\\bot\\node.exe`,
    args: [`${resources}\\bot\\src\\main.ts`, '--home', home, '--port', String(port), '--supervised'],
  }
}

/** `%USERPROFILE%\AppData\Local` is `%LOCALAPPDATA%`; NSH forwards USERPROFILE to children, not LOCALAPPDATA (windows/.nsh/types/process.d.ts:57). */
export function homeFromProfile(profile: string): string {
  const p = profile.trim().replace(/[\\/]+$/, '')
  return p ? `${p}\\AppData\\Local\\DeepSeek Bot` : ''
}
