import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { startToolsServer } from '../src/tools.ts'
import { Memory } from '../src/memory.ts'
import { Scheduler } from '../src/scheduler.ts'
import { Goals } from '../src/goals.ts'

async function boot(extra: Partial<Parameters<typeof startToolsServer>[0]> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tools-'))
  writeFileSync(join(dir, 'USER.md'), '# USER.md\n')
  writeFileSync(join(dir, 'MEMORY.md'), '# MEMORY.md\n')
  const pushes: { title: string; body: string }[] = []
  const due: string[] = []
  const memory = new Memory(dir)
  const scheduler = await Scheduler.open(join(dir, 'schedules.json'), { onDue: async (t) => { due.push(t.name) } })
  const goals = await Goals.open(join(dir, 'goals.json'))
  const srv = await startToolsServer({ memory, scheduler, goals, notify: async (n) => { pushes.push(n) }, ...extra })
  const connect = async (secret = srv.secret) => {
    const client = new Client({ name: 'test', version: '0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(srv.url), { requestInit: { headers: { authorization: `Bearer ${secret}` } } }))
    return client
  }
  return { dir, srv, memory, scheduler, goals, pushes, due, connect, close: () => srv.close() }
}
const textOf = (r: { content: { type: string; text?: string }[] }) => r.content.filter((c) => c.type === 'text').map((c) => c.text).join('')

test('the tools are listed over MCP and refuse a wrong secret', async () => {
  const s = await boot()
  try {
    const c = await s.connect()
    const names = (await c.listTools()).tools.map((t) => t.name).sort()
    assert.deepEqual(names, ['forget', 'goal_list', 'goal_set', 'goal_update', 'notify', 'remember', 'schedule_create', 'schedule_delete', 'schedule_list', 'schedule_update', 'show', 'ui'])
    await assert.rejects(s.connect('wrong'))
  } finally { await s.close() }
})

test('remember writes a dated fact once; forget removes matching lines', async () => {
  const s = await boot()
  try {
    const c = await s.connect()
    assert.match(textOf(await c.callTool({ name: 'remember', arguments: { fact: 'Prefers oat milk', kind: 'preference' } })), /Saved \(preference\)/)
    assert.match(textOf(await c.callTool({ name: 'remember', arguments: { fact: 'prefers oat milk', kind: 'preference' } })), /Already known/)
    assert.match(readFileSync(join(s.dir, 'USER.md'), 'utf8'), /^- \d{4}-\d{2}-\d{2} \[preference\] Prefers oat milk$/m)
    await c.callTool({ name: 'remember', arguments: { fact: 'Ship the bot by Friday' } })
    const r = textOf(await c.callTool({ name: 'forget', arguments: { query: 'oat milk' } }))
    assert.match(r, /Removed:/)
    assert.doesNotMatch(readFileSync(join(s.dir, 'USER.md'), 'utf8'), /oat milk/)
    assert.match(readFileSync(join(s.dir, 'MEMORY.md'), 'utf8'), /Ship the bot/)
  } finally { await s.close() }
})

test('schedule_create stores a task with a next run; list/update/delete round-trip', async () => {
  const s = await boot()
  try {
    const c = await s.connect()
    const at = new Date(Date.now() + 3600_000).toISOString()
    const created = textOf(await c.callTool({ name: 'schedule_create', arguments: { name: 'Call mom', instruction: 'Remind me to call mom', when: { kind: 'once', at } } }))
    const id = /Created (\w+):/.exec(created)![1]
    assert.equal(s.scheduler.list()[0].nextRunAt, at)
    assert.match(textOf(await c.callTool({ name: 'schedule_list', arguments: {} })), /Call mom/)
    assert.match(textOf(await c.callTool({ name: 'schedule_update', arguments: { id, active: false } })), /inactive/)
    assert.match(textOf(await c.callTool({ name: 'schedule_delete', arguments: { id } })), /Deleted/)
    assert.equal(s.scheduler.list().length, 0)
    const past = await c.callTool({ name: 'schedule_create', arguments: { name: 'x', instruction: 'y', when: { kind: 'once', at: '2000-01-01T00:00:00Z' } } })
    assert.equal(past.isError, true)
  } finally { await s.close() }
})

test('goals and notify', async () => {
  const s = await boot()
  try {
    const c = await s.connect()
    const id = /Goal (\w+) created/.exec(textOf(await c.callTool({ name: 'goal_set', arguments: { title: 'Run a 10k', plan: ['Run 3x a week', 'Sign up'] } })))![1]
    await c.callTool({ name: 'goal_update', arguments: { id, note: 'Ran twice this week' } })
    assert.match(textOf(await c.callTool({ name: 'goal_list', arguments: {} })), /Run a 10k[\s\S]*Ran twice/)
    await c.callTool({ name: 'notify', arguments: { title: 'Rain at 5pm', body: 'Bring an umbrella' } })
    assert.deepEqual(s.pushes, [{ title: 'Rain at 5pm', body: 'Bring an umbrella' }])
  } finally { await s.close() }
})

test('memory items carry a kind and stable ids; forgetById removes one line', async () => {
  const s = await boot()
  try {
    const c = await s.connect()
    await c.callTool({ name: 'remember', arguments: { fact: 'Call me Owl', kind: 'fact' } })
    await c.callTool({ name: 'remember', arguments: { fact: 'Waiting for the client reply by Thursday', kind: 'project' } })
    await c.callTool({ name: 'remember', arguments: { fact: 'Invoices go to the company address', kind: 'decision' } })
    const items = await s.memory.items()
    assert.deepEqual(items.map((i) => [i.file, i.kind]), [['user', 'fact'], ['memory', 'project'], ['memory', 'decision']])
    assert.match(readFileSync(join(s.dir, 'MEMORY.md'), 'utf8'), /^- \d{4}-\d{2}-\d{2} \[project\] Waiting for the client/m)
    const removed = await s.memory.forgetById(items[1].id)
    assert.match(removed ?? '', /Waiting/)
    assert.equal((await s.memory.items()).length, 2)
    assert.equal(await s.memory.forgetById('nope'), null)
  } finally { await s.close() }
})

test('show validates the card and answers with how the reply will arrive; junk is refused', async () => {
  const s = await boot()
  try {
    const c = await s.connect()
    const ok = await c.callTool({ name: 'show', arguments: { kind: 'choices', title: 'Which day?', options: [{ label: 'Thu' }, { label: 'Fri' }] } })
    assert.match(textOf(ok as never), /Shown\. .*answer/)
    const bad = await c.callTool({ name: 'show', arguments: { kind: 'choices', title: 'x', options: [] } })
    assert.equal((bad as { isError?: boolean }).isError, true)
    // a plain table is display only; with pick the tap comes back as a message
    const table = { kind: 'table', title: 'Ways', columns: ['Way', 'Time'], rows: [['Train', '3 h'], ['Bus', '4 h']] }
    assert.equal(textOf(await c.callTool({ name: 'show', arguments: table }) as never), 'Shown.')
    assert.match(textOf(await c.callTool({ name: 'show', arguments: { ...table, pick: true } }) as never), /Shown\. .*answer/)
  } finally { await s.close() }
})

// The model (DeepSeek V4.1 Flash via Magpie) sent a table's `columns`, `rows` and `pick` as JSON strings; the tool
// refused them ("columns: expected array, received string") and no table ever showed (QA, iOS, 2026-10-30).
test('show takes a card whose lists and flags came as JSON strings, and still lists them as arrays', async () => {
  const s = await boot()
  try {
    const c = await s.connect()
    const r = await c.callTool({ name: 'show', arguments: { kind: 'table', title: 'Ways', columns: '["Way","Time"]', rows: '[["Train","3 h"],["Bus","4 h"]]', pick: 'true' } })
    assert.notEqual((r as { isError?: boolean }).isError, true, textOf(r as never))
    assert.match(textOf(r as never), /Shown\. .*answer/)
    const choices = await c.callTool({ name: 'show', arguments: { kind: 'choices', title: 'Which day?', options: '[{"label":"Thu"},{"label":"Fri"}]' } })
    assert.notEqual((choices as { isError?: boolean }).isError, true, textOf(choices as never))
    assert.equal((await c.callTool({ name: 'show', arguments: { kind: 'table', title: 'x', columns: 'Way, Time', rows: '[]' } }) as { isError?: boolean }).isError, true, 'not JSON: still refused')
    const tools = (await c.listTools()).tools
    const show = JSON.stringify(tools.find((t) => t.name === 'show')!.inputSchema)
    assert.match(show, /"columns":\{[^}]*"type":"array"/)
  } finally { await s.close() }
})

test('install_browser runs the bot\'s own installer (the agent cannot: its shell is sandboxed) and is absent where there is none', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tools-'))
  const memory = new Memory(dir)
  const scheduler = await Scheduler.open(join(dir, 'schedules.json'), { onDue: async () => {} })
  const goals = await Goals.open(join(dir, 'goals.json'))
  let ran = 0
  const srv = await startToolsServer({ memory, scheduler, goals, notify: async () => {}, installBrowser: async () => { ran++; return 'Installed. The browser tools appear in about 20 seconds.' } })
  const plain = await startToolsServer({ memory, scheduler, goals, notify: async () => {} })
  const { Client } = await import('@modelcontextprotocol/client')
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client')
  const connect = async (s: typeof srv) => { const c = new Client({ name: 't', version: '1' }); await c.connect(new StreamableHTTPClientTransport(new URL(s.url), { requestInit: { headers: { authorization: `Bearer ${s.secret}` } } })); return c }
  try {
    const c = await connect(srv)
    assert.ok((await c.listTools()).tools.some((t) => t.name === 'install_browser'))
    const r = await c.callTool({ name: 'install_browser', arguments: {} }) as { content: { text: string }[] }
    assert.match(r.content[0].text, /about 20 seconds/); assert.equal(ran, 1)
    const p = await connect(plain)
    assert.ok(!(await p.listTools()).tools.some((t) => t.name === 'install_browser'))
    await c.close(); await p.close()
  } finally { await srv.close(); await plain.close(); scheduler.stop() }
})

test('set_my_name renames the assistant through the handler the bot wires to its settings store, and notes it in the activity list', async () => {
  const renamed: string[] = []
  const acts: { kind: string; text: string }[] = []
  const s = await boot({ rename: async (n: string) => { renamed.push(n) }, onActivity: (e) => acts.push(e) })
  try {
    const c = await s.connect()
    assert.ok((await c.listTools()).tools.some((t) => t.name === 'set_my_name'))
    const said = textOf(await c.callTool({ name: 'set_my_name', arguments: { name: '  大鲸鱼 ' } })); assert.match(said, /大鲸鱼/); assert.doesNotMatch(said, /^Done\b/, 'no English status word for the model to echo')
    assert.deepEqual(renamed, ['大鲸鱼'])
    assert.ok(acts.some((a) => a.kind === 'name' && a.text.includes('大鲸鱼')), JSON.stringify(acts))
    const bad = await c.callTool({ name: 'set_my_name', arguments: { name: '   ' } })
    assert.equal(renamed.length, 1, 'a blank name changes nothing')
    assert.ok(bad.isError || /name/i.test(textOf(bad as never)))
  } finally { await s.close() }
})

// Where the person lives sets their time zone (a phone that reports UTC could not tell, src/server.ts): the fact is
// saved in their words, the zone goes to the bot's settings. Before, AGENTS.md asked for "Lives in Lisbon (America/New_York)"
// while this tool forbade zone ids, and the real model wrote 「住在里斯本，用里斯本时间」 with no zone (test/plain.e2e, 2026-11-01).
test('remember with a time zone keeps the fact in words and gives the zone to the bot', async () => {
  const zones: string[] = []
  const s = await boot({ setHomeZone: async (z: string) => { zones.push(z) } })
  try {
    const c = await s.connect()
    assert.match(textOf(await c.callTool({ name: 'remember', arguments: { fact: '住在里斯本', kind: 'fact', timeZone: 'Europe/Lisbon' } })), /Saved/)
    assert.deepEqual(zones, ['Europe/Lisbon'])
    assert.match(readFileSync(join(s.dir, 'USER.md'), 'utf8'), /住在里斯本/)
    assert.doesNotMatch(readFileSync(join(s.dir, 'USER.md'), 'utf8'), /Asia\//)
    const bad = await c.callTool({ name: 'remember', arguments: { fact: 'Lives on the moon', kind: 'fact', timeZone: 'Moon/Base' } })
    assert.match(textOf(bad), /not a time zone/)
    assert.deepEqual(zones, ['Europe/Lisbon'], 'an unknown zone is not taken')
  } finally { await s.close() }
})
