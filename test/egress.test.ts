// The forward proxy and the kernel rules that force the cell's uid through it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { connect } from 'node:net'
import { once } from 'node:events'
import { startEgressProxy, firewallRules, nftRules } from '../src/egress.ts'

test('the proxy forwards a public/allowlisted request and refuses everything else', async () => {
  const upstream = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(`upstream:${req.url}`) })
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening')
  const upPort = (upstream.address() as { port: number }).port
  const proxy = await startEgressProxy({ allowedLoopbackPorts: [upPort], resolve: async (h) => h === 'public.example' ? ['127.0.0.1'] : ['93.184.216.34'] })
  try {
    const ok = await rawProxyRequest(proxy.port, `http://127.0.0.1:${upPort}/x`)
    assert.equal(ok.status, 200)
    assert.match(ok.body, /upstream:\/x/)
    const blocked = await rawProxyRequest(proxy.port, 'http://127.0.0.1:3850/approvals')
    assert.equal(blocked.status, 403)
    assert.match(blocked.body, /blocked/i)
    const privateHost = await rawProxyRequest(proxy.port, 'http://public.example/')
    assert.equal(privateHost.status, 403, 'a hostname resolving to 127.0.0.1 is refused')
  } finally { await proxy.close(); await new Promise<void>((r) => upstream.close(() => r())) }
})

test('CONNECT refuses a private destination and allows an allowlisted loopback port', async () => {
  const upstream = createServer((req, res) => res.end('ok'))
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening')
  const upPort = (upstream.address() as { port: number }).port
  const proxy = await startEgressProxy({ allowedLoopbackPorts: [upPort], resolve: async () => ['127.0.0.1'] })
  try {
    const yes = await connectThrough(proxy.port, `127.0.0.1:${upPort}`)
    assert.match(yes, /^HTTP\/1\.1 200/)
    const no = await connectThrough(proxy.port, '127.0.0.1:3850')
    assert.match(no, /^HTTP\/1\.1 403/)
    const dns = await connectThrough(proxy.port, 'public.example:443')
    assert.match(dns, /^HTTP\/1\.1 403/)
  } finally { await proxy.close(); await new Promise<void>((r) => upstream.close(() => r())) }
})

test('the kernel rules use an owner match on the cell uid, then allow only the proxy and the intended loopback ports', () => {
  const r = firewallRules({ uid: 1000, proxyPort: 4555, allowedLoopbackPorts: [4100, 4200], resolvers: ['127.0.0.11', 'fdaa::3'], extraUids: [1001] })
  const v4 = r.v4.map((a) => a.join(' ')).join('\n')
  const v6 = r.v6.map((a) => a.join(' ')).join('\n')
  assert.match(v4, /-m owner --uid-owner 1000 -j DSB-EGRESS/)
  assert.match(v4, /-m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT[\s\S]*-d 127\.0\.0\.1\/32 -p tcp -m multiport --dports 4100,4200,4555 -j ACCEPT/)
  assert.match(v4, /-d 127\.0\.0\.11\/32 -p udp --dport 53 -j ACCEPT/)
  assert.match(v4, /-j REJECT/)
  assert.match(v4, /-A OUTPUT -m owner --uid-owner 1001 -j DSB-EXTRA-1001/)
  assert.match(v4, /-A DSB-EXTRA-1001 -d 127\.0\.0\.1\/32 -p tcp --dport 4555 -j ACCEPT/)
  assert.match(v6, /-m owner --uid-owner 1000 -j DSB-EGRESS6/)
  assert.match(v6, /-m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT[\s\S]*-d fdaa::3\/128 -p udp --dport 53 -j ACCEPT/)
  assert.match(v6, /-j REJECT/)
  assert.match(v6, /-A OUTPUT -m owner --uid-owner 1001 -j DSB-EXTRA6-1001/)
})

function rawProxyRequest(port: number, absoluteUrl: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(absoluteUrl)
    const req = httpRequest({ host: '127.0.0.1', port, method: 'GET', path: absoluteUrl, headers: { host: u.host } }, (res) => {
      let body = ''
      res.on('data', (d) => { body += d })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    })
    req.on('error', reject)
    req.end()
  })
}

function connectThrough(port: number, authority: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = connect(port, '127.0.0.1')
    let buf = ''
    s.on('connect', () => {
      s.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`)
    })
    s.on('data', (d) => {
      buf += d
      if (buf.includes('\r\n\r\n')) { s.destroy(); resolve(buf) }
    })
    s.on('error', reject)
    s.setTimeout(5000, () => { s.destroy(); resolve(buf || 'timeout') })
  })
}

test('the nftables rules use meta skuid, allow only the proxy and intended ports, and reject the rest', () => {
  const t = nftRules({ uid: 1000, proxyPort: 4555, allowedLoopbackPorts: [4100, 4200], resolvers: ['127.0.0.11', 'fdaa::3'], ipv6: true, extraUids: [1001] })
  assert.match(t, /meta skuid 1000 ct state established,related accept/)
  assert.match(t, /meta skuid 1000 ip daddr 127\.0\.0\.1 tcp dport \{ 4100, 4200, 4555 \} accept/)
  assert.match(t, /meta skuid 1000 ip daddr 127\.0\.0\.11 udp dport 53 accept/)
  assert.match(t, /meta skuid 1000 reject with icmp type port-unreachable/)
  assert.match(t, /meta skuid 1000 ip6 daddr fdaa::3 udp dport 53 accept/)
  assert.match(t, /meta skuid 1000 reject with icmpv6 type port-unreachable/)
  assert.match(t, /meta skuid 1001 ip daddr 127\.0\.0\.1 tcp dport \{ 4555 \} accept/)
  assert.match(t, /meta skuid 1001 ip6 daddr ::1 tcp dport \{ 4555 \} accept/)
})

test('the proxy uses the same policy as the bot guard: allow, only, off; loopback ports stay closed', async () => {
  const upstream = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(`upstream:${req.url}`) })
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening')
  const upPort = (upstream.address() as { port: number }).port
  const allow = await startEgressProxy({
    allowedLoopbackPorts: [upPort],
    resolve: async (h) => (h === 'pinned.example' ? ['127.0.0.1'] : ['10.0.0.7']),
    policy: { mode: 'on', allow: ['pinned.example'], only: [], allowPrivate: false },
  })
  try {
    const ok = await rawProxyRequest(allow.port, `http://pinned.example:${upPort}/x`)
    assert.equal(ok.status, 200)
    assert.match(ok.body, /upstream:\/x/)
    const other = await rawProxyRequest(allow.port, `http://pinned.example:3850/approvals`)
    assert.equal(other.status, 403, 'a loopback port outside the list is still refused')
    const privateOther = await rawProxyRequest(allow.port, 'http://other.example/')
    assert.equal(privateOther.status, 403)
  } finally { await allow.close() }

  const only = await startEgressProxy({
    allowedLoopbackPorts: [upPort],
    resolve: async () => ['127.0.0.1'],
    policy: { mode: 'on', allow: ['pinned.example'], only: ['pinned.example'], allowPrivate: false },
  })
  try {
    assert.equal((await rawProxyRequest(only.port, `http://pinned.example:${upPort}/`)).status, 200)
    assert.equal((await rawProxyRequest(only.port, 'http://other.example/')).status, 403)
  } finally { await only.close() }

  const off = await startEgressProxy({
    allowedLoopbackPorts: [upPort],
    resolve: async () => ['127.0.0.1'],
    policy: { mode: 'off', allow: [], only: [], allowPrivate: false },
  })
  try {
    assert.equal((await rawProxyRequest(off.port, `http://private.example:${upPort}/`)).status, 200)
    assert.equal((await rawProxyRequest(off.port, 'http://private.example:3850/')).status, 403, 'off does not open a loopback port')
  } finally { await off.close(); await new Promise<void>((r) => upstream.close(() => r())) }
})

test('the proxy bounds one cell to a request rate', async () => {
  const upstream = createServer((_req, res) => res.writeHead(200).end('ok'))
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening')
  const upPort = (upstream.address() as { port: number }).port
  const proxy = await startEgressProxy({
    allowedLoopbackPorts: [upPort],
    resolve: async () => ['127.0.0.1'],
    policy: { mode: 'on', allow: [], only: [], allowPrivate: true },
    maxRequestsPerMinute: 1,
  })
  try {
    assert.equal((await rawProxyRequest(proxy.port, `http://rate.example:${upPort}/1`)).status, 200)
    assert.equal((await rawProxyRequest(proxy.port, `http://rate.example:${upPort}/2`)).status, 429)
  } finally { await proxy.close(); await new Promise<void>((r) => upstream.close(() => r())) }
})
