import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigFile } from '../src/config.ts'
import { loadSecrets, ModelSwitch } from '../src/modelswitch.ts'

// "Bring your own key" from the app: the key goes into a 0600
// file next to config.json, never into config.json or a log; the model row is
// saved; the bot restarts itself only when a supervisor will bring it back.

test('switching to a DeepSeek key writes secrets.env (0600) and the model row; without a supervisor it reports restartNeeded', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ms-'))
  const config = await ConfigFile.open(join(dir, 'config.json'))
  const exits: number[] = []
  const sw = new ModelSwitch({ home: dir, config, supervised: false, exit: (c) => { exits.push(c) } })
  const r = await sw.set({ provider: 'deepseek-official', model: 'deepseek-flash', apiKey: 'sk-test-abcdefgh' })
  assert.deepEqual(r, { restartNeeded: true })
  const secrets = join(dir, 'secrets.env')
  assert.equal((statSync(secrets).mode & 0o777).toString(8), '600')
  assert.match(readFileSync(secrets, 'utf8'), /^DEEPSEEK_API_KEY=sk-test-abcdefgh$/m)
  assert.doesNotMatch(readFileSync(join(dir, 'config.json'), 'utf8'), /sk-test/)
  assert.equal(config.get().model.provider, 'deepseek-official')
  assert.deepEqual(exits, [])
  // what the app may see: never the key
  assert.deepEqual(sw.describe(), { provider: 'deepseek-official', model: 'deepseek-flash', baseURL: undefined, hasKey: true })
})

test('a custom OpenAI-compatible endpoint keeps its key under DEEPSEEK_BOT_MODEL_KEY; supervised bots schedule an exit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ms-'))
  const config = await ConfigFile.open(join(dir, 'config.json'))
  const exits: number[] = []
  const sw = new ModelSwitch({ home: dir, config, supervised: true, exit: (c) => { exits.push(c) }, exitDelayMs: 0 })
  const r = await sw.set({ provider: 'openrouter', model: 'deepseek/deepseek-chat', baseURL: 'https://openrouter.ai/api/v1', apiKey: 'or-key-123456' })
  assert.deepEqual(r, { restarting: true })
  await new Promise((x) => setTimeout(x, 20))
  assert.deepEqual(exits, [0])
  const m = config.get().model
  assert.equal(m.provider, 'openrouter'); assert.equal(m.baseURL, 'https://openrouter.ai/api/v1'); assert.equal(m.apiKeyEnv, 'DEEPSEEK_BOT_MODEL_KEY')
  assert.match(readFileSync(join(dir, 'secrets.env'), 'utf8'), /^DEEPSEEK_BOT_MODEL_KEY=or-key-123456$/m)
  // loadSecrets puts the file into an env object without clobbering what is already set
  const env: Record<string, string | undefined> = { DEEPSEEK_API_KEY: 'from-shell' }
  await loadSecrets(dir, env)
  assert.equal(env.DEEPSEEK_BOT_MODEL_KEY, 'or-key-123456'); assert.equal(env.DEEPSEEK_API_KEY, 'from-shell')
})

test('bad input is refused: a key with whitespace, an unknown provider without baseURL', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ms-'))
  const config = await ConfigFile.open(join(dir, 'config.json'))
  const sw = new ModelSwitch({ home: dir, config, supervised: false, exit: () => {} })
  await assert.rejects(sw.set({ provider: 'deepseek-official', model: 'deepseek-flash', apiKey: 'sk bad' }), /key/)
  await assert.rejects(sw.set({ provider: 'mine', model: 'x', apiKey: 'k' }), /baseURL/)
})

test('a custom base URL is checked before anything is written; a refusal leaves the model unchanged', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ms-'))
  const config = await ConfigFile.open(join(dir, 'config.json'))
  const seen: string[] = []
  const sw = new ModelSwitch({
    home: dir, config, supervised: false, exit: () => {},
    checkBaseURL: async (url) => { seen.push(url); if (url.includes('169.254')) throw new Error('blocked by the outbound guard') },
  })
  await assert.rejects(sw.set({ provider: 'mine', model: 'x', baseURL: 'http://169.254.169.254/v1', apiKey: 'k-12345678' }), /outbound guard/)
  assert.equal(config.get().model.provider, 'deepseek-official', 'the model row was not changed')
  await sw.set({ provider: 'mine', model: 'x', baseURL: 'https://example.com/v1', apiKey: 'k-12345678' })
  assert.deepEqual(seen, ['http://169.254.169.254/v1', 'https://example.com/v1'])
  assert.equal(config.get().model.baseURL, 'https://example.com/v1')
})
