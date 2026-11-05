// The bubblewrap cell around `dsh web`, and the runner that masks the
// harness's own home inside the agent's shell.
//
// The harness runs in a
// runtime cell whose root maps to an unprivileged host user, and the cell's
// root filesystem is separate from the host filesystem where more sensitive
// data lives, with the tools already in the image:
// bwrap + an unprivileged uid. The bot (root, outside the cell) keeps
// config.json, devices.json, connector-secrets.json and secrets.env; the cell
// sees only its DSH home, workspace, browser profile/output and a HOME.
import { chown, mkdir, rm, symlink } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

export interface CellPaths {
  dshHome: string
  workspace: string
  home: string
}

/** Where the bot stages bind-mount sources. Hidden inside the cell after the mounts. */
export const CELL_STAGE = '/run/dsb-cell'

const BINDS: { link: string; mount: string; key: keyof CellPaths }[] = [
  { link: 'dsh', mount: '/data/dsh', key: 'dshHome' },
  { link: 'workspace', mount: '/data/workspace', key: 'workspace' },
  { link: 'home', mount: '/data/home', key: 'home' },
]

/**
 * bwrap arguments that give `dsh web` its own /data: a tmpfs with only the
 * three folders above, mounted at their usual paths, and no view of the bot's
 * files under /data. The sources are symlinks under CELL_STAGE because bwrap
 * resolves them in the host namespace and the final `--tmpfs` hides the stage.
 */
export function cellMountArgs(_paths: CellPaths, stage = CELL_STAGE): string[] {
  const args = ['--ro-bind', '/', '/', '--tmpfs', '/data']
  for (const b of BINDS) args.push('--dir', b.mount)
  for (const b of BINDS) args.push('--bind', `${stage}/${b.link}`, b.mount)
  // The root of /data stays read-only; only the bound folders are writable.
  args.push('--remount-ro', '/data')
  args.push('--tmpfs', stage)
  args.push('--dev', '/dev', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--proc', '/proc', '--die-with-parent', '--tmpfs', '/tmp', '--chmod', '1777', '/tmp', '--chdir', '/data/workspace')
  return args
}

/**
 * The agent's shell is a nested bwrap (DSH asks for `--ro-bind / /` and a
 * writable workspace). Insert masks before the final `--` so the shell sees a
 * read-only root without the harness home, its credentials, the browser
 * profile or the bot's tools token in the profile patch. The workspace keeps
 * its writable bind; HOME becomes an empty writable tmpfs.
 */
export function agentRunnerArgs(profileArgs: string[]): string[] {
  const masks = [
    '--tmpfs', '/data/dsh', '--remount-ro', '/data/dsh',
    '--tmpfs', '/data/home',
  ]
  // A user namespace lets the shell raise its own oom_score_adj (CAP_SYS_RESOURCE
  // in that namespace) while still appearing as uid 1000. The bot keeps DSH at
  // -1000; the shell and everything it spawns is 500, so a memory bomb dies
  // before the harness does.
  const out: string[] = ['--unshare-user', '--uid', '1000', '--gid', '1000']
  let inserted = false
  for (const a of profileArgs) {
    if (!inserted && a === '--') { out.push(...masks); inserted = true; out.push(a); continue }
    out.push(a)
  }
  if (!inserted) out.push(...masks)
  // Wrap the command after `--`: raise the adj, then exec the original argv.
  const i = out.lastIndexOf('--')
  if (i >= 0) {
    const command = out.slice(i + 1)
    out.splice(i + 1, command.length, '/bin/sh', '-c', 'echo 500 > /proc/self/oom_score_adj 2>/dev/null || true; exec "$@"', 'sh', ...command)
  }
  return out
}

/** The agent shell's rlimits, applied by scripts/bwrap-agent.mjs before bwrap. */
export const agentLimits = [
  '--as=1610612736', // 1.5 GiB of address space; Node starts under this
  '--fsize=268435456', // 256 MiB per file
  '--nofile=2048',
  '--core=0',
]

/**
 * Environment the agent shell adds to DSH's. glibc gives threads their own malloc arenas, each a 64 MiB reservation;
 * sharp's threads took Node from 1.2 to 1.69 GB of address space on a Fly cell (2026-10-30), past the cap above, and
 * `chart` crashed. Two arenas kept it at 1.23 GB (test/image-tools.e2e.test.ts measures it).
 */
export const agentEnv: Record<string, string> = { MALLOC_ARENA_MAX: '2' }

/** `runnerCommand` for DSH's sandbox-local: a Node script that applies rlimits and masks, then execs bwrap. */
export function agentRunnerCommand(): string[] {
  return [process.execPath, '/opt/deepseek-bot/scripts/bwrap-agent.mjs']
}

/** Make the host folders writable by the unprivileged cell user and publish the staging symlinks. */
export async function prepareDshCell(paths: CellPaths, uid = 1000, gid = 1000): Promise<void> {
  if (process.platform !== 'linux') throw new Error('the DSH cell needs Linux bubblewrap')
  if (typeof process.getuid === 'function' && process.getuid() !== 0) throw new Error('the DSH cell must be prepared by root')
  for (const p of [paths.dshHome, paths.workspace, paths.home]) await mkdir(p, { recursive: true })
  // Upgrade path: files written by the pre-cell bot are root-owned. Make the
  // whole data the cell may touch belong to the cell user; the bot (root)
  // keeps reading it.
  await run('chown', ['-R', `${uid}:${gid}`, paths.dshHome, paths.workspace, paths.home])
  await rm(CELL_STAGE, { recursive: true, force: true })
  await mkdir(CELL_STAGE, { recursive: true, mode: 0o755 })
  for (const b of BINDS) await symlink(paths[b.key], `${CELL_STAGE}/${b.link}`)
  // chown/mkdir can create a stage owned by root; bwrap only needs to read it.
  await chown(CELL_STAGE, 0, 0)
}
