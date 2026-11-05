// A hard ceiling for the agent's writable data. RLIMIT_FSIZE caps one file;
// many small files could still fill the /data volume and stop the bot. The
// workspace is therefore a fixed-size ext4 image on the volume, loop-mounted at
// /data/workspace. The bot's own files (config.json, dsh, the image itself) are
// outside it.
import { join } from 'node:path'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

export const DEFAULT_WORKSPACE_BYTES = 512 << 20
const MIN_BYTES = 16 << 20

export function workspaceSizeBytes(env: Record<string, string | undefined> = process.env): number {
  const raw = Number(env.DEEPSEEK_BOT_WORKSPACE_BYTES)
  if (Number.isFinite(raw) && raw >= MIN_BYTES) return Math.floor(raw)
  return DEFAULT_WORKSPACE_BYTES
}

export interface QuotaOptions {
  root: string
  workspace: string
  uid?: number
  gid?: number
  sizeBytes?: number
  platform?: NodeJS.Platform
  getuid?: () => number
  image?: string
  /** Only the image confines the agent this way; root on someone's own server keeps their files as they are. */
  inContainer?: boolean
}

export interface QuotaResult { mounted: boolean; image: string; sizeBytes: number }

async function exists(p: string): Promise<boolean> { try { await stat(p); return true } catch { return false } }

/**
 * The container needs the loop block devices to mount the workspace image.
 * Docker passes /dev/loop-control and the block-device cgroup rule; the nodes
 * themselves may be absent (the image's /dev is a tmpfs). mknod is in Docker's
 * default capability set; if it is missing the mount below fails closed.
 */
async function ensureLoopDevices(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    const p = `/dev/loop${i}`
    if (await exists(p)) continue
    try { await run('mknod', [p, 'b', '7', String(i)]) } catch (e) { if (i === 0) throw new Error(`workspace quota needs /dev/loop-control and a loop block device: ${(e as Error).message}`) }
  }
}

async function isMounted(path: string): Promise<boolean> {
  try {
    const info = await readFile('/proc/self/mountinfo', 'utf8')
    return info.split('\n').some((line) => line.split(' ')[4] === path)
  } catch { return false }
}

/** Create (once) and mount the workspace image. Safe to call on every bot start. */
export async function ensureWorkspaceQuota(o: QuotaOptions): Promise<QuotaResult> {
  const platform = o.platform ?? process.platform
  const uid = o.uid ?? 1000
  const gid = o.gid ?? 1000
  const sizeBytes = o.sizeBytes ?? workspaceSizeBytes()
  const image = o.image ?? join(o.root, 'workspace.img')
  const result = { mounted: false, image, sizeBytes }
  if (platform !== 'linux' || !o.inContainer || (o.getuid ?? process.getuid)() !== 0) return result
  if (await isMounted(o.workspace)) {
    await run('chown', ['-R', `${uid}:${gid}`, o.workspace])
    return { ...result, mounted: true }
  }
  await ensureLoopDevices()
  if (!(await exists(image))) {
    try { await run('fallocate', ['-l', String(sizeBytes), image]) } catch { await run('truncate', ['-s', String(sizeBytes), image]) }
    await run('mkfs.ext4', ['-q', '-F', '-m', '0', image])
    // First run: move whatever the bot and DSH already wrote into the image.
    const stage = await mkdtemp(join(o.root, '.workspace-stage-'))
    try {
      await run('mount', ['-o', 'loop,noatime,nosuid,nodev', image, stage])
      await run('cp', ['-a', `${o.workspace}/.`, stage])
    } finally {
      await run('umount', [stage]).catch(() => {})
      await rm(stage, { recursive: true, force: true })
    }
  }
  await run('mount', ['-o', 'loop,noatime,nosuid,nodev', image, o.workspace])
  await run('chown', ['-R', `${uid}:${gid}`, o.workspace])
  return { ...result, mounted: true }
}
