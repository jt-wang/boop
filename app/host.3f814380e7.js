// The page's host for the browser build (nsh.json `web.host`): what the native
// shells pass as `host.params`, the page answers to `launch.params`.
//   pairUrl  — the page was opened from a pairing link (/pair?code=…)
//   hostUrl  — <meta name="deepseek-bot-host" content="https://…"> when the page
//              is served by a host (docs/hosting.md); absent when a bot serves it
//   notificationUrl — a tapped notification opened this window (sw.js: /?open=<url>)
// It also answers `ui.open` (a module the assistant wrote, mobile/src/native.ts):
// the browser cannot verify a signed .nshpkg (nsh 0.3.0's web player runs
// bundles only), so it fetches the module's compiled bundle (bundle.nshc) from the bot and
// runs it in a second player over the page. No signature check on this path;
// the bot that served the bundle is the same one the device token trusts.
const b64ToBytes = (s) => { const b = atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=')); return Uint8Array.from(b, (c) => c.charCodeAt(0)) }

export async function createHost(player) {
  // a tapped notification (sw.js) → the app's `notification` event, as the iOS shell sends it
  const sw = typeof navigator !== 'undefined' ? navigator.serviceWorker : undefined
  if (sw) sw.addEventListener('message', (e) => { if (e.data && e.data.type === 'notification') player.hostEvent('notification', { url: e.data.url || '/' }) })
  return {
    async call(name, args) {
      if (name === 'push.request') {
        if (!('Notification' in globalThis) || !sw || !('PushManager' in globalThis)) return { granted: false }
        return { granted: (await Notification.requestPermission()) === 'granted' }
      }
      if (name === 'push.token') {
        // Web Push: the subscription goes to the bot as POST /push/subscribe (the same body the old PWA sent)
        const vapid = args && args.vapid
        if (!vapid || !sw) return {}
        const reg = await sw.register('/sw.js')
        await sw.ready
        const sub = (await reg.pushManager.getSubscription()) || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(vapid) }))
        return { subscription: sub.toJSON() }
      }
      if (name === 'launch.params') {
        const l = globalThis.location
        const meta = typeof document !== 'undefined' ? document.querySelector('meta[name="deepseek-bot-host"]') : null
        return {
          pairUrl: l && /^\/pair\/?$/.test(l.pathname) ? l.href : undefined,
          hostUrl: meta && meta.content ? meta.content : undefined,
          notificationUrl: (l && new URLSearchParams(l.search).get('open')) || undefined,
        }
      }
      if (name === 'ui.open') return openModule(args || {})
      throw new Error(`no host function ${name}`)
    },
  }
}

/** The runtime this page loaded: `nsh package --target web` names the files in its scripts (nsh.<digest>.js, nsh.<digest>.wasm, harden.<digest>.nshc). */
function findRuntime() {
  let js, wasm, harden
  for (const s of document.scripts) {
    const t = s.textContent || ''
    js ??= (/["'](\.\/)?(nsh\.[0-9a-f]+\.js)["']/.exec(t) || [])[2]
    wasm ??= (/nsh\.[0-9a-f]+\.wasm/.exec(t) || [])[0]
    harden ??= (/harden\.[0-9a-f]+\.nshc/.exec(t) || [])[0]
  }
  if (!js || !wasm || !harden) throw new Error('the NSH runtime of this page was not found')
  return { js: new URL(js, document.baseURI).href, wasm: new URL(wasm, document.baseURI).href, harden: new URL(harden, document.baseURI).href }
}

/**
 * ui.open { bundleUrl, auth, token, title, origin, moduleId } → runs the module in an
 * overlay: a title bar with Done, then a second player (the wasm is already in the
 * browser cache). The module gets { token, origin, moduleId } from `launch.params`
 * and closes itself with `ui.close`. `runtime` is for tests; the page finds its own.
 */
export async function openModule(args, runtime) {
  if (!args.bundleUrl || !args.auth || !args.moduleId) throw new Error('ui.open needs bundleUrl, auth and moduleId')
  const started = performance.now()
  const { js, wasm, harden } = runtime || findRuntime()
  // bytecode, as the page itself runs: the released runtime has no eval ("Error: eval is not supported" for a source bundle, measured 2026-10-27)
  const [{ createPlayer }, response, hardenBytes] = await Promise.all([import(js), fetch(args.bundleUrl, { headers: { authorization: `Bearer ${args.auth}` } }), fetch(harden).then((r) => r.arrayBuffer())])
  if (!response.ok) throw new Error(`bundle: HTTP ${response.status}`)
  const code = await response.arrayBuffer()

  const overlay = document.createElement('div')
  overlay.className = 'ui-sheet'
  overlay.setAttribute('role', 'dialog')
  overlay.style.cssText = 'position:fixed;inset:0;z-index:1000;display:flex;flex-direction:column;background:Canvas;color:CanvasText;color-scheme:light dark'
  const bar = document.createElement('div')
  bar.style.cssText = 'display:flex;align-items:center;height:44px;padding:0 8px 0 16px;border-bottom:0.5px solid rgba(128,128,128,.4);font:600 17px/22px -apple-system,system-ui,sans-serif;flex:none'
  const title = document.createElement('span'); title.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'; title.textContent = args.title || ''
  const done = document.createElement('button'); done.type = 'button'; done.textContent = 'Done'; done.setAttribute('data-testid', 'ui-done')
  done.style.cssText = 'appearance:none;border:0;background:none;color:#007AFF;font:600 17px -apple-system,system-ui,sans-serif;min-width:44px;height:44px;cursor:pointer'
  const container = document.createElement('div'); container.style.cssText = 'flex:1;position:relative;min-height:0'; container.setAttribute('data-testid', 'ui-module')
  const note = document.createElement('div'); note.style.cssText = 'flex:none;padding:8px 16px;font:12px/16px ui-monospace,monospace;opacity:.7;white-space:pre-wrap;display:none'
  bar.append(title, done); overlay.append(bar, container, note); document.body.append(overlay)

  let player = null
  const close = () => { try { player && player.stop() } catch {} overlay.remove() }
  done.onclick = close
  const params = { token: args.token || '', origin: args.origin || location.origin, moduleId: args.moduleId }
  player = await createPlayer(container, {
    wasm: fetch(wasm),
    overlay: false,
    // ui.close is answered first and the player stopped on the next tick: stopping it from inside its own host call panics the runtime ("RefCell already borrowed", measured 2026-10-27)
    host: { call: (name) => { if (name === 'launch.params') return params; if (name === 'ui.close') { setTimeout(close, 0); return null } throw new Error(`no host function ${name}`) } },
    onError: (message) => { note.style.display = 'block'; note.textContent = message },
  })
  player.run(code, { release: true, harden: hardenBytes, capabilities: JSON.stringify({ network: { hosts: [new URL(params.origin).hostname] }, host: ['*'] }), appId: `dev.deepseekbot.ui.${args.moduleId}` })
  return { ok: true, verified: false, ms: Math.round(performance.now() - started) }
}
