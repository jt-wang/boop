import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { computerName, computerInfo } from '../src/computer.ts'

// GET /me tells the phone what its Settings show about this computer.
const issueToken = async (d: { issue(n: string): Promise<unknown> }) => { const r = await d.issue('iPhone') as string | { token: string }; return typeof r === 'string' ? r : r.token }
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }

test('the name is the machine name without the .local of a Mac', () => {
  assert.equal(computerName('Studio-Mac.local'), 'Studio-Mac')
  assert.equal(computerName('Studio-Mac.LOCAL'), 'Studio-Mac')
  assert.equal(computerName('box'), 'box')
})

test('the version is what package.json says', () => {
  assert.deepEqual(computerInfo(), { name: computerName(hostname()), version: pkg.version })
})

test('the app version in the code is the one the build ships (mobile/nsh.json)', () => {
  const nsh = JSON.parse(readFileSync(new URL('../mobile/nsh.json', import.meta.url), 'utf8')) as { version: string }
  const code = readFileSync(new URL('../mobile/src/version.ts', import.meta.url), 'utf8')
  assert.equal(/APP_VERSION = '([^']+)'/.exec(code)?.[1], nsh.version)
})

test('GET /me carries them; a phone with no token gets nothing', async () => {
  const { createBotServer } = await import('../src/server.ts')
  const { MemoryDeviceStore } = await import('../src/devices.ts')
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'computer-'))
  const harness = { kind: 'fake', events: { on() {}, clientId: 'c' }, async createSession() { return { sessionId: 'p1' } }, async listSessions() { return [] }, async prompt() {}, async answer() {}, async cancel() { return true }, async rpc() { return {} as never }, async close() {}, async follow() { return () => {} } }
  const devices = new MemoryDeviceStore()
  const bot = await createBotServer({ dsh: { origin: 'http://127.0.0.1:9', cookie: 'c=1' }, devices, harness: harness as never, host: '127.0.0.1', port: 0, workspace: dir, settings: { get: async () => ({ assistantName: 'Nori', mainSessionId: 'main-1', language: 'en' }), set: async (p) => p as never } })
  try {
    assert.equal((await fetch(`${bot.origin}/me`)).status, 401)
    const token = await issueToken(devices)
    const me = await (await fetch(`${bot.origin}/me`, { headers: { authorization: `Bearer ${token}` } })).json() as { computer: unknown }
    assert.deepEqual(me.computer, computerInfo())
  } finally { await bot.close(); rmSync(dir, { recursive: true, force: true }) }
})
