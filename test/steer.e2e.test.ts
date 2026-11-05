import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { startScriptedModel, text, type Msg } from './fixtures/scripted-model.ts'
import { ThreadView } from './threadview.ts'

// A message sent while the assistant is in the middle of a task reaches it at its next step,
// not after the whole task ends (the owner's session on 2026-10-27 had a 323 s turn during which
// a new message just waited). The scripted model runs a 20 s command; the second message is sent
// during it; the model's very next request must already contain it.
// Needs only this machine. Skipped unless DEEPSEEK_BOT_E2E=1 or DEEPSEEK_BOT_E2E_MODEL=1.
const run = process.env.DEEPSEEK_BOT_E2E === '1' || process.env.DEEPSEEK_BOT_E2E_MODEL === '1'

// Since the hand-off the message no longer joins the running step: at the
// step boundary the task moves to a background task with the command's result, and the conversation's next turn
// has the message. Before, this test wanted both in one request (4c3b9a8, 2026-10-27).
test('a message sent mid-task reaches the assistant at its next step, and the task goes on in the background', { skip: !run, timeout: 300_000 }, async () => {
  const model = await startScriptedModel([{ name: 'bash', arguments: { command: 'sleep 20; echo FIRST-DONE', description: 'wait' } }])
  const home = mkdtempSync(join(tmpdir(), 'bot-steer-'))
  const bot: ChildProcess = spawn(process.execPath, ['src/main.ts', '--home', home, '--host', '127.0.0.1', '--port', '0', '--model', 'scripted/scripted', '--base-url', model.url, '--api-key-env', 'DEEPSEEK_BOT_MODEL_KEY'], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, DEEPSEEK_BOT_MODEL_KEY: 'local' } })
  let out = ''
  bot.stdout!.on('data', (d) => { out += d }); bot.stderr!.on('data', (d) => { out += d })
  const agentRequests = () => model.requests.filter((r) => Array.isArray((r as { tools?: unknown[] }).tools) && (r as { tools?: unknown[] }).tools!.length) as { messages: { role: string; content?: unknown }[] }[]
  const says = (r: { messages: { content?: unknown }[] }, s: string) => JSON.stringify(r.messages).includes(s)
  try {
    let pair = ''
    for (let i = 0; i < 300 && !pair; i++) { const m = /(http:\/\/[^\s]+\/pair\?code=\d{6})/.exec(out); if (m) pair = m[1]; else await new Promise((r) => setTimeout(r, 200)) }
    assert.ok(pair, out)
    for (let i = 0; i < 100 && !/listening to the assistant/.test(out); i++) await new Promise((r) => setTimeout(r, 200))
    const u = new URL(pair)
    const { token } = await (await fetch(`${u.origin}/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: u.searchParams.get('code'), name: 'e2e' }) })).json() as { token: string }
    const h = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
    await fetch(`${u.origin}/consent`, { method: 'PUT', headers: h, body: JSON.stringify({ ai: true, age: 'adult' }) }) // the person agreed to the AI provider
    const t = await (await fetch(`${u.origin}/threads`, { method: 'POST', headers: h, body: JSON.stringify({}) })).json() as { sessionId: string }
    const send = (text: string) => fetch(`${u.origin}/threads/${t.sessionId}/messages`, { method: 'POST', headers: h, body: JSON.stringify({ text }) })
    assert.equal((await send('FIRST-TASK')).status, 200)
    for (let i = 0; i < 100 && agentRequests().length < 1; i++) await new Promise((r) => setTimeout(r, 200))
    await new Promise((r) => setTimeout(r, 3000)) // the command is running now
    assert.equal((await send('SECOND-7731')).status, 200)
    const isTask = (r: { messages: unknown[] }) => says(r, 'You are a delegated subagent')
    const conversation = () => agentRequests().filter((r) => !isTask(r))
    for (let i = 0; i < 120 && !conversation().slice(1).some((r) => says(r, 'SECOND-7731')); i++) await new Promise((r) => setTimeout(r, 500))
    assert.ok(conversation().slice(1).some((r) => says(r, 'SECOND-7731')), 'the conversation was asked again with the message sent during the command')
    const next = conversation().slice(1).find((r) => says(r, 'SECOND-7731'))!
    const handoff = next.messages.find((m) => m.role === 'tool' && /started subagent/.test(JSON.stringify(m.content)))
    assert.match(JSON.stringify(handoff?.content), /the work moved to the background: it goes on in that subagent from where you were/, 'the conversation reads why its task moved (QA 2026-10-30, the Porto thread)')
    for (let i = 0; i < 40 && !agentRequests().some((r) => isTask(r) && says(r, 'FIRST-DONE')); i++) await new Promise((r) => setTimeout(r, 500))
    assert.ok(agentRequests().some((r) => isTask(r) && says(r, 'FIRST-DONE')), 'the task goes on in the background from the command\'s result')
  } finally {
    await new Promise<void>((r) => { bot.once('exit', () => r()); bot.kill('SIGTERM') })
    await model.close()
  }
})


// H5: a question sent mid-task got its answer and the task in progress was
// dropped. Now the work moves to a background task, the conversation answers at once, a change
// reaches the task, and the task's result comes back into the same thread.
// The scripted model plays DeepSeek's H5 habit: it answers the person's newest message and ends.
const COMPARE = [
  { name: 'bash', arguments: { command: 'sleep 12; echo STEP-1', description: 'step 1' } },
  { name: 'bash', arguments: { command: 'sleep 12; echo STEP-2', description: 'step 2' } },
  { text: 'COMPARISON-READY' },
]
function midTaskModel(taskAsks = false) {
  const lastUser = (ms: Msg[]) => [...ms].reverse().find((m) => m.role === 'user' && !/Background subagent|sent a message:|You are a delegated subagent/.test(text(m.content)))
  return startScriptedModel(COMPARE, '127.0.0.1', {
    respond: ({ messages, task }) => {
      const all = JSON.stringify(messages)
      const newest = messages[messages.length - 1]
      if (task) { // the background task: one step of work, then its result (changed if it was told to)
        // its own steps: those after its prompt (the history before it is the conversation's, inherited)
        const own = messages.slice(messages.findLastIndex((m) => m.role === 'user' && text(m.content).includes('COMPARE-TASK')) + 1)
        if (!own.some((m) => m.role === 'tool')) return taskAsks
          ? { name: 'bash', arguments: { command: 'echo TASK-STEP', description: 'task step', sandbox_permissions: 'danger-full-access', justification: 'TEST-ESCALATION' } }
          : { name: 'bash', arguments: { command: 'sleep 8; echo TASK-STEP', description: 'task step' } }
        return { text: all.includes('CHANGE-TWO') ? 'COMPARISON-TWO' : 'COMPARISON-READY' }
      }
      if (newest?.role === 'user' && text(newest.content).startsWith('Background subagent')) return { text: `RELAY:${text(newest.content)}` }
      const started = /started subagent (\S+)/.exec([...messages].reverse().find((m) => m.role === 'tool' && /started subagent/.test(text(m.content)))?.content as string ?? '')?.[1]
      const person = text(lastUser(messages)?.content)
      if (newest?.role === 'user' && person.includes('CHANGE-TWO') && started) return { name: 'send_message', arguments: { agent_id: started, message: person } }
      if (newest?.role === 'tool' && /message delivered/.test(text(newest.content))) return { text: 'OK-CHANGED' }
      const answered = messages.some((m) => m.role === 'assistant' && text(m.content) === `ANSWER:${person}`)
      if (newest?.role === 'user' && messages.some((m) => m.role === 'assistant') && !answered && !person.includes('COMPARE-TASK')) return { text: `ANSWER:${person}` } // H5: answer and end
      return undefined
    },
  })
}

async function botOn(modelUrl: string, env: Record<string, string> = {}) {
  const home = mkdtempSync(join(tmpdir(), 'bot-steer-'))
  const bot: ChildProcess = spawn(process.execPath, ['src/main.ts', '--home', home, '--host', '127.0.0.1', '--port', '0', '--model', 'scripted/scripted', '--base-url', modelUrl, '--api-key-env', 'DEEPSEEK_BOT_MODEL_KEY'], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, DEEPSEEK_BOT_MODEL_KEY: 'local', ...env } })
  let out = ''
  bot.stdout!.on('data', (d) => { out += d }); bot.stderr!.on('data', (d) => { out += d })
  let pair = ''
  for (let i = 0; i < 300 && !pair; i++) { const m = /(http:\/\/[^\s]+\/pair\?code=\d{6})/.exec(out); if (m) pair = m[1]; else await new Promise((r) => setTimeout(r, 200)) }
  assert.ok(pair, out)
  for (let i = 0; i < 100 && !/listening to the assistant/.test(out); i++) await new Promise((r) => setTimeout(r, 200))
  const u = new URL(pair)
  const { token } = await (await fetch(`${u.origin}/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: u.searchParams.get('code'), name: 'e2e' }) })).json() as { token: string }
  const h = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
  await fetch(`${u.origin}/consent`, { method: 'PUT', headers: h, body: JSON.stringify({ ai: true, age: 'adult' }) })
  const t = await (await fetch(`${u.origin}/threads`, { method: 'POST', headers: h, body: JSON.stringify({}) })).json() as { sessionId: string }
  const send = (s: string) => fetch(`${u.origin}/threads/${t.sessionId}/messages`, { method: 'POST', headers: h, body: JSON.stringify({ text: s }) })
  const tap = (cardId: string, s: string) => fetch(`${u.origin}/threads/${t.sessionId}/messages`, { method: 'POST', headers: h, body: JSON.stringify({ text: s, cardId }) })
  // the thread as the app sees it, live
  const view = new ThreadView(t.sessionId)
  const ws = new WebSocket(`${u.origin.replace('http', 'ws')}/events`, ['bearer', token])
  ws.on('message', (m) => view.apply(JSON.parse(m.toString())))
  await new Promise<void>((r) => ws.on('open', () => { ws.send(JSON.stringify({ type: 'follow', sessionId: t.sessionId, lang: 'en' })); r() }))
  const threads = async () => await (await fetch(`${u.origin}/threads`, { headers: h })).json() as { sessionId: string }[]
  const stop = async () => { if (process.env.E2E_LOG) console.log(out); ws.close(); await new Promise<void>((r) => { bot.once('exit', () => r()); bot.kill('SIGTERM') }) }
  const cancel = () => fetch(`${u.origin}/sessions/${t.sessionId}/cancel`, { method: 'POST', headers: h })
  return { send, tap, view, threads, stop, cancel, sessionId: t.sessionId, out: () => out }
}
const replies = (v: ThreadView) => v.rows().filter((r) => r.kind === 'them').map((r) => r.text ?? '')
const waitFor = async (ok: () => boolean, seconds: number) => { for (let i = 0; i < seconds * 2 && !ok(); i++) await new Promise((r) => setTimeout(r, 500)) }

test('a question sent mid-task is answered and the task still delivers into the thread', { skip: !run, timeout: 300_000 }, async () => {
  const model = await midTaskModel()
  const bot = await botOn(model.url)
  try {
    assert.equal((await bot.send('COMPARE-TASK')).status, 200)
    await waitFor(() => model.requests.length > 0, 20)
    await new Promise((r) => setTimeout(r, 3000)) // step 1 is running
    const asked = Date.now()
    assert.equal((await bot.send('WHAT-TIME-4410')).status, 200)
    await waitFor(() => replies(bot.view).some((t) => t.includes('ANSWER:WHAT-TIME-4410')) && replies(bot.view).some((t) => t.includes('COMPARISON-READY')), 150)
    const rs = replies(bot.view)
    const answer = rs.findIndex((t) => t.includes('ANSWER:WHAT-TIME-4410')), result = rs.findIndex((t) => t.includes('COMPARISON-READY'))
    assert.ok(answer >= 0, `the question was answered in the thread (replies: ${JSON.stringify(rs)})`)
    assert.ok(result >= 0, `the task's result came into the same thread (replies: ${JSON.stringify(rs)})`)
    assert.ok(answer < result, 'the question did not wait for the task')
    const answeredAt = model.answers.find((a) => a.text.includes('ANSWER:WHAT-TIME-4410'))!.at
    assert.ok(answeredAt - asked < 20_000, `answered within the step that was running (${answeredAt - asked} ms)`)
    assert.ok(!model.results.some((r) => r.includes('STEP-2')), 'the conversation stopped doing the task itself')
    const firstTask = model.requests.find((r) => JSON.stringify(r).includes('You are a delegated subagent'))
    assert.ok(firstTask && JSON.stringify(firstTask).includes('STEP-1'), 'the task goes on from the steps already done: it starts with their results, not over')
    // QA 2026-10-30: the child inherited the conversation's waiting message, answered it first, and its own prompt waited behind it
    assert.ok(JSON.stringify(firstTask).includes('Your parent agent id is'), 'the task\'s first turn is its own prompt')
    assert.ok(!model.requests.some((r) => JSON.stringify(r).includes('You are a delegated subagent') && JSON.stringify(r).includes('WHAT-TIME-4410')), 'the message waiting for the conversation never reaches the task')
    // the conversation answered the question and then stopped the task with interrupt_agent (real model, 2026-10-29): only the person stops it
    const conversation = model.requests.filter((r) => !JSON.stringify(r).includes('You are a delegated subagent') && Array.isArray((r as { tools?: unknown[] }).tools)) as { tools: { function: { name: string } }[] }[]
    assert.ok(conversation.length && conversation.every((r) => !r.tools.some((t) => t.function.name === 'interrupt_agent')), 'the conversation cannot stop its background task')
    assert.equal((await bot.threads()).length, 1, 'the background task is not a thread of its own')
  } finally { await bot.stop(); await model.close() }
})

test('a message that changes the task, sent mid-task, changes what the task delivers', { skip: !run, timeout: 300_000 }, async () => {
  const model = await midTaskModel()
  const bot = await botOn(model.url)
  try {
    assert.equal((await bot.send('COMPARE-TASK')).status, 200)
    await waitFor(() => model.requests.length > 0, 20)
    await new Promise((r) => setTimeout(r, 3000))
    assert.equal((await bot.send('CHANGE-TWO only two ways')).status, 200)
    await waitFor(() => replies(bot.view).some((t) => /COMPARISON-(TWO|READY)/.test(t) && t.startsWith('RELAY:')), 150)
    const rs = replies(bot.view)
    assert.ok(rs.some((t) => t.startsWith('RELAY:') && t.includes('COMPARISON-TWO')), `the task delivered the changed result (replies: ${JSON.stringify(rs)})`)
    assert.ok(!rs.some((t) => t.includes('COMPARISON-READY')), 'not the original one')
  } finally { await bot.stop(); await model.close() }
})

// A background task asks the way the conversation does. DSH pins every subagent's
// approval policy to "never" (dsh-subagent captureDelegatedPolicyOverrides); the bot's plugin sets it back to "ask"
// for a thread's own background tasks. The task here asks to leave the sandbox: the bot's DSH plugin denies that in
// DSH's own pre-execute gate, so the model gets a policy refusal and no approval is requested (bug #20).
test('a background task that asks to leave the sandbox is refused by the computer, not the person', { skip: !run, timeout: 300_000 }, async () => {
  const model = await midTaskModel(true)
  const bot = await botOn(model.url)
  try {
    assert.equal((await bot.send('COMPARE-TASK')).status, 200)
    await waitFor(() => model.requests.length > 0, 20)
    await new Promise((r) => setTimeout(r, 3000))
    assert.equal((await bot.send('WHAT-TIME-4410')).status, 200)
    await waitFor(() => replies(bot.view).some((t) => t.startsWith('RELAY:')), 120)
    const taskRequests = model.requests.filter((r) => JSON.stringify(r).includes('You are a delegated subagent'))
    assert.ok(taskRequests.length >= 2, 'the task ran')
    assert.match(JSON.stringify(taskRequests.at(-1)), /Approval policy: ask/, 'the task is told it may ask')
    const refused = model.results.find((r) => /outside its sandbox/.test(r))
    assert.ok(refused, `the task's model got the policy refusal: ${JSON.stringify(model.results.slice(-5))}`)
    assert.match(refused!, /nobody was asked/)
    assert.ok(!model.results.some((r) => /the user rejected/.test(r)), 'the model was never told the person rejected it')
    assert.ok(!bot.out().includes('[bot] refused leaving the sandbox'), 'no approval was requested')
  } finally { await bot.stop(); await model.close() }
})

// Stop: while a task runs in the background the thread says it is working, so Stop stops that too.
test('Stop while a task runs in the background stops the task as well', { skip: !run, timeout: 300_000 }, async () => {
  const model = await midTaskModel()
  const bot = await botOn(model.url)
  try {
    assert.equal((await bot.send('COMPARE-TASK')).status, 200)
    await waitFor(() => model.requests.length > 0, 20)
    await new Promise((r) => setTimeout(r, 3000))
    assert.equal((await bot.send('WHAT-TIME-4410')).status, 200)
    await waitFor(() => replies(bot.view).some((t) => t.includes('ANSWER:WHAT-TIME-4410')), 60)
    assert.equal((await bot.cancel()).status, 200)
    await waitFor(() => replies(bot.view).some((t) => t.startsWith('RELAY:')), 60)
    const relay = replies(bot.view).find((t) => t.startsWith('RELAY:')) ?? ''
    assert.match(relay, /was stopped before it finished/, `the task stopped (replies: ${JSON.stringify(replies(bot.view))})`)
    assert.ok(!relay.includes('COMPARISON-READY'))
  } finally { await bot.stop(); await model.close() }
})

// DSH starts at most maxActiveSubagents (8) live background tasks per thread; one more fails to start. The turn
// it would have moved goes on and answers, and the message waiting for it comes after (SECREVIEW.md, item 4).
test('when no more background tasks can start, the turn goes on and the waiting message is answered after it', { skip: !run, timeout: 300_000 }, async () => {
  const model = await startScriptedModel([], '127.0.0.1', {
    respond: ({ messages, task }) => {
      if (task) return messages.some((m) => m.role === 'tool' && text(m.content).includes('LONG-TASK')) ? { text: 'A-RESULT' } : { name: 'bash', arguments: { command: 'sleep 60; echo LONG-TASK', description: 'long' } }
      // the person's last message (TASK-… or Q…) and what came after it
      const at = messages.findLastIndex((m) => m.role === 'user' && /^(TASK-|Q)/.test(text(m.content)))
      const said = text(messages[at]?.content)
      const after = messages.slice(at + 1)
      if (/^Q/.test(said)) return { text: `ANSWER:${said}` }
      if (!after.some((m) => m.role === 'tool')) return { name: 'bash', arguments: { command: `sleep 8; echo ${said}-STEP`, description: 'step' } }
      return { text: `${said.slice(5)}-DONE` }
    },
  })
  const bot = await botOn(model.url, { DEEPSEEK_BOT_MAX_BACKGROUND_TASKS: '1' })
  try {
    assert.equal((await bot.send('TASK-A')).status, 200)
    await waitFor(() => model.requests.length > 0, 20); await new Promise((r) => setTimeout(r, 2500))
    assert.equal((await bot.send('Q1')).status, 200)
    await waitFor(() => replies(bot.view).includes('ANSWER:Q1'), 60)
    assert.ok(replies(bot.view).includes('ANSWER:Q1'), 'the first task moved to the background')
    const before = model.requests.length
    assert.equal((await bot.send('TASK-C')).status, 200)
    await waitFor(() => model.requests.length > before, 20); await new Promise((r) => setTimeout(r, 2500))
    assert.equal((await bot.send('Q2')).status, 200)
    await waitFor(() => replies(bot.view).includes('ANSWER:Q2'), 90)
    const rs = replies(bot.view)
    assert.ok(rs.includes('C-DONE'), `the second task's turn went on and answered (replies: ${JSON.stringify(rs)})`)
    assert.ok(rs.indexOf('C-DONE') < rs.indexOf('ANSWER:Q2'), 'and the waiting message came after it')
    assert.match(bot.out(), /deepseek-bot: a background task could not start/, 'the bot\'s log says why')
  } finally { await bot.stop(); await model.close() }
})

// QA 2026-10-30 (en): a task that sends its result with send_message (as DSH tells it to) and then finishes woke the
// conversation twice, once for the message and once for the settlement notice; the person got the result twice.
test('a task that sends its result and then finishes brings one reply, not two', { skip: !run, timeout: 300_000 }, async () => {
  const model = await startScriptedModel([], '127.0.0.1', {
    respond: ({ messages, task }) => {
      if (task) {
        const parent = /Your parent agent id is \\?"([^"\\]+)/.exec(JSON.stringify(messages))?.[1]
        return messages.some((m) => m.role === 'tool' && /message delivered/.test(text(m.content))) ? { text: 'CHILD-DONE' } : { name: 'send_message', arguments: { agent_id: parent, message: 'CHILD-RESULT' } }
      }
      const newest = text(messages[messages.length - 1]?.content)
      if (/^(Agent \S+ sent a message|Background subagent)/.test(newest)) return { text: `RELAY:${newest.slice(0, 40)}` }
      if (!messages.some((m) => m.role === 'tool')) return { name: 'subagent_fork', arguments: { description: 'child', prompt: 'CHILD-WORK' } }
      return { text: 'STARTED' }
    },
  })
  const bot = await botOn(model.url)
  try {
    assert.equal((await bot.send('DELEGATE')).status, 200)
    await waitFor(() => replies(bot.view).some((t) => t.startsWith('RELAY:')), 90)
    await waitFor(() => replies(bot.view).filter((t) => t.startsWith('RELAY:')).length > 1, 10) // the settlement comes within seconds of the message
    const relays = replies(bot.view).filter((t) => t.startsWith('RELAY:'))
    assert.deepEqual(relays.map((t) => t.startsWith('RELAY:Agent')), [true], `one reply, for the result the task sent (replies: ${JSON.stringify(replies(bot.view))})`)
    assert.match(bot.out(), /settlement notice repeats the result it already sent/)
    assert.equal(bot.view.statuses.at(-1), false, 'and the thread no longer says it works in the background')
  } finally { await bot.stop(); await model.close() }
})

// A card a background task made stayed in the task's session; the conversation only relayed it in words. It shows in the conversation, and a tap on it is the person's message there.
test('a card a background task makes shows in the conversation, and a tap on it answers there', { skip: !run, timeout: 300_000 }, async () => {
  let shown: string | undefined // what the task's show call returned to it
  const model = await startScriptedModel([], '127.0.0.1', {
    respond: ({ messages, task }) => {
      const all = JSON.stringify(messages)
      if (task) {
        const parent = /Your parent agent id is \\?"([^"\\]+)/.exec(all)?.[1]
        const own = messages.slice(messages.findLastIndex((m) => m.role === 'user' && text(m.content).includes('CARD-WORK')) + 1)
        const tools = own.filter((m) => m.role === 'tool')
        if (!tools.length) return { name: 'mcp__bot__show', arguments: { kind: 'choices', title: 'TASK-CARD which train?', options: [{ label: 'Odakyu' }, { label: 'JR' }] } }
        shown ??= text(tools[0].content)
        return tools.some((m) => /message delivered/.test(text(m.content))) ? { text: 'CHILD-DONE' } : { name: 'send_message', arguments: { agent_id: parent, message: 'TASK-RESULT: pick a train on the card' } }
      }
      const newest = text(messages[messages.length - 1]?.content)
      if (/^(Agent \S+ sent a message|Background subagent)/.test(newest)) return { text: 'RELAY' }
      if (/Odakyu/.test(newest)) return { text: `PICKED:${newest.includes('card') ? 'marker' : 'plain'}` }
      if (!messages.some((m) => m.role === 'tool')) return { name: 'subagent_fork', arguments: { description: 'trains', prompt: 'CARD-WORK' } }
      return { text: 'STARTED' }
    },
  })
  const bot = await botOn(model.url)
  try {
    assert.equal((await bot.send('DELEGATE')).status, 200)
    const card = () => bot.view.rows().find((r) => r.kind === 'card') as { id: string; card: { title: string }; answer?: string } | undefined
    await waitFor(() => Boolean(card()) && replies(bot.view).includes('RELAY'), 120)
    assert.equal(card()?.card.title, 'TASK-CARD which train?', `the task's card is in the conversation (rows: ${JSON.stringify(bot.view.rows().map((r) => r.kind))})`)
    assert.equal(bot.view.rows().filter((r) => r.kind === 'card').length, 1, 'once')
    assert.equal(shown, 'Shown in the person\'s conversation. Their answer goes to the conversation, not to you.', 'the task is told where the answer goes')
    assert.equal((await bot.tap(card()!.id, 'Odakyu')).status, 200)
    await waitFor(() => replies(bot.view).some((t) => t.startsWith('PICKED')) && card()?.answer === 'Odakyu', 60)
    assert.equal(card()?.answer, 'Odakyu', 'the card shows it was answered')
    assert.ok(replies(bot.view).some((t) => t.startsWith('PICKED')), `the conversation got the pick (replies: ${JSON.stringify(replies(bot.view))})`)
  } finally { await bot.stop(); await model.close() }
})

// Only tasks the bot moved ask again (SECREVIEW.md item 1): a subagent the model starts itself keeps DSH's "never".
test('a subagent the model starts itself keeps DSH\'s "never": approvals stay off for it', { skip: !run, timeout: 300_000 }, async () => {
  const model = await startScriptedModel([], '127.0.0.1', {
    respond: ({ messages, task }) => {
      if (task) return messages.some((m) => m.role === 'tool' && text(m.content).includes('CHILD-STEP')) ? { text: 'CHILD-DONE' } : { name: 'bash', arguments: { command: 'echo CHILD-STEP', description: 'child step' } }
      const newest = messages[messages.length - 1]
      if (newest?.role === 'user' && text(newest.content).startsWith('Background subagent')) return { text: 'RELAY' }
      if (!messages.some((m) => m.role === 'tool')) return { name: 'subagent_fork', arguments: { description: 'child', prompt: 'CHILD-WORK' } }
      return { text: 'STARTED' }
    },
  })
  const bot = await botOn(model.url)
  try {
    assert.equal((await bot.send('DELEGATE')).status, 200)
    await waitFor(() => replies(bot.view).includes('RELAY'), 90)
    const child = model.requests.filter((r) => JSON.stringify(r).includes('You are a delegated subagent'))
    assert.ok(child.length >= 2, 'the model\'s own subagent ran')
    assert.match(JSON.stringify(child.at(-1)), /Approval prompts are disabled in this session/, 'and DSH\'s "never" still holds for it')
    // QA 2026-10-30: a turn that started a background task sleep-waited for it; it ends with that step instead
    const conversation = model.requests.filter((r) => !JSON.stringify(r).includes('You are a delegated subagent') && Array.isArray((r as { tools?: unknown[] }).tools)).map((r) => JSON.stringify(r))
    assert.ok(!conversation.some((r) => r.includes('started subagent') && !r.includes('Background subagent')), 'the conversation is not asked again until the task\'s settlement notice')
    assert.ok(!replies(bot.view).includes('STARTED'), 'so it never says it is waiting')
  } finally { await bot.stop(); await model.close() }
})

// A command still running when the person writes: the
// question waited 55 s for DSH to move a `sleep 100` to job bash-1 at 60 s, and the background task then got
// "Error: job bash-1 belongs to another session" for it. Now the wait ends when the person writes, the job goes
// with the work, its output reaches the task, and its completion notice wakes the task, not the conversation.
function longTaskModel(command = 'sleep 25; echo LONG-DONE-5521') {
  return startScriptedModel([], '127.0.0.1', {
    respond: ({ messages, task }) => {
      const all = JSON.stringify(messages)
      const newest = messages[messages.length - 1]
      if (task) {
        const job = /moved to background job (\S+?)\]/.exec(all)?.[1]
        const read = messages.some((m) => m.role === 'assistant' && JSON.stringify(m.tool_calls ?? '').includes('job_output'))
        if (read) return { text: messages.some((m) => m.role === 'tool' && text(m.content).startsWith('LONG-DONE-5521')) ? 'LONG-RESULT' : 'TASK-COULD-NOT-READ' }
        if (job && new RegExp(`background job ${job} \\(.*finished`).test(all)) return { name: 'job_output', arguments: { job_id: job } }
        return { text: 'TASK-WAITING' } // DeepSeek's habit: it ends its turn and waits for the notice
      }
      const said = (s: string) => messages.some((m) => m.role === 'assistant' && (text(m.content) === s || JSON.stringify(m.tool_calls ?? '').includes(s)))
      if (newest?.role === 'user' && /Agent \S+ sent a message|Background subagent/.test(text(newest.content))) return { text: `RELAY:${/LONG-RESULT/.test(text(newest.content)) ? 'LONG-RESULT' : 'OTHER'}` }
      if (all.includes('QUICK-Q-8802') && !said('ANSWER:QUICK-Q-8802')) return { text: 'ANSWER:QUICK-Q-8802' }
      if (all.includes('LONG-TASK') && !said('LONG-DONE-5521')) return { name: 'bash', arguments: { command, description: 'long work' } }
      return { text: 'done' }
    },
  })
}

test('a command still running when the person writes moves with the task: the question is answered at once and the task gets the command\'s output', { skip: !run, timeout: 300_000 }, async () => {
  const model = await longTaskModel()
  const bot = await botOn(model.url)
  try {
    assert.equal((await bot.send('LONG-TASK')).status, 200)
    await waitFor(() => model.requests.length > 0, 20)
    await new Promise((r) => setTimeout(r, 3000)) // the command is running
    const asked = Date.now()
    assert.equal((await bot.send('QUICK-Q-8802')).status, 200)
    await waitFor(() => replies(bot.view).some((t) => t.includes('ANSWER:QUICK-Q-8802')), 60)
    const answeredAfter = (model.answers.find((a) => a.text === 'ANSWER:QUICK-Q-8802')?.at ?? Infinity) - asked
    assert.ok(answeredAfter < 12_000, `the question is answered within seconds, not after the command (${answeredAfter} ms)`)
    await waitFor(() => replies(bot.view).some((t) => t.includes('RELAY:LONG-RESULT')), 90)
    const taskRequests = model.requests.map((r) => JSON.stringify(r)).filter((r) => r.includes('You are a delegated subagent'))
    assert.ok(!taskRequests.some((r) => r.includes('belongs to another session')), 'the task can read the command it took over')
    assert.ok(taskRequests.some((r) => r.includes('[still running when the person wrote; moved to background job')), 'the command\'s result says why it moved, not that a timeout passed')
    assert.ok(replies(bot.view).some((t) => t.includes('RELAY:LONG-RESULT')), `the command's output reached the task and its result the thread (replies: ${JSON.stringify(replies(bot.view))})`)
    const conversation = model.requests.map((r) => JSON.stringify(r)).filter((r) => !r.includes('You are a delegated subagent') && r.includes('"tools"'))
    assert.ok(!conversation.some((r) => /background job \S+ \(bash/.test(r)), 'the job\'s completion notice went to the task, not the conversation')
    // the conversation redid moved work after answering: its history held the moved
    // steps, unfinished, before the fork. Its requests now leave them out; the task's keep them.
    const calledBash = (r: unknown) => ((r as { messages: Msg[] }).messages).some((m) => m.role === 'assistant' && (m.tool_calls ?? []).some((c) => c.function.name === 'bash'))
    const answering = (model.requests as { messages: Msg[] }[]).filter((r) => !JSON.stringify(r).includes('You are a delegated subagent') && JSON.stringify(r).includes('QUICK-Q-8802'))
    assert.ok(answering.length && answering.every((r) => !calledBash(r) && JSON.stringify(r).includes('subagent_fork')), 'the conversation sees the hand-off, not the moved steps')
    assert.ok((model.requests as unknown[]).filter((r) => JSON.stringify(r).includes('You are a delegated subagent')).every(calledBash), 'the task still has them')
  } finally {
    await bot.stop(); await model.close() }
})

test('Stop stops a command that moved with the task, and its end wakes nothing', { skip: !run, timeout: 300_000 }, async () => {
  const mark = join(mkdtempSync(join(tmpdir(), 'bot-stop-job-')), 'ran')
  const model = await longTaskModel(`sleep 15; touch ${mark}; echo LONG-DONE-5521`)
  const bot = await botOn(model.url)
  try {
    assert.equal((await bot.send('LONG-TASK')).status, 200)
    await waitFor(() => model.requests.length > 0, 20)
    await new Promise((r) => setTimeout(r, 3000))
    assert.equal((await bot.send('QUICK-Q-8802')).status, 200)
    await waitFor(() => replies(bot.view).some((t) => t.includes('ANSWER:QUICK-Q-8802')), 30)
    await waitFor(() => /moved with the work to/.test(bot.out()), 10)
    assert.equal((await bot.cancel()).status, 200)
    await new Promise((r) => setTimeout(r, 20_000)) // past the command's own end
    assert.ok(!existsSync(mark), 'the command was stopped')
    const taskRequests = model.requests.map((r) => JSON.stringify(r)).filter((r) => r.includes('You are a delegated subagent'))
    assert.ok(!taskRequests.some((r) => /background job \S+ \(bash/.test(r)), 'no notice woke the stopped task')
  } finally { await bot.stop(); await model.close() }
})
