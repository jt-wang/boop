// Runs the breakout probes against the bot image in Docker with a scripted
// model; returns each probe's tool result. Used by test/containment.e2e.test.ts
// and runnable by hand: node test/fixtures/breakout-run.ts [image]
import { execFileSync } from 'node:child_process'
import { startScriptedModel, type ScriptedCall } from './scripted-model.ts'
import { BROWSER_SENTINEL, PROBES, SENTINEL } from './breakout-probes.ts'

export interface Run {
  results: Record<string, string>
  approvals: { reason?: string }[]
  logs: string
  container: string
  origin: string
  token: string
  sessionId: string
  tools: string[]
  close(): Promise<void>
}

export async function runBreakout(image: string, opts: { probes?: { id: string; call: ScriptedCall }[]; until?: (results: string[]) => boolean; approveEscalation?: boolean; mountSrc?: string; port?: number; keep?: boolean; restart?: boolean; timeoutMs?: number; only?: string[]; host?: string; memory?: string; dockerArgs?: string[]; env?: Record<string, string> } = {}): Promise<Run> {
  const probes = opts.probes ?? (opts.only ? PROBES.filter((p) => opts.only!.includes(p.id)) : PROBES)
  const model = await startScriptedModel(probes.map((p) => p.call), '0.0.0.0')
  const port = opts.port ?? 3899
  const name = `dsb-redteam-${process.pid}`
  const modelPort = new URL(model.url).port
  const docker = (...a: string[]) => execFileSync('docker', a, { encoding: 'utf8' })
  let ok = false
  try {
    docker('run', '-d', '--name', name, ...(opts.memory ? [`--memory=${opts.memory}`, `--memory-swap=${opts.memory}`] : []), ...(opts.dockerArgs ?? []), ...(opts.restart ? ['--restart=always'] : []), '-p', `127.0.0.1:${port}:3850`, '--add-host', 'host.docker.internal:host-gateway',
      '-e', `DEEPSEEK_BOT_MODEL_KEY=${SENTINEL}-model`, '-e', `DEEPSEEK_BOT_HOST_SECRET=${SENTINEL}-host`, '-e', 'DEEPSEEK_BOT_WORKSPACE_BYTES=134217728',
      ...Object.entries(opts.env ?? {}).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
      ...(opts.mountSrc ? ['-v', `${opts.mountSrc}:/opt/deepseek-bot/src:ro`] : []),
      image, 'node', 'src/main.ts', '--host', opts.host ?? '::', '--port', '3850', '--model', 'scripted/scripted', '--base-url', `http://host.docker.internal:${modelPort}/v1`, '--api-key-env', 'DEEPSEEK_BOT_MODEL_KEY')
    let code = ''
    for (let i = 0; i < 300 && !code; i++) { const m = /pair\?code=(\d{6})/.exec(docker('logs', name) + ''); if (m) code = m[1]; else await new Promise((r) => setTimeout(r, 300)) }
    if (!code) throw new Error(`no pairing code:\n${docker('logs', name)}`)
    for (let i = 0; i < 100 && !/listening to the assistant/.test(docker('logs', name)); i++) await new Promise((r) => setTimeout(r, 300))
    docker('exec', name, 'sh', '-c', `echo ${SENTINEL}-file > /data/sentinel.txt; echo ${BROWSER_SENTINEL} > /data/dsh/browser-probe.txt`)
    const origin = `http://127.0.0.1:${port}`
    const { token } = await (await fetch(`${origin}/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, name: 'redteam' }) })).json() as { token: string }
    const h = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
    // [compliance] nothing reaches the model before the person (18+) agreed to its provider
    const consent = await fetch(`${origin}/consent`, { method: 'PUT', headers: h, body: JSON.stringify({ age: 'adult', ai: true }) })
    if (consent.status !== 200) throw new Error(`consent ${consent.status} ${await consent.text()}`)
    const t = await (await fetch(`${origin}/threads`, { method: 'POST', headers: h, body: JSON.stringify({ project: 'redteam' }) })).json() as { sessionId: string }
    const r = await fetch(`${origin}/threads/${t.sessionId}/messages`, { method: 'POST', headers: h, body: JSON.stringify({ text: 'go' }) })
    if (r.status !== 200) throw new Error(`send ${r.status} ${await r.text()}`)
    const approvals: { reason?: string }[] = []
    const end = Date.now() + (opts.timeoutMs ?? 240_000)
    while (Date.now() < end && model.results.length < probes.length && !opts.until?.(model.results)) {
      try {
        const asks = await (await fetch(`${origin}/approvals`, { headers: h })).json() as { eventId: string; request: { reason?: string } }[]
        for (const a of asks) {
          approvals.push(a.request)
          await fetch(`${origin}/approvals/${a.eventId}`, { method: 'POST', headers: h, body: JSON.stringify({ outcome: opts.approveEscalation ? 'allowed' : 'rejected' }) })
        }
      } catch { /* the bot may be restarting after kill-all */ }
      await new Promise((x) => setTimeout(x, 500))
    }
    const results: Record<string, string> = {}
    probes.forEach((p, i) => { results[p.id] = model.results[i] ?? '(no result)' })
    const cleanup = async () => { try { docker('rm', '-f', name) } catch {} ; await model.close() }
    ok = true
    const first = model.requests.find((x) => Array.isArray((x as { tools?: unknown[] }).tools) && (x as { tools?: unknown[] }).tools!.length) as { tools?: { function?: { name?: string } }[] } | undefined
    const tools = (first?.tools ?? []).map((x) => x.function?.name ?? '').filter(Boolean)
    return { results, approvals, logs: docker('logs', name), container: name, origin, token, sessionId: t.sessionId, tools, close: cleanup }
  } finally {
    if (!ok || !opts.keep) {
      try { docker('rm', '-f', name) } catch {}
      await model.close()
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const run = await runBreakout(process.argv[2] ?? 'deepseek-bot:slim', { approveEscalation: process.argv.includes('--approve'), mountSrc: process.argv.includes('--src') ? `${process.cwd()}/src` : undefined })
  for (const [k, v] of Object.entries(run.results)) console.log(`== ${k}\n${v.slice(0, 400)}`)
  console.log('== approvals', JSON.stringify(run.approvals))
}
