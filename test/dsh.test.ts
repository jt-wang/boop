import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { parseLaunchUrl, exchangeToken, dshBin } from '../src/dsh.ts'
import { mkdtemp, mkdir, realpath, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('parseLaunchUrl reads the token link dsh web prints', () => {
  const r = parseLaunchUrl('dsh web: http://127.0.0.1:55765/?token=abc_DEF-123\n')
  assert.deepEqual(r, { origin: 'http://127.0.0.1:55765', token: 'abc_DEF-123' })
})

test('parseLaunchUrl returns null for unrelated lines', () => {
  assert.equal(parseLaunchUrl('[info] booting profile web'), null)
})

test('exchangeToken turns the launch token into the dsh-auth cookie', async () => {
  // Measured 2026-10-26 against DSH 0.2.0-rc.2: GET /?token=… answers 303 and
  // Set-Cookie: dsh-auth-<id>=<value>; Path=/; HttpOnly; SameSite=Lax
  const seen: string[] = []
  const srv = createServer((req, res) => {
    seen.push(req.url ?? '')
    res.writeHead(303, { location: './', 'set-cookie': 'dsh-auth-u-xyz=secret; Path=/; HttpOnly; SameSite=Lax' })
    res.end()
  })
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
  const port = (srv.address() as { port: number }).port
  try {
    const cookie = await exchangeToken({ origin: `http://127.0.0.1:${port}`, token: 't0k' })
    assert.equal(cookie, 'dsh-auth-u-xyz=secret')
    assert.deepEqual(seen, ['/?token=t0k'])
  } finally {
    srv.close()
  }
})

test('exchangeToken fails loudly when dsh sets no cookie', async () => {
  const srv = createServer((_req, res) => { res.writeHead(401); res.end() })
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
  const port = (srv.address() as { port: number }).port
  try {
    await assert.rejects(exchangeToken({ origin: `http://127.0.0.1:${port}`, token: 'bad' }), /401/)
  } finally {
    srv.close()
  }
})

test('dshBin finds dsh next to a package.json whose path has a space (the Mac bundle, "DeepSeek Bot.app")', async () => {
  // Seen 2026-10-27 in the packaged Mac app: `new URL(bin, 'file://' + path).pathname` kept the space
  // as %20 and node said: Cannot find module …/DeepSeek%20Bot.app/…/dsh/lib/bin.js
  const root = await mkdtemp(join(tmpdir(), 'with space-'))
  const pkgDir = join(root, 'node_modules', '@deepseek-ai', 'dsh')
  await mkdir(join(pkgDir, 'lib'), { recursive: true })
  await writeFile(join(pkgDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', bin: { dsh: 'lib/bin.js' } }))
  await writeFile(join(pkgDir, 'lib', 'bin.js'), '')
  const bin = dshBin(join(root, 'anchor.js'))
  assert.equal(bin, join(await realpath(pkgDir), 'lib', 'bin.js')) // require.resolve resolves the tmpdir symlink (/var → /private/var)
  assert.ok(existsSync(bin))
})

// web_search is @deepseek-ai/dsh-web-search-deepseek: it reads DEEPSEEK_API_KEY and DEEPSEEK_SEARCH_BASE_URL and
// appends /messages. In the hosted cell those were missing, so the search tool said "no API key" while chat worked.
test('web_search gets the surrogate model key and the model proxy, never the real key', async () => {
  const { dshModelEnv } = await import('../src/dsh.ts')
  const custom = dshModelEnv({ official: false, modelKeyEnv: 'DEEPSEEK_BOT_MODEL_KEY', proxyUrl: 'http://127.0.0.1:4100', upstreamPath: '/v1', surrogate: 'surrogate-abc' })
  assert.deepEqual(custom, {
    DEEPSEEK_BOT_MODEL_KEY: 'surrogate-abc',
    DEEPSEEK_API_KEY: 'surrogate-abc',
    DEEPSEEK_SEARCH_BASE_URL: 'http://127.0.0.1:4100/v1',
  })
  const official = dshModelEnv({ official: true, modelKeyEnv: 'DEEPSEEK_API_KEY', proxyUrl: 'http://127.0.0.1:4100', upstreamPath: '', surrogate: 'surrogate-abc' })
  assert.deepEqual(official, {
    DEEPSEEK_API_KEY: 'surrogate-abc',
    DEEPSEEK_BASE_URL: 'http://127.0.0.1:4100/anthropic',
    DEEPSEEK_SEARCH_BASE_URL: 'http://127.0.0.1:4100/anthropic/v1',
  })
  assert.doesNotMatch(JSON.stringify([custom, official]), /real-official-key|real-custom-key/)
})

test('the harness gets a clean environment: only what it needs, plus the surrogate model key', async () => {
  const { harnessEnv } = await import('../src/dsh.ts')
  const env = harnessEnv({
    PATH: '/bin', HOME: '/home/node', LANG: 'C.UTF-8', NODE_ENV: 'production',
    DEEPSEEK_BOT_MODEL_KEY: 'surrogate', DEEPSEEK_API_KEY: 'real-official-key', MY_KEY: 'real-custom-key',
    DEEPSEEK_BOT_HOST_SECRET: 's', DEEPSEEK_BOT_HOST_ACCESS_CODE: 'c', DEEPSEEK_BOT_PUSH_RELAY: 'https://h',
    AWS_SECRET_ACCESS_KEY: 'aws', GITHUB_TOKEN: 'gh', NODE_OPTIONS: '--require /tmp/x.js',
  }, ['DEEPSEEK_BOT_MODEL_KEY', 'DEEPSEEK_BASE_URL'])
  assert.deepEqual(env, { PATH: '/bin', HOME: '/home/node', LANG: 'C.UTF-8', NODE_ENV: 'production', DEEPSEEK_BOT_MODEL_KEY: 'surrogate' })
  assert.equal(env.DEEPSEEK_BOT_MODEL_KEY, 'surrogate')
  assert.equal(env.DEEPSEEK_BASE_URL, undefined)
  assert.equal(env.DEEPSEEK_API_KEY, undefined)
  assert.equal(env.MY_KEY, undefined)
  assert.equal(env.DEEPSEEK_BOT_HOST_SECRET, undefined)
  assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined)
  assert.equal(env.GITHUB_TOKEN, undefined)
  assert.equal(env.NODE_OPTIONS, undefined)
})

// On a Mac the bot runs as the person, whose own ~/.agents/skills (136 of them, 88k chars in one QA run,
// 2026-10-30) went into every catalog and kept background subagents compacting until they never finished.
test('the harness reads skills from its own home, not the ~/.agents of whoever started the bot', async () => {
  const { dshSpawnEnv } = await import('../src/dsh.ts')
  const env = dshSpawnEnv({ dshHome: '/data/bot/dsh', env: { PATH: '/bin', HOME: '/Users/someone' } })
  assert.equal(env.DSH_HOME, '/data/bot/dsh')
  assert.equal(env.DSH_AGENTS_HOME, '/data/bot/dsh/agents')
  assert.equal(env.HOME, '/Users/someone')
})
