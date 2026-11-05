// The address policy shared by the egress proxy: what the cell may reach and
// what it may not, after DNS resolution.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkTarget, isBlockedAddress, outboundPolicy, parseResolvers } from '../src/net-policy.ts'

test('loopback, RFC1918, link-local, metadata and Fly 6PN addresses are blocked', () => {
  for (const ip of ['127.0.0.1', '127.10.0.2', '10.1.2.3', '172.16.5.4', '172.31.255.254', '192.168.1.1', '169.254.169.254', '169.254.1.1', '0.0.0.0', '100.64.0.1', '::1', '::', 'fc00::1', 'fdaa::1', 'fdaa:2:3::4', 'fe80::1', 'ff02::1']) {
    assert.equal(isBlockedAddress(ip), true, `${ip} must be blocked`)
  }
  for (const ip of ['93.184.216.34', '1.1.1.1', '2606:4700:4700::1111']) assert.equal(isBlockedAddress(ip), false, `${ip} is public`)
})

test('mapped and NAT64 forms of a private IPv4 address are blocked too', () => {
  assert.equal(isBlockedAddress('::ffff:127.0.0.1'), true)
  assert.equal(isBlockedAddress('::ffff:10.0.0.1'), true)
  assert.equal(isBlockedAddress('64:ff9b::7f00:1'), true)
  assert.equal(isBlockedAddress('64:ff9b::808:808'), false)
})

test('a public hostname that resolves to a private address is refused', async () => {
  await assert.rejects(checkTarget('localtest.me', 80, { resolve: async () => ['127.0.0.1'] }), /private|loopback/i)
  await assert.rejects(checkTarget('internal.example', 443, { resolve: async () => ['fdaa::3', '1.1.1.1'] }), /private/i)
})

test('a public hostname resolving only to public addresses is allowed, and the address is pinned', async () => {
  const t = await checkTarget('example.com', 443, { resolve: async () => ['93.184.216.34'] })
  assert.equal(t.address, '93.184.216.34')
  assert.equal(t.family, 4)
})

test('loopback is allowed only on the ports the cell is meant to reach', async () => {
  const t = await checkTarget('127.0.0.1', 4100, { allowedLoopbackPorts: [4100] })
  assert.equal(t.address, '127.0.0.1')
  await assert.rejects(checkTarget('127.0.0.1', 3850, { allowedLoopbackPorts: [4100] }), /loopback/i)
  await assert.rejects(checkTarget('localhost', 80, { allowedLoopbackPorts: [4100] }), /loopback/i)
})

test('resolvers are read from resolv.conf, v4 and v6, without comments', () => {
  assert.deepEqual(parseResolvers('# x\nnameserver 127.0.0.11\nnameserver fdaa::3 # fly\nsearch flycast\n'), ['127.0.0.11', 'fdaa::3'])
})

test('one operator policy: allow, allowPrivate, only and off, shared with the cell proxy', async () => {
  const resolve = async () => ['10.0.0.7']
  await assert.rejects(checkTarget('private.example', 80, { resolve }), /private/)
  const allow = { resolve, policy: { mode: 'on' as const, allow: ['private.example'], only: [], allowPrivate: false } }
  assert.equal((await checkTarget('private.example', 80, allow)).address, '10.0.0.7')
  const allowPrivate = { resolve, policy: { mode: 'on' as const, allow: [], only: [], allowPrivate: true } }
  assert.equal((await checkTarget('other.example', 80, allowPrivate)).address, '10.0.0.7')
  const only = { resolve, policy: { mode: 'on' as const, allow: [], only: ['api.example'], allowPrivate: false } }
  await assert.rejects(checkTarget('other.example', 80, only), /allowlist/)
  const off = { resolve, policy: { mode: 'off' as const, allow: [], only: [], allowPrivate: false } }
  assert.equal((await checkTarget('private.example', 80, off)).address, '10.0.0.7')
})

test('an allow-listed host still cannot reach a loopback port outside the cell list', async () => {
  const policy = { mode: 'on' as const, allow: ['lan.example'], only: [], allowPrivate: false }
  await assert.rejects(checkTarget('lan.example', 3850, { policy, resolve: async () => ['127.0.0.1'] }), /loopback/)
  assert.equal((await checkTarget('lan.example', 4100, { policy, allowedLoopbackPorts: [4100], resolve: async () => ['127.0.0.1'] })).address, '127.0.0.1')
})

test('outboundPolicy parses the same switches the bot guard uses', () => {
  assert.deepEqual(outboundPolicy({ DEEPSEEK_BOT_GUARD: 'OFF', DEEPSEEK_BOT_GUARD_ALLOW: 'A.example, *.lan', DEEPSEEK_BOT_GUARD_ONLY: 'api.example', DEEPSEEK_BOT_GUARD_ALLOW_PRIVATE: '1' }), {
    mode: 'off', allow: ['a.example', '*.lan'], only: ['api.example'], allowPrivate: true,
  })
})
