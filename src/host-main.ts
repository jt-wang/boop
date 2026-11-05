// `node src/host-main.ts`: run a host for several people. One sandbox (the
// assistant's computer) per account, on Docker, Fly Machines or Apple's
// `container`. docs/hosting.md has the one-command setup.
//
//   node src/host-main.ts --port 3860 --provider docker --image deepseek-bot:slim --public-url http://127.0.0.1:3860 --dev-sign-in
//   node src/host-main.ts rotate --email <address>   (on the host machine: new sandbox tokens for that account; docs/hosting.md)
//
// Flags: --home <dir> (default ~/.deepseek-bot-host) --host 127.0.0.1 --port 3860 --public-url <url>
//        --provider docker|fly|apple-container --image <ref> --port-range 3890-3896 (docker/apple host ports; docker default: ephemeral)
//        --docker-network <name>  (docker; the host runs in a container itself: sandboxes join this network, no ports published)
//        --relay-url <url the sandboxes use to reach this host; default: public-url, or http://host.docker.internal:<port> for docker>
//        --idle-minutes 30 --sweep-seconds 15 --dev-sign-in --apple-bundle-id <id> --id-prefix <p>
//        --model provider/model --base-url … --api-key-env NAME   (passed to every sandbox as DEEPSEEK_BOT_MODEL / _BASE_URL / _API_KEY_ENV)
//        --fly-org <slug> --fly-region <code> --fly-app <name>     (fly; token from FLY_API_TOKEN)
// Env:   DEEPSEEK_BOT_HOST_SECRET (generated into <home>/host-secret when absent), DEEPSEEK_API_KEY / DEEPSEEK_BOT_MODEL_KEY and the
//        --api-key-env variable are copied into every sandbox. APNs: <home>/config.json {"apns": {...}} as in docs/ios.md;
//        FCM: {"fcm": {"serviceAccountPath": "..."}} as in docs/push.md.
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { createHostServer } from './host/server.ts'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DockerProvider } from './sandbox/docker.ts'
import { FlyProvider } from './sandbox/fly.ts'
import { AppleContainerProvider } from './sandbox/apple-container.ts'
import { ApnsSender, type ApnsConfig, type ApnsTransport } from './push-apns.ts'
import { FcmSender, type FcmConfig, type FcmTransport } from './push-fcm.ts'
import type { SandboxProvider } from './sandbox/provider.ts'
import { aiProvider } from './compliance.ts' // [compliance]

const argv = process.argv.slice(2)
const flag = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined }
const has = (name: string) => argv.includes(name)

// `rotate --account <id> | --email <address>`: replace one account's sandbox tokens through the running host (src/host/rotate.ts).
if (argv[0] === 'rotate') { const { rotateCommand } = await import('./host/rotate.ts'); process.exit(await rotateCommand(argv.slice(1))) }

const home = flag('--home') ?? process.env.DEEPSEEK_BOT_HOST_HOME ?? join(homedir(), '.deepseek-bot-host')
await mkdir(home, { recursive: true })
const host = flag('--host') ?? '127.0.0.1'
const port = Number(flag('--port') ?? 3860)
// On a Fly machine the platform sets FLY_APP_NAME and FLY_REGION; the host then needs no --public-url, --fly-app or --fly-region (fly.toml).
const flyApp = process.env.FLY_APP_NAME
// On Fly, sandboxes run the very image this host runs (FLY_IMAGE_REF), so one `fly deploy` updates both.
const publicUrl = flag('--public-url') ?? (flyApp ? `https://${flyApp}.fly.dev` : `http://${host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host}:${port}`)
const providerKind = flag('--provider') ?? 'docker'
const image = flag('--image') ?? process.env.FLY_IMAGE_REF ?? 'deepseek-bot:slim'
const range = flag('--port-range') ? (flag('--port-range')!.split('-').map(Number) as [number, number]) : undefined

let secret = process.env.DEEPSEEK_BOT_HOST_SECRET
if (!secret) {
  const p = join(home, 'host-secret')
  try { secret = (await readFile(p, 'utf8')).trim() } catch { secret = randomBytes(32).toString('base64url'); await writeFile(p, secret + '\n', { mode: 0o600 }); console.log(`[host] new host secret written to ${p}`) }
}

let provider: SandboxProvider
let relayUrl = flag('--relay-url')
if (providerKind === 'docker') {
  const network = flag('--docker-network')
  // The sandbox runs bwrap, a loop-mounted workspace and nftables. The
  // narrowest set measured by the containment test is SYS_ADMIN (bwrap and
  // mount), NET_ADMIN (nft), loop-control plus the loop block range, the
  // loop-device nodes the bot creates, and a seccomp profile that adds
  // pivot_root to Docker's default. Without the profile the bot exits rather
  // than run without its cell (fail closed).
  const seccomp = flag('--docker-seccomp')
  const runArgs = [
    '--cap-add=SYS_ADMIN', '--cap-add=NET_ADMIN',
    '--security-opt', 'systempaths=unconfined',
    ...(seccomp ? ['--security-opt', `seccomp=${seccomp}`] : []),
    '--device', '/dev/loop-control', '--device-cgroup-rule', 'b 7:* rmw',
  ]
  if (!seccomp) console.error('[host] docker provider needs --docker-seccomp <host path to deploy/seccomp-bwrap.json>; sandboxes will fail closed')
  provider = new DockerProvider({ hostPortRange: range, network, runArgs })
  // sandboxes reach this host: by Docker's host alias when the host runs on the machine, by this container's hostname on a shared network
  relayUrl ??= network ? `http://${hostname()}:${port}` : `http://host.docker.internal:${port}`
} else if (providerKind === 'fly') {
  const token = process.env.FLY_API_TOKEN
  const region = flag('--fly-region') ?? process.env.FLY_REGION
  const app = flag('--fly-app') ?? flyApp
  if (!token || !region || !app) { console.error('fly needs FLY_API_TOKEN, --fly-region and --fly-app (set by Fly itself on a Fly machine)'); process.exit(2) }
  // --fly-org is only needed to create the app; an existing app needs none
  provider = new FlyProvider({ token, org: flag('--fly-org') ?? '', region, app })
  // sandboxes reach this host over the org's private network: the machines of this app's `host` process group
  if (flyApp && app === flyApp) relayUrl ??= `http://host.process.${flyApp}.internal:${port}`
} else if (providerKind === 'apple-container') {
  if (!range) { console.error('apple-container needs --port-range from-to'); process.exit(2) }
  provider = new AppleContainerProvider({ hostPortRange: range })
} else { console.error(`unknown --provider ${providerKind}`); process.exit(2) }

// What every sandbox's bot gets. Keys travel as environment, never on a command line.
const sandboxEnv: Record<string, string> = {}
for (const k of ['DEEPSEEK_API_KEY', 'DEEPSEEK_BOT_MODEL_KEY']) if (process.env[k]) sandboxEnv[k] = process.env[k]!
if (flag('--model')) sandboxEnv.DEEPSEEK_BOT_MODEL = flag('--model')!
if (flag('--base-url')) sandboxEnv.DEEPSEEK_BOT_BASE_URL = flag('--base-url')!
// [compliance] the optional content filter (src/moderation.ts) is turned on for every sandbox at once
for (const k of ['DEEPSEEK_BOT_MODERATION_KEY', 'DEEPSEEK_BOT_MODERATION_URL', 'DEEPSEEK_BOT_MODERATION_MODEL', 'DEEPSEEK_BOT_MODERATION_NAME']) if (process.env[k]) sandboxEnv[k] = process.env[k]!
if (flag('--api-key-env')) { const k = flag('--api-key-env')!; sandboxEnv.DEEPSEEK_BOT_API_KEY_ENV = k; if (process.env[k]) sandboxEnv[k] = process.env[k]! }
// [guard] the host operator may change the server-side outbound policy for every sandbox.
for (const k of ['DEEPSEEK_BOT_GUARD', 'DEEPSEEK_BOT_GUARD_ALLOW', 'DEEPSEEK_BOT_GUARD_ALLOW_PRIVATE', 'DEEPSEEK_BOT_GUARD_ONLY', 'DEEPSEEK_BOT_ALLOW_MODEL_CHANGE', 'DEEPSEEK_BOT_EGRESS_RATE']) if (process.env[k]) sandboxEnv[k] = process.env[k]!

// APNs: the host's own key, for the App Store build's notifications.
let apns: ApnsTransport | null = null
try {
  const cfg = JSON.parse(await readFile(join(home, 'config.json'), 'utf8')) as { apns?: ApnsConfig }
  if (cfg.apns) { apns = await ApnsSender.fromConfig(cfg.apns); console.log(`[host] APNs on (${apns.origin.includes('sandbox') ? 'sandbox' : 'production'})`) }
} catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') console.error(`[host] APNs off: ${(e as Error).message}`) }
if (!apns) console.log('[host] APNs off: no apns section in ' + join(home, 'config.json') + '; iPhones get no notifications')
// [push] FCM: the host's Firebase service account, for the Android app's notifications.
let fcm: FcmTransport | null = null
try {
  const cfg = JSON.parse(await readFile(join(home, 'config.json'), 'utf8')) as { fcm?: FcmConfig }
  if (cfg.fcm) { fcm = await FcmSender.fromConfig(cfg.fcm); console.log('[host] FCM on') }
} catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') console.error(`[host] FCM off: ${(e as Error).message}`) }
if (!fcm) console.log('[host] FCM off: no fcm section in ' + join(home, 'config.json') + '; Android phones get no notifications')

// [compliance] The operator's admin token reads and answers reports (GET/PATCH /host/admin/reports).
let adminToken = process.env.DEEPSEEK_BOT_HOST_ADMIN_TOKEN
if (!adminToken) {
  const p = join(home, 'admin-token')
  try { adminToken = (await readFile(p, 'utf8')).trim() } catch { adminToken = randomBytes(32).toString('base64url'); await writeFile(p, adminToken + '\n', { mode: 0o600 }); console.log(`[host] new admin token (reports) written to ${p}`) }
}
const contact = process.env.DEEPSEEK_BOT_HOST_CONTACT ?? ''
if (!contact) console.warn('[host] DEEPSEEK_BOT_HOST_CONTACT is not set: the privacy policy and terms have no contact address (the stores require one)')
const modelFlag = flag('--model')
const ai = modelFlag ? aiProvider({ provider: modelFlag.split('/')[0], model: modelFlag.split('/').slice(1).join('/'), baseURL: flag('--base-url') }) : aiProvider({ provider: 'deepseek-official', model: 'deepseek-flash' })
const links = {
  appleAppIds: (flag('--apple-app-id') ?? process.env.DEEPSEEK_BOT_APPLE_APP_ID ?? '').split(',').filter(Boolean),
  androidPackage: flag('--android-package') ?? 'io.jingtao.boop',
  androidCertSha256: (process.env.DEEPSEEK_BOT_ANDROID_CERT_SHA256 ?? '').split(',').map((x) => x.trim()).filter(Boolean),
}
if (!links.androidCertSha256.length) console.log('[host] DEEPSEEK_BOT_ANDROID_CERT_SHA256 not set: /.well-known/assetlinks.json answers 404 and Android opens /open/ links in the browser')

const server = await createHostServer({
  adminToken, contact, operator: process.env.DEEPSEEK_BOT_HOST_OPERATOR || undefined, ai, links, hosting: providerKind === 'fly' ? 'Fly.io' : undefined,
  filter: process.env.DEEPSEEK_BOT_MODERATION_KEY ? (process.env.DEEPSEEK_BOT_MODERATION_NAME || 'OpenAI') : null,

  provider, image, publicUrl, relayUrl, hostSecret: secret, sandboxEnv, apns, fcm,
  accountsPath: join(home, 'accounts.json'),
  appDir: join(dirname(fileURLToPath(import.meta.url)), '..', 'app'), // the same app the phones run, served at / for browsers
  devSignIn: has('--dev-sign-in'),
  accessCode: process.env.DEEPSEEK_BOT_HOST_ACCESS_CODE || undefined,
  maxAccounts: flag('--max-accounts') ? Number(flag('--max-accounts')) : undefined,
  apple: flag('--apple-bundle-id') ? { bundleId: flag('--apple-bundle-id')! } : undefined,
  idleMinutes: Number(flag('--idle-minutes') ?? 30),
  warm: Number(flag('--warm') ?? 0),
  sweepMs: Number(flag('--sweep-seconds') ?? 15) * 1000,
  idPrefix: flag('--id-prefix'),
  host, port,
})
console.log(`[host] ${server.origin} → public ${publicUrl}; provider ${provider.kind}; image ${image}; relay ${relayUrl ?? publicUrl}; idle ${flag('--idle-minutes') ?? 30} min; home ${home}`)
console.log('[host] ready')

const shutdown = async () => { console.log('\n[host] stopping (sandboxes keep running)'); await server.close(); process.exit(0) }
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown)
