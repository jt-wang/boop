import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cutOff, lostJob, RECOVER } from '../src/recover.ts'

const ev = (type: string, data: Record<string, unknown> = {}) => ({ type: 'event', event: { type, data } })
const user = (text: string) => ev('user/message', { content: [{ type: 'text', text }] })
const end = (kind: string) => ev('turn/end', { turn: 1, reason: { kind } })

test('a turn the restart cut off is one to go on with', () => {
  assert.equal(cutOff([user('compare three routes'), ev('turn/start'), ev('tool/call'), end('interrupted')]), true)
})

test('a turn that ended any other way is left alone: done, stopped by the person, an error, waiting on a question', () => {
  for (const kind of ['completed', 'aborted', 'error', 'blocked', 'max-tokens']) assert.equal(cutOff([user('x'), ev('turn/start'), end(kind)]), false, kind)
})

test('only the last turn counts, and a session with no turn is left alone', () => {
  assert.equal(cutOff([user('a'), ev('turn/start'), end('interrupted'), user('b'), ev('turn/start'), end('completed')]), false)
  assert.equal(cutOff([]), false)
})

test('a turn that was itself the going-on is not started a third time, so a computer that keeps restarting does not loop', () => {
  assert.equal(cutOff([user('a'), ev('turn/start'), end('interrupted'), user(RECOVER), ev('turn/start'), end('interrupted')]), false)
})

// A job dies with the process (dsh-jobs: "Jobs managed by the shipped in-process registry die with the harness
// process"), so DSH's completion notice for it never comes and nothing wakes the session that waits for it.
const result = (callId: string, t: string) => ev('tool/result', { message: { toolCallId: callId, content: [{ type: 'text', text: t }] } })
const calls = (...c: { id: string; name: string; arguments?: Record<string, unknown> }[]) => ev('assistant/message', { message: { content: c.map((x) => ({ type: 'tool-call', ...x })) } })
const promoted = [user('build it'), ev('turn/start'), calls({ id: 'c1', name: 'bash' }), result('c1', 'out\n[still running after 60000ms; moved to background job bash-1]\nThe command keeps running'), end('completed')]

test('a session waiting on a job the restart killed is one to go on with', () => {
  assert.equal(lostJob(promoted), true)
  assert.equal(lostJob([user('x'), ev('turn/start'), calls({ id: 'c1', name: 'bash' }), result('c1', 'started background job bash-2'), end('completed')]), true)
})

test('a job whose end the session heard of, read, moved away or already went on from is not lost', () => {
  assert.equal(lostJob([...promoted, ev('user/message', { source: { kind: 'tool-jobs' }, content: [{ type: 'text', text: 'background job bash-1 (bash: make) finished [status: completed]. Read its output with job_output.' }] })]), false, 'its notice came')
  assert.equal(lostJob([...promoted, user('Agent session-1 sent a message: background job bash-1 (bash: make) finished [status: completed]')]), false, 'its notice came through the thread')
  assert.equal(lostJob([...promoted.slice(0, -1), calls({ id: 'c2', name: 'job_output', arguments: { job_id: 'bash-1', wait: true } }), result('c2', 'done\n[status: completed, exit code: 0]'), end('completed')]), false, 'it read the end')
  assert.equal(lostJob([...promoted.slice(0, -1), calls({ id: 'call_bg_x1', name: 'subagent_fork' }), result('call_bg_x1', 'started subagent t1'), end('completed')]), false, 'it moved with the work')
  assert.equal(lostJob([...promoted, user(RECOVER), ev('turn/start'), end('completed')]), false, 'it already went on once')
  assert.equal(lostJob([user('x'), ev('turn/start'), end('completed')]), false)
})
