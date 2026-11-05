import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { ThreadView } from './threadview.ts'

// The thread as a test client sees it over /events. Every socket also gets
// status frames for the person's other sessions (the app filters them by
// sessionId, mobile/src/state.ts apply). The eval did not: with three threads
// in flight, one thread's "running: false" ended the wait of the others, which
// were recorded as turns with no reply. Fixture: real frames from that run.
const fx = JSON.parse(readFileSync(new URL('./fixtures/concurrent-follow.json', import.meta.url), 'utf8')) as { sessionId: string; frames: ({ ms: number } & Record<string, unknown>)[] }

const replay = (uptoMs: number) => {
  const v = new ThreadView(fx.sessionId)
  for (const f of fx.frames) if (f.ms <= uptoMs) v.apply(f)
  return v
}

test('another session finishing does not end this thread\'s turn', () => {
  const foreignEnd = fx.frames.find((f) => f.type === 'status' && f.sessionId !== fx.sessionId && f.running === false)!
  assert.ok(foreignEnd, 'the fixture has another session ending first')
  const v = replay(foreignEnd.ms + 500)
  assert.equal(v.turnOver(), false)
  assert.equal(v.replyText(), '')
})

test('this thread\'s own running → not running ends the turn, with the reply as the app shows it', () => {
  const v = replay(Infinity)
  assert.equal(v.turnOver(), true)
  const them = v.rows().filter((r) => r.kind === 'them')
  assert.equal(them.length, 1)
  assert.ok(v.replyText().length > 100, v.replyText())
  assert.ok(v.rows().every((r) => r.id), 'rows keep ids')
})

test('nextTurn: the rows stay, the turn is over only after this thread runs and stops again', () => {
  const v = new ThreadView('s1')
  v.apply({ type: 'snapshot', sessionId: 's1', rows: [{ kind: 'card', id: 'c1' }], running: false })
  v.apply({ type: 'status', sessionId: 's1', running: true })
  v.apply({ type: 'status', sessionId: 's1', running: false })
  assert.equal(v.turnOver(), true)
  v.nextTurn()
  assert.equal(v.turnOver(), false)
  assert.equal(v.rows().length, 1)
  v.apply({ type: 'status', sessionId: 's1', running: true })
  v.apply({ type: 'status', sessionId: 's1', running: false })
  assert.equal(v.turnOver(), true)
})

test('frames of other sessions never touch the rows; a snapshot replaces, rows merge, deltas append', () => {
  const v = new ThreadView('s1')
  v.apply({ type: 'snapshot', sessionId: 's1', rows: [{ kind: 'you', id: 'u', text: 'hi' }], running: false })
  v.apply({ type: 'rows', sessionId: 's2', rows: [{ kind: 'them', id: 'x', text: 'not mine' }] })
  v.apply({ type: 'status', sessionId: 's1', running: true })
  v.apply({ type: 'rows', sessionId: 's1', rows: [{ kind: 'them', id: 'a', text: 'He', streaming: true }] })
  v.apply({ type: 'delta', sessionId: 's1', rowId: 'a', text: 'llo' })
  v.apply({ type: 'status', sessionId: 's2', running: false })
  assert.equal(v.turnOver(), false)
  v.apply({ type: 'rows', sessionId: 's1', rows: [{ kind: 'them', id: 'a', text: 'Hello!' }] })
  v.apply({ type: 'status', sessionId: 's1', running: false })
  assert.equal(v.turnOver(), true)
  assert.deepEqual(v.rows().map((r) => [r.kind, r.text]), [['you', 'hi'], ['them', 'Hello!']])
})
