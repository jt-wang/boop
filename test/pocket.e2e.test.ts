import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { networkInterfaces, platform, tmpdir, arch } from 'node:os'
import { join } from 'node:path'
import { createServer, isIPv4, isIPv6 } from 'node:net'
import { inflateSync } from 'node:zlib'

// The real bot started the way a person starts it, the real helper, the real Tailcat network, and TailPocket's test phone
// standing in for the app: pair by QR (TailPocket v0.3.0-pre.4: the person compares four emoji and answers on the computer),
// reach the bot through the tunnel's forward (only under its base, which carries a token), restart, remove the device. Needs a built checkout
// (scripts/tailpocket-sync.sh) and the internet; TAILPOCKET_DIR says where the checkout is.
const T = process.env.TAILPOCKET_DIR ?? join(import.meta.dirname, '..', '..', 'tailpocket')
const suffix = `${platform()}-${arch() === 'x64' ? 'amd64' : arch()}`
const PHONE = join(T, 'build', `tailpocket-phone-${suffix}`)
const HELPER = join(import.meta.dirname, '..', 'vendor', 'tailpocket', 'bin', `tailpocket-host-${suffix}`)
const skip = !process.env.DEEPSEEK_BOT_POCKET_E2E || !existsSync(PHONE) || !existsSync(HELPER)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const freePort = () => new Promise<number>((resolve) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address() as { port: number }; s.close(() => resolve(port)) }) })
const lanIp = () => Object.values(networkInterfaces()).flat().find((i) => i?.family === 'IPv4' && !i.internal)?.address

async function until<T>(what: string, ms: number, f: () => T | Promise<T>): Promise<NonNullable<T>> {
  const end = Date.now() + ms; let last: unknown
  while (Date.now() < end) { try { const v = await f(); if (v) return v as NonNullable<T> } catch (e) { last = e } await sleep(300) }
  throw new Error(`${what}: not within ${ms} ms (${String(last)})`)
}

type Bot = { out: string; c: ChildProcess }
const stop = (c: ChildProcess) => new Promise<void>((r) => { if (c.exitCode !== null) return r(); c.once('exit', () => r()); c.kill('SIGTERM') })

/** The bot as a person starts it; `env` adds to the environment (a fresh HOME, for one). */
function startBot(home: string, port: number, args: string[] = [], env: Record<string, string> = {}): Bot {
  const c = spawn(process.execPath, ['src/main.ts', '--home', home, '--port', String(port), '--model', 'deepseek-official/deepseek-flash', '--api-key-env', 'DEEPSEEK_BOT_MODEL_KEY', ...args], { cwd: join(import.meta.dirname, '..'), env: { ...process.env, DEEPSEEK_BOT_MODEL_KEY: 'unused', DEEPSEEK_BOT_IN_CONTAINER: '', DEEPSEEK_BOT_PUBLIC_URL: '', ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
  const box = { out: '', c }
  c.stdout!.on('data', (d) => { box.out += d }); c.stderr!.on('data', (d) => { box.out += d })
  return box
}

/** TailPocket's test phone pairs with `qr`. It shows four emoji; the bot shows the same with the phone's name and waits
 *  for y or n on its stdin. `phoneArgs`: what the phone may use (`-routes lan`). */
async function pairWith(bot: Bot, f: { qrFile: string; key: string; linkFile: string; children: ChildProcess[]; phoneArgs?: string[]; env?: Record<string, string> }, qr: string, answer: 'y' | 'n') {
  writeFileSync(f.qrFile, qr, { mode: 0o600 })
  const asked = (bot.out.match(/\[bot\] pair-request \{.*\}/g) ?? []).length
  const extra = (f.phoneArgs ?? []).map((a) => `"${a}"`).join(' ')
  const p = spawn('sh', ['-c', `"${PHONE}" pair ${extra} -device "Test phone" -key "${f.key}" -out "${f.linkFile}" - < "${f.qrFile}"`], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...f.env } }); f.children.push(p)
  let err = ''; p.stderr!.on('data', (d) => { err += d })
  const exited = new Promise<number | null>((r) => p.once('exit', (c) => r(c)))
  const ask = await until('the bot asks whether the emoji are the same', 120_000, () => (bot.out.match(/\[bot\] pair-request (\{.*\})/g) ?? [])[asked])
  const shown = JSON.parse(ask.replace('[bot] pair-request ', '')) as { device: string; route: string; emoji: string[] }
  const onPhone = await until('the phone shows its emoji', 10_000, () => /emoji: (.+?) \(check/.exec(err)?.[1])
  assert.equal(shown.device, 'Test phone')
  assert.equal(shown.emoji.length, 4)
  assert.equal(onPhone, shown.emoji.join(' '), 'both screens show the same four emoji')
  bot.c.stdin!.write(`${answer}\n`)
  return { status: await exited, err, route: shown.route }
}

/** The test phone opens the tunnel and listens on the phone's loopback, as the bridge does for the app. */
async function connectPhone(linkFile: string, children: ChildProcess[], phoneArgs: string[] = [], env: Record<string, string> = {}) {
  const p = spawn(PHONE, ['connect', ...phoneArgs, '-link', linkFile], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } }); children.push(p)
  let out = ''; p.stdout!.on('data', (d) => { out += d }); p.stderr!.on('data', (d) => { out += d })
  const m = await until('the test phone listens', 60_000, () => /listening (127\.0\.0\.1:\d+) base (http:\/\/\S+\/_tailpocket\/\S+) token/.exec(out))
  return { p, addr: m[1], origin: m[2] }
}

test('local use: pair by QR, reach the bot through the tunnel, nothing on the local network, restart, remove the device', { skip, timeout: 300_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'pocket-e2e-'))
  const keys = mkdtempSync(join(tmpdir(), 'pocket-e2e-keys-'))
  const port = await freePort()
  const start = () => startBot(home, port)
  const children: ChildProcess[] = []
  let bot = start(); children.push(bot.c)
  try {
    const first = await until('the bot prints a pairing code', 90_000, () => /tailpocket2:\S+/.exec(bot.out)?.[0])
    assert.doesNotMatch(bot.out, /\/pair\?code=/, 'no plain pairing link')
    assert.equal(statSync(join(home, 'pairing.txt')).mode & 0o777, 0o600)
    assert.equal(readFileSync(join(home, 'pairing.txt'), 'utf8').trim(), first)

    // the bot listens on loopback only: the local network gets nothing
    const lan = lanIp()
    if (lan) await assert.rejects(fetch(`http://${lan}:${port}/me`, { signal: AbortSignal.timeout(3000) }), 'nothing listens on the local network')

    const qrFile = join(keys, 'qr.txt')
    const key = join(keys, 'phone.key'); const linkFile = join(keys, 'link.json')
    const pairPhone = (qr: string, answer: 'y' | 'n') => pairWith(bot, { qrFile, key, linkFile, children }, qr, answer)
    // a no pairs nobody, and spends that code: the next one comes up
    const refused = await pairPhone(first, 'n')
    assert.notEqual(refused.status, 0)
    // connectphone.ErrUnauthorized, which the bridges report as `unauthorized`, right after the no (TailPocket v0.3.0)
    assert.match(refused.err, /the host rejected the invite/)
    const qr = await until('a new code after the refusal', 30_000, () => { const all = bot.out.match(/tailpocket2:\S+/g) ?? []; return all.at(-1) !== first ? all.at(-1) : undefined })
    const paired = await pairPhone(qr, 'y')
    assert.equal(paired.status, 0, paired.err)
    const code = JSON.parse(readFileSync(linkFile, 'utf8')).payload as string
    assert.match(code, /^\d{6}$/, 'the Boop code came inside the tunnel')

    const connect = () => connectPhone(linkFile, children)
    let phone = await connect()
    const pair = await until('POST /pair through the tunnel', 120_000, async () => {
      const r = await fetch(`${phone.origin}/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, name: 'Test phone' }), signal: AbortSignal.timeout(20_000) })
      return r.status === 200 ? await r.json() as { token: string } : null
    })
    const h = { authorization: `Bearer ${pair.token}` }
    const me = await (await fetch(`${phone.origin}/me`, { headers: h })).json() as { device: { id: string; name: string } }
    assert.equal(me.device.name, 'Test phone')
    assert.equal((await fetch(`${phone.origin}/me`)).status, 401, 'the tunnel alone buys nothing: no token, no answer')
    assert.equal((await fetch(`http://${phone.addr}/me`, { headers: h })).status, 403, 'any program on the phone reaches the port: without the forward token it gets nothing')

    // a restarted computer keeps its phones
    await stop(phone.p); await stop(bot.c)
    bot = start(); children.push(bot.c)
    await until('the bot is back', 90_000, () => /listening to the assistant/.test(bot.out))
    phone = await connect()
    await until('the phone reconnects without pairing', 120_000, async () => (await fetch(`${phone.origin}/me`, { headers: h, signal: AbortSignal.timeout(20_000) })).status === 200)

    // removing the device cuts the phone off the tunnel, not only its token
    assert.equal((await fetch(`${phone.origin}/devices/${me.device.id}`, { method: 'DELETE', headers: h })).status, 200)
    await until('the tunnel refuses a removed phone', 60_000, async () => {
      const r = await fetch(`${phone.origin}/health`, { signal: AbortSignal.timeout(8000) }).catch(() => null)
      return r === null
    })
    // with no phone left, the way back in is on the screen again: a new code, which pairs
    const again = await until('a new code after the last phone went', 30_000, () => { const all = bot.out.match(/tailpocket2:\S+/g) ?? []; return all.at(-1) !== qr ? all.at(-1) : undefined })
    const repaired = await pairPhone(again, 'y')
    assert.equal(repaired.status, 0, repaired.err)
  } finally { for (const c of children) c.kill('SIGTERM') }
})

// ---- Without Tailcat (TailPocket v0.3.2 routes) ----

/** Every internet socket the given processes hold, sampled with lsof every 100 ms: `remote` for a connection, `local` for
 *  a listening or unconnected one. A short-lived connection between two samples can be missed; the control test below
 *  shows the same probe sees Tailcat when it is on. */
function watchSockets(pids: () => number[]) {
  const seen = new Map<string, { proto: string; local: string; remote?: string; cmd: string }>()
  let busy = false
  const sample = () => {
    const list = pids(); if (!list.length || busy) return
    busy = true
    execFile('lsof', ['+c', '0', '-nP', '-a', '-p', list.join(','), '-i'], (_e, out) => {
      busy = false
      for (const line of out.split('\n').slice(1)) {
        const cols = line.trim().split(/\s+/); if (cols.length < 9) continue
        const proto = cols[7]; const name = cols.slice(8).join(' ').replace(/ \(.*\)$/, '')
        const [local, remote] = name.split('->')
        seen.set(`${cols[0]} ${proto} ${name}`, { proto, local, remote, cmd: cols[0] })
      }
    })
  }
  const timer = setInterval(sample, 100)
  return { seen, stop: () => clearInterval(timer) }
}
const host = (addr: string) => addr.replace(/:\d+$/, '').replace(/^\[|\]$/g, '')
/** Loopback, private (RFC 1918), link-local, unique local, or the wildcard of a listener. */
const onThisNetwork = (addr: string) => {
  const h = host(addr)
  if (h === '*' || h === 'localhost') return true
  if (isIPv4(h)) { const [a, b] = h.split('.').map(Number); return a === 127 || a === 10 || (a === 172 && b >= 16 && b < 32) || (a === 192 && b === 168) || (a === 169 && b === 254) }
  if (isIPv6(h)) { const l = h.toLowerCase(); return l === '::1' || l.startsWith('fe80') || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('::ffff:127.') || l.startsWith('::ffff:192.168.') || l.startsWith('::ffff:10.') }
  return false
}
const pgrep = (...args: string[]) => { try { return execFileSync('pgrep', args, { encoding: 'utf8' }).trim().split('\n').map(Number).filter(Boolean) } catch { return [] } }
/** The bot's helper, and every test phone of this checkout (pairing and connected). */
const pocketPids = (botPid: number) => [...pgrep('-P', String(botPid), '-f', 'tailpocket-host'), ...pgrep('-f', PHONE)]
/** The v2 invite inside a `tailpocket2:` QR: zlib-compressed JSON (TailPocket connectinvite.Encode). */
const invite = (qr: string) => JSON.parse(inflateSync(Buffer.from(qr.slice('tailpocket2:'.length), 'base64url')).toString()) as { via: { t: string; a?: string[] }[] }
/** HOME and the XDG directories pointed at an empty directory; `tailcatFiles` lists anything named tailcat made there. */
function freshHome() {
  const dir = mkdtempSync(join(tmpdir(), 'pocket-home-'))
  const env = Object.fromEntries(['HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'XDG_DATA_HOME'].map((v) => [v, join(dir, v.toLowerCase())]))
  return { env, tailcatFiles: () => readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((p) => /tailcat/i.test(p)) }
}

test('LAN only (--routes lan): pair with emoji, reach the bot, restart, remove the device; never a Tailcat socket or file', { skip: skip || !lanIp(), timeout: 300_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'pocket-lan-'))
  const keys = mkdtempSync(join(tmpdir(), 'pocket-lan-keys-'))
  const machine = freshHome()
  const port = await freePort()
  const children: ChildProcess[] = []
  const phoneArgs = ['-routes', 'lan']
  let bot = startBot(home, port, ['--routes', 'lan'], machine.env); children.push(bot.c)
  const probe = watchSockets(() => pocketPids(bot.c.pid!))
  try {
    const first = await until('the bot prints a pairing code', 90_000, () => /tailpocket2:\S+/.exec(bot.out)?.[0])
    assert.match(bot.out, /TailPocket routes: the local network\. No Tailcat: nothing goes to tailcat\.dev or its relays\. A phone away from this network cannot connect\./)
    assert.match(bot.out, /works on this network/)
    assert.deepEqual(invite(first).via.map((r) => r.t), ['lan'], 'the QR lists the local network and nothing else')
    assert.equal(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')).routes.join(','), 'lan', 'kept for the next start')

    const f = { qrFile: join(keys, 'qr.txt'), key: join(keys, 'phone.key'), linkFile: join(keys, 'link.json'), children, phoneArgs, env: machine.env }
    const paired = await pairWith(bot, f, first, 'y')
    assert.equal(paired.status, 0, paired.err)
    assert.equal(paired.route, 'lan', 'the phone asked over the local network')
    const link = JSON.parse(readFileSync(f.linkFile, 'utf8')) as { payload: string; address?: string; via: { t: string }[] }
    assert.match(link.payload, /^\d{6}$/, 'the Boop code came inside the encrypted session')
    assert.ok(!link.address, 'no Tailcat address in the saved link')
    assert.deepEqual(link.via.map((r) => r.t), ['lan'])

    let phone = await connectPhone(f.linkFile, children, phoneArgs, machine.env)
    const pair = await until('POST /pair through the tunnel', 60_000, async () => {
      const r = await fetch(`${phone.origin}/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: link.payload, name: 'Test phone' }), signal: AbortSignal.timeout(10_000) })
      return r.status === 200 ? await r.json() as { token: string } : null
    })
    const h = { authorization: `Bearer ${pair.token}` }
    const me = await (await fetch(`${phone.origin}/me`, { headers: h })).json() as { device: { id: string; name: string } }
    assert.equal(me.device.name, 'Test phone')
    assert.equal((await fetch(`${phone.origin}/me`)).status, 401, 'the tunnel alone buys nothing')

    // a restarted computer without Tailcat still knows the phone: its end-to-end key was saved
    await stop(phone.p); await stop(bot.c)
    assert.ok(Object.keys(JSON.parse(readFileSync(join(home, 'tailpocket.json'), 'utf8')).keys ?? {}).length === 1, 'the phone\'s key is in tailpocket.json')
    bot = startBot(home, port, [], machine.env); children.push(bot.c) // no flag: config.json keeps --routes lan
    await until('the bot is back', 90_000, () => /listening to the assistant/.test(bot.out))
    assert.match(bot.out, /TailPocket routes: the local network\./)
    assert.doesNotMatch(bot.out, /pair again|scan a new code/)
    phone = await connectPhone(f.linkFile, children, phoneArgs, machine.env)
    await until('the phone reconnects without pairing', 60_000, async () => (await fetch(`${phone.origin}/me`, { headers: h, signal: AbortSignal.timeout(10_000) })).status === 200)

    // revoke works without Tailcat: removing the device closes the phone's session
    assert.equal((await fetch(`${phone.origin}/devices/${me.device.id}`, { method: 'DELETE', headers: h })).status, 200)
    await until('the tunnel refuses a removed phone', 60_000, async () => (await fetch(`${phone.origin}/health`, { signal: AbortSignal.timeout(5000) }).catch(() => null)) === null)
    await sleep(500)
  } finally { probe.stop(); for (const c of children) c.kill('SIGTERM') }
  const sockets = [...probe.seen.values()]
  // the probe saw both sides of the session over the local network, so it was looking at the right processes
  for (const side of ['tailpocket-host', 'tailpocket-phone']) assert.ok(sockets.some((s) => s.cmd.startsWith(side) && s.remote && !host(s.remote).startsWith('127.')), `${side} over the local network`)
  const off = sockets.filter((s) => !onThisNetwork(s.local) || (s.remote && !onThisNetwork(s.remote)))
  assert.deepEqual(off, [], 'no socket of the helper or the phone left this network')
  assert.deepEqual(sockets.filter((s) => s.proto === 'UDP'), [], 'no UDP at all: Tailcat\'s WireGuard runs over UDP, the local network route over TCP')
  assert.deepEqual(machine.tailcatFiles(), [], 'no Tailcat state written')
})

// The control: the same probe on a computer with Tailcat sees it leave the network, so the empty lists above mean something.
test('control: with Tailcat (no --routes) the same probe sees the helper reach beyond this network', { skip: skip || !lanIp(), timeout: 120_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'pocket-ctl-'))
  const machine = freshHome()
  const bot = startBot(home, await freePort(), [], machine.env)
  const probe = watchSockets(() => pocketPids(bot.c.pid!))
  try {
    const qr = await until('the bot prints a pairing code', 90_000, () => /tailpocket2:\S+/.exec(bot.out)?.[0])
    assert.ok(invite(qr).via.some((r) => r.t === 'tailcat'))
    await until('a socket beyond this network', 60_000, () => [...probe.seen.values()].some((s) => s.remote && !onThisNetwork(s.remote)))
  } finally { probe.stop(); await stop(bot.c) }
  assert.ok([...probe.seen.values()].some((s) => s.proto === 'UDP'), 'Tailcat holds UDP sockets')
})
