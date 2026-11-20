import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { networkInterfaces, platform, tmpdir, arch } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'

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

test('local use: pair by QR, reach the bot through the tunnel, nothing on the local network, restart, remove the device', { skip, timeout: 300_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'pocket-e2e-'))
  const keys = mkdtempSync(join(tmpdir(), 'pocket-e2e-keys-'))
  const port = await freePort()
  const start = () => {
    const c = spawn(process.execPath, ['src/main.ts', '--home', home, '--port', String(port), '--model', 'deepseek-official/deepseek-flash', '--api-key-env', 'DEEPSEEK_BOT_MODEL_KEY'], { cwd: join(import.meta.dirname, '..'), env: { ...process.env, DEEPSEEK_BOT_MODEL_KEY: 'unused', DEEPSEEK_BOT_IN_CONTAINER: '', DEEPSEEK_BOT_PUBLIC_URL: '' }, stdio: ['pipe', 'pipe', 'pipe'] })
    const box = { out: '', c }
    c.stdout!.on('data', (d) => { box.out += d }); c.stderr!.on('data', (d) => { box.out += d })
    return box
  }
  const stop = (c: ChildProcess) => new Promise<void>((r) => { c.once('exit', () => r()); c.kill('SIGTERM') })
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
    // The phone shows four emoji; the bot shows the same with the phone's name and waits for y or n on its stdin.
    const pairPhone = async (qr: string, answer: 'y' | 'n') => {
      writeFileSync(qrFile, qr, { mode: 0o600 })
      const asked = (bot.out.match(/\[bot\] pair-request \{.*\}/g) ?? []).length
      const p = spawn('sh', ['-c', `"${PHONE}" pair -device "Test phone" -key "${key}" -out "${linkFile}" - < "${qrFile}"`], { stdio: ['ignore', 'pipe', 'pipe'] }); children.push(p)
      let err = ''; p.stderr!.on('data', (d) => { err += d })
      const exited = new Promise<number | null>((r) => p.once('exit', (c) => r(c)))
      const ask = await until('the bot asks whether the emoji are the same', 120_000, () => (bot.out.match(/\[bot\] pair-request (\{.*\})/g) ?? [])[asked])
      const shown = JSON.parse(ask.replace('[bot] pair-request ', '')) as { device: string; emoji: string[] }
      const onPhone = await until('the phone shows its emoji', 10_000, () => /emoji: (.+?) \(check/.exec(err)?.[1])
      assert.equal(shown.device, 'Test phone')
      assert.equal(shown.emoji.length, 4)
      assert.equal(onPhone, shown.emoji.join(' '), 'both screens show the same four emoji')
      bot.c.stdin!.write(`${answer}\n`)
      return { status: await exited, err }
    }
    // a no pairs nobody, and spends that code: the next one comes up
    const refused = await pairPhone(first, 'n')
    assert.notEqual(refused.status, 0)
    // connectphone.ErrUnauthorized, which the bridges report as `unauthorized`, right after the no (TailPocket v0.3.0-pre.9)
    assert.match(refused.err, /the host rejected the invite/)
    const qr = await until('a new code after the refusal', 30_000, () => { const all = bot.out.match(/tailpocket2:\S+/g) ?? []; return all.at(-1) !== first ? all.at(-1) : undefined })
    const paired = await pairPhone(qr, 'y')
    assert.equal(paired.status, 0, paired.err)
    const code = JSON.parse(readFileSync(linkFile, 'utf8')).payload as string
    assert.match(code, /^\d{6}$/, 'the Boop code came inside the tunnel')

    const connect = async () => {
      const p = spawn(PHONE, ['connect', '-link', linkFile], { stdio: ['ignore', 'pipe', 'pipe'] }); children.push(p)
      let out = ''; p.stdout!.on('data', (d) => { out += d }); p.stderr!.on('data', (d) => { out += d })
      const m = await until('the test phone listens', 60_000, () => /listening (127\.0\.0\.1:\d+) base (http:\/\/\S+\/_tailpocket\/\S+) token/.exec(out))
      return { p, addr: m[1], origin: m[2] }
    }
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
