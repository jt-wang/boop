// The page's host for the browser build (nsh.json `web.host`): what the native
// shells pass as `host.params`, the page answers to `launch.params`.
//   pairUrl  — the page was opened from a pairing link (/pair?code=…)
//   hostUrl  — <meta name="deepseek-bot-host" content="https://…"> when the page
//              is served by a host (docs/hosting.md); absent when a bot serves it
//   notificationUrl — a tapped notification opened this window (sw.js: /?open=<url>)
// It also exports `openModule`, which the play page uses to run a module the assistant wrote (src/server.ts playPage):
// the browser cannot verify a signed .nshpkg, so that page gets the module's bundle.js from the bot. No signature check on
// this path; the bot that served the bundle is the same one the device token trusts, and the page has no origin of its own.
const b64ToBytes = (s) => { const b = atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=')); return Uint8Array.from(b, (c) => c.charCodeAt(0)) }

export async function createHost(player) {
  // a tapped notification (sw.js) → the app's `notification` event, as the iOS shell sends it
  const sw = typeof navigator !== 'undefined' ? navigator.serviceWorker : undefined
  if (sw) sw.addEventListener('message', (e) => { if (e.data && e.data.type === 'notification') player.hostEvent('notification', { url: e.data.url || '/' }) })
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => player.hostEvent('appState', { state: document.hidden ? 'background' : 'foreground' }))
  return {
    async call(name, args) {
      if (name === 'diagnostics.share') {
        if (typeof args?.text !== 'string' || new TextEncoder().encode(args.text).length > 262144) throw new Error('Invalid diagnostic export')
        const url = URL.createObjectURL(new Blob([args.text], { type: 'application/json' }))
        const link = document.createElement('a')
        link.href = url; link.download = 'Boop Diagnostics.json'; link.click()
        setTimeout(() => URL.revokeObjectURL(url), 1000)
        return { opened: true }
      }
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
      throw new Error(`no host function ${name}`)
    },
  }
}

/**
 * { bundleUrl, auth, token, title, origin, moduleId } → runs the module in an overlay: a title bar with Done, then a
 * player from the runtime files the play page names. The module gets { token, origin, moduleId } from `launch.params`
 * and closes itself with `ui.close`.
 */
export async function openModule(args, runtime) {
  if (!args.bundleUrl || !args.auth || !args.moduleId) throw new Error('ui.open needs bundleUrl, auth and moduleId')
  const started = performance.now()
  const { js, wasm } = runtime
  const [{ createPlayer }, response] = await Promise.all([import(js), fetch(args.bundleUrl)])
  if (!response.ok) throw new Error(`bundle: HTTP ${response.status}`)
  const code = await response.text()

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
  await player.runSource(code, { capabilities: JSON.stringify({ network: { hosts: [new URL(params.origin).hostname] }, host: ['*'] }), appId: `dev.deepseekbot.ui.${args.moduleId}`, name: 'App.tsx' })
  return { ok: true, verified: false, ms: Math.round(performance.now() - started) }
}
