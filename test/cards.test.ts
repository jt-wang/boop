import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CardSchema, answerText, answerable, cardAnswerPrompt, parseCardAnswer } from '../src/cards.ts'
import { emptyThread, foldEvent, INJECT, type Row } from '../src/fold.ts'

// Generative UI, first layer: the assistant calls `show` with a structured
// card; the thread shows it as a native control; the person's tap comes back
// as a user message the fold turns into an answer on the card plus a `you` row.

const assistant = (content: unknown[]) => ({ type: 'assistant/message', time: 2, data: { message: { role: 'assistant', content } } })
const user = (text: string, id = 'u1') => ({ type: 'user/message', time: 3, data: { id, content: [{ type: 'text', text }], source: { kind: 'user' } } })

test('CardSchema accepts the six kinds and rejects junk', () => {
  for (const c of [
    { kind: 'choices', title: 'Which day?', options: [{ label: 'Thu' }, { label: 'Fri', detail: 'after 3pm' }] },
    { kind: 'form', title: 'Dentist', fields: [{ name: 'when', label: 'When', type: 'time' }, { name: 'note', label: 'Note', type: 'text' }] },
    { kind: 'confirm', title: 'Send the email to Ana?', detail: 'Subject: Invoice 42' },
    { kind: 'table', title: 'Flights', columns: ['Airline', 'Price'], rows: [['TAP', '€120'], ['Ryanair', '€48']] },
    { kind: 'progress', title: 'Website', items: [{ label: 'Scaffold', state: 'done' }, { label: 'Deploy', state: 'doing' }] },
    { kind: 'summary', title: 'Order', items: [{ label: 'Total', value: '€48' }] },
    { kind: 'connect', title: 'Connect Notion', service: 'notion', detail: 'So I can read your pages.' },
  ]) assert.ok(CardSchema.safeParse(c).success, c.kind)
  assert.equal(CardSchema.safeParse({ kind: 'connect', title: 'x', service: 'Not A Service' }).success, false)
  assert.equal(CardSchema.safeParse({ kind: 'choices', title: 'x', options: [] }).success, false)
  assert.equal(CardSchema.safeParse({ kind: 'wat', title: 'x' }).success, false)
})

test('a table with pick is a comparison the person answers by tapping a row: answerable, the answer is the first cell', () => {
  const plain = CardSchema.parse({ kind: 'table', title: 'Ways', columns: ['Way', 'Time'], rows: [['Train', '3 h'], ['Bus', '4 h']] })
  const pick = CardSchema.parse({ kind: 'table', title: 'Ways', columns: ['Way', 'Time'], rows: [['Train', '3 h'], ['Bus', '4 h']], pick: true })
  assert.equal(answerable(plain), false)
  assert.equal(answerable(pick), true)
  assert.equal(answerText(pick, { choice: 'Bus' }), 'Bus')
  assert.equal(answerText(plain, { choice: 'Bus' }), '')
})

test('answerText turns a structured answer into the words the person would have typed', () => {
  const choices = CardSchema.parse({ kind: 'choices', title: 'Which day?', options: [{ label: 'Thu' }, { label: 'Fri' }] })
  assert.equal(answerText(choices, { choice: 'Fri' }), 'Fri')
  assert.equal(answerText(choices, { choices: ['Thu', 'Fri'] }), 'Thu, Fri')
  const form = CardSchema.parse({ kind: 'form', title: 'Dentist', fields: [{ name: 'when', label: 'When', type: 'time' }, { name: 'note', label: 'Note', type: 'text' }] })
  assert.equal(answerText(form, { when: '09:00', note: '' }), 'When: 09:00')
  const confirm = CardSchema.parse({ kind: 'confirm', title: 'Send?' })
  assert.equal(answerText(confirm, { ok: true }), 'Yes'); assert.equal(answerText(confirm, { ok: false }), 'No')
})

test('cardAnswerPrompt / parseCardAnswer round-trip through the bot-injected prefix', () => {
  const p = cardAnswerPrompt('c9', 'Fri')
  assert.ok(p.startsWith(INJECT))
  assert.deepEqual(parseCardAnswer(p), { cardId: 'c9', text: 'Fri' })
  assert.equal(parseCardAnswer(`${INJECT}[Reminder] x`), null)
  assert.equal(parseCardAnswer('Fri'), null)
})

test('fold: a show call becomes a card row, not a step; the answer lands on the card and shows as the person', () => {
  const s = emptyThread()
  foldEvent(s, assistant([
    { type: 'text', text: 'Two options.' },
    { type: 'tool-call', id: 'c9', name: 'mcp__bot__show', arguments: JSON.stringify({ kind: 'choices', title: 'Which day?', options: [{ label: 'Thu' }, { label: 'Fri' }] }) },
  ]))
  assert.deepEqual(s.rows.map((r) => r.kind), ['them', 'card'])
  const card = s.rows[1] as Extract<Row, { kind: 'card' }>
  assert.equal(card.id, 'c9'); assert.equal(card.card.title, 'Which day?'); assert.equal(card.answer, undefined)
  // the tool result is noise
  foldEvent(s, { type: 'tool/result', data: { message: { toolCallId: 'c9', content: [{ type: 'text', text: 'Shown.' }] } } })
  assert.equal(s.rows.length, 2)
  foldEvent(s, user(cardAnswerPrompt('c9', 'Fri')))
  assert.deepEqual(s.rows.map((r) => r.kind), ['them', 'card', 'you'])
  assert.equal((s.rows[1] as Extract<Row, { kind: 'card' }>).answer, 'Fri')
  assert.equal((s.rows[2] as Extract<Row, { kind: 'you' }>).text, 'Fri')
})

test('fold: a malformed show call falls back to a plain step so nothing is lost', () => {
  const s = emptyThread()
  foldEvent(s, assistant([{ type: 'tool-call', id: 'c1', name: 'mcp__bot__show', arguments: '{"kind":"nope"}' }]))
  assert.deepEqual(s.rows.map((r) => r.kind), ['step'])
})

test('fold: steps taken in reply to a bot-injected prompt (opening, reminders) stay hidden; the words show', () => {
  const s = emptyThread()
  foldEvent(s, user(`${INJECT}This is the first time the person opens the app.`, 'i1'))
  foldEvent(s, assistant([{ type: 'tool-call', id: 'c1', name: 'bash', arguments: '{"command":"cat USER.md"}' }]))
  foldEvent(s, assistant([{ type: 'text', text: "I'm Nori." }]))
  assert.deepEqual(s.rows.map((r) => r.kind), ['them'])
  // a real message from the person makes steps visible again
  foldEvent(s, user('Call me Sam', 'u2'))
  foldEvent(s, assistant([{ type: 'tool-call', id: 'c2', name: 'mcp__bot__remember', arguments: '{"fact":"Sam"}' }]))
  assert.deepEqual(s.rows.map((r) => r.kind), ['them', 'you', 'step'])
})

test('fold: a step sets the status line to its own words (the description), not the tool name', () => {
  const s = emptyThread()
  foldEvent(s, user('Count my downloads', 'u3'))
  foldEvent(s, assistant([{ type: 'tool-call', id: 'c1', name: 'bash', arguments: JSON.stringify({ command: 'ls ~/Downloads | wc -l', description: 'Counting the files in Downloads' }) }]))
  assert.equal(s.statusText, 'Counting the files in Downloads…')
  foldEvent(s, assistant([{ type: 'tool-call', id: 'c2', name: 'web_search', arguments: JSON.stringify({ query: 'x' }) }]))
  assert.equal(s.statusText, 'Searching the web…')
})
