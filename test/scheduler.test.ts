import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Scheduler, nextRun } from '../src/scheduler.ts'

test('nextRun: once in the future, every from the previous run, daily in a time zone across a clock change', () => {
  const now = Date.UTC(2026, 9, 27, 13, 0) // 2026-10-27T13:00Z = 09:00 New York
  assert.equal(nextRun({ kind: 'once', at: '2026-10-27T14:00:00Z' }, now, undefined), now + 3600_000)
  assert.equal(nextRun({ kind: 'once', at: '2026-10-26T01:00:00Z' }, now, undefined), null)
  assert.equal(nextRun({ kind: 'every', seconds: 600 }, now, now - 300_000), now + 300_000)
  // 09:30 New York today is 13:30Z; 08:00 New York already passed → tomorrow 12:00Z
  assert.equal(nextRun({ kind: 'daily', time: '09:30', timeZone: 'America/New_York' }, now, undefined), now + 1800_000)
  assert.equal(nextRun({ kind: 'daily', time: '08:00', timeZone: 'America/New_York' }, now, undefined), Date.UTC(2026, 9, 28, 12, 0))
  // weekly: 2026-10-27 is a Tuesday (ISO 2); next Monday 10:00 New York, after the clocks changed on Nov 1, = 2026-11-02T15:00Z
  assert.equal(nextRun({ kind: 'weekly', time: '10:00', timeZone: 'America/New_York', weekdays: [1] }, now, undefined), Date.UTC(2026, 10, 2, 15, 0))
})

test('tick fires due tasks once, re-arms recurring ones, deactivates one-shots', async () => {
  let t = Date.UTC(2026, 9, 27, 0, 0)
  const fired: string[] = []
  const s = await Scheduler.open(join(mkdtempSync(join(tmpdir(), 'sched-')), 'schedules.json'), { now: () => t, onDue: async (task) => { fired.push(task.name) } })
  await s.create({ name: 'once', instruction: 'a', when: { kind: 'once', at: new Date(t + 60_000).toISOString() } })
  await s.create({ name: 'every', instruction: 'b', when: { kind: 'every', seconds: 120 } })
  assert.deepEqual(await s.tick(), [])
  t += 60_000
  assert.deepEqual((await s.tick()).map((x) => x.name), ['once'])
  assert.equal(s.list().find((x) => x.name === 'once')!.active, false)
  t += 60_000
  assert.deepEqual((await s.tick()).map((x) => x.name), ['every'])
  assert.equal(s.list().find((x) => x.name === 'every')!.nextRunAt, new Date(t + 120_000).toISOString())
  assert.deepEqual(await s.tick(), [])
  assert.deepEqual(fired, ['once', 'every'])
})
