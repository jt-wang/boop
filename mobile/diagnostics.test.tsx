import { expect, open, test } from 'nsh/test'
import { Bot, pair } from './src/api.ts'
import { diagnosticLog, exportDiagnostics } from './src/diagnostics.ts'

const key = 'boop.diagnostics.v1' // gitleaks:allow -- local storage name, not a credential
const enter = async (app: Awaited<ReturnType<typeof open>>) => {
  await app.waitFor('id:diagnostics-open')
  await app.press('id:diagnostics-open')
  await app.waitFor('id:diagnostics-enabled')
}

test('Bot operations retain their responses but export no credentials, content, paths or raw errors', async () => {
  const bait = { token: 'BAIT_TOKEN_AUTH', query: 'BAIT_QUERY', fragment: 'BAIT_FRAGMENT', path: '/Users/BAIT_USER/private', prompt: 'BAIT_PROMPT', reply: 'BAIT_REPLY', terminal: 'BAIT_TERMINAL', input: 'BAIT_KEYBOARD', error: 'BAIT_ERROR', session: 'BAIT_SESSION', name: 'BAIT_NAME' }
  const all = { interaction: true, performance: true, network: true, resources: true }
  const original = globalThis.fetch
  let calls = 0, response = '{}', rejected = false
  globalThis.fetch = async (_url, init) => {
    calls++
    if (calls > 1) expect((init!.headers as Record<string, string>).authorization).toBe(`Bearer ${bait.token}`)
    if (rejected) throw Error(bait.error)
    return new Response(response, { status: 200 })
  }
  diagnosticLog.configure(true, all, false)
  try {
    response = JSON.stringify({ token: bait.token })
    expect(await pair(`https://example.test/?${bait.query}#${bait.fragment}`, '123456', bait.name)).toEqual({ ok: true, token: bait.token })
    const bot = new Bot({ origin: 'https://example.test', token: bait.token })
    response = JSON.stringify({ text: bait.reply })
    expect(await bot.prompt(bait.session, bait.prompt)).toEqual({ text: bait.reply })
    expect(await bot.send('POST', '/input', bait.input, true)).toEqual({ text: bait.reply })
    response = bait.terminal
    expect(await bot.text(`/file?path=${bait.path}`)).toBe(bait.terminal)
    response = JSON.stringify({ result: { ok: false, error: { message: bait.error } } })
    let message = ''
    try { await bot.rpc('terminal', { command: bait.input }) } catch (error) { message = (error as Error).message }
    expect(message).toBe(bait.error)
    rejected = true
    try { await bot.get(`/error?${bait.query}`) } catch (error) { expect((error as Error).message).toBe(bait.error) }
    const report = exportDiagnostics(0, all), output = JSON.stringify(report)
    expect(report.events.map(e => e.fields.operation)).toEqual(['pair', 'prompt', 'send', 'text', 'rpc', 'get'])
    for (const secret of Object.values(bait)) expect(output.includes(secret)).toBe(false)
    expect(calls).toBe(6)
  } finally { globalThis.fetch = original; diagnosticLog.configure(false, all, false) }
})

test('diagnostics opt-in, restart retention, clear and explicit export work without network', async () => {
  const exports: string[] = []
  const host = { handlers: { 'diagnostics.share': (data: { text: string }) => { exports.push(data.text); return { opened: true } } } }
  const app = await open('./App.tsx', { clock: {}, host })
  await enter(app)
  await app.clock!.fastForward(120000)
  expect(app.storage()[key]).toBe(undefined)
  expect(app.requests().length).toBe(0)
  await app.press('id:diagnostics-enabled')
  await app.press('id:diagnostics-retain')
  await app.press('id:diagnostics-back')
  await enter(app)
  await app.press('id:diagnostics-enabled')
  const saved = app.storage()
  expect(JSON.parse(saved[key]).events.some((e: { event: string }) => e.event === 'ui.navigation')).toBe(true)
  await app.press('id:diagnostics-share') // Cancel is the default; no host export.
  await app.waitFor('text:Review & share…')
  expect(exports.length).toBe(0)
  app.onDialog(() => 'Share')
  await app.press('id:diagnostics-share')
  await app.waitFor('text:Review & share…')
  await app.press('id:diagnostics-share')
  await app.waitFor('text:Review & share…')
  expect(exports.length).toBe(2)
  const first = JSON.parse(exports[0]), second = JSON.parse(exports[1])
  expect(first.schemaVersion).toBe(1)
  expect(first.exportId === second.exportId).toBe(false)
  expect(first.events.length > 0).toBe(true)
  expect(first.range.to - first.range.from).toBe(900000)
  const restored = await open('./App.tsx', { storage: saved, clock: {}, host })
  restored.clock!.setSystemTime(first.range.to)
  await enter(restored)
  expect(restored.shows('text:Off')).toBe(true)
  restored.onDialog(() => 'Share')
  await restored.press('id:diagnostics-share')
  await restored.waitFor('text:Review & share…')
  expect(JSON.parse(exports[2]).events).toEqual(first.events)
  await restored.press('id:diagnostics-clear')
  await restored.press('id:diagnostics-share')
  await restored.waitFor('text:Review & share…')
  expect(JSON.parse(exports[3]).events).toEqual([])
  expect(JSON.parse(restored.storage()[key]).events).toEqual([])
  expect(restored.requests().length).toBe(0)
})

test('failed real pairing operation exports only metadata, with category selection and no automatic share', async () => {
  let output = '', requests = 0
  const app = await open('./App.tsx', {
    host: { handlers: { 'diagnostics.share': (data: { text: string }) => { output = data.text; return {} } } },
    network: { 'POST https://canary-host.example/pair': req => {
      requests++
      expect(JSON.parse(String(req.body)).code).toBe('983271')
      return { status: 403, body: { error: 'CANARY_ERROR_BODY' } }
    } },
  })
  await enter(app)
  await app.press('id:diagnostics-enabled')
  await app.press('id:diagnostics-back')
  await app.press('id:own-computer')
  if (app.shows('id:connect-server')) await app.press('id:connect-server')
  await app.type('id:address', 'https://canary-host.example/?query=CANARY_QUERY#CANARY_FRAGMENT')
  await app.type('id:code', '983271')
  await app.press('id:connect')
  await app.waitFor('id:connect-error')
  expect(output).toBe('')
  await enter(app)
  await app.press('id:diagnostics-export-interaction')
  app.onDialog(() => 'Share')
  await app.press('id:diagnostics-share')
  await app.waitFor('text:Review & share…')
  const report = JSON.parse(output)
  expect(report.events.length).toBe(1)
  expect(report.events[0].fields.operation).toBe('pair')
  expect(report.events[0].fields.status).toBe(403)
  expect(report.categories).toEqual(['performance', 'network', 'resources'])
  for (const bait of ['canary-host', 'CANARY_QUERY', 'CANARY_FRAGMENT', '983271', 'CANARY_ERROR_BODY']) expect(output.includes(bait)).toBe(false)
  expect(requests).toBe(1)
  expect(app.requests().length).toBe(1)
})

test('performance and resource sampling stop in background and when disabled', async () => {
  let output = '', samples = 0
  const app = await open('./App.tsx', { clock: {}, host: { handlers: {
    'diagnostics.share': (data: { text: string }) => { output = data.text; return {} },
    'diagnostics.sample': () => { samples++; return { batteryLevel: 0.37, thermal: 'fair', lowPower: 'on', path: 'CANARY_NATIVE_PATH' } },
  } } })
  await enter(app)
  await app.press('id:diagnostics-enabled')
  await app.clock!.fastForward(60000)
  await app.host.send('appState', { state: 'background' })
  await app.clock!.fastForward(180000)
  await app.host.send('appState', { state: 'foreground' })
  await app.clock!.fastForward(60000)
  await app.press('id:diagnostics-enabled')
  await app.clock!.fastForward(180000)
  app.onDialog(() => 'Share')
  await app.press('id:diagnostics-share')
  await app.waitFor('text:Review & share…')
  const events = JSON.parse(output).events.filter((e: { event: string }) => e.event === 'js.callback')
  expect(events.length).toBe(2)
  expect(events.map((e: { fields: unknown }) => e.fields)).toEqual([{ intervalMs: 60000, delayMs: 0 }, { intervalMs: 60000, delayMs: 0 }])
  expect(samples).toBe(2)
  expect(JSON.parse(output).events.filter((e: { event: string }) => e.event === 'device.sample').length).toBe(2)
  expect(output.includes('CANARY_NATIVE_PATH')).toBe(false)
  expect(app.requests().length).toBe(0)
})

test('failed native persistence disables collection and clear failures remain visible', async () => {
  let samples = 0
  const app = await open('./App.tsx', { clock: {}, host: { params: { diagnostics: true }, handlers: {
    'diagnostics.read': null,
    'diagnostics.write': () => { throw Error('CANARY_STORAGE_FAILURE') },
    'diagnostics.remove': true,
    'diagnostics.sample': () => { samples++; return {} },
  } } })
  await enter(app)
  await app.press('id:diagnostics-retain')
  await app.press('id:diagnostics-enabled')
  await app.waitFor('text:Off')
  await app.clock!.fastForward(120000)
  expect(samples).toBe(0)
  await app.press('id:diagnostics-clear')
  await app.waitFor('text:Could not clear saved logs. Try again.')
  expect(app.shows('text:Logs cleared')).toBe(false)
  expect(app.requests().length).toBe(0)
})
