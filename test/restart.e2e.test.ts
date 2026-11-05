import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { startScriptedModel, text, type Msg } from './fixtures/scripted-model.ts'
import { ThreadView } from './threadview.ts'

// A turn the computer's restart cut off goes on after the restart. DSH's own
// crash recovery closes the open turn with "interrupted" tool results and starts nothing; dsh-superagent
// (deepseek-ai/dsh-superagent-prototype, docs/003-execution.md "Restart") starts interrupted work again with a
// recovery note. Before this, a deploy, a model switch under the supervisor or a crash during a turn left the person
// with no reply. Needs only this machine.
const run = process.env.DEEPSEEK_BOT_E2E === '1' || process.env.DEEPSEEK_BOT_E2E_MODEL === '1'

function start(home: string, modelUrl: string) {
  // its own process group, so a "machine restart" can take the bot and its harness down together
  const bot: ChildProcess = spawn(process.execPath, ['src/main.ts', '--home', home, '--host', '127.0.0.1', '--port', '0', '--model', 'scripted/scripted', '--base-url', modelUrl, '--api-key-env', 'DEEPSEEK_BOT_MODEL_KEY'], { stdio: ['pipe', 'pipe', 'pipe'], detached: true, env: { ...process.env, DEEPSEEK_BOT_MODEL_KEY: 'local' } })
  const state = { out: '' }
  bot.stdout!.on('data', (d) => { state.out += d }); bot.stderr!.on('data', (d) => { state.out += d })
  return { bot, state }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function origin(state: { out: string }) {
  for (let i = 0; i < 300; i++) {
    const m = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(state.out) ?? /(http:\/\/127\.0\.0\.1:\d+)\/pair\?code=/.exec(state.out)
    if (m && /listening to the assistant/.test(state.out)) return m[1]
    await sleep(200)
  }
  assert.fail(state.out)
}
const exited = (bot: ChildProcess) => new Promise<void>((r) => { if (bot.exitCode !== null || bot.signalCode !== null) r(); else bot.once('exit', () => r()) })

for (const how of ['SIGKILL', 'SIGTERM'] as const) {
  test(`a turn cut off by a restart (${how}) goes on after it, and its reply reaches the thread`, { skip: !run, timeout: 300_000 }, async () => {
    const model = await startScriptedModel([
      { name: 'bash', arguments: { command: 'sleep 60; echo FIRST-DONE', description: 'wait' } },
      { text: 'RECOVERED-7720' },
    ])
    const home = mkdtempSync(join(tmpdir(), 'bot-restart-'))
    let a = start(home, model.url)
    let b: ReturnType<typeof start> | undefined
    let ws: WebSocket | undefined
    try {
      let pair = ''
      for (let i = 0; i < 300 && !pair; i++) { const m = /(http:\/\/[^\s]+\/pair\?code=\d{6})/.exec(a.state.out); if (m) pair = m[1]; else await sleep(200) }
      assert.ok(pair, a.state.out)
      await origin(a.state)
      const u = new URL(pair)
      const { token } = await (await fetch(`${u.origin}/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: u.searchParams.get('code'), name: 'e2e' }) })).json() as { token: string }
      const h = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
      await fetch(`${u.origin}/consent`, { method: 'PUT', headers: h, body: JSON.stringify({ ai: true, age: 'adult' }) })
      const t = await (await fetch(`${u.origin}/threads`, { method: 'POST', headers: h, body: JSON.stringify({}) })).json() as { sessionId: string }
      assert.equal((await fetch(`${u.origin}/threads/${t.sessionId}/messages`, { method: 'POST', headers: h, body: JSON.stringify({ text: 'LONG-TASK' }) })).status, 200)
      for (let i = 0; i < 100 && !model.results.length && model.requests.length < 1; i++) await sleep(200)
      await sleep(4000) // the command is running
      const before = model.requests.length
      if (how === 'SIGKILL') process.kill(-a.bot.pid!, 'SIGKILL') // the machine went away: bot and harness at once
      else a.bot.kill('SIGTERM') // a deploy: the bot is asked to stop
      await exited(a.bot)
      if (how === 'SIGKILL') await sleep(500)

      b = start(home, model.url)
      const o = await origin(b.state)
      const view = new ThreadView(t.sessionId)
      ws = new WebSocket(`${o.replace('http', 'ws')}/events`, ['bearer', token])
      ws.on('message', (m) => view.apply(JSON.parse(m.toString())))
      await new Promise<void>((r, j) => { ws!.on('open', () => { ws!.send(JSON.stringify({ type: 'follow', sessionId: t.sessionId, lang: 'en' })); r() }); ws!.on('error', j) })
      const reply = () => view.rows().filter((r) => r.kind === 'them').map((r) => r.text ?? '').join('\n')
      for (let i = 0; i < 120 && !reply().includes('RECOVERED-7720'); i++) await sleep(500)
      const after = (model.requests.slice(before) as { messages: Msg[] }[]).filter((r) => r.messages.some((m) => m.role === 'user' && text(m.content).includes('LONG-TASK')))
      assert.ok(after.length, `the model was asked again about the interrupted task after the restart\n${b.state.out.slice(-3000)}`)
      assert.ok(reply().includes('RECOVERED-7720'), `the reply reached the thread (rows: ${JSON.stringify(view.rows().map((r) => [r.kind, r.text?.slice(0, 60)]))})`)
      assert.ok(!view.rows().some((r) => /computer restarted|recovery/i.test(r.text ?? '')), 'the thread shows no internal note')
      // once is enough: another restart does not start the finished task again
      const n = model.requests.length
      ws.close(); ws = undefined
      b.bot.kill('SIGTERM'); await exited(b.bot)
      b = start(home, model.url); await origin(b.state); await sleep(5000)
      assert.equal(model.requests.length, n, 'a finished turn is not started again by a later restart')
    } finally {
      ws?.close()
      for (const p of [a, b]) if (p && p.bot.exitCode === null && p.bot.signalCode === null) { try { process.kill(-p.bot.pid!, 'SIGTERM') } catch {} ; await exited(p.bot) }
      await model.close()
    }
  })
}

// A background task the restart cut off goes on too, and its result still reaches the thread.
test('a background task cut off by a restart goes on after it, and its result reaches the thread', { skip: !run, timeout: 300_000 }, async () => {
  const model = await startScriptedModel([], '127.0.0.1', {
    respond: ({ messages, task }) => {
      const all = JSON.stringify(messages)
      const newest = text(messages[messages.length - 1]?.content)
      if (task) return all.includes('The computer restarted') ? { text: 'TASK-RESULT-8810' } : messages.some((m) => m.role === 'tool' && /started subagent/.test(text(m.content))) && !messages.slice(messages.findLastIndex((m) => m.role === 'user' && text(m.content).includes('TASK-WORK'))).some((m) => m.role === 'assistant') ? { name: 'bash', arguments: { command: 'sleep 60; echo TASK-DONE', description: 'wait' } } : { name: 'bash', arguments: { command: 'sleep 60; echo TASK-DONE', description: 'wait' } }
      if (/^(Agent \S+ sent a message|Background subagent)/.test(newest)) return { text: `RELAY:${newest.includes('TASK-RESULT-8810') ? 'TASK-RESULT-8810' : 'OTHER'}` }
      if (all.includes('LONG-TASK') && !all.includes('started subagent')) return { name: 'subagent_fork', arguments: { description: 'long work', prompt: 'TASK-WORK' } }
      return { text: 'done' }
    },
  })
  const home = mkdtempSync(join(tmpdir(), 'bot-restart-task-'))
  const a = start(home, model.url)
  let b: ReturnType<typeof start> | undefined
  let ws: WebSocket | undefined
  const isTask = (r: unknown) => JSON.stringify(r).includes('You are a delegated subagent')
  try {
    let pair = ''
    for (let i = 0; i < 300 && !pair; i++) { const m = /(http:\/\/[^\s]+\/pair\?code=\d{6})/.exec(a.state.out); if (m) pair = m[1]; else await sleep(200) }
    await origin(a.state)
    const u = new URL(pair)
    const { token } = await (await fetch(`${u.origin}/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: u.searchParams.get('code'), name: 'e2e' }) })).json() as { token: string }
    const h = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
    await fetch(`${u.origin}/consent`, { method: 'PUT', headers: h, body: JSON.stringify({ ai: true, age: 'adult' }) })
    const t = await (await fetch(`${u.origin}/threads`, { method: 'POST', headers: h, body: JSON.stringify({}) })).json() as { sessionId: string }
    assert.equal((await fetch(`${u.origin}/threads/${t.sessionId}/messages`, { method: 'POST', headers: h, body: JSON.stringify({ text: 'LONG-TASK' }) })).status, 200)
    for (let i = 0; i < 100 && !model.requests.some(isTask); i++) await sleep(200)
    assert.ok(model.requests.some(isTask), 'the task started')
    await sleep(4000) // the task's command is running
    process.kill(-a.bot.pid!, 'SIGKILL'); await exited(a.bot); await sleep(500)

    b = start(home, model.url)
    const o = await origin(b.state)
    const view = new ThreadView(t.sessionId)
    ws = new WebSocket(`${o.replace('http', 'ws')}/events`, ['bearer', token])
    ws.on('message', (m) => view.apply(JSON.parse(m.toString())))
    await new Promise<void>((r, j) => { ws!.on('open', () => { ws!.send(JSON.stringify({ type: 'follow', sessionId: t.sessionId, lang: 'en' })); r() }); ws!.on('error', j) })
    const reply = () => view.rows().filter((r) => r.kind === 'them').map((r) => r.text ?? '').join('\n')
    for (let i = 0; i < 120 && !reply().includes('RELAY:TASK-RESULT-8810'); i++) await sleep(500)
    assert.ok(reply().includes('RELAY:TASK-RESULT-8810'), `the task went on and its result reached the thread (rows: ${JSON.stringify(view.rows().map((r) => [r.kind, r.text?.slice(0, 60)]))})\n${b.state.out.slice(-3000)}`)
  } finally {
    ws?.close()
    for (const p of [a, b]) if (p && p.bot.exitCode === null && p.bot.signalCode === null) { try { process.kill(-p.bot.pid!, 'SIGTERM') } catch {} ; await exited(p.bot) }
    await model.close()
  }
})

// A command left running in the background dies with the computer, and DSH's notice for it never comes.
test('a thread waiting on a background command the restart killed goes on after it', { skip: !run, timeout: 300_000 }, async () => {
  const model = await startScriptedModel([], '127.0.0.1', {
    respond: ({ messages }) => {
      const all = JSON.stringify(messages)
      if (all.includes('The computer restarted')) return { text: 'JOB-RECOVERED-3391' }
      if (all.includes('started background job')) return { text: 'WAITING-FOR-IT' }
      if (all.includes('LONG-TASK')) return { name: 'bash', arguments: { command: 'sleep 90; echo BUILT', description: 'build', run_in_background: true } }
      return { text: 'done' }
    },
  })
  const home = mkdtempSync(join(tmpdir(), 'bot-restart-job-'))
  const a = start(home, model.url)
  let b: ReturnType<typeof start> | undefined
  let ws: WebSocket | undefined
  try {
    let pair = ''
    for (let i = 0; i < 300 && !pair; i++) { const m = /(http:\/\/[^\s]+\/pair\?code=\d{6})/.exec(a.state.out); if (m) pair = m[1]; else await sleep(200) }
    await origin(a.state)
    const u = new URL(pair)
    const { token } = await (await fetch(`${u.origin}/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: u.searchParams.get('code'), name: 'e2e' }) })).json() as { token: string }
    const h = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
    await fetch(`${u.origin}/consent`, { method: 'PUT', headers: h, body: JSON.stringify({ ai: true, age: 'adult' }) })
    const t = await (await fetch(`${u.origin}/threads`, { method: 'POST', headers: h, body: JSON.stringify({}) })).json() as { sessionId: string }
    assert.equal((await fetch(`${u.origin}/threads/${t.sessionId}/messages`, { method: 'POST', headers: h, body: JSON.stringify({ text: 'LONG-TASK' }) })).status, 200)
    for (let i = 0; i < 100 && !model.answers.some((x) => x.text === 'WAITING-FOR-IT'); i++) await sleep(200)
    assert.ok(model.answers.some((x) => x.text === 'WAITING-FOR-IT'), 'the turn ended with the command in the background')
    await sleep(1500)
    process.kill(-a.bot.pid!, 'SIGKILL'); await exited(a.bot); await sleep(500)

    b = start(home, model.url)
    const o = await origin(b.state)
    const view = new ThreadView(t.sessionId)
    ws = new WebSocket(`${o.replace('http', 'ws')}/events`, ['bearer', token])
    ws.on('message', (m) => view.apply(JSON.parse(m.toString())))
    await new Promise<void>((r, j) => { ws!.on('open', () => { ws!.send(JSON.stringify({ type: 'follow', sessionId: t.sessionId, lang: 'en' })); r() }); ws!.on('error', j) })
    const reply = () => view.rows().filter((r) => r.kind === 'them').map((r) => r.text ?? '').join('\n')
    for (let i = 0; i < 60 && !reply().includes('JOB-RECOVERED-3391'); i++) await sleep(500)
    assert.ok(reply().includes('JOB-RECOVERED-3391'), `the thread went on (rows: ${JSON.stringify(view.rows().map((r) => [r.kind, r.text?.slice(0, 60)]))})\n${b.state.out.slice(-2000)}`)
  } finally {
    ws?.close()
    for (const p of [a, b]) if (p && p.bot.exitCode === null && p.bot.signalCode === null) { try { process.kill(-p.bot.pid!, 'SIGTERM') } catch {} ; await exited(p.bot) }
    await model.close()
  }
})
