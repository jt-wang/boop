import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, devices, type Browser } from 'playwright'

// "Download and it works": the hosted path end to end — a host (src/host-main.ts)
// with the real Docker provider and the slim image, driven through the app's
// browser build in a phone browser: Start → sign in → the computer comes up →
// name it → it speaks first → a real reply. Needs Docker, the slim image
// (`docker build -t deepseek-bot:slim .`) and the model gateway reachable from
// containers (host.docker.internal:3425). Skipped unless DEEPSEEK_BOT_E2E_MODEL=1.
// Measured 2026-10-27 (arm64, Docker 29): computer ready 2.3 s after sign-in,
// first words 8.7 s, whole flow 10.9 s.
const run = process.env.DEEPSEEK_BOT_E2E_MODEL === '1' && (() => { try { execFileSync('docker', ['image', 'inspect', 'deepseek-bot:slim'], { stdio: 'ignore' }); return true } catch { return false } })()
const shots = join(process.cwd(), 'test', 'screenshots')
const PORT = 3862
// the image under test; the default is whatever `docker build -t deepseek-bot:slim .` last built — rebuild it first
const IMAGE = process.env.DEEPSEEK_BOT_TEST_IMAGE ?? 'deepseek-bot:slim' // host.e2e.test.ts has 3861; node --test runs the files in parallel

async function startHost(): Promise<{ origin: string; stop(): Promise<void> }> {
  const home = mkdtempSync(join(tmpdir(), 'host-e2e-'))
  const child: ChildProcess = spawn(process.execPath, ['src/host-main.ts', '--home', home, '--port', String(PORT), '--provider', 'docker', '--image', IMAGE, '--public-url', `http://127.0.0.1:${PORT}`, '--dev-sign-in', '--port-range', '3880-3884', '--id-prefix', 'e2e-', '--idle-minutes', '30', '--model', 'magpie/group/auto-deepseek-flash', '--base-url', 'http://host.docker.internal:3425/v1', '--api-key-env', 'DEEPSEEK_BOT_MODEL_KEY'], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, DEEPSEEK_BOT_MODEL_KEY: 'local' } })
  let out = ''
  child.stdout!.on('data', (d) => { out += d }); child.stderr!.on('data', (d) => { out += d })
  for (let i = 0; i < 100 && !/\[host\] ready/.test(out); i++) await new Promise((r) => setTimeout(r, 200))
  assert.match(out, /\[host\] ready/, out)
  return {
    origin: `http://127.0.0.1:${PORT}`,
    stop: async () => {
      await new Promise<void>((r) => { child.once('exit', () => r()); child.kill('SIGTERM') })
      // the sandboxes this run made (ids start with e2e-)
      try { const ids = execFileSync('docker', ['ps', '-aq', '--filter', 'name=dsb-e2e-']).toString().split('\n').filter(Boolean); if (ids.length) execFileSync('docker', ['rm', '-f', ...ids], { stdio: 'ignore' }) } catch {}
      try { const vols = execFileSync('docker', ['volume', 'ls', '-q', '--filter', 'name=dsb-e2e-']).toString().split('\n').filter(Boolean); if (vols.length) execFileSync('docker', ['volume', 'rm', ...vols], { stdio: 'ignore' }) } catch {}
    },
  }
}

test('hosted: Start → sign in → its computer comes up → name → it speaks first → a real reply, in a phone browser', { skip: !run, timeout: 400_000 }, async () => {
  mkdirSync(shots, { recursive: true })
  const host = await startHost()
  let browser: Browser | null = null
  try {
    browser = await chromium.launch({ channel: 'chrome' })
    const ctx = await browser.newContext({ ...devices['iPhone 15 Pro'], locale: 'en-US' })
    const page = await ctx.newPage()
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(String(e)))
    const t = (id: string) => page.locator(`[data-testid=${id}]`)

    await page.goto(`${host.origin}/`)
    await t('start').waitFor({ state: 'attached', timeout: 60_000 })
    await page.screenshot({ path: join(shots, 'hosted-welcome.png') })
    await t('start').click({ force: true })
    await t('email').waitFor({ state: 'attached', timeout: 10_000 })
    await t('email').click({ force: true }); await page.keyboard.type('sam@example.com')
    await t('sign-in').click({ force: true })
    const t1 = Date.now()
    await t('name').waitFor({ state: 'attached', timeout: 180_000 })
    const readyMs = Date.now() - t1
    await t('name').click({ force: true }); await page.keyboard.type('Nori')
    await t('name-go').click({ force: true })
    await t('composer').waitFor({ state: 'attached', timeout: 30_000 })
    await page.getByText(/putting off/).waitFor({ timeout: 120_000 })   // the opening prompt (it asks only what you've been putting off), through the proxy's WebSocket
    const firstWordsMs = Date.now() - t1
    await page.screenshot({ path: join(shots, 'hosted-opening.png') })
    await t('composer').click({ force: true }); await page.keyboard.type('Reply with exactly the word PONG and nothing else.')
    await t('send').click({ force: true })
    await page.getByText(/^PONG$/).waitFor({ timeout: 120_000 })
    await page.screenshot({ path: join(shots, 'hosted-reply.png') })
    console.log(`hosted: computer ready ${(readyMs / 1000).toFixed(1)} s, first words ${(firstWordsMs / 1000).toFixed(1)} s after sign-in`)
    assert.ok(readyMs < 120_000)
    assert.deepEqual(errors, [], 'no page errors')
  } finally { await browser?.close(); await host.stop() }
})
