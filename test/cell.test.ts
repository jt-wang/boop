import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cellMountArgs, agentRunnerArgs } from '../src/cell.ts'

const paths = {
  dshHome: '/data/dsh',
  workspace: '/data/workspace',
  home: '/data/home',
}

test('the DSH cell hides /data, then mounts only its own folders at their usual paths', () => {
  const a = cellMountArgs(paths)
  const s = a.join(' ')
  assert.match(s, /--ro-bind \/ \//)
  assert.match(s, /--tmpfs \/data/)
  for (const p of ['/data/dsh', '/data/workspace', '/data/home']) {
    assert.match(s, new RegExp(`--bind /run/dsb-cell/[a-z-]+ ${p.replace(/[/-]/g, '\\$&')}`))
  }
  // The browser profile lives with the broker outside the cell; it is not a mount here.
  assert.doesNotMatch(s, /browser-profile|browser-output/)
  assert.match(s, /--tmpfs \/run\/dsb-cell/)
  assert.match(s, /--unshare-pid/)
  assert.match(s, /--die-with-parent/)
})

test('the agent shell masks the harness home and credentials and keeps the workspace writable', () => {
  const a = agentRunnerArgs(['--ro-bind', '/', '/', '--tmpfs', '/tmp', '--bind', '/data/workspace', '/data/workspace', '--', 'sh', '-c', 'true'])
  const s = a.join(' ')
  assert.match(s, /--tmpfs \/data\/dsh/)
  assert.match(s, /--tmpfs \/data\/home/)
  assert.match(s, /--bind \/data\/workspace \/data\/workspace/)
  assert.ok(s.indexOf('--tmpfs /data/dsh') < s.indexOf('-- /bin/sh'), 'the mask is inside the sandbox, before the command')
  assert.match(s, /--unshare-user --uid 1000 --gid 1000/)
  assert.match(s, /echo 500 > \/proc\/self\/oom_score_adj 2>\/dev\/null \|\| true; exec "\$@"/)
  assert.match(s, /sh sh -c true$/)
})
