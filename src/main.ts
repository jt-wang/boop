// `deepseek-bot` entry: open the home, start dsh web on loopback, start the
// bot on the LAN, print the pairing QR.
import { Tiles } from './tiles.ts'
import { homedir, hostname, networkInterfaces } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import qrcode from 'qrcode-terminal'
import { ConfigFile, type BotConfig } from './config.ts'
import { openHome } from './home.ts'
import { dshModelEnv, harnessEnv, startDshWeb } from './dsh.ts'
import { personZone, setComputerZone } from './clock.ts'
import { loadSecrets, ModelSwitch } from './modelswitch.ts'
import { FileDeviceStore } from './devices.ts'
import { Pairing } from './pairing.ts'
import { Pocket, pocketWanted, windowSeconds } from './pocket.ts' // the local connection, docs/connection.md
import { PushService, type Notification } from './push.ts'
import { ApnsSender, RelayApnsSender, type ApnsConfig } from './push-apns.ts' // [agent:ios] [host]
import { FcmSender, RelayFcmSender, type FcmConfig } from './push-fcm.ts' // [push]
import { EventWatcher } from './events.ts'
import { createBotServer, forgetGoneMainSession, INJECT, type Settings } from './server.ts'
import { DshHarness } from './harness.ts'
import { recoverInterrupted } from './recover.ts'
import { Memory } from './memory.ts'
import { Scheduler } from './scheduler.ts'
import { Goals } from './goals.ts'
import { startToolsServer } from './tools.ts'
import { enableBrowser } from './browser.ts'
import { startBrowserBroker, startBrowserFront, workFolderWriter, type BrowserBroker } from './browser-broker.ts'
import { startEgressProxy, installEgressFirewall, type EgressProxy } from './egress.ts'
import { ensureWorkspaceQuota } from './workspace-quota.ts'
import { JsonList } from './store.ts'
import { rpc } from './dshclient.ts'
import { Library } from './library.ts' // [agent:library]
import { randomBytes, randomUUID } from 'node:crypto'
// [agent:proactive]
import { LlmClient, llmOptionsFor } from './llm.ts'
import { Reflector } from './reflect.ts'
import { Ideas } from './ideas.ts'
import { Connectors, connectorEnvNames } from './connectors.ts' // [agent:connectors]
import { ConnectorAuth, ConnectorSecrets } from './oauth.ts' // [agent:connectors] one-tap sign-in
import { startConnectorProxy } from './connector-proxy.ts' // [agent:connectors]
import { moduleHosts, Ui } from './ui.ts' // [agent:genui]
import { browserInstaller } from './browser-install.ts'
import { Compliance, gateLlm } from './compliance.ts' // [compliance]
import { moderatorFromEnv } from './moderation.ts' // [compliance]
import { activityView, line, personLanguage, uiLang, wordsFor, type Line } from './lang.ts'
import { startModelProxy } from './model-proxy.ts'
import { createGuard, guardPolicy } from './guard.ts'

const argv = process.argv.slice(2)
const flag = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined }
const root = flag('--home') ?? process.env.DEEPSEEK_BOT_HOME ?? join(homedir(), '.deepseek-bot')
// A key the person entered in the app (PUT /model) lives in <home>/secrets.env; the shell's own variables win.
await loadSecrets(root)

const overrides: Partial<BotConfig> = {}
if (flag('--port')) overrides.port = Number(flag('--port'))
if (flag('--host')) overrides.host = flag('--host')!
if (argv.includes('--tunnel')) overrides.tunnel = 'cloudflared'
// [host] a hosted sandbox gets the same three as env vars (DEEPSEEK_BOT_MODEL / _BASE_URL / _API_KEY_ENV); flags win
const modelFlag = flag('--model') ?? process.env.DEEPSEEK_BOT_MODEL
if (modelFlag) {
  // --model provider/model, e.g. deepseek-official/deepseek-flash or magpie/group/auto-deepseek-flash
  const [provider, ...rest] = modelFlag.split('/')
  overrides.model = { provider, model: rest.join('/'), baseURL: flag('--base-url') ?? process.env.DEEPSEEK_BOT_BASE_URL, apiKeyEnv: flag('--api-key-env') ?? process.env.DEEPSEEK_BOT_API_KEY_ENV }
  // --web-search: this custom provider serves DeepSeek's native web search for this model (src/home.ts ModelConfig.webSearch)
  if (argv.includes('--web-search') || process.env.DEEPSEEK_BOT_WEB_SEARCH === '1') overrides.model.webSearch = true
}

const config = await ConfigFile.open(join(root, 'config.json'), overrides)
const cfg = config.get()
// Local use goes through TailPocket and the bot stays on loopback; without its helper (a checkout that has not run
// scripts/tailpocket-sync.sh) it stays as it was, on the local network, and says so.
const localPocket = pocketWanted({ inContainer: process.env.DEEPSEEK_BOT_IN_CONTAINER === '1', publicUrl: process.env.DEEPSEEK_BOT_PUBLIC_URL || undefined, tunnel: cfg.tunnel, configHost: cfg.host, argv }) && await (async () => {
  const { tailPocketHelperPath } = await import('../vendor/tailpocket/index.js')
  const ok = existsSync(process.env.TAILPOCKET_HOST || tailPocketHelperPath())
  if (!ok) console.log('[bot] No TailPocket helper: phones reach this computer in plain HTTP over the local network only. scripts/tailpocket-sync.sh sets it up.')
  return ok
})()
if (localPocket) cfg.host = '127.0.0.1'
// [compliance] Nothing reaches the model until the person (18+) agreed to its provider; reports
// go to the host on a hosted computer. `publicOrigin` is known once the server listens.
const moderator = moderatorFromEnv()
if (moderator) console.log(`[bot] content filter on (${moderator.name})`)
const compliance = await Compliance.open(root, {
  moderator,
  settings: config.settings, model: () => config.get().model,
  relay: process.env.DEEPSEEK_BOT_PUSH_RELAY && process.env.DEEPSEEK_BOT_HOST_SECRET ? { url: process.env.DEEPSEEK_BOT_PUSH_RELAY, secret: process.env.DEEPSEEK_BOT_HOST_SECRET } : undefined,
  publicUrl: process.env.DEEPSEEK_BOT_PUBLIC_URL || undefined,
  origin: () => publicOrigin,
})

// The harness never gets the provider key. It gets a per-boot surrogate and a
// loopback URL; this bot process (outside the DSH cell) swaps the surrogate for
// the real key at the network boundary, like the connector proxy does for
// OAuth tokens. The bot's own background calls keep using cfg.model directly.
const officialModel = cfg.model.provider === 'deepseek-official'
const upstreamBase = officialModel ? (process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com') : (cfg.model.baseURL ?? '')
if (!upstreamBase) throw new Error('a custom model provider needs a baseURL')
const modelKeyEnv = officialModel ? 'DEEPSEEK_API_KEY' : (cfg.model.apiKeyEnv ?? 'DEEPSEEK_BOT_MODEL_KEY')
// [guard] the server-side outbound policy. On by default.
// A base URL the operator passed on the command line or in the environment is trusted for the
// model proxy and background calls; a base URL stored from the app (PUT /model) is not.
const policy = guardPolicy()
const operatorBase = officialModel ? process.env.DEEPSEEK_BASE_URL : (flag('--base-url') ?? process.env.DEEPSEEK_BOT_BASE_URL)
const trustedModel = (() => {
  if (!operatorBase) return false
  try { return new URL(upstreamBase).origin === new URL(operatorBase).origin } catch { return false }
})()
const guard = createGuard(policy)
// The operator's own model endpoint is trusted for the address policy, but the connection still pins the resolved address.
const modelGuard = trustedModel ? createGuard({ ...policy, mode: 'off' }) : guard
if (guard.policy.mode === 'off') console.log('[bot] outbound guard OFF (DEEPSEEK_BOT_GUARD=off)')
else console.log(`[bot] outbound guard on${guard.policy.lockModel ? ' (hosted: model change locked)' : ''}${guard.policy.allow.length ? `; allowed: ${guard.policy.allow.join(', ')}` : ''}`)
const guardedFetch = guard.fetch

const modelProxy = await startModelProxy({
  upstream: upstreamBase,
  apiKey: process.env[modelKeyEnv],
  auth: officialModel ? 'x-api-key' : 'bearer',
  fetch: modelGuard.fetch,
  guard: trustedModel ? undefined : guard,
})
const harnessModel = officialModel ? cfg.model : {
  ...cfg.model,
  baseURL: `${modelProxy.url}${new URL(upstreamBase).pathname.replace(/\/$/, '')}`,
  apiKeyEnv: modelKeyEnv,
}

// The assistant's own tools (memory, reminders, goals, notify) come up first so
// the profile patch can point dsh at them.
const push = await PushService.open(join(root, 'push.json'), { check: async (u) => { await guard.checkPushEndpoint(u) }, agent: guard.httpsAgent() })
// [agent:ios] APNs for the iOS app: config.json `apns` { keyId, teamId, keyPath, bundleId, sandbox } (docs/ios.md).
{
  const apnsCfg = (cfg as { apns?: ApnsConfig }).apns
  if (apnsCfg) {
    try { push.apns = await ApnsSender.fromConfig(apnsCfg); console.log(`[bot] APNs on (${push.apns.origin.includes('sandbox') ? 'sandbox' : 'production'})`) }
    catch (e) { console.error(`[bot] APNs off: ${(e as Error).message}`) }
  }
  // [push] FCM for the Android app: config.json `fcm` { serviceAccountPath } (docs/push.md).
  const fcmCfg = (cfg as { fcm?: FcmConfig }).fcm
  if (fcmCfg) {
    try { push.fcm = await FcmSender.fromConfig(fcmCfg); console.log('[bot] FCM on') }
    catch (e) { console.error(`[bot] FCM off: ${(e as Error).message}`) }
  }
  // [host] inside a hosted sandbox: no Apple key or Firebase account here, the host relays (src/host/server.ts POST /host/push)
  const relay = process.env.DEEPSEEK_BOT_PUSH_RELAY
  if (relay && process.env.DEEPSEEK_BOT_HOST_SECRET) {
    push.apns = new RelayApnsSender(relay, process.env.DEEPSEEK_BOT_HOST_SECRET)
    push.fcm = new RelayFcmSender(relay, process.env.DEEPSEEK_BOT_HOST_SECRET)
    console.log(`[bot] APNs and FCM through the host at ${relay}`)
  }
  else if (relay) console.error('[bot] DEEPSEEK_BOT_PUSH_RELAY set without DEEPSEEK_BOT_HOST_SECRET; notifications to phones are off')
}
// Lines the bot templates keep their template (`line`), so the list is said again in the person's language when they read it.
const activity = await JsonList.open<{ id: string; at: string; kind: string; text: string; line?: Line }>(join(root, 'activity.json'))
const logActivity = (kind: string, text: string, l?: Line) => { activity.insert({ at: new Date().toISOString(), kind, text: text.slice(0, 300), ...(l ? { line: l } : {}) }).catch(() => {}) }
const lang = () => uiLang(personLanguage(config.get().settings))
const memory = new Memory(join(root, 'workspace'), { zone: () => personZone(config.get().settings) })
const goals = await Goals.open(join(root, 'goals.json'))
// [push] Notifications the bot sends itself go through the bot server once it is up: it skips an app that is open on
// that thread and links the tap to it (src/server.ts notify). Before that, straight to the phones.
let notifyPhones: (n: Notification, o?: { sessionId?: string; turn?: boolean }) => Promise<void> = (n) => push.notify(n)
const scheduler = await Scheduler.open(join(root, 'schedules.json'), {
  onDue: async (task) => {
    const st = await config.settings.get()
    if (!st.mainSessionId) return
    // the reminder's name and "it's time" in the person's words; the instruction is for the assistant, not for the lock screen
    const n = { title: task.name, body: wordsFor(st).reminderDue, tag: `schedule:${task.id}` }
    if (await compliance.gate()) { await notifyPhones(n, { sessionId: st.mainSessionId }); return } // [compliance] the reminder still reaches the phone; the model is not asked
    // the person's zone, so the assistant's clock (dsh-time-context, src/home.ts) reads in it
    await rpc({ origin: dsh.origin, cookie: dsh.cookie }, 'session/prompt', { request: { requestId: randomUUID(), sessionId: st.mainSessionId, mode: 'queue', content: [{ type: 'text', text: `${INJECT}[Reminder "${task.name}" is due] ${task.instruction}` }], ...zoneOf(st) } })
    { const e = line(lang(), 'reminderFired', task.name); logActivity('schedule', e.text, e.line) }
    await notifyPhones(n, { sessionId: st.mainSessionId, turn: true }) // the answer that follows does not push again
  },
})
// [agent:genui] Generative UI modules: keys under <home>/keys (made on first start), packages under <home>/ui.
const ui = await Ui.open(root, { runAs: process.env.DEEPSEEK_BOT_IN_CONTAINER === '1' ? { uid: 1000, gid: 1000 } : undefined })
if (moderator) ui.moderate = (t) => moderator.check(t) // [compliance] a flagged interface is not built
console.log(ui.available ? `[bot] ui modules on (nsh at ${ui.nsh}${ui.timings.keygenMs !== undefined ? `, keys made in ${ui.timings.keygenMs} ms` : ''})` : `[bot] ui modules off: no nsh CLI at ${ui.nsh}`)
// Inside the image the browser is installed on demand by the bot (the agent's shell is sandboxed and
// cannot install system packages): one install at a time, a later call joins it, and each call answers
// before the harness's tool timeout (src/browser-install.ts). Once it is in, the broker starts and the profile
// gains its row while that call waits; the call answers when DSH has the browser's tools, so the same turn uses them
//.
const installBrowser = process.env.DEEPSEEK_BOT_IN_CONTAINER === '1' ? browserInstaller({
  exe: process.env.DEEPSEEK_BOT_BROWSER_EXECUTABLE || '/usr/bin/chromium',
  script: join(import.meta.dirname, '..', 'scripts', 'install-browser.sh'),
  mount: async () => {
    if (cfg.browser === false) return
    if (!browserBroker) await startBroker()
    await openHome(root, homeOpts())
    await Promise.race([browserBroker!.listed, new Promise((r) => setTimeout(r, 30_000).unref())])
    console.log('[bot] browser installed and mounted')
  },
}) : undefined
// set_my_name: the same settings store PUT /settings uses (it rewrites AGENTS.md), then every connected app hears it
const tools = await startToolsServer({ memory, scheduler, goals, setHomeZone: async (zone) => { const st = await config.settings.get(); await settingsStore.set({ person: { ...st.person, timeZone: zone, timeZoneGuessed: undefined } }) }, notify: async (n) => notifyPhones(n, { sessionId: (await config.settings.get()).mainSessionId ?? undefined }), onActivity: (e) => logActivity(e.kind, e.text, e.line), ui, language: async () => personLanguage(await config.settings.get()), installBrowser, rename: async (name) => { const st = await settingsStore.set({ assistantName: name }); bot.broadcast({ type: 'me-updated', assistant: { name: st.assistantName } }) } })

// [main] the assistant's browser (src/browser.ts). Inside the image it is a
// broker outside the cell, started as uid 1001; the cell gets a bearer-checked
// loopback endpoint and never a stdio child running as its own uid.
const inContainer = process.env.DEEPSEEK_BOT_IN_CONTAINER === '1'
// The egress proxy comes up first so the browser broker can use it too: the
// browser is outside the cell, but it is still agent-driven and must not reach
// private or metadata addresses.
let egress: EgressProxy | undefined
if (inContainer) egress = await startEgressProxy({ allowedLoopbackPorts: [modelProxy.url, tools.url].map((u) => Number(new URL(u).port)), policy, maxRequestsPerMinute: Number(process.env.DEEPSEEK_BOT_EGRESS_RATE ?? 3000) })
const browserExe = process.env.DEEPSEEK_BOT_BROWSER_EXECUTABLE || '/usr/bin/chromium'
let browserBroker: BrowserBroker | undefined
// Its bearer proxy is up from the start, browser or not: the kernel rules below take the cell's loopback ports once.
// Screenshots are also saved in the work folder, where the assistant can hand them over (`present`)
const browserFront = inContainer && cfg.browser !== false ? await startBrowserFront({ saveShot: workFolderWriter({ dir: join(root, 'workspace', 'screenshots'), uid: 1000, gid: 1000 }) }) : undefined
if (browserFront) egress?.allowPort(browserFront.proxy.port)
async function startBroker() {
  browserBroker = await startBrowserBroker({ root, exe: browserExe, uid: 1001, gid: 1001, proxy: egress?.url, front: browserFront })
  console.log(`[bot] browser broker on ${browserBroker.url} as uid 1001`)
}
if (inContainer && cfg.browser !== false && existsSync(browserExe)) await startBroker()
enableBrowser()
// [agent:connectors] Connectors: one-tap services the person signed in to (src/oauth.ts;
// tokens in <home>/connector-secrets.json, reached through the loopback proxy) and
// advanced MCP servers. Each enabled one is an mcp-client row in the profile patch.
// A running dsh web reloads the patch (HMR; measured 2026-10-27: a row appended at
// runtime was connected 2.1 s later), so a change in the app applies without a restart.
const connectors = await Connectors.open(join(root, 'connectors.json'))
const connectorSecrets = await ConnectorSecrets.open(join(root, 'connector-secrets.json'))
// Where a browser reaches this bot, for the OAuth redirect: the host's address for a hosted bot, else the LAN/tunnel address printed below.
const oauthOrigin = () => process.env.DEEPSEEK_BOT_PUBLIC_URL?.replace(/\/$/, '') || publicOrigin
const connectorAuth = new ConnectorAuth({ store: connectors, secrets: connectorSecrets, publicOrigin: oauthOrigin, loopbackOrigin: () => `http://127.0.0.1:${boundPort}`, fetch: guardedFetch, onConnected: (c) => { onConnected(c.id, c.name).catch((e) => console.error('[bot] connected', e)) } })
const connectorProxy = await startConnectorProxy({ auth: connectorAuth, store: connectors, fetch: guardedFetch })
egress?.allowPort(Number(new URL(connectorProxy.url).port))

const homeOpts = () => { const st = config.get().settings; return { model: harnessModel, assistantName: st.assistantName, proactivity: st.proactivity, person: st.person, tools: { url: tools.url, secret: tools.secret }, browser: cfg.browser, browserBroker: browserBroker ? { url: browserBroker.url, secret: browserBroker.secret } : undefined, connectors: connectors.enabled(), connectorProxy } }
const home = await openHome(root, homeOpts())
// A hard ceiling for the agent's writable data: a fixed-size ext4 image on the
// volume, so many files cannot fill /data and take the bot down. The bot's own
// files are outside it.
const quota = await ensureWorkspaceQuota({ root, workspace: home.workspace, uid: 1000, gid: 1000, inContainer })
if (quota.mounted) console.log(`[bot] workspace quota ${quota.sizeBytes} bytes (${quota.image})`)
if (connectors.enabled().length) console.log(`[bot] connectors: ${connectors.enabled().map((c) => c.id).join(', ')}`)
connectors.markApplied()
// Every change in the app rewrites the patch at once; dsh picks it up live.
connectors.onChange = async () => { try { await openHome(root, homeOpts()); connectors.markApplied() } catch (e) { console.error('[bot] profile patch rewrite failed', e) } }
// Settings that change what the assistant is told (name, how often it speaks first) rewrite AGENTS.md at once.
// The computer keeps the person's time zone (src/clock.ts): in the image the bot is root and sets /etc/localtime the
// moment the phone says its zone; every shell after that reads local time.
function zoneOf(st: Settings) { const z = personZone(st); return z ? { clientTimeZone: z } : {} } // hoisted: a reminder can fire before this line runs
const followZone = async (st: Settings) => { const z = personZone(st); if (z && inContainer && process.getuid?.() === 0 && await setComputerZone(z).catch(() => false)) console.log(`[bot] clock zone ${z}`) }
await followZone(config.get().settings)
const settingsStore = { get: config.settings.get, set: async (p: Partial<Settings>) => { const v = await config.settings.set(p); if (p.person !== undefined || p.timeZone !== undefined) await followZone(v); if (p.proactivity !== undefined || p.assistantName !== undefined || p.person !== undefined) await openHome(root, homeOpts()).catch((e) => console.error('[bot] AGENTS.md rewrite failed', e)); return v } }
const modelSwitch = new ModelSwitch({ home: root, config, supervised: process.env.DEEPSEEK_BOT_SUPERVISED === '1', checkBaseURL: async (u) => { await guard.checkModelBaseURL(u) }, exit: (c) => { console.log('[bot] model changed; restarting under the supervisor'); process.exit(c) } })

// A service was connected: the phones hear it, the activity list notes it, and
// the assistant is told in the main thread once dsh has mounted the new tools
// (measured ~2 s after the patch write; 5 s leaves room).
const onConnected = async (id: string, name: string) => {
  bot.broadcast({ type: 'connector', id, connected: true })
  const st = await config.settings.get()
  { const e = line(lang(), 'connected', name); logActivity('connector', e.text, e.line) }
  if (!st.mainSessionId || await compliance.gate()) return // [compliance]
  await new Promise((r) => setTimeout(r, 5000))
  await rpc({ origin: dsh.origin, cookie: dsh.cookie }, 'session/prompt', { request: { requestId: randomUUID(), sessionId: st.mainSessionId, mode: 'queue', ...zoneOf(st), content: [{ type: 'text', text: `${INJECT}[Connected ${name}] The person just connected ${name}; its tools are available now as mcp__${id}__*. If they asked you for something that needed it, do that now; otherwise say in one line that ${name} is connected.` }] } })
}

// The surrogate env for the harness. Everything else in the bot's environment
// stays here; harnessEnv keeps only the known, non-secret variables.
const surrogateModelKey = randomBytes(24).toString('base64url')
// The env names the person gave their connectors go in by name (their rows read them from the harness's env);
// the model variables below are set after, so a connector naming one gets the surrogate.
const dshEnv = harnessEnv(process.env, [...connectorEnvNames(connectors.enabled()), ...(officialModel ? ['DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL'] : [modelKeyEnv])])
connectors.markStarted()
// Outside the image the machine's own zone stays, unless the person's is known; inside it /etc/localtime decides.
{ const z = personZone(config.get().settings); if (inContainer) delete dshEnv.TZ; else if (z) dshEnv.TZ = z }
Object.assign(dshEnv, dshModelEnv({
  official: officialModel,
  modelKeyEnv,
  proxyUrl: modelProxy.url,
  upstreamPath: new URL(upstreamBase).pathname.replace(/\/$/, ''),
  surrogate: surrogateModelKey,
}))

// Inside the image the harness gets its own cell: an unprivileged uid that sees
// only its DSH home, workspace and a HOME, not the bot's data and not the
// browser broker's profile.
const cell = inContainer ? {
  workspace: home.workspace,
  home: join(root, 'home'),
  uid: 1000,
  gid: 1000,
} : undefined
if (cell && typeof process.getuid === 'function' && process.getuid() === 0) writeFile('/proc/self/oom_score_adj', '-1000').catch(() => {})

// The cell's only way out: one forward proxy that refuses private and metadata
// destinations, and kernel owner-match rules so the cell's uid cannot bypass it.
let removeEgressFirewall: (() => Promise<void>) | undefined
if (inContainer && egress) {
  const allowedPorts = [modelProxy.url, tools.url, connectorProxy.url, ...(browserFront ? [browserFront.proxy.url] : [])].map((u) => Number(new URL(u).port))
  removeEgressFirewall = await installEgressFirewall({ uid: 1000, extraUids: [1001], proxyPort: egress.port, allowedLoopbackPorts: allowedPorts })
  for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) dshEnv[k] = egress.url
  const noProxy = '127.0.0.1,localhost,::1'
  dshEnv.NO_PROXY = noProxy; dshEnv.no_proxy = noProxy
  console.log(`[bot] cell egress via ${egress.url}; uid 1000 restricted by kernel rules`)
}

console.log(`[bot] home ${root}`)
console.log(`[bot] model ${cfg.model.provider} / ${cfg.model.model}`)
const dsh = await startDshWeb({ dshHome: home.dshHome, env: dshEnv, allowedEnv: Object.keys(dshEnv), cell })
console.log(`[bot] dsh web on ${dsh.origin} (loopback only)`)

const devices = await FileDeviceStore.open(home.devicesPath)
const tiles = new Tiles(join(root, 'tiles'))
tiles.prune().catch((e) => console.error('[bot] tiles', e))
let pocket: Pocket | null = null
const pairing = new Pairing(devices, { onClaim: (code, id) => pocket?.claimed(code, id) })
scheduler.start()
const watcher = new EventWatcher({ origin: dsh.origin, cookie: dsh.cookie })
watcher.on('event', (e) => { if (e.type === 'ready') console.log('[bot] listening to the assistant') })
watcher.start()

// [agent:library] The Library lists the workspace and follows sessions for `present` calls.
const library = new Library(home.workspace)
watcher.on('event', (e) => { if (e.type === 'status' && e.running) library.follow({ origin: dsh.origin, cookie: dsh.cookie }, e.sessionId) })
const startupHarness = new DshHarness({ origin: dsh.origin, cookie: dsh.cookie }, watcher)
await forgetGoneMainSession(startupHarness, config.settings)
// A turn the restart cut off goes on, once the harness is up (src/recover.ts).
let recovered = false
const recoverOnce = () => { if (recovered) return; recovered = true; recoverInterrupted(startupHarness).catch((err) => console.error('[bot] going on after a restart failed', err)) }
if (watcher.clientId) recoverOnce(); else watcher.on('event', (e) => { if (e.type === 'ready') recoverOnce() })
config.settings.get().then((st) => { if (st.mainSessionId) library.follow({ origin: dsh.origin, cookie: dsh.cookie }, st.mainSessionId) }).catch(() => {})

// [agent:proactive] cheap background calls on the same provider: memory reflection after each main-thread turn, and the daily ideas (+ optional morning brief).
const llm = gateLlm(new LlmClient({ ...llmOptionsFor(cfg.model, cfg.cheapModel), timeoutMs: 90_000, fetch: modelGuard.fetch, ...(trustedModel ? {} : { guard }) }), () => compliance.gate()) // [compliance] background calls wait for consent too
const reflector = new Reflector({ llm, memory, language: async () => personLanguage(await config.settings.get()), onActivity: (e) => logActivity(e.kind, e.text, e.line), onUpdated: (r) => bot.broadcast({ type: 'memory-updated', user: r.user.length, memory: r.memory.length }) })
const ideas = await Ideas.open(join(root, 'ideas.json'), {
  llm,
  settings: async () => { const st = await config.settings.get(); return { ...st, language: personLanguage(st) } },
  context: async () => ({ user: await memory.read('user'), memory: await memory.read('memory'), goals: goals.list().filter((g) => g.status !== 'done'), schedules: scheduler.list().filter((t) => t.active).map((t) => ({ name: t.name, instruction: t.instruction, nextRunAt: t.nextRunAt })), activity: activity.all().slice(-10).reverse() }),
  notify: (n) => notifyPhones({ ...n, url: '/discover' }), // the ideas live in Discover
  onActivity: (e) => logActivity(e.kind, e.text, e.line),
})
ideas.start()

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'app')
const bot = await createBotServer({
  // removing a device cuts its phone off the tunnel; with none left, the way back in is on the screen again
  onDeviceRevoked: async (id) => { const p = pocket; if (!p) return; await p.deviceRevoked(id); if (!windowOpen && await wantsQr()) await printPocketPairing(p) },
  dsh: { origin: dsh.origin, cookie: dsh.cookie }, devices, pairing, push, watcher,
  workspace: home.workspace, workspaceUid: cell?.uid, appDir, host: cfg.host, port: cfg.port, settings: settingsStore, model: modelSwitch, guard,
  scheduler, goals, activity: () => activityView(activity.all().slice(-200).reverse(), lang()), memory, home: root,
  library, // [agent:library]
  connectors, connectorAuth, // [agent:connectors]
  hostSecret: process.env.DEEPSEEK_BOT_HOST_SECRET || undefined, // [host]
  ui, // [agent:genui]
  tiles, // maps in interfaces (src/module-kit/map.tsx)
  compliance, // [compliance]
  // [agent:proactive] ideas routes; after each main-thread turn the phone sees memory-updating → memory-updated while the reflection runs
  ideas,
  onTurnEnd: (_sessionId, turn) => { bot.broadcast({ type: 'memory-updating' }); reflector.reflect(turn).then((r) => { if (!r || !(r.user.length + r.memory.length)) bot.broadcast({ type: 'memory-updated', user: 0, memory: 0 }) }).catch(() => {}) },
})
notifyPhones = (n, o) => bot.notify(n, o) // [push]

const boundPort = Number(new URL(bot.origin).port)
let publicOrigin = lanOrigin(cfg.host, boundPort)
if (cfg.tunnel === 'cloudflared') publicOrigin = await startTunnel(boundPort).catch((e) => { console.error('[bot] tunnel failed:', e.message); return publicOrigin })
// [agent:genui] a module may only fetch the bot: the addresses a phone reaches it by
ui.hosts = moduleHosts({ publicOrigin, publicUrl: process.env.DEEPSEEK_BOT_PUBLIC_URL || undefined, bindHost: cfg.host })

// The first code waits for you (12h); codes you ask for later last 10 minutes.
const printPairing = (ttlMs = 10 * 60_000) => {
  const code = pairing.create(ttlMs)
  const url = `${publicOrigin}/pair?code=${code}`
  console.log('\nOpen this on your phone (same Wi-Fi), then add it to your home screen:\n')
  qrcode.generate(url, { small: true }, (q: string) => console.log(q))
  console.log(`  ${url}\n  pairing code: ${code} (valid ${Math.round(ttlMs / 60_000)} minutes)\n`)
  writeFile(join(root, 'pairing.txt'), `${url}\n`, { mode: 0o600 }).catch(() => {})
}
// Through TailPocket the phone scans a QR once and then reaches this computer from any network. A window lasts at most 15
// minutes, so one is kept open while no phone has paired, and always under the Mac window, which has nobody to press p.
let windowOpen = false
const wantsQr = async () => !process.stdin.isTTY || !(await devices.list()).some((d) => !d.revokedAt)
const printPocketPairing = async (p: Pocket, ttlMs = 15 * 60_000) => {
  const code = pairing.create(ttlMs)
  const w = await p.window(code, windowSeconds(ttlMs))
  console.log('\nScan this with the Boop app on your phone. It pairs once, then works from any network:\n')
  qrcode.generate(w.qr, { small: true }, (q: string) => console.log(q))
  console.log(`  ${w.qr}\n  valid until ${w.expiresAt.toLocaleTimeString()}. Whoever holds this code can pair, so keep it to yourself.\n`)
  await writeFile(join(root, 'pairing.txt'), `${w.qr}\n`, { mode: 0o600 }).catch(() => {})
  windowOpen = true
  w.closed.then(async () => {
    windowOpen = false
    if (!stopping && await wantsQr()) await printPocketPairing(p, ttlMs)
  }).catch(() => {})
}
let stopping = false
if (localPocket) {
  try {
    pocket = await Pocket.open({ statePath: join(root, 'tailpocket.json'), forward: `127.0.0.1:${boundPort}`, name: hostname() })
    if (await wantsQr()) await printPocketPairing(pocket)
    else console.log('[bot] TailPocket is on. Press p⏎ to pair another phone.')
  } catch (e) { console.error(`[bot] TailPocket did not start (${(e as Error).message}). No phone can reach this computer; start with --host 0.0.0.0 for the local network.`) }
} else printPairing(12 * 60 * 60_000)
process.stdin.on('data', (d) => { if (d.toString().trim() !== 'p') return; if (pocket) printPocketPairing(pocket).catch((e) => console.error(`[bot] ${(e as Error).message}`)); else if (!localPocket) printPairing() })
if (process.stdin.isTTY) { process.stdin.setRawMode?.(false); console.log('Press p⏎ for a new pairing code, Ctrl-C to stop.') }

const shutdown = async () => { console.log('\n[bot] stopping'); stopping = true; await pocket?.close().catch(() => {}); scheduler.stop(); await bot.close(); await watcher.stop(); await dsh.stop(); await egress?.close(); await removeEgressFirewall?.(); await browserBroker?.close(); await tools.close(); await connectorProxy.close(); await modelProxy.close(); await guard.close(); if (modelGuard !== guard) await modelGuard.close(); process.exit(0) }
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown)
dsh.child.on('exit', (code) => { console.error(`[bot] dsh web exited (${code}); stopping`); process.exit(1) })

function lanOrigin(host: string, port: number) {
  if (host !== '0.0.0.0' && host !== '::') return `http://${host}:${port}`
  for (const list of Object.values(networkInterfaces())) for (const i of list ?? []) if (i.family === 'IPv4' && !i.internal) return `http://${i.address}:${port}`
  return `http://127.0.0.1:${port}`
}

function startTunnel(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn('cloudflared', ['tunnel', '--url', `http://127.0.0.1:${port}`], { stdio: ['ignore', 'pipe', 'pipe'] })
    const t = setTimeout(() => reject(new Error('cloudflared printed no URL in 30s')), 30_000)
    const look = (d: Buffer) => { const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(d.toString()); if (m) { clearTimeout(t); console.log(`[bot] tunnel ${m[0]}`); resolve(m[0]) } }
    p.stdout.on('data', look); p.stderr.on('data', look)
    p.on('error', (e) => { clearTimeout(t); reject(e) })
    p.on('exit', (c) => { clearTimeout(t); reject(new Error(`cloudflared exited ${c}`)) })
    process.on('exit', () => p.kill())
  })
}
