// The assistant's profile, opened by tapping the avatar:
// the avatar with a pencil, the name, what it is doing now, and four icon
// segments — Activity, Permissions, Upcoming, Memory. The fourth segment is the
// structured memory list, each item editable and forgettable.
import { formatDate, formatTime } from './locale.ts'
import { AlertDialog } from 'nsh/base'
import { computed, effect, resource, signal, Text, View } from 'nsh'
import { api, lang, me, rows, running, session, showToast, statusText, str, t } from './state.ts'
import { cm, service } from './i18n-cm.ts'
import { activityText } from './plain.ts'
import { emojiFor } from './chat.tsx'
import { openStop } from './stop.tsx'
import { connectedIds, connectorsVersion, fetchView, type ConnectorsView } from './connectors.tsx'
import { Avatar, Page } from './ui.tsx'
import { BrandMark, Glyph, IconSegments, Row, SectionTitle, Tile, type IconName, muted } from './kit.tsx'

export type ProfileTab = 'activity' | 'permissions' | 'upcoming' | 'memory'
export interface MemoryItem { id: string; file: 'user' | 'memory'; kind: 'preference' | 'fact' | 'decision' | 'project' | 'person'; text: string; date: string }
type Activity = { id: string; at: string; kind: string; text: string }
type Task = { id: string; name: string; instruction: string; when: { kind: string; seconds?: number; time?: string; weekdays?: number[] }; nextRunAt: string | null; active: boolean }

/** Bumped after an edit or a forget so the memory list refetches when the person comes back to it. */
export const memoryVersion = signal(0)

const clock = (iso: string) => formatTime(iso, lang())
const day = (iso: string) => formatDate(iso, lang()) || iso
const dayKey = (iso: string) => { const d = new Date(iso), n = new Date(); const y = new Date(n); y.setDate(n.getDate() - 1); return d.toDateString() === n.toDateString() ? 'today' : d.toDateString() === y.toDateString() ? 'yesterday' : 'earlier' }
const KIND_ICON: Record<string, IconName> = { memory: 'brain', schedule: 'clock', approval: 'shield', notify: 'bell', goal: 'target', connector: 'plug', ideas: 'sparkles', ui: 'sparkles', show: 'sparkles' }

/** The four memory groups, in order of what matters to the person. */
export const GROUPS: { key: 'memAboutYou' | 'memTracking' | 'memDecisions' | 'memPeople'; kinds: MemoryItem['kind'][] }[] = [
  { key: 'memAboutYou', kinds: ['fact', 'preference'] },
  { key: 'memTracking', kinds: ['project'] },
  { key: 'memDecisions', kinds: ['decision'] },
  { key: 'memPeople', kinds: ['person'] },
]
/** Up to this many rows per group before "Show N more". */
const FOLD = 5

export function ProfilePage(props: { tab?: ProfileTab; focus?: string; onEditName: () => void; onConnectors: () => void; onConnector: (id: string) => void; onEditMemory: (it: MemoryItem) => void }) {
  const tab = signal<ProfileTab>(props.tab ?? 'activity')
  const liveStep = computed(() => { const r = rows(); for (let i = r.length - 1; i >= 0; i--) { const x = r[i]; if (x.kind === 'you') return null; if (x.kind === 'step' && x.output === undefined) return x } return null })
  const lastAsk = computed(() => { const r = rows(); for (let i = r.length - 1; i >= 0; i--) if (r[i].kind === 'you') return (r[i] as { text: string }).text; return '' })
  const status = () => (running() ? `${emojiFor(liveStep()?.name ?? '')} ${statusText().replace(/…$/, '') || cm('working')}` : str('online'))
  const segments = [
    { key: 'activity' as const, icon: 'list' as const, label: cm('tabActivity') },
    { key: 'permissions' as const, icon: 'shield' as const, label: cm('tabPermissions') },
    { key: 'upcoming' as const, icon: 'clock' as const, label: cm('tabUpcoming') },
    { key: 'memory' as const, icon: 'fingerprint' as const, label: cm('tabMemory') },
  ]
  return (
    <Page page={`ProfilePage/${tab()}`} class="flex-1 bg-background" contentClass="pb-[calc(env(safe-area-inset-bottom)+32px)]" testID="profile">
      <View class="items-center pt-2">
        <View style={{ width: 112, height: 112 }}>
          <Avatar size={112} />
          <View role="button" accessibilityLabel={cm('editProfile')} testID="profile-edit" onPress={props.onEditName}
            class="absolute items-center justify-center rounded-full bg-background dark:bg-card active:opacity-70" style={{ width: 36, height: 36, right: -6, bottom: 2, boxShadow: '0 1px 4px rgba(0,0,0,0.14)' }}>
            <Glyph name="pencil" size={17} />
          </View>
        </View>
        <Text class="text-foreground text-[28px] leading-[34px] font-bold mt-[15px]" numberOfLines={1}>{me()?.assistant.name ?? ''}</Text>
        <View class="px-8"><Text class="text-muted-foreground text-[17px] leading-[22px] mt-[6px] text-center" numberOfLines={1} testID="profile-status">{status()}</Text></View>
      </View>
      <View class="px-4 mt-10"><IconSegments items={segments} value={tab()} onChange={(k) => tab.set(k)} /></View>
      <If when={tab() === 'activity'}><ActivityTab lastAsk={lastAsk()} stepName={liveStep()?.name ?? ''} liveStep={liveStep()?.description ?? statusText().replace(/…$/, '')} /></If>
      <If when={tab() === 'permissions'}><PermissionsTab onConnectors={props.onConnectors} onConnector={props.onConnector} /></If>
      <If when={tab() === 'upcoming'}><UpcomingTab /></If>
      <If when={tab() === 'memory'}><MemoryTab focus={props.focus} onEdit={props.onEditMemory} /></If>
    </Page>
  )
}

/** The activity list: the running task on a grey plate with a stop button, then what it did, by day, newest first. */
function ActivityTab(props: { lastAsk: string; stepName: string; liveStep: string }) {
  const list = resource(() => (session() ? `a${running()}` : null), async () => api().get<Activity[]>('/activity').catch(() => [] as Activity[]))
  const groups = () => {
    const out: { key: 'today' | 'yesterday' | 'earlier'; items: Activity[] }[] = []
    for (const a of (list() ?? []).slice(0, 60)) { const k = dayKey(a.at); const g = out.find((x) => x.key === k); if (g) g.items.push(a); else out.push({ key: k, items: [a] }) }
    return out
  }
  return (
    <View testID="tab-activity">
      <If when={running()}>
        <SectionTitle text={cm('today')} />
        <Row highlight testID="activity-running" lead={<Tile><Text class="text-[17px] leading-6">{emojiFor(props.stepName)}</Text></Tile>} title={props.lastAsk || cm('working')} line={props.liveStep || cm('working')}
          right={<View role="button" accessibilityLabel={cm('stopTask')} testID="activity-stop" onPress={openStop} class="items-center justify-center rounded-full bg-background dark:bg-accent active:opacity-70" style={{ width: 30, height: 30 }}><View class="bg-foreground rounded-[3px]" style={{ width: 10, height: 10 }} /></View>} />
      </If>
      <If when={!list.loading() && (list() ?? []).length === 0 && !running()}><View class="px-4"><Text class="text-muted-foreground text-[15px] leading-5 pt-6">{cm('noActivity')}</Text></View></If>
      {groups().map((g, gi) => (
        <View>
          {gi === 0 && running() && g.key === 'today' ? null : <SectionTitle text={cm(g.key)} />}
          {g.items.map((a) => <Row lead={<Tile><Glyph name={KIND_ICON[a.kind] ?? 'globe'} size={22} /></Tile>} title={activityText(a.text, lang())} time={g.key === 'earlier' ? `${day(a.at)} ${clock(a.at)}` : clock(a.at)} testID={`act-${a.id}`} />)}
        </View>
      ))}
    </View>
  )
}

/** What it may use: the services it is signed in to, and the one rule it always keeps (asks before anything hard to undo). */
function PermissionsTab(props: { onConnectors: () => void; onConnector: (id: string) => void }) {
  const view = resource(() => connectorsVersion(), () => fetchView().catch(() => null as ConnectorsView | null))
  const connected = () => (view()?.catalog ?? []).filter((p) => p.auth === 'oauth' && connectedIds().has(p.id))
  return (
    <View testID="tab-permissions">
      <SectionTitle text={cm('permConnected')} />
      {connected().length === 0 && !view.loading() ? <View class="px-4"><Text class="text-muted-foreground text-[15px] leading-5 pb-1">{cm('permNone')}</Text></View> : null}
      {connected().map((p) => { const s = service(p.id, p.name, p.description); return <Row lead={<Tile><BrandMark id={p.id} name={s.name} /></Tile>} title={s.name} line={cm('connStatusConnected')} right={<Glyph name="chevron" size={18} color={muted()} />} onPress={() => props.onConnector(p.id)} testID={`perm-${p.id}`} /> })}
      <Row lead={<Tile><Glyph name="plug" size={22} /></Tile>} title={cm('permMore')} right={<Glyph name="chevron" size={18} color={muted()} />} onPress={props.onConnectors} testID="perm-connectors" />
      <View class="px-4"><Text class="text-muted-foreground text-[15px] leading-5 pt-4">{cm('permAsks')}</Text></View>
    </View>
  )
}

/** Reminders and scheduled checks, next first. Changes happen in the chat. */
function UpcomingTab() {
  const list = resource(() => (session() ? `u${running()}` : null), async () => api().get<Task[]>('/schedules').catch(() => [] as Task[]))
  const items = () => (list() ?? []).filter((x) => x.active && x.nextRunAt).sort((a, b) => Date.parse(a.nextRunAt!) - Date.parse(b.nextRunAt!))
  const whenText = (w: Task['when']) => (w.kind === 'every' ? t('every')(w.seconds ?? 0) : w.kind === 'daily' ? t('daily')(w.time ?? '') : w.kind === 'weekly' ? t('weekly')(w.time ?? '', w.weekdays ?? []) : '')
  return (
    <View testID="tab-upcoming">
      <If when={!list.loading() && items().length === 0}><View class="px-4"><Text class="text-muted-foreground text-[15px] leading-5 pt-6">{cm('noUpcoming')}</Text></View></If>
      <If when={items().length > 0}><View class="pt-3" /></If>
      {items().map((x) => <Row lead={<Tile><Glyph name="clock" size={22} /></Tile>} title={x.name} line={whenText(x.when) || undefined} time={`${day(x.nextRunAt!)} ${clock(x.nextRunAt!)}`} testID={`up-${x.id}`} />)}
    </View>
  )
}

/** Memory: what it knows, by group; tap or ⋮ to change or forget; the whole list can be forgotten at once. */
function MemoryTab(props: { focus?: string; onEdit: (it: MemoryItem) => void }) {
  const items = resource(() => (session() ? `m${memoryVersion()}` : null), async () => api().get<MemoryItem[]>('/memory'))
  const open = signal<Set<string>>(new Set())
  const focused = (it: MemoryItem) => Boolean(props.focus && it.text.toLowerCase().includes(props.focus.toLowerCase()))
  const forget = async (it: MemoryItem) => {
    const ok = await AlertDialog.show({ title: cm('memForgetTitle'), description: it.text, actions: [{ id: 'cancel', label: cm('memCancel'), role: 'cancel' }, { id: 'ok', label: cm('memForget'), role: 'destructive' }] }).then((r) => r === 'ok').catch(() => false)
    if (!ok) return
    try { await api().send('DELETE', `/memory/${encodeURIComponent(it.id)}`); items.mutate((items() ?? []).filter((x) => x.id !== it.id)); showToast(cm('memForgotten')) } catch { showToast(cm('memFailed')) }
  }
  const more = async (it: MemoryItem) => {
    const r = await AlertDialog.show({ title: it.text, presentation: 'actionSheet', actions: [{ id: 'edit', label: cm('memEdit') }, { id: 'forget', label: cm('memForget'), role: 'destructive' }, { id: 'cancel', label: cm('memCancel'), role: 'cancel' }] }).catch(() => null)
    if (r === 'edit') props.onEdit(it); else if (r === 'forget') forget(it).catch(() => {})
  }
  const forgetAll = async () => {
    const ok = await AlertDialog.show({ title: cm('memForgetAllTitle'), description: cm('memForgetAllBody'), actions: [{ id: 'cancel', label: cm('memCancel'), role: 'cancel' }, { id: 'ok', label: cm('memForgetAll'), role: 'destructive' }] }).then((r) => r === 'ok').catch(() => false)
    if (!ok) return
    try { for (const it of items() ?? []) await api().send('DELETE', `/memory/${encodeURIComponent(it.id)}`); items.mutate([]); showToast(cm('memForgotten')) } catch { showToast(cm('memFailed')); items.refetch() }
  }
  return (
    <View testID="memory">
      <If when={items.loading() && !items()}><View /></If>
      <If when={!items.loading() && (items() ?? []).length === 0}><View class="px-4"><Text class="text-muted-foreground text-[15px] leading-5 pt-6">{cm('memEmpty')}</Text></View></If>
      <If when={(items() ?? []).length > 0}>
        <View class="px-4 pt-6 gap-1">
          <Text class="text-foreground text-[17px] leading-[22px] font-semibold" testID="mem-count">{cm('memCount')((items() ?? []).length)}</Text>
          <Text class="text-muted-foreground text-[15px] leading-5">{cm('memAbout')}</Text>
        </View>
        {GROUPS.map((g) => {
          const all = () => (items() ?? []).filter((i) => g.kinds.includes(i.kind)).sort((a, b) => Number(focused(b)) - Number(focused(a)))
          const shown = () => (open().has(g.key) || all().some(focused) ? all() : all().slice(0, FOLD))
          return (
            <If when={all().length > 0}>
              <SectionTitle text={cm(g.key)} testID={`mem-group-${g.key}`} />
              {shown().map((it) => (
                <Row title={it.text} titleLines={3} line={cm('memLearned')(day(it.date))} highlight={focused(it)} onPress={() => props.onEdit(it)} testID={`mem-${it.id.replace(/[^a-z0-9]/gi, '-')}`}
                  right={<View role="button" accessibilityLabel={cm('memForget')} testID={`more-${it.id.replace(/[^a-z0-9]/gi, '-')}`} onPress={() => { more(it).catch(() => {}) }} class="items-center justify-center -mr-2 active:opacity-50" style={{ width: 36, height: 44 }}><Glyph name="dots" size={20} color={muted()} /></View>} />
              ))}
              <If when={shown().length < all().length}>
                <View role="button" testID={`mem-more-${g.key}`} onPress={() => open.set(new Set([...open(), g.key]))} class="flex-row items-center gap-3 px-4 min-h-[44px] active:opacity-60">
                  <Text class="text-muted-foreground text-[17px]">{cm('memShowMore')(all().length - shown().length)}</Text>
                </View>
              </If>
            </If>
          )
        })}
        <View role="button" testID="mem-forget-all" onPress={() => { forgetAll().catch(() => {}) }} class="items-center justify-center min-h-[44px] mt-8 active:opacity-60">
          <Text class="text-destructive text-[17px]">{cm('memForgetAll')}</Text>
        </View>
      </If>
    </View>
  )
}
