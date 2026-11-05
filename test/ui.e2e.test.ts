import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, devices, type Browser } from 'playwright'

// Whole stack in a phone browser: bot (src/main.ts) → real dsh → real model via
// the local Magpie gateway, driven through the app's browser build (app/, the
// same NSH app the iOS shell runs; scripts/build-web.sh) from the pairing link.
// Skipped unless DEEPSEEK_BOT_E2E_MODEL=1. Screenshots land in test/screenshots/.
// Measured 2026-10-27: NSH's web build renders testIDs as data-testid; its
// controls are DIVs, so clicks go through `force` and text through the keyboard.
const run = process.env.DEEPSEEK_BOT_E2E_MODEL === '1'
const shots = join(process.cwd(), 'test', 'screenshots')

async function startBot(): Promise<{ child: ChildProcess; pairUrl: string; origin: string; stop(): Promise<void> }> {
  const home = mkdtempSync(join(tmpdir(), 'bot-ui-'))
  const child = spawn(process.execPath, ['src/main.ts', '--home', home, '--host', '127.0.0.1', '--port', '0', '--model', 'magpie/group/auto-deepseek-flash', '--base-url', 'http://127.0.0.1:3425/v1', '--api-key-env', 'DEEPSEEK_BOT_MODEL_KEY'], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, DEEPSEEK_BOT_MODEL_KEY: 'local' } })
  let out = ''
  const pairUrl = await new Promise<string>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`bot printed no pairing url:\n${out}`)), 90_000)
    child.stdout!.on('data', (d) => { out += d; const m = /(http:\/\/[^\s]+\/pair\?code=\d{6})/.exec(out); if (m) { clearTimeout(t); resolve(m[1]) } })
    child.stderr!.on('data', (d) => { out += d })
    child.on('exit', (c) => { clearTimeout(t); reject(new Error(`bot exited ${c}:\n${out}`)) })
  })
  const u = new URL(pairUrl); u.hostname = '127.0.0.1'
  return { child, pairUrl: u.toString(), origin: u.origin, stop: () => new Promise((r) => { child.once('exit', () => r()); child.kill('SIGTERM') }) }
}

test('phone browser: pairing link → name the assistant → it speaks first → a real reply; the session survives a reload', { skip: !run, timeout: 300_000 }, async () => {
  mkdirSync(shots, { recursive: true })
  const bot = await startBot()
  let browser: Browser | null = null
  try {
    browser = await chromium.launch({ channel: 'chrome' })
    const ctx = await browser.newContext({ ...devices['iPhone 15 Pro'], locale: 'en-US' })
    const page = await ctx.newPage()
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(String(e)))
    const t = (id: string) => page.locator(`[data-testid=${id}]`)

    const wasm = await page.request.get(`${bot.origin}/`)
    assert.equal(wasm.status(), 200)
    await page.goto(bot.pairUrl)
    await t('connect').waitFor({ state: 'attached', timeout: 60_000 })   // the pairing link pre-fills the connect screen (web/host.js)
    await page.screenshot({ path: join(shots, 'web-connect.png') })
    await t('connect').click({ force: true })
    await t('name').waitFor({ state: 'attached', timeout: 20_000 })
    await t('name').click({ force: true }); await page.keyboard.type('Nori')
    await t('name-go').click({ force: true })
    await t('composer').waitFor({ state: 'attached', timeout: 20_000 })
    await page.getByText(/putting off/).waitFor({ timeout: 120_000 })   // it speaks first; the opening asks only what you've been putting off
    await page.screenshot({ path: join(shots, 'web-opening.png') })

    await t('composer').click({ force: true }); await page.keyboard.type('Reply with exactly the word PONG and nothing else.')
    await t('send').click({ force: true })
    await page.getByText(/^PONG$/).waitFor({ timeout: 120_000 })
    await page.screenshot({ path: join(shots, 'web-reply.png') })

    await page.reload()
    await t('composer').waitFor({ state: 'attached', timeout: 30_000 })   // the session is in the browser's storage
    assert.deepEqual(errors, [], 'no page errors')
  } finally { await browser?.close(); await bot.stop() }
})
