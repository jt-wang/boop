// The native shell around the app (ios/): system notifications and the links
// it hands over. Everything here is a no-op when the app runs without a host
// (dev host, web, headless tests without `host`).
//
// Host functions (ios/DeepSeekBot/PushBridge.swift, android/…/PushBridge.java):
//   push.request → { granted }      asks the system for permission
//   push.token   → { token, kind? } the APNs device token, hex (kind 'apns', the default), or the FCM token (kind 'fcm')
// The browser build's page (web/host.js) answers the same names: push.token
// gets { vapid } and returns { subscription } (Web Push) instead of a token.
// Host events:
//   notification { url }            the person tapped a notification; one that launched the app is host.params.notificationUrl
//   appState     { state }          'background' / 'foreground': the bot pushes only while no one can see the app (state.ts)
//   pair         { url }            a deepseekbot://pair link opened while running
//   link         { url }            [compliance] a link to an interface (universal link, App Link, deepseekbot://ui/…) opened while running;
//                                   one the app was opened with arrives as host.params.linkUrl
import { host, platform, signal, Storage } from 'nsh'
import type { Bot } from './api.ts'

export type NativePush = 'unavailable' | 'off' | 'on' | 'denied'
/** Shown by the Settings toggle; `unavailable` outside the native shell. */
export const nativePush = signal<NativePush>('unavailable')
/** The place a tapped notification points at (`/threads/<id>`, `/threads/<id>/asks/<event>`, `/discover`). App.tsx opens it and resets it to null. */
export const notificationUrl = signal<string | null>(null)
/** Whether a person can see the app; the shell says so (`appState`). Without a shell: always foreground. */
export const appState = signal<'foreground' | 'background'>('foreground')
/** A pairing link that arrived while the app was already running. */
export const pairLink = signal<string | null>(null)
/** [compliance] A link to an interface the app was opened with or that arrived while running (App.tsx opens it). */
export const openLink = signal<string | null>(null)
try {
  const first = (host.params as { linkUrl?: unknown } | undefined)?.linkUrl
  if (typeof first === 'string' && first) openLink.set(first)
  host.on('link', (p) => { const url = (p as { url?: string } | null)?.url; if (url) openLink.set(url) })
  // from the start, not only once paired: the QR code is scanned while the app shows the welcome or connect screen
  // (QA 2026-10-28 #1: heard only after pairing, so a link opened then filled nothing in)
  host.on('pair', (p) => { const url = (p as { url?: string } | null)?.url; if (url) pairLink.set(url) })
} catch {}
// [push] a tap on a notification: at launch (params) and while running (event), before pairing is even checked
try {
  const tapped = (host.params as { notificationUrl?: unknown } | undefined)?.notificationUrl
  if (typeof tapped === 'string' && tapped) notificationUrl.set(tapped)
  host.on('notification', (p) => { notificationUrl.set(String((p as { url?: string } | null)?.url ?? '/')) })
  host.on('appState', (p) => { appState.set((p as { state?: string } | null)?.state === 'background' ? 'background' : 'foreground') })
} catch {}

/** Where a notification's url lands: a thread (and the card in it, which sits at the thread's bottom), or Discover. */
export function notificationTarget(url: string): { tab: 'chat' | 'discover'; thread?: string; ask?: string } {
  const m = /^\/threads\/([^/?#]+)(?:\/asks\/([^/?#]+))?/.exec(url)
  if (m) return { tab: 'chat', thread: decodeURIComponent(m[1]), ...(m[2] ? { ask: decodeURIComponent(m[2]) } : {}) }
  if (/^\/discover\b/.test(url)) return { tab: 'discover' }
  return { tab: 'chat' }
}

const PREF = 'nativePush'
let bot: Bot | null = null
let vapid: string | null = null

export function nativeAvailable() { try { return host.available() } catch { return false } }
/**
 * Whether the app around this one runs a module the assistant wrote (`ui.open`): the iOS shell says so in its
 * params (`ui: true`, ios/DeepSeekBot/RootViewController.swift, android/…/MainActivity.java); the browser's page
 * answers it (web/host.js). An app around it that does not say so (the APK `nsh package` makes) gets the play page.
 */
export function shellOpensModules() {
  try { return platform.os === 'web' ? host.available() : Boolean((host.params as { ui?: unknown } | undefined)?.ui) } catch { return false }
}

/** Whether the shell also runs those modules inside the thread (`inlineUi`: the Android shell's InlineModule). */
export function shellRunsInline() {
  try { return platform.os !== 'web' && Boolean((host.params as { inlineUi?: unknown } | undefined)?.inlineUi) } catch { return false }
}

/** After the phone is paired: hear the shell's events and, unless the person turned it off, register for notifications. */
export async function afterConnect(b: Bot, pushPublicKey?: string | null) {
  bot = b; vapid = pushPublicKey ?? null
  if (!nativeAvailable()) return
  const pref = await Storage.getItem(PREF)
  if (pref === 'off') { nativePush.set('off'); return }
  await enableNativePush().catch(() => {})
}


/** Permission → token → bot. Resolves true when the bot has this phone's token. */
export async function enableNativePush(): Promise<boolean> {
  if (!nativeAvailable() || !bot) return false
  const asked = (await host.call('push.request')) as { granted?: boolean } | null
  if (!asked?.granted) { nativePush.set('denied'); return false }
  const got = (await host.call('push.token', { vapid }, { timeout: 20_000 })) as { token?: string; kind?: string; subscription?: { endpoint: string; keys: { p256dh: string; auth: string } } } | null
  if (got?.subscription?.endpoint) await bot.send('POST', '/push/subscribe', got.subscription)   // the browser: a Web Push subscription
  else if (got?.token) await bot.send('POST', '/push/subscribe', { kind: got.kind === 'fcm' ? 'fcm' : 'apns', token: got.token }) // Android: FCM; iOS: APNs
  else { nativePush.set('denied'); return false }
  nativePush.set('on')
  await Storage.setItem(PREF, 'on')
  return true
}

/** The toggle off: the bot forgets this phone's subscriptions; nothing more arrives. */
export async function disableNativePush() {
  nativePush.set('off')
  await Storage.setItem(PREF, 'off')
  if (bot) await bot.send('POST', '/push/unsubscribe', {}).catch(() => {})
}

/** For the Settings toggle. */
export async function setNativePush(on: boolean) { return on ? enableNativePush() : disableNativePush().then(() => true) }

// [agent:genui] Generated interfaces.
//   ui.open { url, auth, token, title, rootKey, origin, moduleId, bundleUrl } → { ok }
//     iOS (UiBridge.swift): downloads `url` (a signed .nshpkg) with `auth` (the device token),
//     verifies it against `rootKey`, runs it in a sheet with params { token, origin, moduleId }.
//     Browser (web/host.js): fetches `bundleUrl` (the module's bundle.nshc) and runs it in an overlay player (no signature check).
//   The module itself posts its result to the bot and asks the shell to `ui.close`.
export interface UiOpenArgs { url: string; bundleUrl: string; auth: string; token: string; title: string; rootKey: string; origin: string; moduleId: string; /** [compliance] What the person allowed this interface beyond its screen; the shell grants that and nothing else. */ grants: string[] }
export function uiOpen(args: UiOpenArgs): Promise<unknown> {
  if (!nativeAvailable()) return Promise.reject(new Error('no host'))
  return host.call('ui.open', args as unknown as Record<string, unknown>, { timeout: 60_000 })
}
