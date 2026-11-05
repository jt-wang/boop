// A one-tool MCP server over stdio for the connectors e2e: `probe` returns the
// value of BOT_E2E_PROBE_TOKEN as the server process sees it. DSH scrubs
// ambient env vars whose names contain TOKEN before spawning a stdio server, so
// the value only arrives when the connector row forwards it by name.
// Plain JSON-RPC over newline-delimited stdio, no SDK.
import { createInterface } from 'node:readline'

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n')
const tool = { name: 'probe', description: 'Returns the probe marker configured on the computer. Takes no arguments.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }

createInterface({ input: process.stdin }).on('line', (line) => {
  let req
  try { req = JSON.parse(line) } catch { return }
  if (req.id === undefined) return // a notification
  const reply = (result) => send({ jsonrpc: '2.0', id: req.id, result })
  switch (req.method) {
    case 'initialize': return reply({ protocolVersion: req.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'envprobe', version: '0.0.1' } })
    case 'ping': return reply({})
    case 'tools/list': return reply({ tools: [tool] })
    case 'tools/call': return reply({ content: [{ type: 'text', text: `marker=${process.env.BOT_E2E_PROBE_TOKEN ?? '(unset)'}` }] })
    default: return send({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: `unknown method ${req.method}` } })
  }
})
