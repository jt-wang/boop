// `node src/host-main.ts rotate --account <id> | --email <address>`: run on the host machine (on Fly:
// `fly ssh console -g host -C "…"`) to replace one account's sandbox device tokens. It asks the running host
// (POST /host/admin/rotate-tokens on loopback) so the host's own copy of accounts.json stays the only writer,
// and reads the admin token from DEEPSEEK_BOT_HOST_ADMIN_TOKEN or <home>/admin-token, never from the command line.
// Prints no token. docs/hosting.md 「Rotate an account's tokens」.
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const USAGE = 'usage: node src/host-main.ts rotate (--account <id> | --email <address>) [--home <dir>] [--port 3860 | --url <host url>]'

export async function rotateCommand(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const flag = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined }
  const account = flag('--account'); const email = flag('--email')
  if (!account && !email) { console.error(USAGE); return 2 }
  const home = flag('--home') ?? env.DEEPSEEK_BOT_HOST_HOME ?? join(homedir(), '.deepseek-bot-host')
  const url = (flag('--url') ?? `http://127.0.0.1:${flag('--port') ?? 3860}`).replace(/\/$/, '')
  let admin = env.DEEPSEEK_BOT_HOST_ADMIN_TOKEN
  if (!admin) { try { admin = (await readFile(join(home, 'admin-token'), 'utf8')).trim() } catch { console.error(`no admin token: set DEEPSEEK_BOT_HOST_ADMIN_TOKEN or run where ${join(home, 'admin-token')} exists (--home)`); return 1 } }
  let r: Response
  try {
    r = await fetch(`${url}/host/admin/rotate-tokens`, { method: 'POST', headers: { authorization: `Bearer ${admin}`, 'content-type': 'application/json' }, body: JSON.stringify(account ? { account } : { email }), signal: AbortSignal.timeout(120_000) })
  } catch (e) { console.error(`rotate failed: the host at ${url} did not answer (${(e as Error).message})`); return 1 }
  const body = await r.json().catch(() => ({})) as { account?: string; sandboxId?: string; revoked?: number; error?: string; accounts?: string[] }
  if (!r.ok) { console.error(`rotate failed: HTTP ${r.status} ${body.error ?? ''}${body.accounts ? ` (${body.accounts.join(', ')})` : ''}`.trim()); return 1 }
  console.log(`account ${body.account}: sandbox ${body.sandboxId} tokens rotated; ${body.revoked} old device(s) revoked. The phone is asked to sign in again on its next launch.`)
  return 0
}
