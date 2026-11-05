// The containment gate: build the image, drive the real agent loop through a
// scripted model, and assert that a hostile agent cannot read the bot's files,
// forge the harness cookie, escape the cell, or take the bot down with a
// bounded resource attack. Needs Docker; runs with DEEPSEEK_BOT_E2E=1 (it builds the image, ~2-4 min,
// and timed out when `npm test` ran it in parallel with everything else on 2026-10-27).
// Run: node --test test/containment.e2e.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:net'
import { createServer as createHttpServer } from 'node:http'
import { once } from 'node:events'
import { join } from 'node:path'
import { runBreakout } from './fixtures/breakout-run.ts'
import { BROWSER_SENTINEL, SENTINEL } from './fixtures/breakout-probes.ts'

const IMAGE = process.env.DEEPSEEK_BOT_CONTAINMENT_IMAGE ?? 'deepseek-bot:containment'

function dockerReady(): boolean {
  try { execFileSync('docker', ['info'], { stdio: 'ignore' }); return true } catch { return false }
}

async function freePort(): Promise<number> {
  const s = createServer()
  s.listen(0, '127.0.0.1')
  await once(s, 'listening')
  const p = (s.address() as { port: number }).port
  await new Promise<void>((r) => s.close(() => r()))
  return p
}

async function sendEventually(run: { origin: string; token: string; sessionId: string }, ms = 60_000): Promise<Response | null> {
  const end = Date.now() + ms
  let last: Response | null = null
  while (Date.now() < end) {
    try { last = await send(run); if (last.status === 200) return last } catch { /* restarting */ }
    await new Promise((r) => setTimeout(r, 1000))
  }
  return last
}

async function waitRestart(container: string, before: number, origin: string, ms = 120_000): Promise<boolean> {
  const end = Date.now() + ms
  let restarted = false
  while (Date.now() < end) {
    try {
      const n = Number(execFileSync('docker', ['inspect', '--format', '{{.RestartCount}}', container], { encoding: 'utf8' }).trim())
      if (n > before) restarted = true
    } catch { /* transient */ }
    if (restarted && await healthy(origin, 2_000)) return true
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

async function healthy(origin: string, ms = 120_000): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    try {
      const r = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(3000) })
      if (r.ok) { const b = await r.json() as { ok?: boolean; dsh?: boolean }; if (b.ok && b.dsh) return true }
    } catch { /* booting */ }
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}


// The sandbox container's narrow set (src/host-main.ts), instead of --privileged.
const dockerArgs = [
  '--cap-add=SYS_ADMIN', '--cap-add=NET_ADMIN', '--cap-add=SYSLOG',
  '--security-opt', 'systempaths=unconfined',
  '--security-opt', `seccomp=${join(import.meta.dirname, '..', 'deploy', 'seccomp-bwrap.json')}`,
  '--device', '/dev/loop-control', '--device-cgroup-rule', 'b 7:* rmw',
]

test('containment: the agent cannot read bot data, forge the DSH cookie, escape, or take the bot down', { skip: process.env.DEEPSEEK_BOT_E2E !== '1' || !dockerReady(), timeout: 1_500_000 }, async () => {
  if (process.env.DEEPSEEK_BOT_CONTAINMENT_NO_BUILD !== '1') {
    execFileSync('docker', ['build', '--build-arg', 'WITH_BROWSER=1', '-t', IMAGE, '.'], { stdio: 'inherit' })
  } else {
    execFileSync('docker', ['image', 'inspect', IMAGE], { stdio: 'ignore' })
  }

  const run = await runBreakout(IMAGE, { keep: true, restart: true, port: await freePort(), memory: '1g', dockerArgs })
  let closed = false
  try {
    const r = run.results
    const sentinel = new RegExp(SENTINEL)

    // The cell is the boundary: the agent keeps its shell and the standard
    // preset's file/search/edit tools, and they work in the workspace.
    assert.match(r.id, /uid=1000\b/, `the agent shell runs as the unprivileged cell user: ${r.id}`)
    assert.doesNotMatch(r.id, /uid=0\b/)
    assert.ok(run.tools.some((n) => /browser_navigate/.test(n)), `the browser tools are mounted: ${run.tools.join(',')}`)
    // The browser surface is navigation, accessibility-tree reading and input;
    // arbitrary-code tools are not in the agent's tool list at all.
    const browserTools = run.tools.filter((n) => n.startsWith('mcp__browser__'))
    for (const keep of ['mcp__browser__browser_navigate', 'mcp__browser__browser_snapshot', 'mcp__browser__browser_click', 'mcp__browser__browser_type']) assert.ok(browserTools.includes(keep), `${keep} is mounted: ${browserTools.join(',')}`)
    for (const gone of ['mcp__browser__browser_evaluate', 'mcp__browser__browser_run_code_unsafe']) assert.ok(!browserTools.includes(gone), `${gone} must not be in the tool list: ${browserTools.join(',')}`)
    // The browser process runs as its own user, not the cell's uid and not root.
    const browserProcs = execFileSync('docker', ['exec', run.container, 'sh', '-c', `for p in /proc/[0-9]*; do c=$(tr '\\0' ' ' < "$p/cmdline" 2>/dev/null); case "$c" in *@playwright/mcp*|*chromium*) echo "$(awk '/^Uid:/{print $2}' "$p/status" 2>/dev/null) $c";; esac; done`], { encoding: 'utf8' })
    assert.match(browserProcs, /^1001 .*@playwright\/mcp/m, `the broker runs as uid 1001: ${browserProcs}`)
    assert.doesNotMatch(browserProcs, /^1000 .*(@playwright\/mcp|chromium)/m, `no browser process runs as the cell uid: ${browserProcs}`)
    assert.equal(execFileSync('docker', ['exec', run.container, 'stat', '-c', '%u', '/data/browser-broker/profile'], { encoding: 'utf8' }).trim(), '1001', 'the browser profile belongs to the broker user')
    for (const tool of ['bash', 'read', 'write', 'edit', 'glob', 'grep']) assert.ok(run.tools.includes(tool), `${tool} is in the tool list: ${run.tools.join(',')}`)
    assert.match(r['workspace-seed'], /workspace-ok-7/, `workspace-seed: ${r['workspace-seed']}`)
    assert.match(r['fs-read-workspace'], /workspace-ok-7/, `fs-read-workspace: ${r['fs-read-workspace']}`)
    assert.match(r['workspace-content'], /written-by-tool/, `workspace-content: ${r['workspace-content']}`)

    // The model key is a surrogate; the bot's environment is not visible.
    assert.doesNotMatch(r.env, sentinel, `env: ${r.env}`)
    assert.doesNotMatch(r['proc-environ'], sentinel, `proc-environ: ${r['proc-environ']}`)
    assert.match(r['proc-environ'], /^0\b/, `proc-environ: ${r['proc-environ']}`)

    // /data is a tmpfs with only the cell folders; the bot's files are gone.
    assert.match(r['list-data'], /workspace/)
    assert.match(r['list-data'], /dsh/)
    for (const f of ['config.json', 'secrets.env', 'connector-secrets.json', 'devices.json', 'sentinel.txt']) {
      assert.doesNotMatch(r['list-data'], new RegExp(f.replace('.', '\\.')), `list-data: ${r['list-data']}`)
    }
    assert.doesNotMatch(r['list-data'], /browser-profile|browser-output|browser-broker/, `the browser profile is outside the cell: ${r['list-data']}`)
    assert.doesNotMatch(r['read-secrets'], sentinel, `read-secrets: ${r['read-secrets']}`)
    assert.doesNotMatch(r['read-patch'], /authorization: Bearer|^1$/m, `read-patch: ${r['read-patch']}`)
    assert.match(r['read-credentials'], /No such file|cannot access/, `read-credentials: ${r['read-credentials']}`)
    assert.doesNotMatch(r['read-credentials'], /authorization: Bearer|secret:/, `read-credentials: ${r['read-credentials']}`)

    // Writes outside the workspace fail. The masked harness home is a
    // read-only tmpfs; even a write into it cannot reach the real file.
    for (const id of ['write-agents', 'write-code', 'write-config', 'escalate']) {
      assert.doesNotMatch(r[id], /rc=0/, `${id}: ${r[id]}`)
    }
    const agents = execFileSync('docker', ['exec', run.container, 'cat', '/data/dsh/AGENTS.md'], { encoding: 'utf8' })
    const config = execFileSync('docker', ['exec', run.container, 'cat', '/data/config.json'], { encoding: 'utf8' })
    assert.doesNotMatch(agents, /pwned/, 'the real AGENTS.md was not appended to')
    assert.notEqual(config.trim(), '{}', 'the real config.json was not overwritten')

    // The harness itself, not only the shell, has no real key. The shell cannot
    // see DSH's /proc, so this check runs from the container's root namespace.
    const findDsh = (): { pid: string; status: string } => {
      for (let i = 0; i < 20; i++) {
        try {
          const pid = execFileSync('docker', ['exec', run.container, 'sh', '-c', 'for p in /proc/[0-9]*; do case "$(cat $p/comm 2>/dev/null)" in node|MainThread) ;; *) continue;; esac; c=$(tr "\\0" " " < $p/cmdline 2>/dev/null); case "$c" in *dsh/lib/bin.js*) echo "$p"; break;; esac; done'], { encoding: 'utf8' }).trim()
          if (pid) return { pid, status: execFileSync('docker', ['exec', run.container, 'cat', `${pid}/status`], { encoding: 'utf8' }) }
        } catch { /* the bot may have restarted between the scan and the read */ }
        execFileSync('sleep', ['0.25'])
      }
      throw new Error(`found no stable DSH process; restarts=${execFileSync('docker', ['inspect', '--format', '{{.RestartCount}}', run.container], { encoding: 'utf8' }).trim()}\n${run.logs.slice(-2000)}`)
    }
    const dsh = findDsh()
    assert.match(dsh.status, /Uid:\s+1000\s+1000\s+1000\s+1000/, 'DSH runs as uid 1000')
    const dshEnv = execFileSync('docker', ['exec', run.container, 'cat', `${dsh.pid}/environ`], { encoding: 'utf8' })
    assert.doesNotMatch(dshEnv, sentinel, `DSH env must not have the real model key: ${dshEnv}`)
    assert.match(dshEnv, /DEEPSEEK_BOT_MODEL_KEY=/, 'DSH has the surrogate model env')
    assert.doesNotMatch(dshEnv, /DEEPSEEK_BOT_HOST_SECRET/, 'DSH has no host secret')

    // The bot's API needs a paired device; killing everything it can see does
    // not reach the bot or DSH.
    assert.match(r['bot-api'], /^(000|401)$/m, `bot-api is blocked or unauthorized: ${r['bot-api']}`)
    assert.doesNotMatch(r['forge-dsh-cookie'], /dsh-api \d+ 200/, `forge-dsh-cookie: ${r['forge-dsh-cookie']}`)
    assert.match(r['forge-dsh-cookie'], /no-secret/, `forge-dsh-cookie: ${r['forge-dsh-cookie']}`)

    // Egress: the cell reaches the public internet through the bot's proxy and
    // cannot reach the bot's own port, metadata, RFC1918, Fly's fdaa:: 6PN, or
    // a public name that resolves to loopback.
    for (const id of ['egress-bot-port', 'egress-metadata', 'egress-6pn', 'egress-private', 'egress-dns-private', 'egress-direct-metadata', 'egress-direct-private', 'egress-direct-6pn', 'egress-direct-dns-private', 'egress-allowed-private']) {
      assert.doesNotMatch(r[id], /code=(200|401)\b/, `${id} must fail: ${r[id]}`)
    }
    assert.match(r['egress-public'], /Example Domain/, `egress-public: ${r['egress-public']}`)

    // Browser: the broker is outside the cell and Chromium's URLBlocklist
    // refuses file://. Ordinary https still works.
    assert.doesNotMatch(r['browser-file-dsh'], new RegExp(BROWSER_SENTINEL), `browser-file-dsh: ${r['browser-file-dsh']}`)
    assert.doesNotMatch(r['browser-file-passwd'], /root:x:0:0/, `browser-file-passwd: ${r['browser-file-passwd']}`)
    assert.match(r['browser-https'], /Example Domain/, `browser-https: ${r['browser-https']}`)
    assert.doesNotMatch(r['browser-bot-api'], /device-unauthorized/, `browser-bot-api: ${r['browser-bot-api']}`)
    assert.match(r['browser-bot-api'], /403|ERR_|blocked|Error/, `browser-bot-api is refused: ${r['browser-bot-api']}`)
    assert.doesNotMatch(r['browser-metadata'], /ami-|instance-id/, `browser-metadata: ${r['browser-metadata']}`)
    assert.match(r['browser-metadata'], /blocked|ERR_|403|Error/, `browser-metadata is refused: ${r['browser-metadata']}`)

    // The unconfined read/search tools are not mounted.
    for (const id of ['fs-read-secret', 'fs-read-bot-config', 'fs-read-environ']) assert.doesNotMatch(r[id], sentinel, `${id}: ${r[id]}`)
    assert.match(r['fs-read-secret'], /not found|cannot read/, `fs-read-secret: ${r['fs-read-secret']}`)
    assert.match(r['fs-read-bot-config'], /not found|cannot read/, `fs-read-bot-config: ${r['fs-read-bot-config']}`)
    assert.doesNotMatch(r['fs-read-credentials'], /secret:|secret\s/, `fs-read-credentials: ${r['fs-read-credentials']}`)
    assert.match(r['fs-read-credentials'], /not found|cannot read/, `fs-read-credentials: ${r['fs-read-credentials']}`)
    // The patch is inside the cell; it carries only per-boot capabilities the
    // agent already has, never the model key or host secret.
    assert.match(r['fs-read-patch'], /authorization: Bearer/, `fs-read-patch read the patch: ${r['fs-read-patch']}`)
    assert.doesNotMatch(r['fs-read-patch'], sentinel, `fs-read-patch has no real key: ${r['fs-read-patch']}`)
    assert.doesNotMatch(r['fs-write-config'], /Created file|Updated file/, `fs-write-config: ${r['fs-write-config']}`)

    // Bounded resource attacks end and the bot is still there.
    assert.match(r['fork-bomb'], /fork-done/, `fork-bomb: ${r['fork-bomb']}`)
    assert.match(r['memory-blowup'], /mem-done/, `memory-blowup: ${r['memory-blowup']}`)
    assert.match(r['disk-fill'], /disk-done/, `disk-fill: ${r['disk-fill']}`)
    const size = /(\d{6,})/.exec(r['disk-fill'])
    if (size) assert.ok(Number(size[1]) <= 268_435_456, `disk-fill wrote ${size[1]} bytes`)
    // Many small files reach the workspace image's ENOSPC; the bot keeps
    // working and can still write its own config under /data.
    assert.match(r['disk-quota'], /quota-full-\d+/, `disk-quota: ${r['disk-quota']}`)
    assert.match(r['disk-quota'], /disk-quota-done/, `disk-quota: ${r['disk-quota']}`)
    assert.match(r['kill-dsh'], /kill-dsh-done/, `kill-dsh: ${r['kill-dsh']}`)
    assert.match(r.after, /alive/, `after: ${r.after}`)
    // Real OOM: hogs die, the bot and DSH do not (a restart would show here).
    assert.match(r['memory-pressure'], /mem-pressure-done/, `memory-pressure: ${r['memory-pressure']}`)
    const oomLog = execFileSync('docker', ['exec', run.container, 'dmesg'], { encoding: 'utf8' }).split('\n').filter((l) => /Memory cgroup out of memory|oom-kill|Killed process/.test(l)).slice(-10).join('\n')
    assert.match(oomLog, /Killed process/, `the kernel OOM killer ran: ${oomLog}`)
    assert.equal(Number(execFileSync('docker', ['inspect', '--format', '{{.RestartCount}}', run.container], { encoding: 'utf8' }).trim()), 0, 'the bot did not restart under memory pressure')

    assert.ok(await healthy(run.origin), 'the bot is healthy after the probes')
    assert.equal((await sendEventually(run))?.status, 200, 'a new message is accepted after the probes')
    const settings = await fetch(`${run.origin}/settings`, { method: 'PUT', headers: { authorization: `Bearer ${run.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ language: 'en' }) })
    assert.equal(settings.status, 200, `PUT /settings after the workspace is full: ${settings.status}`)
    assert.match(execFileSync('docker', ['exec', run.container, 'cat', '/data/config.json'], { encoding: 'utf8' }), /"language": "en"/, 'the bot wrote its config while the workspace was full')

    // Killing DSH is a bot restart (Fly's restart policy); killing the bot is
    // the same. Either way the data volume keeps the device, and a new message
    // is accepted afterwards.
    let restarts = Number(execFileSync('docker', ['inspect', '--format', '{{.RestartCount}}', run.container], { encoding: 'utf8' }).trim())
    try { execFileSync('docker', ['exec', run.container, 'sh', '-c', 'for p in /proc/[0-9]*; do case "$(cat $p/comm 2>/dev/null)" in node|MainThread) ;; *) continue;; esac; c=$(tr "\\0" " " < "$p/cmdline" 2>/dev/null); case "$c" in *dsh/lib/bin.js*) kill -9 "${p#/proc/}";; esac; done']) } catch { /* the exec dies with the container it just killed */ }
    assert.ok(await waitRestart(run.container, restarts, run.origin), 'the bot comes back after DSH is killed')
    assert.equal((await sendEventually(run))?.status, 200, 'a new message is accepted after DSH is killed')

    // SIGTERM's handler exits cleanly; the test container uses --restart=always
    // so both a crash (DSH killed) and a clean exit come back. Fly uses
    // on-failure for the crash path.
    restarts = Number(execFileSync('docker', ['inspect', '--format', '{{.RestartCount}}', run.container], { encoding: 'utf8' }).trim())
    try { execFileSync('docker', ['exec', run.container, 'sh', '-c', 'kill -TERM 1']) } catch { /* the exec dies with PID 1 */ }
    assert.ok(await waitRestart(run.container, restarts, run.origin), 'the bot comes back after it is killed')
    assert.equal((await sendEventually(run))?.status, 200, 'a new message is accepted after the bot is killed')
  } finally {
    if (!closed) { closed = true; await run.close() }
  }
})

// H2: an explicit screenshot name is resolved against Playwright MCP's cwd, which was the
// root-owned /data/browser-broker, so the write failed with EACCES; afterwards the MCP session was gone ("Session
// not found"). The broker's own dirs must belong to uid 1001. A name the model gives is dropped (Playwright MCP returns
// the image only for an unnamed screenshot), so a path the model names is never
// written. The bot then saves the image as uid 1000 into the work folder's screenshots/, where the assistant can
// hand it over.
test('browser: the broker is uid 1001, a name the model gives is dropped, the screenshot is a work-folder file, and the session lives on', { skip: process.env.DEEPSEEK_BOT_E2E !== '1' || !dockerReady(), timeout: 600_000 }, async () => {
  const probes = [
    { id: 'navigate', call: { name: 'mcp__browser__browser_navigate', arguments: { url: 'https://example.com' } } },
    { id: 'screenshot', call: { name: 'mcp__browser__browser_take_screenshot', arguments: { filename: 'example-com.png' } } },
    { id: 'refused', call: { name: 'mcp__browser__browser_take_screenshot', arguments: { filename: '/data/workspace/outside.png' } } },
    { id: 'after', call: { name: 'mcp__browser__browser_snapshot', arguments: {} } },
  ]
  const run = await runBreakout(IMAGE, { probes, mountSrc: join(process.cwd(), 'src'), port: await freePort(), memory: '1g', dockerArgs, keep: true, timeoutMs: 300_000 })
  try {
    assert.match(run.results.navigate, /Example Domain/, run.results.navigate)
    assert.doesNotMatch(run.results.screenshot, /EACCES|Session not found/, run.results.screenshot)
    assert.match(run.results.screenshot, /Screenshot of viewport|example-com\.png/, run.results.screenshot)
    // the link names where the file is, so the thread never takes a workspace file of the same name for it (src/fold.ts)
    const shot = /\]\((\/data\/workspace\/screenshots\/page-[^)]+\.png)\)/.exec(run.results.screenshot)?.[1]
    assert.ok(shot, run.results.screenshot)
    assert.doesNotMatch(run.results.screenshot, /browser-broker/, 'the reply names only the work-folder copy')
    assert.match(run.results.refused, /\]\(\/data\/workspace\/screenshots\/page-[^)]+\.png\)/, run.results.refused)
    assert.equal(execFileSync('docker', ['exec', run.container, 'stat', '-c', '%u %a', shot!], { encoding: 'utf8' }).trim(), '1000 644', 'the cell owns the saved screenshot')
    assert.equal(execFileSync('docker', ['exec', run.container, 'sh', '-c', 'test -e /data/workspace/outside.png && echo yes || echo no'], { encoding: 'utf8' }).trim(), 'no')
    assert.match(run.results.after, /Example Domain/, `the session survives a failed screenshot: ${run.results.after}`)
    const stat = execFileSync('docker', ['exec', run.container, 'stat', '-c', '%u %a %n', '/data/browser-broker', '/data/browser-broker/output'], { encoding: 'utf8' })
    assert.match(stat, /^1001 700 \/data\/browser-broker$/m, stat)
    assert.match(stat, /^1001 700 \/data\/browser-broker\/output$/m, stat)
    let wrote = true
    try { execFileSync('docker', ['exec', '-u', '1000', run.container, 'sh', '-c', 'touch /data/browser-broker/agent-write'], { stdio: 'pipe' }) } catch { wrote = false }
    assert.equal(wrote, false, 'the cell uid cannot write the broker directory')
    assert.doesNotMatch(run.logs, /browser broker exited/)
  } finally { await run.close() }
})

test('egress policy: an allow-listed private host is reachable; the default stays closed', { skip: process.env.DEEPSEEK_BOT_E2E !== '1' || !dockerReady(), timeout: 600_000 }, async () => {
  if (process.env.DEEPSEEK_BOT_CONTAINMENT_NO_BUILD !== '1') {
    execFileSync('docker', ['build', '--build-arg', 'WITH_BROWSER=1', '-t', IMAGE, '.'], { stdio: 'inherit' })
  } else {
    execFileSync('docker', ['image', 'inspect', IMAGE], { stdio: 'ignore' })
  }
  const server = createHttpServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('allowed-private-ok') })
  server.listen(3898, '0.0.0.0'); await once(server, 'listening')
  try {
    const run = await runBreakout(IMAGE, {
      only: ['egress-allowed-private', 'egress-private'],
      env: { DEEPSEEK_BOT_GUARD_ALLOW: 'host.docker.internal' },
      port: await freePort(), memory: '1g', dockerArgs,
    })
    try {
      assert.match(run.results['egress-allowed-private'], /code=200/, run.results['egress-allowed-private'])
      assert.doesNotMatch(run.results['egress-private'], /code=(200|401)\b/, run.results['egress-private'])
    } finally { await run.close() }
  } finally { await new Promise<void>((r) => server.close(() => r())) }
})

async function send(run: { origin: string; token: string; sessionId: string }): Promise<Response> {
  return fetch(`${run.origin}/threads/${run.sessionId}/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${run.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'are you there?' }),
  })
}
