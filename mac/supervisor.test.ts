// The supervisor keeps the bot alive under the Mac window (`nsh test supervisor.test.ts`).
// `process.spawn` is not available headless, so the tests inject a fake one.
import { expect, test } from 'nsh/test'
import { backoffMs, createSupervisor, MAX_FAILURES, parsePairing, resourcesDir, type BotState, type ChildLike } from './src/supervisor.ts'

const RES = '/Applications/Boop.app/Contents/Resources'

class FakeChild implements ChildLike {
  pid = 1
  killed = false
  private handlers: Record<string, ((payload: unknown) => void)[]> = {}
  on(event: string, handler: (payload: never) => void) { (this.handlers[event] ??= []).push(handler as (payload: unknown) => void); return this }
  emit(event: string, payload: unknown) { for (const h of this.handlers[event] ?? []) h(payload) }
  kill() { this.killed = true }
}

function harness(locate: () => Promise<string> = async () => RES) {
  const spawned: { command: string; args: string[]; child: FakeChild }[] = []
  const timers: { fn: () => void; ms: number }[] = []
  const states: BotState[] = []
  const sup = createSupervisor({
    locate,
    spawn: (command, args) => { const child = new FakeChild(); spawned.push({ command, args, child }); return child },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length },
    clearTimeout: () => {},
    onChange: (s) => states.push(s),
  })
  const last = () => spawned[spawned.length - 1]
  const state = () => states[states.length - 1]
  const fire = () => { const t = timers.shift()!; t.fn(); return t.ms }
  return { sup, spawned, timers, states, last, state, fire }
}

test('parsePairing reads the link and the code out of the bot\'s line', () => {
  expect(parsePairing('  http://192.168.1.23:3850/pair?code=123456')).toEqual({ url: 'http://192.168.1.23:3850/pair?code=123456', code: '123456' })
  expect(parsePairing('  tailpocket1:eNo_abc-1')).toEqual({ url: 'tailpocket1:eNo_abc-1', code: null }) // src/main.ts printPocketPairing
  expect(parsePairing('[bot] home /x')).toBe(null)
  expect(parsePairing('Open this on your phone (same Wi-Fi), then add it to your home screen:')).toBe(null)
})

test('resourcesDir goes from the app executable to Contents/Resources', () => {
  expect(resourcesDir('/Applications/Boop.app/Contents/MacOS/DeepSeekBot')).toBe(RES)
})

test('backoff doubles from one second and stops at thirty', () => {
  expect([1, 2, 3, 4, 5, 6, 10].map(backoffMs)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000])
})

test('start locates the bundle and runs its run.sh through /bin/sh on port 3850', async () => {
  const h = harness()
  await h.sup.start()
  expect(h.spawned.length).toBe(1)
  expect(h.last().command).toBe('/bin/sh')
  expect(h.last().args).toEqual([`${RES}/bot/run.sh`, 'bot', '--port', '3850'])
  expect(h.state().phase).toBe('starting')
})

test('the pairing line makes it running, with the link and the code', async () => {
  const h = harness()
  await h.sup.start()
  h.last().child.emit('stdout', '[bot] listening to the assistant')
  expect(h.state().phase).toBe('starting')
  h.last().child.emit('stdout', '  http://192.168.1.23:3850/pair?code=654321')
  expect(h.state()).toEqual({ phase: 'running', pairUrl: 'http://192.168.1.23:3850/pair?code=654321', code: '654321', port: 3850, failures: 0, restarts: 0 })
})

test('a bot whose TailPocket helper did not start says so: no phone could reach it, so the window must not keep waiting for a code', async () => {
  const h = harness()
  await h.sup.start()
  h.last().child.emit('stderr', '[bot] TailPocket did not start (spawn failed). No phone can reach this computer; start with --host 0.0.0.0 for the local network.')
  expect(h.state().phase).toBe('failed')
})

test('a bot that dies after it was running is started again after one second', async () => {
  const h = harness()
  await h.sup.start()
  h.last().child.emit('stdout', '  http://192.168.1.23:3850/pair?code=654321')
  h.last().child.emit('exit', { code: 1, signal: null })
  expect(h.state().phase).toBe('restarting')
  expect(h.state().pairUrl).toBe(null)
  expect(h.fire()).toBe(1000)
  expect(h.spawned.length).toBe(2)
  expect(h.state().phase).toBe('starting')
  expect(h.state().restarts).toBe(1)
  h.last().child.emit('stdout', '  http://192.168.1.23:3850/pair?code=111111')
  expect(h.state().code).toBe('111111')
})

test('a bot that dies before pairing is retried with a growing wait, then given up on', async () => {
  const h = harness()
  await h.sup.start()
  const waits: number[] = []
  for (let i = 1; i < MAX_FAILURES; i++) {
    h.last().child.emit('exit', { code: 1, signal: null })
    expect(h.state().phase).toBe('restarting')
    expect(h.state().failures).toBe(i)
    waits.push(h.fire())
  }
  expect(waits).toEqual([1000, 2000, 4000, 8000])
  h.last().child.emit('exit', { code: 1, signal: null })
  expect(h.state().phase).toBe('failed')
  expect(h.timers.length).toBe(0)
  expect(h.spawned.length).toBe(MAX_FAILURES)
})

test('a taken port is not a failure: the next port is tried at once', async () => {
  const h = harness()
  await h.sup.start()
  h.last().child.emit('stderr', 'Error: listen EADDRINUSE: address already in use 0.0.0.0:3850')
  h.last().child.emit('exit', { code: 1, signal: null })
  expect(h.state().failures).toBe(0)
  expect(h.fire()).toBe(0)
  expect(h.last().args).toEqual([`${RES}/bot/run.sh`, 'bot', '--port', '3851'])
  expect(h.state().port).toBe(3851)
})

test('stop kills the bot and nothing starts again', async () => {
  const h = harness()
  await h.sup.start()
  const child = h.last().child
  h.sup.stop()
  expect(child.killed).toBe(true)
  expect(h.state().phase).toBe('stopped')
  child.emit('exit', { code: null, signal: 'SIGTERM' })
  expect(h.timers.length).toBe(0)
  expect(h.spawned.length).toBe(1)
})

test('when the bundle cannot be found the state is failed and nothing is spawned', async () => {
  const h = harness(async () => { throw new Error('no run.sh') })
  await h.sup.start()
  expect(h.state().phase).toBe('failed')
  expect(h.spawned.length).toBe(0)
})
