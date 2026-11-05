import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startDshWeb } from '../src/dsh.ts'

// Real `dsh web` child (DSH 0.2.0-rc.2 from node_modules). Slow; skipped with DEEPSEEK_BOT_SKIP_E2E=1.
test('startDshWeb boots a real dsh web, exchanges the cookie, and the cookie is accepted by /api', { skip: process.env.DEEPSEEK_BOT_SKIP_E2E === '1', timeout: 90_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-home-'))
  const dsh = await startDshWeb({ dshHome: home })
  try {
    assert.match(dsh.origin, /^http:\/\/127\.0\.0\.1:\d+$/)
    assert.match(dsh.cookie, /^dsh-auth-[A-Za-z0-9_-]+=/)
    const body = JSON.stringify({ type: 'client-request', rpcId: 'e2e-1', method: 'session/list', payload: { args: { _request: {} } } })
    const without = await fetch(`${dsh.origin}/api/session/list`, { method: 'POST', headers: { 'content-type': 'application/json' }, body })
    assert.equal(without.status, 401)
    const withCookie = await fetch(`${dsh.origin}/api/session/list`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: dsh.cookie }, body })
    assert.equal(withCookie.status, 200)
    const json = await withCookie.json() as { result: { ok: boolean } }
    assert.equal(json.result.ok, true)
  } finally {
    await dsh.stop()
    assert.notEqual(dsh.child.exitCode, null)
  }
})
