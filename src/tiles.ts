// Map tiles for the interfaces the assistant writes (src/module-kit/map.tsx). A module may only fetch the bot it came
// from (src/ui.ts moduleCapabilities), so the bot fetches the tiles: GET /ui/:id/tiles/:z/:x/:y.png?token=<the module's>
// (src/server.ts). A module's canvas can send no header, hence the token in the address; without one, nobody who
// merely knows a sandbox id can pull tiles through the bot or fill its volume.
//
// OpenStreetMap's tile usage policy (operations.osmfoundation.org/policies/tiles, read 2026-11-02): a User-Agent that
// names the app and a way to reach it; tiles kept at least 7 days; only tiles someone is looking at, no bulk or
// offline download; "© OpenStreetMap contributors" shown on the map; heavy use may be blocked without notice. Many
// people on one tile server is heavy use: a hosted Boop with many people needs a tile provider with a key
// (DEEPSEEK_BOT_TILES_URL takes its template).
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export type Tile = { z: number; x: number; y: number }
const KEEP_MS = 7 * 86400_000
const MAX_ZOOM = 19
const CONTACT = process.env.DEEPSEEK_BOT_CONTACT_URL ?? 'https://github.com/jt-wang/boop'
export const TILE_USER_AGENT = `Boop/0.1 (+${CONTACT})`
const UPSTREAM = process.env.DEEPSEEK_BOT_TILES_URL ?? 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'

/** `/tiles/z/x/y.png` → the tile, or null when it is not one at that zoom. */
export function tilePath(path: string): Tile | null {
  const m = /^\/tiles\/(\d{1,2})\/(\d{1,7})\/(\d{1,7})\.png$/.exec(path)
  if (!m) return null
  const [z, x, y] = [Number(m[1]), Number(m[2]), Number(m[3])]
  if (z > MAX_ZOOM || x >= 2 ** z || y >= 2 ** z) return null
  return { z, x, y }
}

export class Tiles {
  private inflight = new Map<string, Promise<Buffer | null>>()
  private dir: string
  private fetcher: typeof fetch
  constructor(dir: string, fetcher: typeof fetch = fetch) { this.dir = dir; this.fetcher = fetcher }

  /** The tile's PNG: the kept copy while it is under 7 days old, else from upstream (kept). Null when upstream fails. */
  get(t: Tile): Promise<Buffer | null> {
    const key = `${t.z}/${t.x}/${t.y}`
    const running = this.inflight.get(key)
    if (running) return running
    const p = this.load(t).finally(() => this.inflight.delete(key))
    this.inflight.set(key, p)
    return p
  }

  /** Removes tiles past the 7 days (a sandbox's volume is 1 GB); they come back when someone looks at them. Returns how many. */
  async prune(): Promise<number> {
    const entries = await readdir(this.dir, { recursive: true, withFileTypes: true }).catch(() => [])
    let removed = 0
    for (const e of entries) {
      if (!e.isFile()) continue
      const file = join(e.parentPath, e.name)
      const s = await stat(file).catch(() => null)
      if (s && Date.now() - s.mtimeMs >= KEEP_MS) { await rm(file, { force: true }); removed++ }
    }
    return removed
  }

  private async load(t: Tile): Promise<Buffer | null> {
    const file = join(this.dir, String(t.z), String(t.x), `${t.y}.png`)
    const s = await stat(file).catch(() => null)
    if (s && Date.now() - s.mtimeMs < KEEP_MS) return readFile(file)
    const url = UPSTREAM.replace('{z}', String(t.z)).replace('{x}', String(t.x)).replace('{y}', String(t.y))
    const r = await this.fetcher(url, { headers: { 'user-agent': TILE_USER_AGENT } }).catch(() => null)
    if (!r?.ok) return s ? readFile(file) : null // an old copy beats no map
    const body = Buffer.from(await r.arrayBuffer())
    await mkdir(dirname(file), { recursive: true })
    await writeFile(`${file}.tmp`, body)
    await rename(`${file}.tmp`, file)
    return body
  }
}
