import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { openHome } from '../src/home.ts'
import { startToolsServer } from '../src/tools.ts'
import { Memory } from '../src/memory.ts'
import { Scheduler } from '../src/scheduler.ts'
import { Goals } from '../src/goals.ts'

// An English conversation turned Chinese (m-pick6-en, 2026-11-03): the model wrote its remember fact in Chinese, then its
// reply. Replaying that moment 40 times against the real model: 6 Chinese with AGENTS.md's Chinese in it ("They may mix Chinese
// and English", four Chinese examples), 0 without; the empty USER.md and MEMORY.md and the pages it read were not the cause
//. So what the model reads from Boop names no language and shows none but English.
const FOREIGN = /[぀-ヿ㐀-鿿가-힯Ѐ-ӿ]|\bChinese\b/

const model = { provider: 'deepseek-official', model: 'deepseek-flash' }

for (const container of [false, true]) {
  test(`AGENTS.md, SOUL.md, USER.md, MEMORY.md carry no language but English${container ? ' (in the image)' : ''}`, async () => {
    const prev = process.env.DEEPSEEK_BOT_IN_CONTAINER
    if (container) process.env.DEEPSEEK_BOT_IN_CONTAINER = '1'; else delete process.env.DEEPSEEK_BOT_IN_CONTAINER
    try {
      const root = mkdtempSync(join(tmpdir(), 'reply-lang-'))
      await openHome(root, { model } as never)
      const agents = readFileSync(join(root, 'dsh', 'AGENTS.md'), 'utf8')
      assert.equal(FOREIGN.exec(agents)?.[0], undefined)
      assert.match(agents, /Match the user's language/)
      for (const f of ['SOUL.md', 'USER.md', 'MEMORY.md']) assert.equal(FOREIGN.exec(readFileSync(join(root, 'workspace', f), 'utf8'))?.[0], undefined, f)
    } finally { if (prev === undefined) delete process.env.DEEPSEEK_BOT_IN_CONTAINER; else process.env.DEEPSEEK_BOT_IN_CONTAINER = prev }
  })
}

test('what the person told it stays as they wrote it: a Chinese name or fact is theirs, the frame around it is not', async () => {
  const root = mkdtempSync(join(tmpdir(), 'reply-lang-'))
  await openHome(root, { model, assistantName: '大鲸鱼' } as never)
  assert.match(readFileSync(join(root, 'dsh', 'AGENTS.md'), 'utf8'), /大鲸鱼/)
})

test('the bot tools\' descriptions carry no language but English', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'reply-lang-tools-'))
  writeFileSync(join(dir, 'USER.md'), '# USER.md\n'); writeFileSync(join(dir, 'MEMORY.md'), '# MEMORY.md\n')
  const srv = await startToolsServer({ memory: new Memory(dir), scheduler: await Scheduler.open(join(dir, 's.json'), { onDue: async () => {} }), goals: await Goals.open(join(dir, 'g.json')), onActivity: () => {} } as never)
  try {
    const c = new Client({ name: 't', version: '0' })
    await c.connect(new StreamableHTTPClientTransport(new URL(srv.url), { requestInit: { headers: { authorization: `Bearer ${srv.secret}` } } }))
    const tools = (await c.listTools()).tools
    assert.ok(tools.length > 3)
    for (const t of tools) assert.equal(FOREIGN.exec(JSON.stringify(t))?.[0], undefined, t.name)
    assert.match(tools.find((t) => t.name === 'remember')!.description ?? '', /in the person's language/)
    await c.close()
  } finally { await srv.close() }
})
