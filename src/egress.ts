// The cell's only way out: a forward proxy on loopback that resolves every
// name and refuses loopback, private, link-local and metadata addresses. The
// kernel enforces that the cell's uid can reach nothing else: iptables owner
// match, so an environment variable is not the boundary.
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import { connect as netConnect } from 'node:net'
import { once } from 'node:events'
import { execFile } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { checkTarget, parseResolvers, type OutboundPolicy } from './net-policy.ts'

const run = promisify(execFile)

export interface EgressProxy { url: string; port: number; /** Let the cell reach one more loopback port. */ allowPort(port: number): void; close(): Promise<void> }

export interface EgressOptions {
  allowedLoopbackPorts?: Iterable<number>
  resolve?: (host: string) => Promise<string[]>
  /** The operator's outbound rules; the same object the bot-side guard uses. */
  policy?: OutboundPolicy
  /** Per-cell request bound; default 3000/min. Stops one sandbox becoming a flood. */
  maxRequestsPerMinute?: number
  port?: number
  host?: string
}

export async function startEgressProxy(o: EgressOptions = {}): Promise<EgressProxy> {
  const allowed = new Set(o.allowedLoopbackPorts ?? [])
  const limit = Math.max(1, Math.floor(o.maxRequestsPerMinute ?? 3000))
  let tokens = limit
  let last = Date.now()
  const take = () => {
    const now = Date.now()
    tokens = Math.min(limit, tokens + ((now - last) * limit) / 60_000)
    last = now
    if (tokens < 1) return false
    tokens -= 1
    return true
  }
  const server = createServer((req, res) => {
    if (!take()) return fail(res, 429, 'per-cell request rate exceeded')
    forward(req, res, allowed, o.resolve, o.policy).catch((e) => fail(res, 502, (e as Error).message))
  })
  server.on('connect', (req, socket, head) => {
    if (!take()) { socket.end('HTTP/1.1 429 Too Many Requests\r\n\r\n'); return }
    tunnel(req, socket, head, allowed, o.resolve, o.policy)
  })
  server.listen(o.port ?? 0, o.host ?? '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address() as { port: number }
  return {
    url: `http://${o.host ?? '127.0.0.1'}:${port}`,
    port,
    allowPort: (p: number) => { allowed.add(p) },
    close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()) }),
  }
}

async function forward(req: IncomingMessage, res: ServerResponse, allowed: Set<number>, resolve?: (h: string) => Promise<string[]>, policy?: OutboundPolicy) {
  const raw = req.url ?? ''
  if (!/^https?:\/\//i.test(raw)) return fail(res, 400, 'the egress proxy needs an absolute URL')
  const u = new URL(raw)
  if (u.protocol !== 'http:') return fail(res, 400, 'use CONNECT for https')
  const port = Number(u.port || 80)
  let t
  try { t = await checkTarget(u.hostname, port, { allowedLoopbackPorts: allowed, resolve, policy }) }
  catch (e) { return fail(res, 403, (e as Error).message) }
  const headers: Record<string, string> = {}
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string' && !/^(proxy-connection|connection)$/i.test(k)) headers[k] = v
  headers.host = u.host
  const up = httpRequest({ host: t.address, port, family: t.family, method: req.method, path: `${u.pathname}${u.search}`, headers }, (upRes) => {
    res.writeHead(upRes.statusCode ?? 502, upRes.headers)
    upRes.pipe(res)
  })
  up.on('error', (e) => fail(res, 502, e.message))
  req.pipe(up)
}

function tunnel(req: IncomingMessage, socket: import('node:stream').Duplex, head: Buffer, allowed: Set<number>, resolve?: (h: string) => Promise<string[]>, policy?: OutboundPolicy) {
  const authority = req.url ?? ''
  const m = /^\[([^\]]+)\]:(\d+)$/.exec(authority) ?? /^([^:]+):(\d+)$/.exec(authority)
  if (!m) { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); return }
  const port = Number(m[2])
  checkTarget(m[1], port, { allowedLoopbackPorts: allowed, resolve, policy }).then((t) => {
    const up = netConnect({ host: t.address, port, family: t.family }, () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) up.write(head)
      up.pipe(socket); socket.pipe(up)
    })
    up.on('error', () => socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'))
    socket.on('error', () => up.destroy())
  }).catch((e) => socket.end(`HTTP/1.1 403 Forbidden\r\n\r\n${(e as Error).message}`))
}

function fail(res: ServerResponse, status: number, message: string) {
  if (res.headersSent) return res.end()
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' })
  res.end(`blocked by egress policy: ${message}\n`)
}

/** iptables argument lists (after the binary name). Exported so the rule shape is testable without root. */
export function firewallRules(o: { uid: number; proxyPort: number; allowedLoopbackPorts: number[]; resolvers: string[]; extraUids?: number[] }): { v4: string[][]; v6: string[][] } {
  const ports = [...new Set([...o.allowedLoopbackPorts, o.proxyPort])].sort((a, b) => a - b)
  const v4res = o.resolvers.filter((r) => !r.includes(':'))
  const v6res = o.resolvers.filter((r) => r.includes(':'))
  const v4: string[][] = [
    ['-N', 'DSB-EGRESS'],
    ['-F', 'DSB-EGRESS'],
    // Replies from a server running as the cell uid (DSH's own web port) are
    // OUTPUT packets too; allow them once the connection exists.
    ['-A', 'DSB-EGRESS', '-m', 'conntrack', '--ctstate', 'ESTABLISHED,RELATED', '-j', 'ACCEPT'],
    ['-A', 'DSB-EGRESS', '-d', '127.0.0.1/32', '-p', 'tcp', '-m', 'multiport', '--dports', ports.join(','), '-j', 'ACCEPT'],
    ...v4res.flatMap((r) => [
      ['-A', 'DSB-EGRESS', '-d', `${r}/32`, '-p', 'udp', '--dport', '53', '-j', 'ACCEPT'],
      ['-A', 'DSB-EGRESS', '-d', `${r}/32`, '-p', 'tcp', '--dport', '53', '-j', 'ACCEPT'],
    ]),
    ['-A', 'DSB-EGRESS', '-j', 'REJECT', '--reject-with', 'icmp-port-unreachable'],
    ['-A', 'OUTPUT', '-m', 'owner', '--uid-owner', String(o.uid), '-j', 'DSB-EGRESS'],
  ]
  const v6: string[][] = [
    ['-N', 'DSB-EGRESS6'],
    ['-F', 'DSB-EGRESS6'],
    ['-A', 'DSB-EGRESS6', '-m', 'conntrack', '--ctstate', 'ESTABLISHED,RELATED', '-j', 'ACCEPT'],
    ['-A', 'DSB-EGRESS6', '-d', '::1/128', '-p', 'tcp', '-m', 'multiport', '--dports', ports.join(','), '-j', 'ACCEPT'],
    ...v6res.flatMap((r) => [
      ['-A', 'DSB-EGRESS6', '-d', `${r}/128`, '-p', 'udp', '--dport', '53', '-j', 'ACCEPT'],
      ['-A', 'DSB-EGRESS6', '-d', `${r}/128`, '-p', 'tcp', '--dport', '53', '-j', 'ACCEPT'],
    ]),
    ['-A', 'DSB-EGRESS6', '-j', 'REJECT', '--reject-with', 'icmp6-port-unreachable'],
    ['-A', 'OUTPUT', '-m', 'owner', '--uid-owner', String(o.uid), '-j', 'DSB-EGRESS6'],
  ]
  for (const uid of o.extraUids ?? []) {
    const c = `DSB-EXTRA-${uid}`, c6 = `DSB-EXTRA6-${uid}`
    v4.push(
      ['-N', c], ['-F', c],
      ['-A', c, '-m', 'conntrack', '--ctstate', 'ESTABLISHED,RELATED', '-j', 'ACCEPT'],
      ['-A', c, '-d', '127.0.0.1/32', '-p', 'tcp', '--dport', String(o.proxyPort), '-j', 'ACCEPT'],
      ['-A', c, '-j', 'REJECT', '--reject-with', 'icmp-port-unreachable'],
      ['-A', 'OUTPUT', '-m', 'owner', '--uid-owner', String(uid), '-j', c],
    )
    v6.push(
      ['-N', c6], ['-F', c6],
      ['-A', c6, '-m', 'conntrack', '--ctstate', 'ESTABLISHED,RELATED', '-j', 'ACCEPT'],
      ['-A', c6, '-d', '::1/128', '-p', 'tcp', '--dport', String(o.proxyPort), '-j', 'ACCEPT'],
      ['-A', c6, '-j', 'REJECT', '--reject-with', 'icmp6-port-unreachable'],
      ['-A', 'OUTPUT', '-m', 'owner', '--uid-owner', String(uid), '-j', c6],
    )
  }
  return { v4, v6 }
}

async function ipv6Enabled(): Promise<boolean> {
  try { return (await readFile('/proc/net/if_inet6', 'utf8')).trim().length > 0 } catch { return false }
}


/**
 * The same policy in nftables. Fly's kernel has no xt_owner (measured
 * 2026-10-27: "Extension owner revision 0 not supported"), but it does have
 * nftables' native `meta skuid` (measured the same day). iptables remains the
 * fallback where nftables is unavailable.
 */
export function nftRules(o: { uid: number; proxyPort: number; allowedLoopbackPorts: number[]; resolvers: string[]; ipv6?: boolean; extraUids?: number[] }): string {
  const ports = [...new Set([...o.allowedLoopbackPorts, o.proxyPort])].sort((a, b) => a - b).join(', ')
  const v4res = o.resolvers.filter((r) => !r.includes(':'))
  const v6res = o.resolvers.filter((r) => r.includes(':'))
  const lines = [
    'table ip dsb_egress {',
    '  chain out {',
    '    type filter hook output priority 0; policy accept;',
    `    meta skuid ${o.uid} ct state established,related accept`,
    `    meta skuid ${o.uid} ip daddr 127.0.0.1 tcp dport { ${ports} } accept`,
    ...v4res.flatMap((r) => [
      `    meta skuid ${o.uid} ip daddr ${r} udp dport 53 accept`,
      `    meta skuid ${o.uid} ip daddr ${r} tcp dport 53 accept`,
    ]),
    `    meta skuid ${o.uid} reject with icmp type port-unreachable`,
  ]
  for (const uid of o.extraUids ?? []) lines.push(
    `    meta skuid ${uid} ct state established,related accept`,
    `    meta skuid ${uid} ip daddr 127.0.0.1 tcp dport { ${o.proxyPort} } accept`,
    `    meta skuid ${uid} reject with icmp type port-unreachable`,
  )
  lines.push('  }', '}')
  if (o.ipv6) lines.push(
    'table ip6 dsb_egress6 {',
    '  chain out {',
    '    type filter hook output priority 0; policy accept;',
    `    meta skuid ${o.uid} ct state established,related accept`,
    `    meta skuid ${o.uid} ip6 daddr ::1 tcp dport { ${ports} } accept`,
    ...v6res.flatMap((r) => [
      `    meta skuid ${o.uid} ip6 daddr ${r} udp dport 53 accept`,
      `    meta skuid ${o.uid} ip6 daddr ${r} tcp dport 53 accept`,
    ]),
    `    meta skuid ${o.uid} reject with icmpv6 type port-unreachable`,
  )
  for (const uid of o.extraUids ?? []) lines.push(
    `    meta skuid ${uid} ct state established,related accept`,
    `    meta skuid ${uid} ip6 daddr ::1 tcp dport { ${o.proxyPort} } accept`,
    `    meta skuid ${uid} reject with icmpv6 type port-unreachable`,
  )
  lines.push('  }', '}')
  return lines.join('\n') + '\n'
}

async function installNft(o: { uid: number; proxyPort: number; allowedLoopbackPorts: number[]; resolvers: string[]; extraUids?: number[] }, ipv6: boolean): Promise<void> {
  await run('nft', ['delete', 'table', 'ip', 'dsb_egress']).catch(() => {})
  if (ipv6) await run('nft', ['delete', 'table', 'ip6', 'dsb_egress6']).catch(() => {})
  const file = '/run/dsb-egress.nft'
  await writeFile(file, nftRules({ ...o, ipv6 }), { mode: 0o600 })
  await run('nft', ['-f', file])
}

async function removeNft(ipv6: boolean): Promise<void> {
  await run('nft', ['delete', 'table', 'ip', 'dsb_egress']).catch(() => {})
  if (ipv6) await run('nft', ['delete', 'table', 'ip6', 'dsb_egress6']).catch(() => {})
}

/** Install the owner-match rules. nftables first (Fly), iptables as the fallback. Returns a function that removes them. */
export async function installEgressFirewall(o: { uid: number; proxyPort: number; allowedLoopbackPorts: number[]; resolvers?: string[]; extraUids?: number[] }): Promise<() => Promise<void>> {
  let resolvers = o.resolvers
  if (!resolvers) {
    try { resolvers = parseResolvers(await readFile('/etc/resolv.conf', 'utf8')) } catch { resolvers = [] }
  }
  const rules = firewallRules({ ...o, resolvers })
  const v6 = await ipv6Enabled()
  try {
    await installNft({ ...o, resolvers }, v6)
    return () => removeNft(v6)
  } catch (e) {
    // A partial nft table must not stay behind while the iptables path runs.
    await removeNft(v6)
    console.error(`[bot] nftables egress rules unavailable, falling back to iptables: ${(e as Error).message}`)
  }
  // A chain from an earlier run is flushed; adding it twice must still work.
  for (const [bin, list] of [['iptables', rules.v4], ['ip6tables', rules.v6]] as const) {
    if (bin === 'ip6tables' && !v6) continue
    for (const args of list) {
      // The jump may exist from an earlier bot process in this VM; -A would
      // duplicate it. -C is the standard idempotence check.
      if (args[0] === '-A' && args[1] === 'OUTPUT') {
        try { await run(bin, ['-C', ...args.slice(1)]); continue } catch {}
      }
      try { await run(bin, args) } catch (e) {
        const msg = (e as Error & { stderr?: string }).stderr ?? (e as Error).message
        // -N fails when the chain already exists; everything else is real.
        if (args[0] === '-N' && /exists/i.test(msg)) continue
        throw new Error(`${bin} ${args.join(' ')}: ${msg}`)
      }
    }
  }
  return async () => {
    for (const [bin, chain, jump] of [['iptables', 'DSB-EGRESS', 'DSB-EGRESS'], ['ip6tables', 'DSB-EGRESS6', 'DSB-EGRESS6']] as const) {
      try { await run(bin, ['-D', 'OUTPUT', '-m', 'owner', '--uid-owner', String(o.uid), '-j', jump]) } catch {}
      try { await run(bin, ['-F', chain]) } catch {}
      try { await run(bin, ['-X', chain]) } catch {}
      for (const uid of o.extraUids ?? []) {
        const c = bin === 'iptables' ? `DSB-EXTRA-${uid}` : `DSB-EXTRA6-${uid}`
        try { await run(bin, ['-D', 'OUTPUT', '-m', 'owner', '--uid-owner', String(uid), '-j', c]) } catch {}
        try { await run(bin, ['-F', c]) } catch {}
        try { await run(bin, ['-X', c]) } catch {}
      }
    }
  }
}
