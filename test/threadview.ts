// A test client's view of one thread over /events, applied the way the app
// does (mobile/src/state.ts apply): a snapshot replaces, rows merge by id,
// deltas append. Used by the e2e tests and test/genui.eval.ts.
export type ViewRow = { kind: string; id: string; text?: string; card?: { kind: string; title: string; options?: { label: string }[]; rows?: string[][]; pick?: boolean }; moduleId?: string; title?: string; url?: string; answer?: string; name?: string; output?: string; streaming?: boolean }
type Frame = { type?: unknown; sessionId?: unknown; rows?: unknown; rowId?: unknown; text?: unknown; running?: unknown }

export class ThreadView {
  readonly sessionId: string
  private list: ViewRow[] = []
  private statuses: boolean[] = []
  constructor(sessionId: string) { this.sessionId = sessionId }

  apply(f: Frame) {
    // every socket also carries status for the person's other sessions; the app ignores them, so does this
    if (f.sessionId !== this.sessionId) return
    if (f.type === 'status') { this.statuses.push(Boolean(f.running)); return }
    if (f.type === 'snapshot') this.list = ((f.rows as ViewRow[]) ?? []).map((r) => ({ ...r }))
    else if (f.type === 'rows') for (const r of (f.rows as ViewRow[]) ?? []) { const i = this.list.findIndex((x) => x.id === r.id); if (i >= 0) this.list[i] = { ...r }; else this.list.push({ ...r }) }
    else if (f.type === 'delta') { const r = this.list.find((x) => x.id === f.rowId); if (r) r.text = (r.text ?? '') + String(f.text ?? '') }
  }

  rows(): ViewRow[] { return this.list.map((r) => ({ ...r })) }
  /** The assistant's words in this turn, as the thread shows them. */
  replyText(): string { return this.list.filter((r) => r.kind === 'them').map((r) => r.text ?? '').join('\n') }
  /** Before sending the next message: keep the rows, forget that a turn already ran and stopped. */
  nextTurn() { this.statuses = [] }
  /** The turn ran and stopped. */
  turnOver(): boolean { return this.statuses.includes(true) && this.statuses.at(-1) === false }
}
