import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The public code names no Apple team. A signer's team lives in ios/Config/Signing.local.xcconfig (not committed), and a
// host's App ID for universal links comes from its flag or environment.
const ROOT = join(import.meta.dirname, '..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

test('the project takes its team from the shared config, which is empty and reads the optional local file', () => {
  const yml = read('ios/project.yml')
  assert.doesNotMatch(yml, /DEVELOPMENT_TEAM/)
  assert.match(yml, /configFiles:\n\s+Debug: Config\/Signing\.shared\.xcconfig\n\s+Release: Config\/Signing\.shared\.xcconfig/)
  const shared = read('ios/Config/Signing.shared.xcconfig')
  assert.match(shared, /^DEVELOPMENT_TEAM =\s*$/m)
  assert.match(shared, /^#include\? "Signing\.local\.xcconfig"$/m)
})

test('the generated project and the export options name no team', () => {
  const pbx = read('ios/DeepSeekBot.xcodeproj/project.pbxproj')
  // xcodegen writes an empty DevelopmentTeam into TargetAttributes when the team comes from a config file.
  assert.doesNotMatch(pbx, /DevelopmentTeam = (?!"";)/)
  assert.doesNotMatch(pbx, /DEVELOPMENT_TEAM\s*=/)
  assert.match(pbx, /baseConfigurationReference/)
  assert.doesNotMatch(read('ios/ExportOptions.plist'), /teamID/)
})

test('the local signing file is not committed', () => {
  assert.match(read('ios/.gitignore'), /^Config\/Signing\.local\.xcconfig$/m)
  assert.match(read('ios/Config/Signing.local.xcconfig.example'), /^DEVELOPMENT_TEAM = $/m)
})

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number }
      s.close(() => resolve(port))
    })
  })
}

// The real host process: universal links answer only when the host was told its App ID.
async function appleSiteAssociation(env: Record<string, string>): Promise<{ status: number; body: string }> {
  const port = await freePort()
  const home = mkdtempSync(join(tmpdir(), 'host-signing-'))
  const child = spawn(process.execPath, ['src/host-main.ts', '--host', '127.0.0.1', '--port', String(port), '--public-url', `http://127.0.0.1:${port}`,
    '--provider', 'docker', '--image', 'unused', '--dev-sign-in', '--port-range', '39990-39991', '--id-prefix', 'signing-test-', '--home', home], {
    cwd: ROOT,
    env: { ...process.env, DEEPSEEK_BOT_APPLE_APP_ID: undefined, DEEPSEEK_BOT_HOST_SECRET: 'signing-test-secret-0123456789abcdef', DEEPSEEK_API_KEY: 'sk-test-dummy', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  try {
    let out = ''
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`host did not print ready:\n${out}`)), 30_000)
      const look = (d: Buffer) => { out += d; if (out.includes('[host] ready')) { clearTimeout(t); resolve() } }
      child.stdout!.on('data', look)
      child.stderr!.on('data', look)
      child.once('exit', (c) => { clearTimeout(t); reject(new Error(`host exited ${c}:\n${out}`)) })
    })
    const r = await fetch(`http://127.0.0.1:${port}/.well-known/apple-app-site-association`)
    return { status: r.status, body: await r.text() }
  } finally {
    child.removeAllListeners('exit')
    child.kill('SIGKILL')
    rmSync(home, { recursive: true, force: true })
  }
}

test('a host with no App ID has no universal links; with one it serves exactly that', async () => {
  assert.equal((await appleSiteAssociation({})).status, 404)
  const set = await appleSiteAssociation({ DEEPSEEK_BOT_APPLE_APP_ID: 'ABCDE12345.com.example.app' })
  assert.equal(set.status, 200)
  assert.deepEqual(JSON.parse(set.body).applinks.details[0].appIDs, ['ABCDE12345.com.example.app'])
})
