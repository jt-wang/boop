// An OpenAI-compatible chat model that plays a fixed script of tool calls, so
// tests can drive the real agent loop (DSH's own tools, sandbox and approvals)
// without a real model. Each request answers with the next scripted call; once
// the script is used up it answers with plain text. Every tool result the
// harness sends back is kept, in order, for the test to inspect.
import { createServer, type Server } from 'node:http'

export interface ScriptedCall { name: string; arguments: Record<string, unknown> }
/** A step that answers with this text and ends the turn (instead of a tool call). */
export interface ScriptedText { text: string }

export interface ScriptedModel {
  url: string
  /** Tool results the harness sent back, oldest first. */
  results: string[]
  /** Every request body, for debugging. */
  requests: unknown[]
  /** Plain-text answers to agent requests, with the time each was sent. */
  answers: { at: number; text: string }[]
  /** Anthropic Messages requests (`POST …/messages`, DSH's DeepSeek web search), with the auth headers they came with. */
  messages: { path: string; body: Record<string, unknown>; authorization?: string }[]
  close(): Promise<void>
}

export type Msg = { role: string; content?: unknown; tool_call_id?: string; tool_calls?: { id: string; function: { name: string; arguments: string } }[] }
export const text = (c: unknown): string => typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => (p as { text?: string }).text ?? '').join('') : ''

export interface ScriptedOptions {
  /** Answer a message the person sent after the turn began the way DeepSeek did in H5:
   *  when the newest message in a request is the person's, and the model has spoken before, reply
   *  `ANSWER:<their text>` and end the turn, without spending the script. */
  answerNewestUserMessage?: boolean
  /** Decide an agent request by its contents before the script: a call or a text, or undefined to fall through.
   *  `task` is true for a background task's request (DSH tells a delegated subagent so in its context). */
  respond?: (req: { messages: Msg[]; task: boolean }) => ScriptedCall | ScriptedText | undefined
}

export async function startScriptedModel(script: (ScriptedCall | ScriptedText)[], host = '127.0.0.1', opts: ScriptedOptions = {}): Promise<ScriptedModel> {
  const results: string[] = []
  const requests: unknown[] = []
  const answers: { at: number; text: string }[] = []
  const messages: ScriptedModel['messages'] = []
  let step = 0, callCount = 0
  const server: Server = createServer((req, res) => {
    let body = ''
    req.on('data', (d) => { body += d })
    req.on('end', () => {
      if (req.url?.endsWith('/messages') && req.method === 'POST') { // a native web search: one result block
        messages.push({ path: req.url, body: JSON.parse(body), authorization: req.headers.authorization })
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ id: 'msg', type: 'message', role: 'assistant', model: 'scripted', content: [
          { type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: { query: 'q' } },
          { type: 'web_search_tool_result', tool_use_id: 'srv_1', content: [{ type: 'web_search_result', url: 'https://example.com/weather', title: 'SCRIPTED-RESULT' }] },
        ], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }))
        return
      }
      if (!req.url?.endsWith('/chat/completions')) { res.writeHead(404).end(); return }
      const r = JSON.parse(body) as { messages: Msg[]; stream?: boolean }
      requests.push(r)
      // the tool results added since our last answer
      const msgs = r.messages
      const lastAssistant = msgs.map((m) => m.role).lastIndexOf('assistant')
      const agentCall = Array.isArray((r as { tools?: unknown[] }).tools) && (r as { tools?: unknown[] }).tools!.length > 0
      if (agentCall && lastAssistant >= 0) for (const m of msgs.slice(lastAssistant + 1)) if (m.role === 'tool') results.push(text(m.content))
      // side calls the harness makes (titles, summaries) carry no tools: answer them without spending the script
      const newest = msgs[msgs.length - 1]
      const answerPerson = agentCall && opts.answerNewestUserMessage && newest?.role === 'user' && lastAssistant >= 0
      const decided = agentCall && opts.respond ? opts.respond({ messages: msgs, task: JSON.stringify(msgs).includes('You are a delegated subagent') }) : undefined
      const next = decided ?? (agentCall && !answerPerson && step < script.length ? script[step++] : undefined)
      const call = next && 'name' in next ? next : undefined
      const reply = answerPerson ? `ANSWER:${text(newest.content)}` : next && 'text' in next ? next.text : 'done'
      if (agentCall && !call) answers.push({ at: Date.now(), text: reply })
      const id = call ? `call_${++callCount}` : `call_${callCount}` // the nth tool call is call_n, as before the respond hook
      const chunks: unknown[] = call
        ? [{ delta: { role: 'assistant', tool_calls: [{ index: 0, id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] }, finish_reason: null },
           { delta: {}, finish_reason: 'tool_calls' }]
        : [{ delta: { role: 'assistant', content: reply }, finish_reason: null }, { delta: {}, finish_reason: 'stop' }]
      if (r.stream === false) {
        const message = call ? { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] } : { role: 'assistant', content: reply }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ id: 'x', object: 'chat.completion', created: 0, model: 'scripted', choices: [{ index: 0, message, finish_reason: call ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const c of chunks) res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 0, model: 'scripted', choices: [{ index: 0, ...(c as object) }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 0, model: 'scripted', choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`)
      res.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>((r) => server.listen(0, host, () => r()))
  const port = (server.address() as { port: number }).port
  return { url: `http://${host}:${port}/v1`, results, requests, answers, messages, close: () => new Promise((r) => server.close(() => r())) }
}
