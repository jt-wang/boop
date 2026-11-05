// Goals: something the person wants over days or weeks. The assistant keeps a
// plan and progress notes; the app shows them.
import { JsonList } from './store.ts'

export interface Goal {
  id: string
  title: string
  plan: string[]
  notes: { at: string; text: string }[]
  status: 'active' | 'done' | 'paused'
  createdAt: string
  updatedAt: string
}

export class Goals {
  private readonly store: JsonList<Goal>
  private constructor(store: JsonList<Goal>) { this.store = store }
  static async open(path: string) { return new Goals(await JsonList.open<Goal>(path)) }
  list() { return this.store.all() }
  async set(title: string, plan: string[] = []) {
    const now = new Date().toISOString()
    return this.store.insert({ title: title.slice(0, 120), plan: plan.map((p) => p.slice(0, 200)).slice(0, 20), notes: [], status: 'active', createdAt: now, updatedAt: now })
  }
  async update(id: string, patch: { title?: string; plan?: string[]; note?: string; status?: Goal['status'] }) {
    const g = this.store.get(id); if (!g) return undefined
    const notes = patch.note ? [...g.notes, { at: new Date().toISOString(), text: patch.note.slice(0, 500) }].slice(-50) : g.notes
    return this.store.update(id, { title: patch.title ?? g.title, plan: patch.plan ?? g.plan, status: patch.status ?? g.status, notes, updatedAt: new Date().toISOString() })
  }
  remove(id: string) { return this.store.remove(id) }
}
