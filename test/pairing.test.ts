import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Pairing } from '../src/pairing.ts'
import { MemoryDeviceStore } from '../src/devices.ts'

test('a pairing code issues one device token and is spent', async () => {
  const devices = new MemoryDeviceStore()
  const p = new Pairing(devices, { ttlMs: 60_000, now: () => 1000 })
  const code = p.create()
  assert.match(code, /^\d{6}$/)
  const token = await p.claim(code, 'iPhone')
  assert.ok(token && token.length > 20)
  assert.equal((await devices.lookup(token!))?.name, 'iPhone')
  assert.equal(await p.claim(code, 'again'), null)
})

test('an expired or unknown code is refused', async () => {
  let t = 1000
  const p = new Pairing(new MemoryDeviceStore(), { ttlMs: 100, now: () => t })
  const code = p.create()
  t = 1200
  assert.equal(await p.claim(code, 'late'), null)
  assert.equal(await p.claim('000000', 'nope'), null)
})

test('wrong guesses are rate limited', async () => {
  const p = new Pairing(new MemoryDeviceStore(), { ttlMs: 60_000, now: () => 1, maxAttempts: 3 })
  const code = p.create()
  for (let i = 0; i < 3; i++) await p.claim('111111', 'x')
  assert.equal(await p.claim(code, 'x'), null, 'locked after too many wrong guesses')
})
