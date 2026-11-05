// DSH's `read_image` storage path inside the image, without the rest of the bot: the cell user's egress rules
// as src/main.ts installs them, then, as uid 1000 (the uid DSH runs as in the cell), dsh-attachment-local's
// saveImageFile with the limits and normalization policy its LocalAttachmentStore uses by default. That is the
// call read_image makes (`attachments.saveImage`), and the first one that loads sharp. test/image-tools.e2e.test.ts
// runs it in the linux/amd64 image, where the whole bot cannot start under Rosetta. Prints one JSON line.
// Run inside the image: node /fixtures/read-image-in-image.ts <png>
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, chownSync } from 'node:fs'
import { join } from 'node:path'

if (process.argv[3] === '--child') {
  try {
    const store = await import('/opt/deepseek-bot/node_modules/@deepseek-ai/dsh-attachment-local/lib/index.js')
    const limits = { maxImageBytes: 20971520, maxImagesPerMessage: 20, maxMessageImageBytes: 209715200, maxImagePixels: 64e6, maxImageDimension: 8192, mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] }
    const policy = { maxPixels: 4194304, maxDimension: 8192, maxBytes: 4194304 }
    const ref = await store.saveImageFile(process.argv[4], { data: readFileSync(process.argv[2]), mediaType: 'image/png', name: 'shot.png' }, limits, policy)
    console.log(JSON.stringify({ ok: true, uid: process.getuid?.(), ref }))
  } catch (e) {
    console.log(JSON.stringify({ ok: false, uid: process.getuid?.(), error: String((e as Error)?.message ?? e).slice(0, 2000) }))
  }
} else {
  const { startEgressProxy, installEgressFirewall } = await import('/opt/deepseek-bot/src/egress.ts')
  const egress = await startEgressProxy({})
  const remove = await installEgressFirewall({ uid: 1000, extraUids: [1001], proxyPort: egress.port, allowedLoopbackPorts: [] })
  try {
    const root = mkdtempSync('/tmp/attachments-')
    chownSync(root, 1000, 1000)
    // the store's root is DSH_HOME/attachments/v1, and it fixes the modes of the folders above it up to DSH_HOME
    const out = execFileSync('setpriv', ['--reuid=1000', '--regid=1000', '--clear-groups', '--', process.execPath, process.argv[1], process.argv[2], '--child', join(root, 'dsh', 'attachments', 'v1')], { encoding: 'utf8', env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: root } })
    console.log(out.trim().split('\n').at(-1))
  } finally {
    await remove()
    await egress.close()
  }
}
