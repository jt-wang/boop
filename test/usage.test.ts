import { test } from 'node:test'
import assert from 'node:assert/strict'
import { summarize, startOfToday, usage } from '../src/usage.ts'

test('summarize totals today\'s sessions from the harness projections', () => {
  const day = Date.UTC(2026, 9, 27)
  const items = [
    { sessionId: 'a', updatedAt: day + 3600_000, projections: { values: { title: 'Trip', tokenUsage: { uncachedInputTokens: 1000, outputTokens: 200, cacheReadTokens: 5000 }, sessionStats: { turns: 3 } } } },
    { sessionId: 'b', updatedAt: day - 3600_000, projections: { values: { tokenUsage: { uncachedInputTokens: 10, outputTokens: 1, cacheReadTokens: 0 } } } },
    { sessionId: 'c', updatedAt: day + 7200_000 },
  ]
  const u = summarize(items, day)
  assert.deepEqual(u.today, { inputTokens: 1000, cachedTokens: 5000, outputTokens: 200, sessions: 2 })
  assert.deepEqual(u.sessions.map((s) => s.sessionId), ['c', 'a', 'b'])
  assert.equal(u.sessions[1].title, 'Trip'); assert.equal(u.sessions[1].turns, 3)
})

test('startOfToday respects the time zone', () => {
  const now = Date.UTC(2026, 9, 27, 1, 0) // 02:00 Berlin on the 27th; still the 26th in Los Angeles
  assert.equal(startOfToday(now, 'Europe/Berlin'), Date.UTC(2026, 9, 26, 23, 0))
  assert.equal(startOfToday(now, 'America/Los_Angeles'), Date.UTC(2026, 9, 26, 7, 0))
})

test('usage() asks the harness for the session list', async () => {
  const calls: string[] = []
  const u = await usage({ rpc: async (m: string) => { calls.push(m); return { items: [] } as never } })
  assert.deepEqual(calls, ['session/list']); assert.equal(u.today.sessions, 0)
})

// QA 2026-10-30 (iOS, Chinese): Usage listed the main chat's background tasks as threads of their own, titled
// "You are researching actual travel" and 「小诺初次问候用户」 (a fork carries the main chat's first prompt). A
// background task is part of its thread: its tokens count on the thread that started it.
test('summarize counts a background task on the thread that started it, never as a row of its own', () => {
  const day = Date.UTC(2026, 9, 30)
  const tokens = (i: number, o: number, c: number) => ({ uncachedInputTokens: i, outputTokens: o, cacheReadTokens: c })
  const items = [
    { sessionId: 'main', updatedAt: day + 1000, projections: { values: { title: '小诺初次问候用户', tokenUsage: tokens(100, 10, 1000), sessionStats: { turns: 5 } } } },
    { sessionId: 'task', updatedAt: day + 9000, origin: 'subagent', parentSessionId: 'main', projections: { values: { title: 'You are researching actual travel', tokenUsage: tokens(50, 5, 500), sessionStats: { turns: 1 } } } },
    { sessionId: 'task-of-task', updatedAt: day + 5000, origin: 'subagent', parentSessionId: 'task', projections: { values: { title: '小诺初次问候用户', tokenUsage: tokens(1, 1, 1) } } },
    { sessionId: 'side', updatedAt: day + 2000, projections: { values: { title: 'Trip plan', tokenUsage: tokens(7, 7, 7) } } },
  ]
  const u = summarize(items, day)
  assert.deepEqual(u.sessions.map((s) => s.sessionId), ['main', 'side'])
  assert.deepEqual(u.sessions[0], { sessionId: 'main', title: '小诺初次问候用户', updatedAt: day + 9000, inputTokens: 151, cachedTokens: 1501, outputTokens: 16, turns: 5 })
  assert.deepEqual(u.today, { inputTokens: 158, cachedTokens: 1508, outputTokens: 23, sessions: 2 })
})

test('summarize puts a background task whose thread is gone on that thread\'s row, untitled', () => {
  const items = [{ sessionId: 'task', updatedAt: 10, origin: 'subagent', parentSessionId: 'gone', projections: { values: { title: 'You are researching actual travel', tokenUsage: { uncachedInputTokens: 3 } } } }]
  assert.deepEqual(summarize(items, 0).sessions, [{ sessionId: 'gone', title: undefined, updatedAt: 10, inputTokens: 3, cachedTokens: 0, outputTokens: 0, turns: 0 }])
})
