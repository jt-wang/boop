// Only this schema can enter the journal, including when reading a previous run.
// There are deliberately no text, URL, path, error-message or identity fields.
export const categories = ['interaction', 'performance', 'network', 'resources'] as const
export type Category = typeof categories[number]
type Rule = readonly string[] | readonly [number, number]
const screens = ['chat', 'discover', 'menu', 'settings', 'diagnostics', 'profile', 'library', 'file', 'connect', 'welcome', 'other'] as const
const schema: Record<string, { category: Category; fields: Record<string, Rule> }> = {
  'ui.navigation': { category: 'interaction', fields: { screen: screens } },
  'app.state': { category: 'interaction', fields: { state: ['foreground', 'background'] } },
  'js.callback': { category: 'performance', fields: { intervalMs: [60000, 60000], delayMs: [0, 3600000] } },
  'http.request': { category: 'network', fields: {
    operation: ['pair', 'get', 'send', 'text', 'rpc', 'prompt', 'cancel'], method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    outcome: ['response', 'transport-error'], status: [100, 599], durationMs: [0, 3600000], contentLength: [0, 1073741824],
  } },
  'device.sample': { category: 'resources', fields: {
    batteryLevel: [0, 1], charging: ['charging', 'full', 'unplugged', 'unknown'],
    thermal: ['nominal', 'fair', 'serious', 'critical', 'unknown'], androidThermalStatus: [0, 6], lowPower: ['on', 'off'],
  } },
}
export interface DiagnosticEvent { at: number; category: Category; event: string; fields: Record<string, string | number> }
export interface DiagnosticStorage { getItem(key: string): Promise<string | null>; setItem(key: string, value: string): Promise<unknown>; removeItem(key: string): Promise<unknown> }
export const MAX_EVENTS = 512
export const MAX_BYTES = 256 * 1024
const KEY = 'boop.diagnostics.v1' // gitleaks:allow -- local storage name, not a credential
const allCategories = () => Object.fromEntries(categories.map(c => [c, true])) as Record<Category, boolean>

function project(event: string, input: Record<string, unknown>, at: number): DiagnosticEvent | null {
  const spec = Object.hasOwn(schema, event) ? schema[event] : null
  if (!spec || !Number.isSafeInteger(at) || at < 0) return null
  const fields: DiagnosticEvent['fields'] = {}
  for (const [key, rule] of Object.entries(spec.fields)) {
    const value = input[key]
    if (typeof rule[0] === 'number') {
      if (typeof value === 'number' && Number.isFinite(value) && value >= rule[0] && value <= (rule[1] as number)) fields[key] = value
    } else if (typeof value === 'string' && (rule as readonly string[]).includes(value)) fields[key] = value
  }
  return { at, category: spec.category, event, fields }
}

export class DiagnosticLog {
  enabled = false
  retain = false
  selected = allCategories()
  error: 'storage' | 'invalid-journal' | null = null
  private events: DiagnosticEvent[] = []
  private bytes = 2
  private dirty = false
  private writing: Promise<void> | null = null
  private revision = 0
  private storage: DiagnosticStorage
  private clock: () => number
  constructor(storage: DiagnosticStorage, clock: () => number = Date.now) { this.storage = storage; this.clock = clock }

  async load() {
    try {
      const raw = await this.storage.getItem(KEY)
      if (!raw) return
      if (raw.length > MAX_BYTES) throw new Error('invalid journal')
      const parsed = JSON.parse(raw)
      if (!Array.isArray(parsed.events)) throw new Error('invalid journal')
      this.retain = true
      for (const c of categories) this.selected[c] = parsed.categories?.[c] === true
      for (const item of parsed.events.slice(-MAX_EVENTS)) {
        if (!item || typeof item.event !== 'string' || !item.fields || typeof item.fields !== 'object') continue
        const clean = project(item.event, item.fields, item.at)
        if (clean) this.append(clean)
      }
      // Retain previous records, but never resume capture without a new opt-in.
    } catch { this.error = 'invalid-journal' }
  }

  configure(enabled: boolean, selected: Record<Category, boolean>, retain: boolean) {
    this.enabled = enabled
    this.selected = Object.fromEntries(categories.map(c => [c, selected[c] === true])) as Record<Category, boolean>
    this.retain = retain
    this.dirty = true
    this.revision++ // Requests begun before a privacy-setting change cannot later enter the journal.
  }

  get generation() { return this.revision }
  accepts(category: Category) { return this.enabled && this.selected[category] }
  record(event: string, fields: Record<string, unknown>, generation = this.revision) {
    const spec = Object.hasOwn(schema, event) ? schema[event] : null
    if (!spec || !this.accepts(spec.category) || generation !== this.revision) return
    const clean = project(event, fields, this.clock())
    if (clean) { this.append(clean); this.dirty = true }
  }
  private append(event: DiagnosticEvent) {
    this.events.push(event); this.bytes += JSON.stringify(event).length + 1
    // ASCII-only fields: character length equals UTF-8 bytes. Reserve room for the envelope.
    while (this.events.length > MAX_EVENTS || this.bytes > MAX_BYTES - 4096) this.bytes -= JSON.stringify(this.events.shift()).length + 1
  }
  get count() { return this.events.length }
  get size() { return this.bytes }

  async flush(): Promise<void> {
    if (this.writing) { await this.writing; return this.flush() }
    if (!this.dirty) return
    this.dirty = false
    const raw = this.retain ? JSON.stringify({ categories: this.selected, events: this.events }) : null
    this.writing = (async () => {
      try {
        if (raw === null) await this.storage.removeItem(KEY)
        else await this.storage.setItem(KEY, raw)
        this.error = null
      } catch { this.error = 'storage'; this.dirty = true; this.enabled = false; this.revision++ }
    })()
    await this.writing; this.writing = null
  }
  async clear() {
    this.events = []; this.bytes = 2; this.revision++; this.dirty = true
    await this.flush()
  }
  snapshot(from: number, to: number, selected = this.selected) {
    return this.events.filter(e => e.at >= from && e.at <= to && selected[e.category]).map(e => ({ ...e, fields: { ...e.fields } }))
  }
}

/** Observe an existing fetch only. Never inspect body, URL, headers or error text for logging. */
export async function observeRequest(log: DiagnosticLog, operation: string, method: string, request: () => Promise<Response>): Promise<Response> {
  if (!log.accepts('network')) return request()
  const generation = log.generation
  const start = Date.now()
  try {
    const response = await request()
    const length = response.headers.get('content-length')
    log.record('http.request', { operation, method, outcome: 'response', status: response.status, durationMs: Math.max(0, Date.now() - start),
      ...(length !== null && /^\d+$/.test(length) ? { contentLength: Number(length) } : {}),
    }, generation)
    return response
  } catch (error) {
    log.record('http.request', { operation, method, outcome: 'transport-error', durationMs: Math.max(0, Date.now() - start) }, generation)
    throw error
  }
}
