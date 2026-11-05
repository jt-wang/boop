import { test } from 'node:test'
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import { emptyThread, foldEvent, foldSnapshot, foldStream, retryLog, toolWord } from '../src/fold.ts'
import { fileSha256 } from '../src/thread.ts'

const user = (text: string) => ({ type: 'user/message', time: 1, data: { id: 'u1', content: [{ type: 'text', text }], source: { kind: 'user' } } })
const assistant = (content: unknown[]) => ({ type: 'assistant/message', time: 2, data: { turn: 1, step: 1, message: { role: 'assistant', content } } })

// Captured 2026-10-27 from a DSH 0.2.0-rc.2 session file (session.v4.jsonl.zstd, `zstd -dc`): the
// committed message after a streamed reply. Its own `id` is the message's, not the streaming row's.
const committed = { type: 'assistant/message', seq: 34, time: 1793072590320, data: { turn: 1, step: 4, message: { role: 'assistant', content: [{ type: 'text', text: '$180 ≈ **£140.00 GBP** or **€160.91 EUR**.' }], source: { kind: 'model', provider: 'magpie', model: 'group/auto-deepseek-flash' }, id: 'd114007e-01e4-4946-be24-cde1ac45b58b' } } }

test('the committed message keeps the streaming row\'s id, so a client that merges rows by id sees one reply', () => {
  const s = emptyThread()
  foldStream(s, { type: 'start' })
  foldStream(s, { type: 'chunk', chunk: { type: 'text-delta', text: '$180 ≈' } })
  const streamingId = s.rows[0].id
  foldEvent(s, committed)
  const them = s.rows.filter((r) => r.kind === 'them')
  assert.equal(them.length, 1)
  assert.equal(them[0].id, streamingId)
  assert.equal((them[0] as { text: string }).text, '$180 ≈ **£140.00 GBP** or **€160.91 EUR**.')
  assert.equal(s.streamingId, null)
})

test('snapshot records become rows; runtime context user messages are hidden', () => {
  const s = emptyThread()
  foldSnapshot(s, { header: { cwd: '/w' }, records: [
    { type: 'event', event: user('hi') },
    { type: 'event', event: { type: 'user/message', data: { content: [{ type: 'text', text: 'ctx' }], source: { kind: 'runtime-context' } } } },
    { type: 'event', event: assistant([{ type: 'text', text: 'Hello **you**' }]) },
  ], projections: { values: { title: 'Greeting' } } })
  assert.deepEqual(s.rows.map((r) => r.kind), ['you', 'them'])
  assert.equal(s.cwd, '/w'); assert.equal(s.title, 'Greeting')
})

test('streaming text builds one provisional row that the committed message replaces', () => {
  const s = emptyThread()
  foldStream(s, { type: 'start' })
  assert.equal(s.running, true)
  foldStream(s, { type: 'chunk', chunk: { type: 'text-delta', text: 'Hel' } })
  foldStream(s, { type: 'chunk', chunk: { type: 'text-delta', text: 'lo' } })
  assert.equal(s.rows.length, 1); assert.equal((s.rows[0] as { text: string }).text, 'Hello'); assert.equal((s.rows[0] as { streaming?: boolean }).streaming, true)
  foldEvent(s, assistant([{ type: 'text', text: 'Hello' }]))
  assert.equal(s.rows.length, 1); assert.equal((s.rows[0] as { streaming?: boolean }).streaming, undefined)
  foldEvent(s, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  assert.equal(s.running, false); assert.equal(s.statusText, '')
})

test('tool calls become steps with plain words, results attach to them, ask_user_question is hidden', () => {
  const s = emptyThread()
  foldEvent(s, assistant([
    { type: 'text', text: 'Checking.' },
    { type: 'tool-call', id: 'c1', name: 'bash', arguments: JSON.stringify({ command: 'ls -1', description: 'List files' }) },
    { type: 'tool-call', id: 'c2', name: 'ask_user_question', arguments: '{}' },
  ]))
  assert.deepEqual(s.rows.map((r) => r.kind), ['them', 'step'])
  foldEvent(s, { type: 'tool/result', data: { message: { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'a\nb\n' }] } } })
  const step = s.rows[1] as { description?: string; output?: string }
  assert.equal(step.description, 'List files'); assert.equal(step.output, 'a\nb\n')
  assert.equal(toolWord('mcp__bot__remember', 'en'), 'Remembering')
  assert.equal(toolWord('mcp__bot__remember', 'zh'), '记下来')
  // a connected service's tool says which service, in the person's language; never the tool's own English name
  assert.equal(toolWord('mcp__acme-pages__search_pages', 'en'), 'Using Acme Pages')
  assert.equal(toolWord('mcp__acme-pages__search_pages', 'zh'), '使用 Acme Pages')
  assert.equal(toolWord('mcp__notion__notion-search', 'zh'), '使用 Notion')
  assert.equal(toolWord('mcp__bot__something_new', 'zh'), '处理中')
  assert.equal(toolWord('apply_patch', 'zh'), '处理中')
  assert.equal(toolWord('apply_patch', 'en'), 'Working')
  foldStream(s, { type: 'chunk', chunk: { type: 'tool-call-delta', name: 'web_search' } })
  assert.equal(s.statusText, 'Searching the web…')
})

test('an abandoned attempt drops its provisional row; an error turn adds a notice', () => {
  const s = emptyThread()
  foldStream(s, { type: 'start' }); foldStream(s, { type: 'chunk', chunk: { type: 'text-delta', text: 'x' } })
  foldStream(s, { type: 'end', outcome: { kind: 'abandoned' } })
  assert.equal(s.rows.length, 0)
  foldEvent(s, { type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: { message: 'Insufficient Balance' } } } })
  assert.equal(s.rows[0].kind, 'notice')
})

test('bot-injected prompts (reminders, opening) are hidden; the reply shows', () => {
  const s = emptyThread()
  foldEvent(s, { type: 'user/message', data: { content: [{ type: 'text', text: '⟦bot⟧ [Reminder "Stretch" is due] Stand up' }], source: { kind: 'user' } } })
  foldEvent(s, assistant([{ type: 'text', text: 'Time to stretch.' }]))
  assert.deepEqual(s.rows.map((r) => r.kind), ['them'])
})

// The thread never shows the harness's own words. A turn that fails says what it means
// for the person, in their language, in one line (seen 2026-10-27 on a hosted sandbox without a model key:
// "llm-deepseek: no API key for provider route "deepseek-official"; store DEEPSEEK_API_KEY through …").
test('a failed turn becomes one plain line, never the harness error', async () => {
  const { humanError } = await import('../src/fold.ts')
  const cases: [string, RegExp][] = [
    ['llm-deepseek: no API key for provider route "deepseek-official"; store DEEPSEEK_API_KEY through the credentials service', /no model key/i],
    ['Cannot find package \'openai\' imported from /opt/deepseek-bot/node_modules/x.js', /could not reach its model/i],
    ['model answered 401: Authentication Fails (governor)', /model key was refused/i],
    ['fetch failed', /could not reach its model/i],
  ]
  for (const [raw, want] of cases) {
    const en = humanError(raw, 'en')
    assert.match(en, want, raw)
    assert.doesNotMatch(en, /DEEPSEEK_API_KEY|provider route|node_modules|llm-deepseek|governor/, en)
  }
  assert.match(humanError('llm-deepseek: no API key for provider route', 'zh'), /模型/)
  const s = emptyThread()
  foldEvent(s, { type: 'turn/end', time: 1, data: { reason: { kind: 'error', error: { message: 'llm-deepseek: no API key for provider route "deepseek-official"' } } } })
  const notice = s.rows.find((r) => r.kind === 'notice') as { text: string } | undefined
  assert.ok(notice); assert.doesNotMatch(notice.text, /llm-deepseek|DEEPSEEK_API_KEY/)
})

test('a rate limit reads as busy and retried; only a real balance problem reads as out of credit', async () => {
  const { humanError } = await import('../src/fold.ts')
  const busy = humanError('429 status code (no body)', 'zh')
  assert.match(busy, /太忙/); assert.doesNotMatch(busy, /额度/)
  assert.doesNotMatch(humanError('429 status code (no body)', 'en'), /quota|credit/i)
  assert.match(humanError('402 Insufficient Balance', 'zh'), /余额|额度/)
  assert.match(humanError('insufficient_quota: You exceeded your current quota', 'en'), /credit|quota/i)
})

// What the assistant hands over with DSH's `present` (a `deliverables/presented` event, DSH 0.2.0-rc.2) becomes a
// row of its own per file: an image is shown in the thread, any other file as a card that opens. Before, the event
// was dropped and the owner saw nothing where three charts were (2026-10-27, Android APK).
test('presented files become file rows: path against the session cwd, images marked', () => {
  const s = emptyThread()
  foldSnapshot(s, { header: { cwd: '/data/workspace' }, records: [] })
  foldEvent(s, { type: 'deliverables/presented', time: 5, data: { turn: 1, callId: 'c7', files: [{ path: 'charts/intc.png', description: 'INTC 日线' }, { path: '/data/workspace/report.pdf' }] } })
  assert.deepEqual(s.rows, [
    { kind: 'file', id: 'c7:0', path: '/data/workspace/charts/intc.png', name: 'intc.png', description: 'INTC 日线', image: true, at: 5 },
    { kind: 'file', id: 'c7:1', path: '/data/workspace/report.pdf', name: 'report.pdf', image: false, at: 5 },
  ])
})

// Android pass of 2026-11-02 (APK android-preview-2026-11-01 on the Fly host, real model): "Plan a 2-day Evora trip
// next weekend for me and two friends" got its plan as a table in the reply and, under it, a card for evora_trip.md
// that the assistant had written and presented. The person asked for a plan, not a file. A presented note or script is a card only when the person's words name it or ask for a file; an
// image, and a file only a file can be (a PDF, a spreadsheet, a deck), still show; the rest stay in the Library.
test('a presented note or script the person did not ask for is no card; asked for, or a picture or a PDF, it is', () => {
  const turn = (said: string, files: string[]) => {
    const s = emptyThread()
    s.cwd = '/w'
    foldEvent(s, { type: 'turn/start', time: 1, data: { turn: 1 } })
    foldEvent(s, user(said))
    foldEvent(s, { type: 'deliverables/presented', time: 5, data: { turn: 1, callId: 'p1', files: files.map((path) => ({ path })) } })
    return s.rows.filter((r) => r.kind === 'file').map((r) => (r as { name: string }).name)
  }
  assert.deepEqual(turn('Plan a 2-day Evora trip next weekend for me and two friends', ['evora_trip.md', 'plan.py', 'itinerary.txt']), [])
  assert.deepEqual(turn('Plan a 2-day Evora trip', ['route.png', 'tickets.pdf', 'budget.xlsx']), ['route.png', 'tickets.pdf', 'budget.xlsx'])
  assert.deepEqual(turn('save the plan as evora_trip.md', ['evora_trip.md']), ['evora_trip.md'])
  assert.deepEqual(turn('make a report', ['report.md']), ['report.md'])
  assert.deepEqual(turn('put the itinerary in a file', ['itinerary.md']), ['itinerary.md'])
  assert.deepEqual(turn('把行程写成文档发我', ['行程.md']), ['行程.md'])
  assert.deepEqual(turn('send me the markdown', ['trip.md']), ['trip.md'])
})

// "Write me a haiku and save it as haiku.md": the reply showed the haiku and nothing in the thread opened the file
// (side-by-side run against DS-Bot, 2026-10-27). DSH's own web client lists a turn's files from its successful
// `write`, `edit` and mutating `str_replace_editor` calls (dsh-client-ui-deliverables, `mutationPath`). A file the
// assistant writes on its way (a chart script, notes) is no card: the person did not ask for a file, and the Library
// lists it (2026-10-29, the Android pass carded lisbon_chart.py under a chart). A file the person named gets its card.
const call = (id: string, name: string, args: Record<string, unknown>) => ({ type: 'tool-call', id, name, arguments: JSON.stringify(args) })
const result = (id: string, text: string, isError = false) => ({ type: 'tool/result', time: 6, data: { message: { role: 'tool', toolCallId: id, isError, content: [{ type: 'text', text }] } } })
test('a file the person named becomes a card after the reply when the turn ends; files written on the way do not', () => {
  const s = emptyThread()
  foldEvent(s, user('Write me a haiku and save it as Haiku.md, then tidy my plan'))
  foldSnapshot(s, { header: { cwd: '/data/workspace' }, records: [] })
  foldEvent(s, { type: 'turn/start', time: 3, data: { turn: 1 } })
  foldEvent(s, user('write me a haiku and save it as haiku.md'))
  foldEvent(s, assistant([
    call('w1', 'write', { file_path: 'haiku.md', content: 'old pond' }),
    call('w2', 'write', { file_path: '/data/workspace/notes/plan.md', content: 'x' }),
    call('e1', 'edit', { file_path: 'notes/plan.md', old_string: 'x', new_string: 'y' }),
    call('w3', 'write', { file_path: 'USER.md', content: 'x' }),                // a memory file
    call('w4', 'write', { file_path: '.cache/x.txt', content: 'x' }),           // a hidden folder
    call('w5', 'write', { file_path: '/tmp/scratch.py', content: 'x' }),        // outside the work folder
    call('w6', 'write', { file_path: 'failed.md', content: 'x' }),              // the call failed
    call('s1', 'str_replace_editor', { command: 'view', path: 'haiku.md' }),     // a read
    call('s2', 'str_replace_editor', { command: 'create', path: 'trip/porto.md', file_text: 'x' }),
    call('b1', 'bash', { command: 'echo hi > shell.md' }),                      // not a file tool: the harness cannot know the path
  ]))
  foldEvent(s, result('w1', '<path>/data/workspace/haiku.md</path>\n<type>file</type>\n<content>\nCreated file\n</content>'))
  foldEvent(s, result('w2', '<content>\nUpdated file\n</content>'))
  foldEvent(s, result('e1', 'ok'))
  for (const id of ['w3', 'w4', 'w5', 's1', 's2', 'b1']) foldEvent(s, result(id, 'ok'))
  foldEvent(s, result('w6', 'Permission denied', true))
  // nothing yet: the cards come with the end of the turn, after the reply
  assert.equal(s.rows.filter((r) => r.kind === 'file').length, 0)
  foldEvent(s, assistant([{ type: 'text', text: 'Old pond, a frog jumps. Saved it.' }]))
  foldEvent(s, { type: 'turn/end', time: 9, data: { turn: 1, reason: { kind: 'completed' } } })
  const files = s.rows.filter((r) => r.kind === 'file')
  assert.deepEqual(files.map((r) => [r.path, r.name, (r as { change?: string }).change, r.image]), [
    ['/data/workspace/haiku.md', 'haiku.md', 'new', false],
  ])
  assert.equal(s.rows.findIndex((r) => r.kind === 'file') > s.rows.findIndex((r) => r.kind === 'them'), true, 'the cards come after the reply')
})

test('from a snapshot too: a file the turn also presented gets no second card; a named picture it wrote is a card, not drawn again', () => {
  const s = emptyThread()
  foldSnapshot(s, { header: { cwd: '/w' }, records: [
    { type: 'event', event: { type: 'turn/start', time: 1, data: { turn: 1 } } },
    { type: 'event', event: user('make a report and a logo.svg, and a chart script') },
    { type: 'event', event: assistant([call('w1', 'write', { file_path: 'report.md', content: 'x' }), call('w2', 'write', { file_path: 'logo.svg', content: '<svg/>' }), call('w3', 'write', { file_path: 'chart.py', content: 'x' })]) },
    { type: 'event', event: result('w3', 'Created file') },
    { type: 'event', event: result('w1', 'Created file') },
    { type: 'event', event: result('w2', 'Created file') },
    { type: 'event', event: { type: 'deliverables/presented', time: 7, data: { turn: 1, callId: 'p1', files: [{ path: 'report.md', description: 'The report' }] } } },
    { type: 'event', event: assistant([{ type: 'text', text: 'Done.' }]) },
    { type: 'event', event: { type: 'turn/end', time: 9, data: { turn: 1, reason: { kind: 'completed' } } } },
  ] })
  const files = s.rows.filter((r) => r.kind === 'file')
  assert.deepEqual(files.map((r) => [r.path, r.image, (r as { change?: string }).change]), [['/w/report.md', false, undefined], ['/w/logo.svg', false, 'new']])
})

test('every event type the harness wrote in real sessions is either shown or deliberately ignored; nothing is dropped silently', async () => {
  const { EVENT_COVERAGE } = await import('../src/fold.ts')
  const real = JSON.parse(readFileSync(new URL('./fixtures/harness-event-types.json', import.meta.url), 'utf8')) as { types: string[] }
  const missing = real.types.filter((t) => !(t in EVENT_COVERAGE))
  assert.deepEqual(missing, [], `decide for each: show it in the thread or ignore it with a reason (src/fold.ts EVENT_COVERAGE)`)
})

test('an event type nobody decided on is reported, not swallowed', async () => {
  const { foldEvent, emptyThread } = await import('../src/fold.ts')
  const seen: string[] = []
  foldEvent(emptyThread(), { type: 'brand-new/thing', data: {} }, 'en', (t) => seen.push(t))
  assert.deepEqual(seen, ['brand-new/thing'])
})

test('a model retry and a compaction say so in the status line instead of looking stuck', async () => {
  const { foldEvent, emptyThread } = await import('../src/fold.ts')
  const s = emptyThread(); s.running = true
  assert.equal(foldEvent(s, { type: 'llm/retry', data: { retry: 2, delayMs: 4000, failure: { code: 'RATE_LIMIT' } } }, 'zh'), true)
  assert.match(s.statusText, /忙|重试/)
  foldEvent(s, { type: 'compaction/start', data: {} }, 'zh')
  assert.match(s.statusText, /整理/)
})

// The status line sits beside the name in the header and is one line: on a 320 dp Android screen it showed
// "The model is busy, tr…" and "Tidying up a long co…" (QA, 2026-10-30). 21 characters fit there; 10 in Chinese.
test('the retry and compaction status fits the header on a small phone', async () => {
  const { foldEvent, emptyThread } = await import('../src/fold.ts')
  for (const [lang, max] of [['en', 21], ['zh', 10]] as const) {
    for (const ev of [{ type: 'llm/retry', data: { retry: 12 } }, { type: 'compaction/start', data: {} }]) {
      const s = emptyThread(); s.running = true
      foldEvent(s, ev, lang)
      assert.ok(s.statusText.length <= max, `${lang}: ${s.statusText}`)
    }
  }
})

// Screenshots the assistant takes with its browser (Playwright MCP `browser_take_screenshot`) come back as an image
// part of the tool result: DSH keeps the bytes in its attachment store and the event carries a reference (shape
// measured 2026-10-27). They were dropped: the step said 截图 and nothing showed. Each becomes an
// image row right after its step, fetched through the bot (GET /library/attachment) with the device's token.
test('a browser screenshot in a tool result becomes an image row after its step', () => {
  const s = emptyThread()
  foldEvent(s, assistant([{ type: 'tool-call', id: 'call_9', name: 'mcp__browser__browser_take_screenshot', arguments: '{}' }]))
  foldEvent(s, { type: 'tool/result', time: 9, data: { message: { toolCallId: 'call_9', content: [
    { type: 'text', text: '### Result\n- [Screenshot of viewport](/home/me/.deepseek-bot/browser-output/page-2026-10-27T10-00-00-000Z.png)' },
    { type: 'image', attachment: { attachmentId: 'sha256:2fb36298', mediaType: 'image/png', bytes: 78465, width: 1280, height: 720 } },
  ] } } })
  assert.deepEqual(s.rows.map((r) => r.kind), ['step', 'file'])
  assert.deepEqual(s.rows[1], { kind: 'file', id: 'call_9:img0', path: '/home/me/.deepseek-bot/browser-output/page-2026-10-27T10-00-00-000Z.png', name: 'page-2026-10-27T10-00-00-000Z.png', image: true, attachment: 'sha256:2fb36298', at: 9 })
  // a named one keeps its name; a result without an image adds nothing
  foldEvent(s, assistant([{ type: 'tool-call', id: 'call_10', name: 'mcp__browser__browser_take_screenshot', arguments: '{"filename":"example-com.png"}' }]))
  foldEvent(s, { type: 'tool/result', time: 10, data: { message: { toolCallId: 'call_10', content: [{ type: 'image', attachment: { attachmentId: 'sha256:aa', mediaType: 'image/png', name: 'example-com.png' } }] } } })
  assert.equal((s.rows[3] as { name: string }).name, 'example-com.png')
  foldEvent(s, assistant([{ type: 'tool-call', id: 'call_11', name: 'mcp__browser__browser_navigate', arguments: '{"url":"https://example.com"}' }]))
  foldEvent(s, { type: 'tool/result', time: 11, data: { message: { toolCallId: 'call_11', content: [{ type: 'text', text: 'Page Title: Example Domain' }] } } })
  assert.deepEqual(s.rows.map((r) => r.kind), ['step', 'file', 'step', 'file', 'step'])
})

// QA 2026-10-28: the assistant looked at its chart (`read_image`) or took a browser
// screenshot, then handed the same file over with `present`: the thread showed the image twice, and the first copy
// (an attachment, no file page) opened nothing. The handed-over file takes the place of the look at it.
test('an image the assistant looked at and then presented shows once, as the presented file', () => {
  const s = emptyThread()
  s.cwd = '/home/me/workspace'
  foldEvent(s, user('draw it'))
  foldEvent(s, assistant([{ type: 'tool-call', id: 'r1', name: 'read_image', arguments: '{"path":"lisbon_temp_week.png"}' }]))
  foldEvent(s, { type: 'tool/result', time: 3, data: { message: { toolCallId: 'r1', content: [
    { type: 'text', text: '<path>/home/me/workspace/lisbon_temp_week.png</path>' },
    { type: 'image', attachment: { attachmentId: 'sha256:69c0', mediaType: 'image/png', name: 'lisbon_temp_week.png' } },
  ] } } })
  foldEvent(s, assistant([{ type: 'tool-call', id: 's1', name: 'mcp__browser__browser_take_screenshot', arguments: '{"filename":"example-com.png"}' }]))
  foldEvent(s, { type: 'tool/result', time: 4, data: { message: { toolCallId: 's1', content: [
    // the browser names where it wrote (Playwright MCP with --file-paths absolute); on a laptop its folder is the workspace
    { type: 'text', text: '- [Screenshot of viewport](/home/me/workspace/example-com.png)' },
    { type: 'image', attachment: { attachmentId: 'sha256:aa', mediaType: 'image/png', name: 'example-com.png' } },
  ] } } })
  foldEvent(s, { type: 'deliverables/presented', time: 5, data: { turn: 1, callId: 'p1', files: [{ path: 'lisbon_temp_week.png', description: 'chart' }, { path: '/home/me/workspace/example-com.png' }, { path: 'week1.md' }] } })
  const images = s.rows.filter((r) => r.kind === 'file' && r.image) as { path: string; attachment?: string }[]
  assert.deepEqual(images.map((r) => r.path), ['/home/me/workspace/lisbon_temp_week.png', '/home/me/workspace/example-com.png'])
  assert.equal(images.some((r) => r.attachment), false)
})

// Hosted check 2026-10-29: the assistant looked at an old chart, redrew it under the same name, looked
// again, then presented it. The first look gave way to the presented file and the second stayed: the new chart twice.
test('an image looked at twice and then presented shows once', () => {
  const s = emptyThread()
  s.cwd = '/w'
  foldEvent(s, user('draw me a chart'))
  for (const [id, sha] of [['r1', 'sha256:01d'], ['r2', 'sha256:2e3']]) {
    foldEvent(s, assistant([{ type: 'tool-call', id, name: 'read_image', arguments: '{"path":"chart.png"}' }]))
    foldEvent(s, { type: 'tool/result', time: 3, data: { message: { toolCallId: id, content: [
      { type: 'text', text: '<path>/w/chart.png</path>' },
      { type: 'image', attachment: { attachmentId: sha, mediaType: 'image/png', name: 'chart.png' } },
    ] } } })
  }
  foldEvent(s, { type: 'deliverables/presented', time: 5, data: { turn: 1, callId: 'p1', files: [{ path: 'chart.png' }] } })
  const images = s.rows.filter((r) => r.kind === 'file' && r.image) as { path: string; attachment?: string }[]
  assert.deepEqual(images.map((r) => [r.path, r.attachment]), [['/w/chart.png', undefined]])
})

// The browser saved a new example-com.png in its own folder, the
// workspace still held an older example-com.png from another service, and the assistant presented that one. The
// thread matched them by name, so the new screenshot was replaced by the old file. A look gives way only to the
// same file.
test('a screenshot gives way only to the same file: a presented file of the same name elsewhere does not hide it', () => {
  const s = emptyThread()
  s.cwd = '/data/workspace'
  foldEvent(s, user('用浏览器截一张 example.com 的图'))
  foldEvent(s, assistant([{ type: 'tool-call', id: 's1', name: 'mcp__browser__browser_take_screenshot', arguments: '{"filename":"example-com.png"}' }]))
  foldEvent(s, { type: 'tool/result', time: 4, data: { message: { toolCallId: 's1', content: [
    { type: 'text', text: '- [Screenshot of viewport](/data/browser-broker/example-com.png)' },
    { type: 'image', attachment: { attachmentId: 'sha256:new', mediaType: 'image/png', name: 'example-com.png' } },
  ] } } })
  // read_image of a file of the same name in the workspace is a different file too
  foldEvent(s, assistant([{ type: 'tool-call', id: 'r1', name: 'read_image', arguments: '{"file_path":"example-com.png"}' }]))
  foldEvent(s, { type: 'tool/result', time: 5, data: { message: { toolCallId: 'r1', content: [
    { type: 'text', text: '<path>example-com.png</path>\n<type>image</type>' },
    { type: 'image', attachment: { attachmentId: 'sha256:old', mediaType: 'image/png', name: 'example-com.png' } },
  ] } } })
  foldEvent(s, { type: 'deliverables/presented', time: 6, data: { turn: 1, callId: 'p1', files: [{ path: 'example-com.png' }] } })
  const images = s.rows.filter((r) => r.kind === 'file' && r.image) as { path: string; attachment?: string }[]
  assert.deepEqual(images.map((r) => [r.path, r.attachment]), [
    ['/data/browser-broker/example-com.png', 'sha256:new'],
    ['/data/workspace/example-com.png', undefined],
  ])
})

// The bot saved the screenshot as screenshots/page-….png, the assistant copied it
// to example-com-screenshot.png and presented the copy; the thread showed both. A look gives way to a presented file
// with the same bytes too: the attachment id is the image's sha256 (DSH's attachment store; for a browser screenshot
// it equals the saved file's, measured 2026-10-29 with test/browser-mount.e2e.test.ts).
test('a screenshot gives way to a presented copy of it under another name, and not to another image', () => {
  const s = emptyThread()
  s.cwd = '/data/workspace'
  const files: Record<string, string> = { '/data/workspace/example-com-screenshot.png': 'ab12', '/data/workspace/chart.png': 'cd34' }
  const hashOf = (p: string) => files[p]
  foldEvent(s, user('用浏览器截一张 example.com 的图'), 'zh', undefined, hashOf)
  foldEvent(s, assistant([{ type: 'tool-call', id: 's1', name: 'mcp__browser__browser_take_screenshot', arguments: '{}' }]), 'zh', undefined, hashOf)
  foldEvent(s, { type: 'tool/result', time: 4, data: { message: { toolCallId: 's1', content: [
    { type: 'text', text: '- [Screenshot of viewport](/data/workspace/screenshots/page-1.png)' },
    { type: 'image', attachment: { attachmentId: 'sha256:ab12', mediaType: 'image/png' } },
  ] } } }, 'zh', undefined, hashOf)
  foldEvent(s, { type: 'deliverables/presented', time: 6, data: { turn: 1, callId: 'p1', files: [{ path: 'chart.png' }, { path: 'example-com-screenshot.png' }] } }, 'zh', undefined, hashOf)
  const images = s.rows.filter((r) => r.kind === 'file' && r.image) as { id: string; path: string; attachment?: string }[]
  assert.deepEqual(images.map((r) => [r.id, r.path, r.attachment]), [
    ['s1:img0', '/data/workspace/example-com-screenshot.png', undefined],
    ['p1:0', '/data/workspace/chart.png', undefined],
  ])
})

test('the file hash the thread compares: a regular file only, not through a link, not a huge one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fold-sha-'))
  writeFileSync(join(dir, 'a.png'), 'png bytes')
  symlinkSync(join(dir, 'a.png'), join(dir, 'link.png'))
  assert.equal(fileSha256(join(dir, 'a.png')), createHash('sha256').update('png bytes').digest('hex'))
  assert.equal(fileSha256(join(dir, 'link.png')), undefined)
  assert.equal(fileSha256(join(dir, 'missing.png')), undefined)
  assert.equal(fileSha256(join(dir, 'a.png'), 4), undefined)
})

test('a screenshot the assistant did not present stays in the thread', () => {
  const s = emptyThread()
  foldEvent(s, assistant([{ type: 'tool-call', id: 's1', name: 'mcp__browser__browser_take_screenshot', arguments: '{}' }]))
  foldEvent(s, { type: 'tool/result', time: 4, data: { message: { toolCallId: 's1', content: [{ type: 'image', attachment: { attachmentId: 'sha256:aa', mediaType: 'image/png', name: 'page.png' } }] } } })
  foldEvent(s, { type: 'deliverables/presented', time: 5, data: { turn: 1, callId: 'p1', files: [{ path: 'other.png' }] } })
  assert.equal(s.rows.filter((r) => r.kind === 'file').length, 2)
})

// A task moved to the background keeps the thread "working" until its result comes back.
test('a background task keeps the thread working, says what it is doing, and ends when its settlement notice arrives', () => {
  const s = emptyThread()
  foldEvent(s, { type: 'turn/start', data: { turn: 1 } }, 'zh')
  foldEvent(s, user('帮我比较里斯本到辛特拉的三种走法'), 'zh')
  foldEvent(s, assistant([{ type: 'tool-call', id: 'c1', name: 'subagent_fork', arguments: JSON.stringify({ description: '帮我比较里斯本到辛特拉的三种走法', prompt: '帮我比较里斯本到辛特拉的三种走法' }) }]), 'zh')
  const step = s.rows.find((r) => r.kind === 'step') as { description?: string }
  assert.equal(step.description, '转到后台：帮我比较里斯本到辛特拉的三种走法')
  foldEvent(s, { type: 'tool/result', data: { message: { toolCallId: 'c1', content: [{ type: 'text', text: 'started subagent child-1' }] } } }, 'zh')
  foldEvent(s, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }, 'zh')
  assert.equal(s.running, true, 'still working: the task runs in the background')
  assert.equal(s.statusText, '后台：帮我比较里斯本到辛特拉的三种走法…')
  foldEvent(s, { type: 'turn/start', data: { turn: 2 } }, 'zh')
  foldEvent(s, user('现在里斯本几点？'), 'zh')
  foldEvent(s, assistant([{ type: 'text', text: '凌晨 2:27。' }]), 'zh')
  foldEvent(s, { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } }, 'zh')
  assert.equal(s.running, true, 'the answer did not end the background task')
  foldEvent(s, { type: 'turn/start', data: { turn: 3 } }, 'zh')
  assert.equal(foldEvent(s, { type: 'user/message', data: { content: [{ type: 'text', text: 'Background subagent child-1 finished …' }], source: { kind: 'subagent-settled', senderSessionId: 'child-1' } } }, 'zh'), true)
  assert.ok(!s.rows.some((r) => r.kind === 'you' && r.text.startsWith('Background')), 'the notice is not shown')
  foldEvent(s, assistant([{ type: 'text', text: '比较好了：…' }]), 'zh')
  foldEvent(s, { type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } }, 'zh')
  assert.equal(s.running, false)
  assert.equal(s.statusText, '')
})

// The bot's DSH plugin drops a settlement notice whose result the task already sent (src/dsh-plugin.js), so the notice
// never becomes a user/message; the thread learns the task ended when DSH queues the notice.
test('a background task ends for the thread when its settlement notice is queued, even if it is never answered', () => {
  const s = emptyThread()
  foldEvent(s, { type: 'turn/start', data: { turn: 1 } }, 'en')
  foldEvent(s, assistant([{ type: 'tool-call', id: 'c1', name: 'subagent_fork', arguments: JSON.stringify({ description: 'Compare', prompt: 'Compare' }) }]), 'en')
  foldEvent(s, { type: 'tool/result', data: { message: { toolCallId: 'c1', content: [{ type: 'text', text: 'started subagent child-1' }] } } }, 'en')
  foldEvent(s, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }, 'en')
  assert.equal(s.statusText, 'In the background: Compare…')
  foldEvent(s, { type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, inserted: [{ id: 'n1', role: 'user', content: [{ type: 'text', text: 'Background subagent child-1 finished …' }], source: { kind: 'subagent-settled', senderSessionId: 'child-1' } }] } }, 'en')
  foldEvent(s, { type: 'turn/start', data: { turn: 2 } }, 'en')
  foldEvent(s, { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } }, 'en')
  assert.equal(s.running, false)
  assert.equal(s.statusText, '')
})

// A hosted pass of 2026-10-29 showed 「模型那边忙，正在重试」 19 times and nothing said why: the bot dropped the failure
// DSH records with each retry. The log line carries the provider's status, code and message, with keys masked.
test('a model retry is logged with the provider, status, code and message', () => {
  const line = retryLog({ provider: 'siliconflow', retry: 3, maxRetries: 8, delayMs: 4000, failure: { code: 'RATE_LIMITED', status: 429, message: `Too many requests for key ${'sk-' + 'abcdefghijklmnopqrstuvwxyz'}` } })
  assert.equal(line, '[bot] model retry 3/8 in 4000 ms (siliconflow): 429 RATE_LIMITED Too many requests for key sk-…')
  assert.equal(retryLog({ provider: 'p', retry: 1, delayMs: 10, failure: { code: 'NETWORK', message: 'x'.repeat(400) } }).length < 260, true)
})

// The show call the model makes with its lists as JSON text (2026-10-30) is drawn as the card it describes.
test('a show call whose lists came as JSON text becomes a card row', () => {
  const s = emptyThread()
  foldEvent(s, assistant([{ type: 'tool-call', id: 'c1', name: 'mcp__bot__show', arguments: JSON.stringify({ kind: 'table', title: 'Ways', columns: '["Way","Time"]', rows: '[["Train","3 h"]]', pick: 'true' }) }]), 'en')
  const card = s.rows.find((r) => r.kind === 'card') as { card?: { columns?: unknown; pick?: unknown } } | undefined
  assert.deepEqual(card?.card?.columns, ['Way', 'Time'])
  assert.equal(card?.card?.pick, true)
})

// A turn the computer's restart cut off goes on after it (src/recover.ts): the going-on is the bot's own prompt, so
// the thread does not show it, but its steps are the person's task going on and show as the task's steps did.
test('the turn that goes on after a restart shows its steps, though not the bot\'s prompt', async () => {
  const { RECOVER } = await import('../src/recover.ts')
  const call = assistant([{ type: 'tool-call', id: 'c1', name: 'bash', arguments: { command: 'ls', description: 'look' } }])
  const person = emptyThread(), resumed = emptyThread()
  foldEvent(person, user('compare three routes')); foldEvent(person, call)
  foldEvent(resumed, { type: 'user/message', time: 1, data: { id: 'u2', content: [{ type: 'text', text: RECOVER }], source: { kind: 'user' } } }); foldEvent(resumed, call)
  assert.deepEqual(resumed.rows.map((r) => r.kind), person.rows.map((r) => r.kind).filter((k) => k !== 'you'))
  assert.ok(resumed.rows.length > 0, 'it shows the step')
})
