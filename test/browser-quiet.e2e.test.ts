import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { browserPatchYaml, CHROME_QUIET_CONFIG } from '../src/browser.ts'

// The assistant's browser stays off the network unless a page asks. Measured on Chrome 156 (macOS, 2026-11-03): what each
// switch changes is in src/playwright-mcp.ts. The page is on this machine, so any connection that is not loopback is the browser's own.
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const SKIP = process.env.DEEPSEEK_BOT_SKIP_E2E === '1' || !existsSync(CHROME)

const quiet = JSON.parse(readFileSync(CHROME_QUIET_CONFIG, 'utf8')) as { browser: { launchOptions: { args: string[] } } }
const args = quiet.browser.launchOptions.args
const features = args.find((a) => a.startsWith('--disable-features='))!.slice('--disable-features='.length).split(',')

test('our --disable-features keeps every one of Playwright\'s: a later one replaces the earlier list (measured: more traffic, not less)', () => {
  const req = createRequire(createRequire(import.meta.url).resolve('@playwright/mcp/package.json'))
  const bundle = readFileSync(join(dirname(req.resolve('playwright-core/package.json')), 'lib', 'coreBundle.js'), 'utf8')
  const block = /disabledFeatures = \[([\s\S]*?)\n\s*\]/.exec(bundle)![1]!
  const theirs = [...block.matchAll(/^\s*"([A-Za-z]+)",?\s*$/gm)].map((m) => m[1]!)
  assert.ok(theirs.includes('OptimizationHints'), 'the bundle still has the list where this test looks')
  for (const f of theirs) assert.ok(features.includes(f), f)
  for (const f of ['SafeBrowsingHashPrefixRealTimeLookups', 'AutofillServerCommunication', 'PreconnectToSearch']) assert.ok(features.includes(f), f)
  assert.ok(args.includes('--no-pings'))
})

test('the laptop row passes the config', () => {
  const prev = process.env.DEEPSEEK_BOT_BROWSER_EXECUTABLE
  delete process.env.DEEPSEEK_BOT_BROWSER_EXECUTABLE
  try { assert.ok(rowArgs('/tmp/x').includes(CHROME_QUIET_CONFIG)) } finally { if (prev !== undefined) process.env.DEEPSEEK_BOT_BROWSER_EXECUTABLE = prev }
})

function rowArgs(root: string): string[] {
  const yaml = browserPatchYaml({ root, opts: { model: { provider: 'deepseek-official', model: 'm' } } } as never)
  return JSON.parse(/args: (\[.*\])/.exec(yaml)![1]!) as string[]
}

const remotesOf = (root: number) => {
  const ps = execFileSync('ps', ['-axo', 'pid=,ppid=']).toString().trim().split('\n').map((l) => l.trim().split(/\s+/).map(Number))
  const set = new Set([root]); let n: number
  do { n = set.size; for (const [p, pp] of ps) if (set.has(pp!)) set.add(p!) } while (n !== set.size)
  let o = ''
  try { o = execFileSync('lsof', ['-nP', '-a', '-i', '-p', [...set].join(',')], { stdio: ['ignore', 'pipe', 'ignore'] }).toString() } catch (e) { o = (e as { stdout?: Buffer }).stdout?.toString() ?? '' }
  return [...o.matchAll(/->(\S+)/g)].map((m) => m[1]!).filter((r) => !/^(127\.0\.0\.1|\[::1\])/.test(r))
}

/** Boop's own row with a throwaway profile; opens a page on this machine, then watches the whole process tree. */
async function measure(cliArgs: string[], seconds: number) {
  const page = createServer((_q, r) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end('<title>Local page</title><h1>hello from this machine</h1>') })
  await new Promise<void>((r) => page.listen(0, '127.0.0.1', r))
  const c = spawn(process.execPath, cliArgs, { stdio: ['pipe', 'pipe', 'ignore'] })
  let buf = '', id = 0
  const waiting = new Map<number, (m: { result?: { content?: { text?: string }[] } }) => void>()
  c.stdout.on('data', (d) => { buf += d; let i: number; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); try { const m = JSON.parse(l); waiting.get(m.id)?.(m) } catch {} } })
  const call = (method: string, params: unknown) => new Promise<{ result?: { content?: { text?: string }[] } }>((r) => { const n = ++id; waiting.set(n, r); c.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n') })
  try {
    await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } })
    c.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
    const nav = await call('tools/call', { name: 'browser_navigate', arguments: { url: `http://127.0.0.1:${(page.address() as { port: number }).port}/` } })
    const seen = new Set<string>()
    const end = Date.now() + seconds * 1000
    while (Date.now() < end) { for (const r of remotesOf(c.pid!)) seen.add(r); await new Promise((r) => setTimeout(r, 2000)) }
    return { remotes: [...seen], page: nav.result?.content?.[0]?.text ?? '' }
  } finally { c.kill(); page.close() }
}

const rootDir = () => { const r = mkdtempSync(join(tmpdir(), 'browser-quiet-')); return r }

test('the instrument: Chrome with Playwright\'s switches alone does connect out, so an empty list below means something', { skip: SKIP, timeout: 120_000 }, async () => {
  const a = rowArgs(rootDir())
  const i = a.indexOf('--config'); if (i >= 0) a.splice(i, 2)
  const m = await measure(a, 15)
  assert.match(m.page, /Local page/)
  assert.ok(m.remotes.length > 0, 'expected connections from a plain start')
})

test('as Boop starts it: the page opens, and in 75 seconds nothing in the process tree connects anywhere but this machine', { skip: SKIP, timeout: 180_000 }, async () => {
  const m = await measure(rowArgs(rootDir()), 75)
  assert.match(m.page, /Local page/)
  assert.deepEqual(m.remotes, [])
})

test('the broker in the image starts with the same config', () => {
  const src = readFileSync(new URL('../src/browser-broker.ts', import.meta.url), 'utf8')
  assert.match(/const inner = \[[\s\S]*?\]\n/.exec(src)![0], /'--config', CHROME_QUIET_CONFIG/)
})
