import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocketServer } from 'ws'
import { Library } from '../src/library.ts'
import { createBotServer } from '../src/server.ts'
import { MemoryDeviceStore } from '../src/devices.ts'

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'library-'))
  const ws = join(dir, 'workspace'); mkdirSync(join(ws, 'notes'), { recursive: true }); mkdirSync(join(ws, '.cache'))
  writeFileSync(join(ws, 'SOUL.md'), '# Soul\n'); writeFileSync(join(ws, 'USER.md'), ''); writeFileSync(join(ws, 'MEMORY.md'), '')
  writeFileSync(join(ws, 'notes', 'hello.md'), '# Hi\n\nold pond\n')
  writeFileSync(join(ws, 'chart.png'), PNG)
  writeFileSync(join(ws, 'data.bin'), Buffer.from([0, 1, 2, 255]))
  writeFileSync(join(ws, '.hidden'), 'x'); writeFileSync(join(ws, '.cache', 'c.txt'), 'x')
  writeFileSync(join(dir, 'outside.txt'), 'secret\n')
  return { dir, ws }
}

test('list: every workspace file except the memory files and dotfiles, with kind, size and mtime', async () => {
  const { ws } = workspace()
  const lib = new Library(ws)
  const items = await lib.list()
  const paths = items.map((i) => i.path).sort()
  assert.deepEqual(paths, ['chart.png', 'data.bin', 'notes/hello.md'])
  const md = items.find((i) => i.path === 'notes/hello.md')!
  assert.equal(md.kind, 'text'); assert.equal(md.size, 15); assert.ok(md.mtime > 0)
  assert.equal(items.find((i) => i.path === 'chart.png')!.kind, 'image')
  assert.equal(items.find((i) => i.path === 'data.bin')!.kind, 'binary')
})

test('list caps at 500 entries', async () => {
  const { ws } = workspace()
  for (let i = 0; i < 520; i++) writeFileSync(join(ws, `f${i}.txt`), 'x')
  assert.equal((await new Library(ws).list()).length, 500)
})

test('read: text comes back as utf8 with a mime, binary as bytes, text past 1 MiB is cut', async () => {
  const { ws } = workspace()
  const lib = new Library(ws)
  const md = (await lib.read('notes/hello.md'))!
  assert.equal(md.kind, 'text'); assert.equal(md.mime, 'text/markdown; charset=utf-8'); assert.equal(md.bytes.toString('utf8'), '# Hi\n\nold pond\n')
  const png = (await lib.read('chart.png'))!
  assert.equal(png.kind, 'image'); assert.equal(png.mime, 'image/png'); assert.ok(png.bytes.equals(PNG))
  writeFileSync(join(ws, 'big.txt'), 'a'.repeat((1 << 20) + 10))
  const big = (await lib.read('big.txt'))!
  assert.equal(big.bytes.length, 1 << 20); assert.equal(big.truncated, true)
})

test('read/remove refuse paths outside the workspace, dotfiles and the memory files', async () => {
  const { ws } = workspace()
  const lib = new Library(ws)
  for (const p of ['../outside.txt', '/etc/hosts', 'SOUL.md', '.hidden', '.cache/c.txt', 'notes/../../outside.txt', '']) {
    assert.equal(await lib.read(p), null, p)
    assert.equal(await lib.remove(p), false, p)
  }
  assert.equal(await lib.read('nope.md'), null)
  assert.equal(await lib.remove('notes/hello.md'), true)
  assert.equal(existsSync(join(ws, 'notes', 'hello.md')), false)
  assert.equal(await lib.remove('notes/hello.md'), false)
})

test('presented files: a `present` call adds a description, and a file outside the workspace becomes readable by its exact path', async () => {
  const { ws, dir } = workspace()
  const lib = new Library(ws)
  lib.notePresented([{ path: 'notes/hello.md', description: 'Your haiku' }, { path: join(dir, 'outside.txt'), description: 'Report' }], ws)
  const items = await lib.list()
  assert.equal(items.find((i) => i.path === 'notes/hello.md')!.description, 'Your haiku')
  const out = items.find((i) => i.path === join(dir, 'outside.txt'))!
  assert.ok(out, 'outside file listed'); assert.equal(out.description, 'Report'); assert.equal(out.kind, 'text'); assert.equal(out.size, 7)
  assert.equal((await lib.read(join(dir, 'outside.txt')))!.bytes.toString(), 'secret\n')
  assert.equal(await lib.read(join(dir, 'other.txt')), null, 'only the presented path, nothing else outside')
  // a presented file that no longer exists drops out of the list
  lib.notePresented([{ path: join(dir, 'gone.txt') }], ws)
  assert.equal((await lib.list()).some((i) => i.path.endsWith('gone.txt')), false)
})

// A fake dsh mux that answers session/follow with a snapshot holding one `deliverables/presented` record, then a live one.
async function fakeMux(cwd: string) {
  const srv = createServer((_req, res) => { res.writeHead(404); res.end() })
  const wss = new WebSocketServer({ server: srv, path: '/api/remote.mux' })
  const opened: unknown[] = []
  wss.on('connection', (ws) => {
    ws.on('message', (m) => {
      const f = JSON.parse(m.toString())
      opened.push(f)
      if (f.type === 'open' && f.endpoint === 'session/follow') {
        const send = (v: unknown) => ws.send(JSON.stringify({ type: 'item', streamId: f.streamId, value: v }))
        send({ type: 'snapshot', header: { version: 4, id: 'sess-main', cwd }, cursor: 3, records: [
          { type: 'event', event: { type: 'turn/start', seq: 1, time: 1, data: {} } },
          { type: 'event', event: { type: 'deliverables/presented', seq: 2, time: 2, data: { turn: 1, callId: 'c1', files: [{ path: 'notes/hello.md', description: 'From the snapshot' }] } } },
        ], hasMore: false, projections: { asOfSeq: 3, values: {} }, assistantStream: { revision: 0 } })
        setTimeout(() => send({ type: 'event', event: { type: 'deliverables/presented', seq: 4, time: 4, data: { turn: 2, callId: 'c2', files: [{ path: 'chart.png', description: 'Live one' }] } } }), 30)
      }
    })
  })
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
  const port = (srv.address() as { port: number }).port
  return { origin: `http://127.0.0.1:${port}`, opened, close: () => { for (const c of wss.clients) c.terminate(); wss.close(); srv.close() } }
}

test('follow: deliverables/presented events from a session (snapshot and live) land in the library', async () => {
  const { ws } = workspace()
  const dsh = await fakeMux(ws)
  const lib = new Library(ws)
  const seen: string[] = []
  lib.onPresented = (f) => { seen.push(...f.map((x) => x.path)) }
  try {
    lib.follow({ origin: dsh.origin, cookie: 'c=1' }, 'sess-main')
    lib.follow({ origin: dsh.origin, cookie: 'c=1' }, 'sess-main') // idempotent
    for (let i = 0; i < 100 && seen.length < 2; i++) await new Promise((r) => setTimeout(r, 20))
    assert.deepEqual(seen, [join(ws, 'notes', 'hello.md'), join(ws, 'chart.png')])
    assert.equal(dsh.opened.filter((f) => (f as { type: string }).type === 'open').length, 1, 'one follow per session')
    const items = await lib.list()
    assert.equal(items.find((i) => i.path === 'notes/hello.md')!.description, 'From the snapshot')
    assert.equal(items.find((i) => i.path === 'chart.png')!.description, 'Live one')
  } finally { lib.close(); dsh.close() }
})

test('routes: GET /library, GET /library/file, DELETE /library/file behind device auth', async () => {
  const { ws } = workspace()
  const devices = new MemoryDeviceStore()
  const library = new Library(ws)
  const bot = await createBotServer({ dsh: { origin: 'http://127.0.0.1:1', cookie: 'c=1' }, devices, workspace: ws, host: '127.0.0.1', port: 0, appDir: join(process.cwd(), 'app'), library })
  try {
    assert.equal((await fetch(`${bot.origin}/library`)).status, 401)
    const token = await devices.issue('tester')
    const api = (path: string, init: RequestInit = {}) => fetch(bot.origin + path, { ...init, headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) } })
    const list = await (await api('/library')).json() as { path: string; kind: string }[]
    assert.deepEqual(list.map((i) => i.path).sort(), ['chart.png', 'data.bin', 'notes/hello.md'])
    const md = await api('/library/file?path=notes%2Fhello.md')
    assert.equal(md.status, 200); assert.equal(md.headers.get('content-type'), 'text/markdown; charset=utf-8'); assert.equal(await md.text(), '# Hi\n\nold pond\n')
    const png = await api('/library/file?path=chart.png')
    assert.equal(png.headers.get('content-type'), 'image/png'); assert.ok(Buffer.from(await png.arrayBuffer()).equals(PNG))
    const asJson = await (await api('/library/file?path=chart.png&format=json')).json() as { kind: string; mime: string; base64: string }
    assert.equal(asJson.kind, 'image'); assert.equal(asJson.base64, PNG.toString('base64'))
    assert.equal((await api('/library/file?path=..%2Foutside.txt')).status, 404)
    assert.equal((await api('/library/file?path=SOUL.md')).status, 404)
    assert.equal((await api('/library/file?path=missing.md')).status, 404)
    assert.equal((await api('/library/file')).status, 400)
    assert.equal((await api('/library/file?path=notes%2Fhello.md', { method: 'DELETE' })).status, 200)
    assert.equal((await api('/library/file?path=notes%2Fhello.md')).status, 404)
  } finally { await bot.close() }
})

test('read/remove refuse a symlink or a symlinked folder that leaves the workspace', async () => {
  const { symlinkSync } = await import('node:fs')
  const { ws, dir } = workspace()
  symlinkSync(join(dir, 'outside.txt'), join(ws, 'link.txt'))
  symlinkSync(dir, join(ws, 'outdir'))
  const lib = new Library(ws)
  assert.equal(await lib.read('link.txt'), null)
  assert.equal(await lib.remove('link.txt'), false)
  assert.equal(await lib.read('outdir/outside.txt'), null)
  lib.notePresented([{ path: join(ws, 'link.txt') }], ws)
  assert.equal(await lib.read(join(ws, 'link.txt')), null)
})

// A browser screenshot lives in the harness's attachment store, not in the workspace. The app fetches
// it the way it fetches a presented image: from the bot with the device's token, in the same JSON shape. The bot asks
// the harness (`session/attachment`, answer shape measured 2026-10-27) with its own cookie; the phone never talks to DSH.
test('routes: GET /library/attachment answers a screenshot from the harness as an image, behind device auth', async () => {
  const { ws } = workspace()
  const asked: unknown[] = []
  let up = true
  const dsh = createServer((req, res) => {
    let body = ''
    req.on('data', (d) => { body += d })
    req.on('end', () => {
      if (!up) { res.writeHead(503); res.end('starting'); return }
      const env = JSON.parse(body) as { method: string; payload: { args: { request: { sessionId: string; attachmentId: string } } } }
      asked.push({ url: req.url, cookie: req.headers.cookie, ...env.payload.args.request })
      const { attachmentId } = env.payload.args.request
      const result = attachmentId === 'sha256:aa'
        ? { ok: true, value: { attachment: { attachmentId, mediaType: 'image/png', bytes: PNG.length, width: 1, height: 1 }, data: PNG.toString('base64') } }
        : { ok: false, error: { code: 'attachment/not-found', message: 'no such attachment' } }
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'server-response', rpcId: 'x', result }))
    })
  })
  await new Promise<void>((r) => dsh.listen(0, '127.0.0.1', r))
  const devices = new MemoryDeviceStore()
  const bot = await createBotServer({ dsh: { origin: `http://127.0.0.1:${(dsh.address() as { port: number }).port}`, cookie: 'c=1' }, devices, workspace: ws, host: '127.0.0.1', port: 0, appDir: join(process.cwd(), 'app'), library: new Library(ws) })
  try {
    const q = '/library/attachment?session=sess-main&id=sha256%3Aaa&format=json'
    assert.equal((await fetch(bot.origin + q)).status, 401)
    const token = await devices.issue('tester')
    const api = (path: string) => fetch(bot.origin + path, { headers: { authorization: `Bearer ${token}` } })
    const r = await api(q)
    assert.equal(r.status, 200)
    assert.deepEqual(await r.json(), { path: '', kind: 'image', mime: 'image/png', size: PNG.length, truncated: false, base64: PNG.toString('base64') })
    assert.deepEqual(asked, [{ url: '/api/session/attachment', cookie: 'c=1', sessionId: 'sess-main', attachmentId: 'sha256:aa' }])
    assert.equal((await api('/library/attachment?session=sess-main&id=sha256%3Abb&format=json')).status, 404)
    assert.equal((await api('/library/attachment?session=sess-main')).status, 400)
    up = false // the harness not answering is worth another try: the app retries a 5xx, not a 404
    assert.equal((await api(q)).status, 502)
  } finally { await bot.close(); dsh.close() }
})
