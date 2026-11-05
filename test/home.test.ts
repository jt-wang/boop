import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { presetYaml, openHome } from '../src/home.ts'

test('openHome creates the three memory files, the DSH home, and a profile patch that keeps session logs local', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bot-home-'))
  const home = await openHome(root, { model: { provider: 'deepseek-official', model: 'deepseek-flash' } })
  for (const f of ['SOUL.md', 'USER.md', 'MEMORY.md']) assert.ok(existsSync(join(root, 'workspace', f)), f)
  // the style page shows SOUL.md as it is (long-press 它的风格): no harness words in it (QA 2026-10-28 #12)
  assert.doesNotMatch(readFileSync(join(root, 'workspace', 'SOUL.md'), 'utf8'), /harness|sandbox|workspace/i)
  assert.equal(home.dshHome, join(root, 'dsh'))
  assert.equal(home.workspace, join(root, 'workspace'))
  const agents = readFileSync(join(root, 'dsh', 'AGENTS.md'), 'utf8')
  assert.match(agents, /MEMORY\.md/)
  const patch = readFileSync(join(root, 'dsh', 'profiles', 'web', 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /id: session-log-deepseek\n\s+config:\n\s+enabled: false/)
  // the question tool whose schema tells the model what a Skip is, still waiting for the person (test/skip.e2e.test.ts)
  assert.match(patch, /^- id: preset-standard\n  config:\n    id: standard\n/m)
  assert.match(patch, /\n      - id: tool-ask-user\n        name: '@deepseek-ai\/dsh-tool-ask-user'\n        config:\n          mode: timed\n          timeout: -1\n      - id: /)
  assert.match(patch, /id: agent-default-model\n\s+config:\n\s+provider: deepseek-official\n\s+model: deepseek-flash/)
})

test('presetYaml keeps every row of the installed standard preset and changes only tool-ask-user', () => {
  const r = createRequire(createRequire(import.meta.url).resolve('@deepseek-ai/dsh/package.json'))
  const preset = readFileSync(r.resolve('@deepseek-ai/dsh-web-app/presets/standard.patch.yml'), 'utf8')
  const out = presetYaml(preset)
  const ids = (s: string) => [...s.matchAll(/- id: ([\w-]+)/g)].map((m) => m[1])
  assert.deepEqual(ids(out), ids(preset), 'same rows, same order')
  assert.match(out, /disabled: !!js process\.platform === 'win32'/, 'DSH expressions stay as written')
  // the only change: three lines; the rest is the preset's own config, dedented under `- id: preset-standard`
  const own = preset.slice(preset.indexOf('\n      config:\n') + '\n      config:\n'.length).split('\n').filter((l) => l.trim()).map((l) => l.slice(4)).join('\n')
  assert.equal(out.replace('\n        config:\n          mode: timed\n          timeout: -1\n', '\n'), `- id: preset-standard\n  config:\n${own}\n`)
  // a preset in another shape is left alone rather than guessed at
  assert.equal(presetYaml(preset.replace('- id: tool-ask-user', '- id: ask-user')), '')
  assert.equal(presetYaml(preset.replace("name: '@deepseek-ai/dsh-tool-ask-user'", "name: '@deepseek-ai/dsh-tool-ask-user'\n            config:\n              mode: legacy")), '')
})

test('openHome keeps edited SOUL.md and regenerates AGENTS.md from it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bot-home-'))
  await openHome(root, { model: { provider: 'deepseek-official', model: 'deepseek-flash' } })
  const { writeFileSync } = await import('node:fs')
  writeFileSync(join(root, 'workspace', 'SOUL.md'), '# Soul\nYou are Pumpkin. Short answers.\n')
  await openHome(root, { model: { provider: 'deepseek-official', model: 'deepseek-flash' } })
  assert.match(readFileSync(join(root, 'workspace', 'SOUL.md'), 'utf8'), /Pumpkin/)
  assert.match(readFileSync(join(root, 'dsh', 'AGENTS.md'), 'utf8'), /Pumpkin/)
})

test('openHome writes an OpenAI-compatible provider row when a custom endpoint is configured', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bot-home-'))
  await openHome(root, { model: { provider: 'custom', model: 'deepseek-v4-flash', baseURL: 'http://127.0.0.1:3425/v1', apiKeyEnv: 'MY_KEY' } })
  const patch = readFileSync(join(root, 'dsh', 'profiles', 'web', 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /dsh-llm-pi-ai/)
  assert.match(patch, /baseURL: http:\/\/127\.0\.0\.1:3425\/v1/)
  assert.match(patch, /apiKeyEnv: MY_KEY/)
  assert.doesNotMatch(patch, /sk-[A-Za-z0-9_-]{8,}/)
  assert.match(patch, /provider: custom\n\s+model: deepseek-v4-flash/)
})

test('the profile leaves the upstream agent presets (and their file tools) as shipped, but for the question tool’s mode', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bot-home-'))
  await openHome(root, { model: { provider: 'deepseek-official', model: 'deepseek-flash' } })
  const patch = readFileSync(join(root, 'dsh', 'profiles', 'web', 'cordis.patch.yml'), 'utf8')
  for (const id of ['preset-ptc', 'preset-minimal', 'preset-cordis']) {
    assert.doesNotMatch(patch, new RegExp(`- id: ${id}\\n`), `${id} is not overridden`)
  }
  // preset-standard is DSH's own list with one row's config (presetYaml above): the file tools stay
  assert.match(patch, /\n      - id: tool-fs\n        name: '@deepseek-ai\/dsh-tool-fs'\n      - id: tool-fs-search\n/)
})

test('inside the container the profile routes every shell through the masking bwrap runner', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bot-home-'))
  const prev = process.env.DEEPSEEK_BOT_IN_CONTAINER
  try {
    delete process.env.DEEPSEEK_BOT_IN_CONTAINER
    await openHome(root, { model: { provider: 'deepseek-official', model: 'deepseek-flash' } })
    assert.doesNotMatch(readFileSync(join(root, 'dsh', 'profiles', 'web', 'cordis.patch.yml'), 'utf8'), /runnerCommand/)
    process.env.DEEPSEEK_BOT_IN_CONTAINER = '1'
    await openHome(root, { model: { provider: 'deepseek-official', model: 'deepseek-flash' } })
    const patch = readFileSync(join(root, 'dsh', 'profiles', 'web', 'cordis.patch.yml'), 'utf8')
    const expected = `runnerCommand: ${JSON.stringify([process.execPath, '/opt/deepseek-bot/scripts/bwrap-agent.mjs'])}`
    assert.ok(patch.includes(`- id: sandbox\n  config:\n    ${expected}`), patch)
    assert.match(patch, /runnerFailureSignatures: \["bwrap: "\]/)
    // the container has a chart command and no Python data libraries
    assert.match(readFileSync(join(root, 'dsh', 'AGENTS.md'), 'utf8'), /`chart option\.json out\.png`/)
    // a 1000 × 600 chart (3000 × 1800 px) on Fly, 2026-10-30: its labels read small on a phone; the default is the phone's size
    assert.match(readFileSync(join(root, 'dsh', 'AGENTS.md'), 'utf8'), /default size fits a phone screen/)
  } finally { if (prev === undefined) delete process.env.DEEPSEEK_BOT_IN_CONTAINER; else process.env.DEEPSEEK_BOT_IN_CONTAINER = prev }
})

test('openHome mounts the bot tools MCP server in the profile patch and tells the assistant about the tools', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bot-home-'))
  await openHome(root, { model: { provider: 'deepseek-official', model: 'deepseek-flash' }, tools: { url: 'http://127.0.0.1:4242/mcp', secret: 's3cr3t' } })
  const patch = readFileSync(join(root, 'dsh', 'profiles', 'web', 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /dsh-mcp-client[\s\S]*serverName: bot[\s\S]*url: http:\/\/127\.0\.0\.1:4242\/mcp[\s\S]*authorization: Bearer s3cr3t/)
  const agents = readFileSync(join(root, 'dsh', 'AGENTS.md'), 'utf8')
  assert.match(agents, /`remember`/); assert.match(agents, /schedule_create/); assert.match(agents, /goal_set/); assert.match(agents, /`show`/); assert.match(agents, /never paste raw command output/)
})

test('AGENTS.md tells the assistant how a person connects a service: a connect card, the service ids, and what arrives when it is done', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bot-home-'))
  await openHome(root, { model: { provider: 'deepseek-official', model: 'deepseek-flash' } })
  const agents = readFileSync(join(root, 'dsh', 'AGENTS.md'), 'utf8')
  assert.match(agents, /kind `connect`/)
  assert.match(agents, /`notion`/); assert.match(agents, /`linear`/); assert.match(agents, /`gmail`/)
  assert.match(agents, /\[Connected /)
  assert.doesNotMatch(agents, /NOTION_TOKEN|GITHUB_TOKEN/)
  // QA 2026-10-28: in a Chinese thread it said 「点一下 Connect」 while the button says 连接;
  // the instructions said what the button says in each language; that Chinese also pulled English threads into Chinese
  //. Saying only "name it in their language": 0 of 20 Chinese replies said Connect (2026-11-03)
  assert.match(agents, /when you mention it, name it in their language/)
  assert.doesNotMatch(agents, /they tap Connect\b/)
})

test('AGENTS.md tells the assistant when an interface is the answer and when prose is', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bot-home-'))
  await openHome(root, { model: { provider: 'deepseek-official', model: 'deepseek-flash' }, tools: { url: 'http://127.0.0.1:4242/mcp', secret: 's' } })
  const agents = readFileSync(join(root, 'dsh', 'AGENTS.md'), 'utf8')
  const section = /# Interfaces, not walls of text\n([\s\S]*?)\n# /.exec(agents)?.[1] ?? ''
  assert.ok(section, 'the section exists')
  for (const rule of [/`show`/, /`ui`/, /one sentence/i, /plain text/i]) assert.match(section, rule)
  // High-level only (owner, 2026-11-02: "用户的需求是无穷无尽的，你最多是给 AI 一些比较 high-level 的 guidance"): no
  // table of which ask gets which card. That table made a trip plan a plain table. What each card does is in the
  // tools' own descriptions.
  for (const perCase of [/→/, /A plan, a schedule/i, /Comparing options/i, /`progress`/, /`summary`/, /`table`/]) assert.doesNotMatch(section, perCase)
  assert.ok(section.length < 900, `section is ${section.length} chars`)
})

test('in a container (DEEPSEEK_BOT_IN_CONTAINER=1) AGENTS.md tells the assistant how to install its browser; otherwise it does not', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bot-home-'))
  const prev = process.env.DEEPSEEK_BOT_IN_CONTAINER
  try {
    delete process.env.DEEPSEEK_BOT_IN_CONTAINER
    await openHome(root, { model: { provider: 'deepseek-official', model: 'deepseek-flash' } })
    assert.doesNotMatch(readFileSync(join(root, 'dsh', 'AGENTS.md'), 'utf8'), /install_browser/)
    process.env.DEEPSEEK_BOT_IN_CONTAINER = '1'
    await openHome(root, { model: { provider: 'deepseek-official', model: 'deepseek-flash' } })
    assert.match(readFileSync(join(root, 'dsh', 'AGENTS.md'), 'utf8'), /install_browser/)
  } finally { if (prev === undefined) delete process.env.DEEPSEEK_BOT_IN_CONTAINER; else process.env.DEEPSEEK_BOT_IN_CONTAINER = prev }
})

test('AGENTS.md tells the assistant what the phone already knows about the person, and not to ask for it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'home-'))
  const h = await openHome(root, { model: { provider: 'deepseek-official', model: 'deepseek-flash' }, person: { timeZone: 'America/New_York', locale: 'fr-FR', name: 'JT' } })
  const md = readFileSync(join(h.dshHome, 'AGENTS.md'), 'utf8')
  assert.match(md, /America\/New_York/); assert.match(md, /fr-FR/); assert.match(md, /\bJT\b/)
  assert.match(md, /never ask/i)
})

test('AGENTS.md carries the proactivity level the person chose', async () => {
  const { mkdtempSync, readFileSync } = await import('node:fs'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path')
  for (const [level, phrase] of [['off', /Never message first/], ['low', /clearly worth the interruption/], ['high', /whenever you have something useful/]] as const) {
    const root = mkdtempSync(join(tmpdir(), 'home-'))
    const h = await openHome(root, { model: { provider: 'deepseek-official', model: 'deepseek-flash' }, proactivity: level })
    assert.match(readFileSync(join(h.dshHome, 'AGENTS.md'), 'utf8'), phrase, level)
  }
})

test('AGENTS.md: a new name goes through set_my_name, and the assistant never digs in its own configuration or the harness', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bot-home-'))
  await openHome(root, { model: { provider: 'deepseek-official', model: 'deepseek-flash' }, assistantName: 'Whaile' })
  const agents = readFileSync(join(root, 'dsh', 'AGENTS.md'), 'utf8')
  assert.match(agents, /new name[^\n]*`set_my_name`/)
  assert.match(agents, /[Nn]ever look for or edit your own configuration, installation, environment or the harness's files/)
})

test('AGENTS.md: every step description is in the person\'s language and says what it does for them, never internals', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bot-home-'))
  await openHome(root, { model: { provider: 'deepseek-official', model: 'deepseek-flash' } })
  const agents = readFileSync(join(root, 'dsh', 'AGENTS.md'), 'utf8')
  const rule = agents.split('\n').find((l) => /`description`/.test(l)) ?? ''
  assert.match(rule, /in the person's language/)
  assert.match(rule, /Checking trains from Lisbon to Porto/)
  assert.match(rule, /never paths/)
  for (const w of [/commands/, /environment variables/, /config/, /harness/]) assert.match(rule, w)
})

test('AGENTS.md: after two attempts that do not work, stop and say what is blocked and what the person can do', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bot-home-'))
  await openHome(root, { model: { provider: 'deepseek-official', model: 'deepseek-flash' } })
  const agents = readFileSync(join(root, 'dsh', 'AGENTS.md'), 'utf8')
  const rule = agents.split('\n').find((l) => /two attempts/.test(l)) ?? ''
  assert.match(rule, /stop/); assert.match(rule, /what is blocked/); assert.match(rule, /what they can do/)
})

test('AGENTS.md: what it remembers is written in the person\'s language, because they read it in the app', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bot-home-'))
  await openHome(root, { model: { provider: 'deepseek-official', model: 'deepseek-flash' } })
  const memory = /# Memory\n([\s\S]*?)\n# /.exec(readFileSync(join(root, 'dsh', 'AGENTS.md'), 'utf8'))?.[1] ?? ''
  assert.match(memory, /`remember`[^\n]*in the person's language/)
})

// [agent:genui] AGENTS.md teaches the `ui` tool with one whole example module; the addition stays small (measured below as chars/4 ≈ tokens).
test('AGENTS.md explains when to use ui instead of show, with an example module that compiles, in under ~800 tokens', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bot-home-'))
  await openHome(root, { model: { provider: 'deepseek-official', model: 'deepseek-flash' } })
  const agents = readFileSync(join(root, 'dsh', 'AGENTS.md'), 'utf8')
  const section = agents.slice(agents.indexOf('- `ui` builds'), agents.indexOf('```\n', agents.indexOf('```tsx')) + 4)
  assert.match(section, /six cards are not enough/)
  assert.match(section, /launch\.params/)
  assert.match(section, /\/ui\/\$\{p\.moduleId\}\/result/)
  assert.match(section, /ui\.close/)
  assert.match(section, /compile errors, fix the source/)
  assert.ok(section.length / 4 < 800, `~${Math.round(section.length / 4)} tokens`)
  const example = /```tsx\n([\s\S]*?)```/.exec(section)![1]
  assert.ok(example.trim().split('\n').length <= 22, `${example.trim().split('\n').length} lines`)
  const { Ui } = await import('../src/ui.ts')
  const ui = await Ui.open(join(root, 'uihome'), { hosts: ['127.0.0.1'] })
  if (!ui.available) return
  const r = await ui.create({ title: 'Tip', source: example })
  assert.ok(r.ok, JSON.stringify(r))
})

test('a custom model provider retries a busy model for minutes, not seconds (a 429 burst on SiliconFlow, 2026-10-27, outlasted the default 5 retries in ~20 s)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bot-home-'))
  await openHome(root, { model: { provider: 'siliconflow', model: 'deepseek-ai/DeepSeek-V4.1-Flash', baseURL: 'https://api.siliconflow.cn/v1' } })
  const patch = readFileSync(join(root, 'dsh', 'profiles', 'web', 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /retryPolicy:\n\s+mode: normal\n\s+maxRetries: 12\n\s+backoff:\n\s+initialDelayMs: 1000\n\s+maxDelayMs: 30000\n\s+jitterRatio: 0\.2/)
})

test('openHome does not follow a symlinked SOUL.md to a bot file', async () => {
  const { mkdirSync, writeFileSync, symlinkSync } = await import('node:fs')
  const root = mkdtempSync(join(tmpdir(), 'bot-home-'))
  const ws = join(root, 'workspace'); mkdirSync(ws)
  const outside = join(root, 'secret.json'); writeFileSync(outside, 'SENTINEL-should-not-be-in-the-prompt\n')
  symlinkSync(outside, join(ws, 'SOUL.md'))
  const home = await openHome(root, { model: { provider: 'deepseek-official', model: 'deepseek-flash' } })
  assert.doesNotMatch(readFileSync(join(home.dshHome, 'AGENTS.md'), 'utf8'), /SENTINEL/)
  assert.equal(readFileSync(outside, 'utf8'), 'SENTINEL-should-not-be-in-the-prompt\n')
})

// Asked to write outside its work folder, the assistant told the person "the sandbox blocks writes outside my
// workspace, and you declined the full-access escalation", with /Users/<name>/trip.md (3 of 3 runs, real model,
// 2026-10-27). The person never saw a request: this computer refuses it by itself (src/server.ts). The
// instructions now say so, and keep paths and harness words out of what the person reads.
test('AGENTS.md: no paths or harness words for the person; a refusal by this computer is not the person declining', async () => {
  const root = mkdtempSync(join(tmpdir(), 'home-'))
  await openHome(root, { model: { provider: 'deepseek-official', model: 'deepseek-flash' } })
  const agents = readFileSync(join(root, 'dsh', 'AGENTS.md'), 'utf8')
  assert.match(agents, /never show paths/i)
  assert.match(agents, /never say they declined/i)
})

// In a Chinese thread the assistant wrote "(unverified 内容)" and titled a connect card "Connect Acme Pages", both
// copied from English examples in the instructions (QA pass, Android, 2026-10-27).
// The Chinese that fixed this also pulled English threads into Chinese; with the words "in their language"
// alone, 0 of 20 Chinese replies said unverified and every connect card title was Chinese (real model, 2026-11-03).
test('AGENTS.md: the words it could copy from examples are asked for in the person\'s language', async () => {
  const root = mkdtempSync(join(tmpdir(), 'home-'))
  await openHome(root, { model: { provider: 'deepseek-official', model: 'deepseek-flash' } })
  const agents = readFileSync(join(root, 'dsh', 'AGENTS.md'), 'utf8')
  assert.match(agents, /say so next to it in their language/)
  assert.match(agents, /the title in their language/)
})

// A reply in a Chinese thread began "done — 我在电脑主目录建好了 trip.md".
// The instructions named the three endings with English labels ("done (what changed), stuck (…)") and the model
// opened its reply with the label. Nothing in AGENTS.md may hand it an English status word to lead with.
test('AGENTS.md: no English status label (done / stuck) for the model to open a reply with', async () => {
  const root = mkdtempSync(join(tmpdir(), 'home-'))
  await openHome(root, { model: { provider: 'deepseek-official', model: 'deepseek-flash' } })
  const agents = readFileSync(join(root, 'dsh', 'AGENTS.md'), 'utf8')
  assert.doesNotMatch(agents, /\b(done|stuck|blocked) \(/i)
})

// web_search is DSH's DeepSeek native search (an Anthropic Messages call with the `web_search_20250305` server tool),
// the only search backend DSH ships. On the hosted computer the provider is SiliconFlow, and every search failed with
// "Model does not exist". A provider has to be known to serve it before the model gets the tool.
test('web_search: DeepSeek\'s own API keeps it; a custom provider gets it only when marked, with its own model name', async () => {
  const read = (root: string) => ({ patch: readFileSync(join(root, 'dsh', 'profiles', 'web', 'cordis.patch.yml'), 'utf8'), agents: readFileSync(join(root, 'dsh', 'AGENTS.md'), 'utf8') })
  const official = mkdtempSync(join(tmpdir(), 'bot-home-'))
  await openHome(official, { model: { provider: 'deepseek-official', model: 'deepseek-flash' } })
  assert.doesNotMatch(read(official).patch, /webSearch: false|web-search-deepseek/)
  assert.match(read(official).agents, /web search/)

  const custom = mkdtempSync(join(tmpdir(), 'bot-home-'))
  await openHome(custom, { model: { provider: 'siliconflow', model: 'deepseek-ai/DeepSeek-V4.1-Flash', baseURL: 'https://api.siliconflow.cn/v1' } })
  assert.match(read(custom).patch, /- id: deepseek-bot\n\s+name: \.\/deepseek-bot-plugin\.mjs\n\s+config:\n\s+webSearch: false\n/, 'the bot\'s DSH plugin leaves web_search out')
  assert.doesNotMatch(read(custom).agents, /web search/, 'the instructions do not promise it')

  const marked = mkdtempSync(join(tmpdir(), 'bot-home-'))
  await openHome(marked, { model: { provider: 'magpie', model: 'group/auto-deepseek-flash', baseURL: 'http://127.0.0.1:3425/v1', webSearch: true } })
  assert.match(read(marked).patch, /- id: web-search-deepseek\n\s+config:\n\s+model: "group\/auto-deepseek-flash"\n/)
  assert.doesNotMatch(read(marked).patch, /webSearch: false/)
  assert.match(read(marked).agents, /web search/)
})

// DSH's compaction keeps 65,536 tokens of headroom for its summary unless told otherwise; with a 128k window and 16k
// replies that is a threshold of min(128000 × 0.8, 128000 − 16384 − 65536) = 46,080 tokens. On the iOS pass of
// 2026-10-30 one turn at ~45k input compacted 10 times and twice failed "summary is not smaller than the shadowed
// content". The summary is a reply of the same model, so it cannot be longer than the model's maxTokens.
test('a custom model compacts near its window: the summary headroom is the model\'s own reply limit', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bot-home-'))
  await openHome(root, { model: { provider: 'magpie', model: 'group/auto-deepseek-flash', baseURL: 'http://127.0.0.1:1/v1' } })
  const patch = readFileSync(join(root, 'dsh', 'profiles', 'web', 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /\n {10}- id: compaction-basic\n {12}name: '@deepseek-ai\/dsh-compaction-basic'\n {12}config:\n {14}headroomTokens: 16384\n {10}- id: /)
  const threshold = Math.min(128000 * 0.8, 128000 - 16384 - 16384)
  assert.equal(threshold, 95232)
  // the question tool keeps its own edit
  assert.match(patch, /mode: timed\n {10}timeout: -1/)
})

test('the official model keeps DSH\'s own compaction settings', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bot-home-'))
  await openHome(root, { model: { provider: 'deepseek-official', model: 'deepseek-flash' } })
  const patch = readFileSync(join(root, 'dsh', 'profiles', 'web', 'cordis.patch.yml'), 'utf8')
  assert.doesNotMatch(patch, /headroomTokens/)
})
