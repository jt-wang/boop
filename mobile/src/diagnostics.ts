import { cleanup, effect, host, platform, signal, Storage } from 'nsh'
import { appState } from './native.ts'
import { APP_VERSION } from './version.ts'
import { DiagnosticLog, categories, type Category } from './diagnostic-log.ts'
import appConfig from '../nsh.json'

// Native journals live separately from NSH preferences, outside device backups.
const nativeStore = Boolean((host.params as { diagnostics?: boolean } | undefined)?.diagnostics)
export const diagnosticLog = new DiagnosticLog(nativeStore ? {
  getItem: () => host.call<string | null>('diagnostics.read'),
  setItem: (_key, text) => host.call('diagnostics.write', { text }),
  removeItem: () => host.call('diagnostics.remove'),
} : Storage)
export const diagnosticState = signal(0)
export const diagnosticError = signal(false)
const changed = () => diagnosticState.set(diagnosticState() + 1)
export async function flushDiagnostics() {
  const enabled = diagnosticLog.enabled
  await diagnosticLog.flush()
  diagnosticError.set(Boolean(diagnosticLog.error))
  if (enabled !== diagnosticLog.enabled) changed()
}
export async function loadDiagnostics() { await diagnosticLog.load(); diagnosticError.set(Boolean(diagnosticLog.error)); changed() }
export async function configureDiagnostics(enabled: boolean, selected = diagnosticLog.selected, retain = diagnosticLog.retain) {
  diagnosticLog.configure(enabled, selected, retain); changed()
  await flushDiagnostics()
}
export async function clearDiagnostics() { await diagnosticLog.clear(); changed(); diagnosticError.set(Boolean(diagnosticLog.error)) }

// No timers or native sampling while off or backgrounded. Persistence is batched,
// at most once per five seconds; an abrupt kill can lose this last interval.
export function runDiagnostics() {
  effect(() => { diagnosticLog.record('app.state', { state: appState() }) })
  effect(() => {
    diagnosticState()
    const foreground = appState() === 'foreground'
    if (!diagnosticLog.enabled || !foreground) {
      void flushDiagnostics()
      return
    }
    const generation = diagnosticLog.generation
    let active = true
    const persist = diagnosticLog.retain ? setInterval(() => {
      void flushDiagnostics()
    }, 5000) : null
    let expected = Date.now() + 60000
    const sample = async () => {
      const now = Date.now()
      if (diagnosticLog.accepts('performance')) diagnosticLog.record('js.callback', { intervalMs: 60000, delayMs: Math.max(0, now - expected) }, generation)
      expected = now + 60000
      if (diagnosticLog.accepts('resources') && (platform.os === 'ios' || platform.os === 'android')) {
        try {
          const fields = await host.call<Record<string, unknown>>('diagnostics.sample')
          if (active && appState() === 'foreground') diagnosticLog.record('device.sample', fields, generation)
        } catch { diagnosticError.set(true) }
      }
    }
    const timer = diagnosticLog.selected.performance || diagnosticLog.selected.resources ? setInterval(sample, 60000) : null
    cleanup(() => { active = false; if (persist !== null) clearInterval(persist); if (timer !== null) clearInterval(timer) })
  })
}

export function exportDiagnostics(minutes: number, selected: Record<Category, boolean>) {
  const to = Date.now(), from = minutes === 0 ? 0 : to - minutes * 60000
  const events = diagnosticLog.snapshot(from, to, selected)
  return {
    schemaVersion: 1, exportId: crypto.randomUUID(),
    app: { version: APP_VERSION, build: appConfig.build, platform: platform.os, os: platform.version, deviceClass: platform.idiom, runtime: 'NSH 0.4.0' },
    range: { from, to }, actualRange: events.length ? { from: Math.min(...events.map(e => e.at)), to: Math.max(...events.map(e => e.at)) } : null,
    categories: categories.filter(c => selected[c]),
    measurements: { performance: '60-second JS callback lateness, not UI FPS', network: 'fetch response-header duration; Content-Length when supplied, not measured transfer bytes', resources: 'foreground system samples every 60 seconds; not app energy attribution; androidThermalStatus is the Android API value 0..6' },
    events,
  }
}
