// What the cell's forward proxy will connect to. Every outbound request:
// resolve the name first, then
// refuse loopback, private, link-local and metadata addresses. A hostname that
// resolves to one of them is refused even if another answer is public.
import { isIP } from 'node:net'
import { lookup } from 'node:dns/promises'

export interface Target { address: string; family: 4 | 6 }

export interface OutboundPolicy {
  mode: 'on' | 'off'
  /** Hosts the operator explicitly allows, even when they are private. Exact or `*.suffix`. */
  allow: string[]
  /** When non-empty, only these hosts are reachable (strict allowlist). */
  only: string[]
  /** Allow every private/loopback destination (a trusted LAN). */
  allowPrivate: boolean
}

export const STRICT_POLICY: OutboundPolicy = { mode: 'on', allow: [], only: [], allowPrivate: false }

/** The same switches for the bot guard and the cell proxy. */
export function outboundPolicy(env: NodeJS.ProcessEnv = process.env): OutboundPolicy {
  const list = (v: string | undefined) => (v ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
  return {
    mode: (env.DEEPSEEK_BOT_GUARD ?? '').toLowerCase() === 'off' ? 'off' : 'on',
    allow: list(env.DEEPSEEK_BOT_GUARD_ALLOW),
    only: list(env.DEEPSEEK_BOT_GUARD_ONLY),
    allowPrivate: env.DEEPSEEK_BOT_GUARD_ALLOW_PRIVATE === '1',
  }
}

export function matchesHost(list: string[], host: string): boolean {
  const h = host.toLowerCase()
  return list.some((entry) => entry === h || (entry.startsWith('*.') && h.endsWith(entry.slice(1))))
}

/** True for every address the cell must not reach directly. */
export function isBlockedAddress(ip: string): boolean {
  const clean = ip.toLowerCase().replace(/%.*$/, '')
  const v = isIP(clean)
  if (v === 4) return blockedV4(clean)
  if (v === 6) return blockedV6(clean)
  return true
}

function octets(ip: string): number[] { return ip.split('.').map(Number) }

function blockedV4(ip: string): boolean {
  const [a, b, c] = octets(ip)
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true
  if (a === 192 && b === 88 && c === 99) return true
  if (a === 198 && (b === 18 || b === 19)) return true
  if (a === 198 && b === 51 && c === 100) return true
  if (a === 203 && b === 0 && c === 113) return true
  if (a >= 224) return true
  return false
}

function hextets(ip: string): number[] | null {
  let s = ip.replace(/%.*$/, '')
  let tail: number[] = []
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(s)
  if (v4) {
    const [a, b, c, d] = octets(v4[1])
    tail = [(a << 8) | b, (c << 8) | d]
    s = s.slice(0, -v4[1].length)
    if (s.endsWith(':')) s = s.slice(0, -1)
    if (!s.includes(':')) s += ':'
  }
  const halves = s.split('::')
  if (halves.length > 2) return null
  const parse = (x: string) => x ? x.split(':').filter(Boolean).map((h) => parseInt(h, 16)) : []
  const left = parse(halves[0])
  const right = halves.length === 2 ? parse(halves[1]) : []
  const fill = 8 - left.length - right.length - tail.length
  if (fill < 0) return null
  return [...left, ...Array(halves.length === 2 ? fill : 0).fill(0), ...right, ...tail]
}

function blockedV6(ip: string): boolean {
  const h = hextets(ip)
  if (!h || h.length !== 8 || h.some((x) => !Number.isFinite(x))) return true
  if (h.every((x) => x === 0)) return true
  // ::1 and the rest of the reserved ::/96 block
  if (h.slice(0, 6).every((x) => x === 0)) return true
  // IPv4-mapped ::ffff:0:0/96
  if (h.slice(0, 5).every((x) => x === 0) && h[5] === 0xffff) return blockedV4(`${h[6] >> 8}.${h[6] & 255}.${h[7] >> 8}.${h[7] & 255}`)
  // NAT64 64:ff9b::/96
  if (h[0] === 0x64 && h[1] === 0xff9b && h.slice(2, 6).every((x) => x === 0)) return blockedV4(`${h[6] >> 8}.${h[6] & 255}.${h[7] >> 8}.${h[7] & 255}`)
  // 6to4 2002::/16 embeds the IPv4 address in hextets 1-2
  if (h[0] === 0x2002) {
    const v4 = `${h[1] >> 8}.${h[1] & 255}.${h[2] >> 8}.${h[2] & 255}`
    if (blockedV4(v4)) return true
  }
  if ((h[0] & 0xfe00) === 0xfc00) return true // fc00::/7, includes Fly fdaa::/16
  if ((h[0] & 0xffc0) === 0xfe80) return true // link-local
  if ((h[0] & 0xffc0) === 0xfec0) return true // deprecated site-local
  if ((h[0] & 0xff00) === 0xff00) return true // multicast
  if (h[0] === 0x2001 && h[1] === 0x0db8) return true // documentation
  return false
}

export interface CheckOptions {
  resolve?: (host: string) => Promise<string[]>
  allowedLoopbackPorts?: Iterable<number>
  /** The operator's rules; defaults to strict (private/loopback/metadata refused). */
  policy?: OutboundPolicy
}

const defaultResolve = async (host: string): Promise<string[]> =>
  (await lookup(host, { all: true, verbatim: true })).map((a) => a.address)

/** A loopback address in any of the forms a resolver or URL may hand us. */
function isLoopbackAddress(ip: string): boolean {
  const clean = ip.toLowerCase().replace(/%.*$/, '')
  if (isIP(clean) === 4) return octets(clean)[0] === 127
  if (clean === '::1') return true
  if (clean.startsWith('::ffff:')) {
    const tail = clean.slice(7)
    if (isIP(tail) === 4) return octets(tail)[0] === 127
    const m = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(tail)
    if (m) return (parseInt(m[1], 16) >> 8) === 127
  }
  const nat = /^64:ff9b::([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(clean)
  if (nat) return (parseInt(nat[1], 16) >> 8) === 127
  return false
}

/** Validate one proxy target. Returns the address to connect to (pinned, so DNS cannot change under us). */
export async function checkTarget(host: string, port: number, o: CheckOptions = {}): Promise<Target> {
  const policy = o.policy ?? STRICT_POLICY
  const clean = host.replace(/^\[|\]$/g, '').toLowerCase()
  const loop = new Set(o.allowedLoopbackPorts ?? [])
  const literal = isIP(clean)
  if (policy.mode === 'on' && policy.only.length && !matchesHost(policy.only, clean)) throw new Error(`${clean} is not in the outbound allowlist`)
  const allowed = policy.mode === 'off' || matchesHost(policy.allow, clean) || policy.allowPrivate
  const isLoop = clean === 'localhost' || clean.endsWith('.localhost') || (literal === 4 && octets(clean)[0] === 127) || clean === '::1'
  if (isLoop) {
    if (!loop.has(port)) throw new Error(`loopback ${clean}:${port} is not an allowed cell port`)
    const address = clean === 'localhost' ? '127.0.0.1' : clean
    return { address, family: isIP(address) === 6 ? 6 : 4 }
  }
  const addresses = literal ? [clean] : await (o.resolve ?? defaultResolve)(clean)
  if (!addresses.length) throw new Error(`no address for ${clean}`)
  // Even an allow-listed host may not use a loopback port outside the cell's list:
  // the proxy has no device token and must not become a path to the bot's API.
  if (addresses.some(isLoopbackAddress) && !loop.has(port)) throw new Error(`loopback ${clean}:${port} is not an allowed cell port`)
  if (!allowed) for (const a of addresses) if (isBlockedAddress(a)) throw new Error(`refusing private/loopback address for ${clean}: ${a}`)
  const address = addresses[0]
  return { address, family: isIP(address) === 6 ? 6 : 4 }
}

/** Nameservers from resolv.conf, so the cell can resolve names for tools that do not use the proxy. */
export function parseResolvers(text: string): string[] {
  const out: string[] = []
  for (const line of text.split('\n')) {
    const m = /^\s*nameserver\s+([0-9a-fA-F:.]+)\s*(?:#.*)?$/.exec(line)
    if (m) out.push(m[1])
  }
  return out
}
