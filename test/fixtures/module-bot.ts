// The bot test/module.e2e.test.ts starts (src/main.ts with the local model gateway), here so that
// test/nsh-version.test.ts can check what it is started with without a model.
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NSH } from './nsh.ts'

/** A bot on its own home and a free port, as the model E2E runs it; `run` is `spawn` unless a test stops it there. */
export async function startBot(run: typeof spawn = spawn) {
  const home = mkdtempSync(join(tmpdir(), 'bot-module-'))
  const child: ChildProcess = run(process.execPath, ['src/main.ts', '--home', home, '--host', '127.0.0.1', '--port', '0', '--model', 'magpie/group/auto-deepseek-flash', '--base-url', 'http://127.0.0.1:3425/v1', '--api-key-env', 'DEEPSEEK_BOT_MODEL_KEY'], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, NSH_BIN: NSH, DEEPSEEK_BOT_MODEL_KEY: 'local' } })  // the CLI the tests found, not the bot's own default
  let out = ''
  const pairUrl = await new Promise<string>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`no pairing url:\n${out}`)), 90_000)
    child.stdout!.on('data', (d) => { out += d; const m = /(http:\/\/[^\s]+\/pair\?code=(\d{6}))/.exec(out); if (m) { clearTimeout(t); resolve(m[1]) } })
    child.stderr!.on('data', (d) => { out += d })
    child.on('exit', (c) => { clearTimeout(t); reject(new Error(`bot exited ${c}:\n${out}`)) })
  })
  for (let i = 0; i < 100 && !/listening to the assistant/.test(out); i++) await new Promise((r) => setTimeout(r, 200))
  assert.match(out, /ui modules on/, 'the bot found nsh and made its keys')
  const u = new URL(pairUrl); u.hostname = '127.0.0.1'
  return { home, origin: u.origin, code: u.searchParams.get('code')!, log: () => out, stop: () => new Promise<void>((r) => { child.once('exit', () => { rmSync(home, { recursive: true, force: true }); r() }); child.kill('SIGTERM') }) }
}
