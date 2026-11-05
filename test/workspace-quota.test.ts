// The workspace is a fixed-size ext4 image on the /data volume, so many small
// files cannot fill the volume and take the bot down with them.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { workspaceSizeBytes, ensureWorkspaceQuota } from '../src/workspace-quota.ts'

test('the workspace size defaults to 512 MiB and can be lowered for tests', () => {
  assert.equal(workspaceSizeBytes({}), 512 << 20)
  assert.equal(workspaceSizeBytes({ DEEPSEEK_BOT_WORKSPACE_BYTES: String(64 << 20) }), 64 << 20)
  assert.equal(workspaceSizeBytes({ DEEPSEEK_BOT_WORKSPACE_BYTES: 'nonsense' }), 512 << 20)
})

test('outside Linux or without root the quota is not mounted and no image is made', async () => {
  const r = await ensureWorkspaceQuota({ root: '/tmp/does-not-exist', workspace: '/tmp/does-not-exist/workspace', platform: 'darwin', getuid: () => 501 })
  assert.equal(r.mounted, false)
})

// A person running `npm start` as root on their own Linux server (the install path) is not the image: the bot crashed
// there on `mount -o loop` in a container without loop devices, and would have put their files in a 512 MiB image owned
// by uid 1000 on a machine that allows it. Seen 2026-11-04 in node:24 on linux/arm64.
test('as root on Linux outside the image the quota is not mounted and no image is made', async () => {
  const root = await mkdtemp(join(tmpdir(), 'quota-'))
  try {
    const r = await ensureWorkspaceQuota({ root, workspace: join(root, 'workspace'), platform: 'linux', getuid: () => 0, inContainer: false })
    assert.equal(r.mounted, false)
    assert.deepEqual(await readdir(root), [])
  } finally { await rm(root, { recursive: true, force: true }) }
})
