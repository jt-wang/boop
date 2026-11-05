// Web Push: VAPID keys minted once per bot home, one subscription per paired
// device, pushes fan out to every device.
import { readFile } from 'node:fs/promises'
import webpush from 'web-push'
import type { Agent } from 'node:https'
// [agent:ios] APNs tokens from the iOS app (src/push-apns.ts).
import type { ApnsTransport } from './push-apns.ts'
// [push] FCM tokens from the Android app (src/push-fcm.ts).
import { fcmTokenGone, type FcmTransport } from './push-fcm.ts'
import { writeAtomic } from './atomic.ts'

export interface PushSubscriptionJSON { endpoint: string; expirationTime?: number | null; keys: { p256dh: string; auth: string } }
export interface Notification { title: string; body: string; url?: string; tag?: string }
type Sender = (sub: PushSubscriptionJSON, payload: string) => Promise<unknown>

/** Whether a send failed in a way the next try may not: the service was busy or down (429, 5xx), or nothing answered. */
const transient = (e: unknown) => { const code = (e as { statusCode?: number }).statusCode; return code === undefined || code === 429 || code >= 500 }
/** The waits before each new try of a push that failed for a moment; after the last one it is dropped. */
const RETRY_DELAYS_MS = [5_000, 30_000, 120_000]

interface State {
  publicKey: string; privateKey: string; subscriptions: { deviceId: string; sub: PushSubscriptionJSON }[]
  /** [agent:ios] One APNs device token per paired iPhone. */
  apns?: { deviceId: string; token: string }[]
  /** [push] One FCM registration token per paired Android phone. */
  fcm?: { deviceId: string; token: string }[]
}

export class PushService {
  private readonly path: string
  private state: State
  private readonly sender: Sender
  private readonly check?: (url: string) => Promise<void>
  private readonly retryDelaysMs: number[]
  private constructor(path: string, state: State, sender: Sender, check?: (url: string) => Promise<void>, retryDelaysMs = RETRY_DELAYS_MS) { this.path = path; this.state = state; this.sender = sender; this.check = check; this.retryDelaysMs = retryDelaysMs }

  static async open(path: string, opts: { sender?: Sender; subject?: string; check?: (url: string) => Promise<void>; agent?: Agent; retryDelaysMs?: number[] } = {}) {
    let state: State
    try { state = JSON.parse(await readFile(path, 'utf8')) } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
      const k = webpush.generateVAPIDKeys()
      state = { publicKey: k.publicKey, privateKey: k.privateKey, subscriptions: [] }
    }
    const subject = opts.subject ?? 'mailto:bot@localhost'
    const sender: Sender = opts.sender ?? ((sub, payload) => webpush.sendNotification(sub, payload, {
      vapidDetails: { subject, publicKey: state.publicKey, privateKey: state.privateKey },
      TTL: 3600,
      ...(opts.agent ? { agent: opts.agent } : {}),
    }))
    const svc = new PushService(path, state, sender, opts.check, opts.retryDelaysMs)
    await svc.persist()
    return svc
  }

  get publicKey() { return this.state.publicKey }

  async subscribe(deviceId: string, sub: PushSubscriptionJSON) {
    await this.check?.(sub.endpoint)
    this.state.subscriptions = this.state.subscriptions.filter((s) => s.deviceId !== deviceId && s.sub.endpoint !== sub.endpoint)
    this.state.subscriptions.push({ deviceId, sub })
    await this.persist()
  }

  async unsubscribeDevice(deviceId: string) {
    this.state.subscriptions = this.state.subscriptions.filter((s) => s.deviceId !== deviceId)
    if (this.state.apns) this.state.apns = this.state.apns.filter((s) => s.deviceId !== deviceId) // [agent:ios]
    if (this.state.fcm) this.state.fcm = this.state.fcm.filter((s) => s.deviceId !== deviceId) // [push]
    await this.persist()
  }

  async subscriptions() { return this.state.subscriptions.map((s) => s.sub) }

  /**
   * Try a send that failed for a moment again after the next wait, while `still()` says the device is still subscribed.
   * DeepSeek's dsh-superagent prototype retries its outbox with growing waits the same way (src/app/outbox.ts). The
   * waits are short against a push's own life (web push TTL 3600 s), so they are kept in memory: a restart drops them.
   */
  private later(send: () => Promise<unknown>, still: () => boolean, what: string, attempt = 0) {
    const wait = this.retryDelaysMs[attempt]
    if (wait === undefined) { console.warn(`[bot] ${what}: gave up after ${attempt + 1} tries`); return }
    setTimeout(() => {
      if (!still()) return
      send().catch((e) => { if (transient(e)) this.later(send, still, what, attempt + 1); else console.warn(`[bot] ${what}: ${(e as Error).message}`) })
    }, wait).unref?.()
  }

  /** Send to every device; drops subscriptions the push service reports gone, and tries again one that failed for a moment. */
  async notify(n: Notification) {
    const payload = JSON.stringify(n)
    const dead = new Set<string>()
    await Promise.all(this.state.subscriptions.map(async ({ sub }) => {
      try { await this.check?.(sub.endpoint) } catch { dead.add(sub.endpoint); return }
      try { await this.sender(sub, payload) } catch (e) {
        const code = (e as { statusCode?: number }).statusCode
        if (code === 404 || code === 410) dead.add(sub.endpoint)
        else if (transient(e)) this.later(() => this.sender(sub, payload), () => this.state.subscriptions.some((s) => s.sub.endpoint === sub.endpoint), 'web push')
      }
    }))
    if (dead.size) { this.state.subscriptions = this.state.subscriptions.filter((s) => !dead.has(s.sub.endpoint)); await this.persist() }
    await this.notifyApns(n) // [agent:ios]
    await this.notifyFcm(n) // [push]
  }

  // [push] FCM: the Android app registers its token; main.ts sets `fcm` when config.json has an `fcm` section (or the
  // host relays). Without one, tokens are kept and nothing is sent, as for APNs.
  fcm: FcmTransport | null = null
  private warnedNoFcm = false

  async subscribeFcm(deviceId: string, token: string) {
    this.state.fcm = (this.state.fcm ?? []).filter((s) => s.deviceId !== deviceId && s.token !== token)
    this.state.fcm.push({ deviceId, token })
    await this.persist()
    if (!this.fcm && !this.warnedNoFcm) { this.warnedNoFcm = true; console.warn('[bot] an Android phone registered for notifications, but config.json has no "fcm" section; see docs/push.md') }
  }

  fcmTokens() { return (this.state.fcm ?? []).map((s) => s.token) }

  private async notifyFcm(n: Notification) {
    const subs = this.state.fcm ?? []
    if (!this.fcm || subs.length === 0) return
    const dead = new Set<string>()
    await Promise.all(subs.map(async ({ token }) => {
      try { await this.fcm!.send(token, n) } catch (e) {
        if (fcmTokenGone(e as { statusCode?: number; reason?: string })) dead.add(token)
        else if (transient(e)) this.later(() => this.fcm!.send(token, n), () => Boolean(this.fcm) && (this.state.fcm ?? []).some((s) => s.token === token), 'FCM')
        else console.warn(`[bot] FCM: ${(e as Error).message}`)
      }
    }))
    if (dead.size) { this.state.fcm = subs.filter((s) => !dead.has(s.token)); await this.persist() }
  }

  // [agent:ios] APNs: the iOS app registers its device token; main.ts sets
  // `apns` when config.json has an `apns` section. Without one, tokens are
  // kept (so turning it on later needs no re-pairing) and nothing is sent.
  apns: ApnsTransport | null = null
  private warnedNoApns = false

  async subscribeApns(deviceId: string, token: string) {
    const t = token.toLowerCase()
    this.state.apns = (this.state.apns ?? []).filter((s) => s.deviceId !== deviceId && s.token !== t)
    this.state.apns.push({ deviceId, token: t })
    await this.persist()
    if (!this.apns && !this.warnedNoApns) { this.warnedNoApns = true; console.warn('[bot] an iPhone registered for notifications, but config.json has no "apns" section; see docs/ios.md') }
  }

  apnsTokens() { return (this.state.apns ?? []).map((s) => s.token) }

  private async notifyApns(n: Notification) {
    const subs = this.state.apns ?? []
    if (!this.apns || subs.length === 0) return
    const dead = new Set<string>()
    await Promise.all(subs.map(async ({ token }) => {
      try { await this.apns!.send(token, n) } catch (e) {
        const { statusCode, reason } = e as { statusCode?: number; reason?: string }
        if (statusCode === 410 || (statusCode === 400 && reason === 'BadDeviceToken')) dead.add(token)
        else if (transient(e)) this.later(() => this.apns!.send(token, n), () => Boolean(this.apns) && (this.state.apns ?? []).some((s) => s.token === token), 'APNs')
        else console.warn(`[bot] APNs: ${(e as Error).message}`)
      }
    }))
    if (dead.size) { this.state.apns = subs.filter((s) => !dead.has(s.token)); await this.persist() }
  }

  private async persist() {
    await writeAtomic(this.path, () => JSON.stringify(this.state, null, 2))
  }
}
