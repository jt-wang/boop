// The bot's `ui` compile path inside the image, without the rest of the bot:
// the cell user's egress rules as src/main.ts installs them (a proxy for uid
// 1000, kernel rules that refuse everything else), then Ui.open and Ui.create
// as root with runAs uid 1000, the way src/main.ts and the `ui` tool call them.
// test/image-tools.e2e.test.ts runs it in the linux/amd64 image, where the
// whole bot cannot start under Rosetta (bwrap's user namespace: EINVAL); nsh
// exists only for amd64. Prints one JSON line.
// Run inside the image: node /fixtures/ui-compile-in-image.ts <source file>
import { readFileSync } from 'node:fs'
import { startEgressProxy, installEgressFirewall } from '/opt/deepseek-bot/src/egress.ts'
import { Ui } from '/opt/deepseek-bot/src/ui.ts'

const source = readFileSync(process.argv[2], 'utf8')
const egress = await startEgressProxy({})
const remove = await installEgressFirewall({ uid: 1000, extraUids: [1001], proxyPort: egress.port, allowedLoopbackPorts: [] })
try {
  const ui = await Ui.open('/data', { runAs: { uid: 1000, gid: 1000 } })
  const r = await ui.create({ title: 'Tip calculator', source })
  console.log(JSON.stringify(r.ok ? { ok: true, id: r.module.id, size: r.size, ms: r.ms } : { ok: false, errors: r.errors }))
} finally {
  await remove()
  await egress.close()
}
