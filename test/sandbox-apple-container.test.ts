// Apple `container` CLI provider with a mocked exec. The CLI is not installed
// on this machine and was not run; the argument shapes follow Apple's
// container CLI help (github.com/apple/container, read 2026-10-27) and are
// not run against a real container.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AppleContainerProvider, parseContainerInspect } from '../src/sandbox/apple-container.ts'

function fakeCli() {
  const calls: string[][] = []
  const state = new Map<string, { status: string; port: number }>()
  const exec = async (args: string[]) => {
    calls.push(args)
    const [cmd] = args
    if (cmd === 'run') {
      const name = args[args.indexOf('--name') + 1]
      const pub = args[args.indexOf('--publish') + 1]
      state.set(name, { status: 'running', port: Number(pub.split(':')[1]) })
      return { stdout: 'abc123\n', stderr: '' }
    }
    if (cmd === 'inspect') {
      const s = state.get(args[1]); if (!s) throw Object.assign(new Error(`container not found: ${args[1]}`), { code: 1 })
      return { stdout: JSON.stringify([{ status: s.status, configuration: { id: args[1], publishedPorts: [{ hostAddress: '127.0.0.1', hostPort: s.port, containerPort: 3850, proto: 'tcp' }] } }]), stderr: '' }
    }
    if (cmd === 'stop') { state.get(args[1])!.status = 'stopped'; return { stdout: '', stderr: '' } }
    if (cmd === 'start') { state.get(args[1])!.status = 'running'; return { stdout: '', stderr: '' } }
    if (cmd === 'rm' || cmd === 'delete') { state.delete(args[args.length - 1]); return { stdout: '', stderr: '' } }
    if (cmd === 'volume') return { stdout: '', stderr: '' }
    if (cmd === 'ls' || cmd === 'list') return { stdout: JSON.stringify([...state.entries()].map(([id, s]) => ({ status: s.status, configuration: { id, publishedPorts: [{ hostAddress: '127.0.0.1', hostPort: s.port, containerPort: 3850, proto: 'tcp' }] } }))), stderr: '' }
    throw new Error(`unhandled ${args.join(' ')}`)
  }
  return { calls, state, exec }
}

test('parseContainerInspect reads status and the published loopback port', () => {
  assert.deepEqual(parseContainerInspect([{ status: 'running', configuration: { id: 'dsb-x', publishedPorts: [{ hostAddress: '127.0.0.1', hostPort: 3891, containerPort: 3850, proto: 'tcp' }] } }]), { status: 'running', origin: 'http://127.0.0.1:3891' })
  assert.deepEqual(parseContainerInspect([{ status: 'stopped', configuration: { id: 'dsb-x', publishedPorts: [] } }]), { status: 'stopped', origin: null })
  assert.equal(parseContainerInspect([]).status, 'missing')
})

test('apple-container: create runs with name, volume, loopback publish from the range and env via the environment; lifecycle maps statuses', async () => {
  const cli = fakeCli()
  const p = new AppleContainerProvider({ hostPortRange: [3890, 3896], exec: cli.exec })
  assert.equal(await p.status('acc-a1'), 'missing')
  const sb = await p.create('acc-a1', { image: 'deepseek-bot:slim', env: { DEEPSEEK_BOT_HOST_SECRET: 's' } })
  assert.equal(sb.origin, 'http://127.0.0.1:3890')
  const run = cli.calls.find((c) => c[0] === 'run')!
  assert.ok(run.includes('--detach'))
  assert.equal(run[run.indexOf('--name') + 1], 'dsb-acc-a1')
  assert.equal(run[run.indexOf('--volume') + 1], 'dsb-acc-a1-data:/data')
  assert.equal(run[run.indexOf('--publish') + 1], '127.0.0.1:3890:3850/tcp')
  assert.equal(run[run.indexOf('--env') + 1], 'DEEPSEEK_BOT_HOST_SECRET', 'name only; the value rides in the child environment')
  assert.equal(run[run.length - 1], 'deepseek-bot:slim')
  assert.ok(cli.calls.some((c) => c[0] === 'volume' && c[1] === 'create' && c.includes('dsb-acc-a1-data')))
  assert.equal(await p.status('acc-a1'), 'running')
  await p.stop('acc-a1'); assert.equal(await p.status('acc-a1'), 'stopped')
  await p.start('acc-a1'); assert.equal(await p.status('acc-a1'), 'running')
  const b = await p.create('acc-b2', { image: 'deepseek-bot:slim', env: {} })
  assert.equal(b.origin, 'http://127.0.0.1:3891', 'next free port')
  await p.remove('acc-a1')
  assert.equal(await p.status('acc-a1'), 'missing')
  assert.ok(cli.calls.some((c) => c[0] === 'volume' && c[1] === 'delete' && c.includes('dsb-acc-a1-data')))
})
