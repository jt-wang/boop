// 发现 — what the assistant is tracking for you :
// a dotted section title; rows with a checkbox, a title, one grey line and a
// ⋮; three rows, then "Show N more"; ideas as an icon, a first-person title
// and a short plan. Goals and ideas share
// one page under the one Discover tab. Nothing is created here; everything
// comes from the conversation. What it did lives in the profile's Activity.
import { formatDate, formatDateTime } from './locale.ts'
import { AlertDialog } from 'nsh/base'
import { computed, effect, resource, signal, Text, View } from 'nsh'
import { api, asks, joined, lang, me, running, send, session, showToast, str as baseStr, t } from './state.ts'
import { MAIN_STRINGS } from './i18n.ts'
import { cm } from './i18n-cm.ts'
import { memoryVersion, type MemoryItem } from './profile.tsx'
import { Avatar, Btn, Page } from './ui.tsx'
import { Glyph, muted } from './kit.tsx'
const str = (k: string) => String((MAIN_STRINGS[lang()] as Record<string, unknown>)[k] ?? (baseStr as (k: never) => string)(k as never))
const ms = <K extends keyof typeof MAIN_STRINGS.en>(k: K) => MAIN_STRINGS[lang()][k]

type Goal = { id: string; title: string; plan: string[]; notes: { at: string; text: string }[]; status: 'active' | 'done' | 'paused' }
type Task = { id: string; name: string; instruction: string; when: { kind: string; seconds?: number; time?: string; weekdays?: number[] }; nextRunAt: string | null; active: boolean }
type Idea = { id: string; title: string; body: string; action: string; dismissed?: boolean }
type Item = { key: string; kind: 'goal' | 'wait' | 'reminder'; title: string; line: string; goal?: Goal; task?: Task; memory?: MemoryItem }

const fmt = (iso: string | null) => (iso ? formatDateTime(iso, lang()) : '')
const dayOnly = (iso: string) => formatDate(iso, lang()) || iso
const whenText = (w: Task['when']) => (w.kind === 'every' ? t('every')(w.seconds ?? 0) : w.kind === 'daily' ? t('daily')(w.time ?? '') : w.kind === 'weekly' ? t('weekly')(w.time ?? '', w.weekdays ?? []) : str('once'))
/** Three rows per section, then "Show N more". */
const FOLD = 3

/** A section title: a 17pt semibold word. */
function Heading(props: { text: string; testID?: string; right?: { label: string; onPress: () => void; testID?: string } }) {
  return (
    <View class="flex-row items-center gap-[10px] px-4 pt-5 pb-1" testID={props.testID}>
      <Text class="flex-1 text-foreground text-[17px] leading-[22px] font-semibold">{props.text}</Text>
      {props.right ? <View role="button" testID={props.right.testID} onPress={props.right.onPress} class="min-h-[44px] justify-center active:opacity-50"><Text class="text-muted-foreground text-[15px]">{props.right.label}</Text></View> : null}
    </View>
  )
}

/** One tracked thing: a checkbox (done), the title, one grey line, and ⋮ for the rest. */
function Tracked(props: { item: Item; onCheck?: () => void; onMore: () => void; onPress: () => void }) {
  return (
    <View role="button" testID={`${props.item.kind}-${props.item.key}`} onPress={props.onPress} class="flex-row items-start gap-[11px] px-4 py-[10px] active:bg-black/[0.04] dark:active:bg-white/[0.06]">
      {props.onCheck
        ? <View role="checkbox" accessibilityLabel={props.item.title} testID={`check-${props.item.key}`} onPress={props.onCheck} class="items-center justify-center -mt-[11px] active:opacity-50" style={{ width: 22, height: 44 }}><View class="rounded-[6px] border-[2px] border-muted-foreground" style={{ width: 22, height: 22 }} /></View>
        : <View class="items-center justify-center" style={{ width: 22, height: 22 }}><Glyph name="clock" size={20} color={muted()} /></View>}
      <View class="flex-1 min-w-0 gap-[4px]">
        <Text class="text-foreground text-[17px] leading-[22px]" numberOfLines={2}>{props.item.title}</Text>
        {props.item.line ? <Text class="text-muted-foreground text-[15px] leading-5" numberOfLines={2}>{props.item.line}</Text> : null}
      </View>
      <View role="button" accessibilityLabel={str('more')} testID={`more-${props.item.key}`} onPress={props.onMore} class="items-center justify-center -mr-2 -mt-[11px] active:opacity-50" style={{ width: 36, height: 44 }}><Glyph name="dots" size={20} color={muted()} /></View>
    </View>
  )
}

function ShowMore(props: { n: number; onPress: () => void; testID: string }) {
  return (
    <View role="button" testID={props.testID} onPress={props.onPress} class="flex-row items-center gap-3 px-4 min-h-[40px] active:opacity-60">
            <Text class="text-muted-foreground text-[17px]">{cm('memShowMore')(props.n)}</Text>
    </View>
  )
}

export function DiscoverPage(props: { onOpenThread: () => void }) {
  const goals = resource(() => session(), async (s) => (s ? api().get<Goal[]>('/goals') : []))
  const tasks = resource(() => session(), async (s) => (s ? api().get<Task[]>('/schedules') : []))
  const ideas = resource(() => session(), async (s) => (s ? api().get<Idea[]>('/ideas').catch(() => [] as Idea[]) : []))
  const memory = resource(() => (session() ? `m${memoryVersion()}` : null), async () => api().get<MemoryItem[]>('/memory').catch(() => [] as MemoryItem[]))
  const refreshing = signal(false)
  const open = signal<Set<string>>(new Set())
  const refreshAll = () => { goals.refetch(); tasks.refetch(); ideas.refetch(); memory.refetch() }
  // The tab stays mounted beside the thread: what a turn set or changed (a goal, a reminder, a wait) shows up when the turn ends.
  let wasRunning = false
  effect(() => { const r = running(); if (wasRunning && !r) refreshAll(); wasRunning = r })
  const pending = computed(() => asks())
  const tracked = computed<Item[]>(() => [
    ...(goals() ?? []).filter((g) => g.status !== 'done').map((g) => ({ key: g.id, kind: 'goal' as const, title: g.title, line: g.status === 'paused' ? str('paused') : g.notes.length ? g.notes[g.notes.length - 1].text : (g.plan[0] ?? ''), goal: g })),
    ...(memory() ?? []).filter((m) => m.kind === 'project').map((m) => ({ key: m.id.replace(/[^a-z0-9]/gi, '-'), kind: 'wait' as const, title: m.text, line: cm('memLearned')(dayOnly(m.date)), memory: m })),
  ])
  const upcoming = computed<Item[]>(() => (tasks() ?? []).filter((x) => x.active && x.nextRunAt).sort((a, b) => Date.parse(a.nextRunAt!) - Date.parse(b.nextRunAt!)).map((x) => ({ key: x.id, kind: 'reminder' as const, title: x.name, line: joined(whenText(x.when), `${str('next')} ${fmt(x.nextRunAt)}`), task: x })))
  const live = computed(() => (ideas() ?? []).filter((i) => !i.dismissed).slice(0, 3))
  const empty = computed(() => !goals.loading() && !tasks.loading() && !memory.loading() && pending().length === 0 && tracked().length === 0 && upcoming().length === 0 && live().length === 0)

  const say = async (text: string) => { try { await send(text); props.onOpenThread() } catch { showToast(str('failed')) } }
  const act = async (fn: () => Promise<unknown>, after: () => void) => { try { await fn(); after() } catch { showToast(str('failed')) } }
  const check = (it: Item) => {
    if (it.goal) act(() => api().send('PATCH', `/goals/${it.goal!.id}`, { status: 'done' }), () => { goals.refetch(); showToast(str('done')) })
    else if (it.memory) act(() => api().send('DELETE', `/memory/${encodeURIComponent(it.memory!.id)}`), () => { memoryVersion.set(memoryVersion() + 1); showToast(str('done')) })
  }
  const more = async (it: Item) => {
    const acts = it.kind === 'reminder'
      ? [{ id: 'pause', label: str('pause') }, { id: 'delete', label: str('remove'), role: 'destructive' as const }]
      : it.kind === 'goal'
        ? [{ id: 'ask', label: ms('checkIn') }, { id: it.goal!.status === 'paused' ? 'resume' : 'pause', label: it.goal!.status === 'paused' ? str('resume') : str('pause') }, { id: 'done', label: str('markDone') }, { id: 'delete', label: str('remove'), role: 'destructive' as const }]
        : [{ id: 'ask', label: ms('checkIn') }, { id: 'done', label: str('markDone') }]
    const r = await AlertDialog.show({ title: it.title, presentation: 'actionSheet', actions: [...acts, { id: 'cancel', label: cm('memCancel'), role: 'cancel' as const }] }).catch(() => null)
    if (r === 'ask') say(ms('checkInMsg')(it.title)).catch(() => {})
    else if (r === 'done') check(it)
    else if (r === 'pause' && it.task) act(() => api().send('PATCH', `/schedules/${it.task!.id}`, { active: false }), () => tasks.refetch())
    else if ((r === 'pause' || r === 'resume') && it.goal) act(() => api().send('PATCH', `/goals/${it.goal!.id}`, { status: r === 'pause' ? 'paused' : 'active' }), () => goals.refetch())
    else if (r === 'delete' && it.task) act(() => api().send('DELETE', `/schedules/${it.task!.id}`), () => tasks.refetch())
    else if (r === 'delete' && it.goal) act(() => api().send('DELETE', `/goals/${it.goal!.id}`), () => goals.refetch())
  }
  const idea = async (i: Idea) => {
    const r = await AlertDialog.show({ title: i.title, description: i.body || undefined, presentation: 'actionSheet', actions: [{ id: 'do', label: str('doIt') }, { id: 'no', label: str('notNow') }, { id: 'cancel', label: cm('memCancel'), role: 'cancel' }] }).catch(() => null)
    if (r === 'do') say(i.action).catch(() => {})
    else if (r === 'no') act(() => api().send('POST', `/ideas/${encodeURIComponent(i.id)}/dismiss`), () => ideas.refetch())
  }
  const newIdeas = async () => {
    if (refreshing()) return
    refreshing.set(true)
    try { ideas.mutate(await api().send<Idea[]>('POST', '/ideas/refresh')) } catch { showToast(str('failed')) } finally { refreshing.set(false) }
  }
  const section = (key: string, items: Item[], onCheck: boolean) => {
    const shown = open().has(key) ? items : items.slice(0, FOLD)
    return (
      <View>
        {shown.map((it) => <Tracked item={it} onCheck={onCheck ? () => check(it) : undefined} onMore={() => { more(it).catch(() => {}) }} onPress={() => { more(it).catch(() => {}) }} />)}
        {items.length > shown.length ? <ShowMore n={items.length - shown.length} testID={`show-more-${key}`} onPress={() => open.set(new Set([...open(), key]))} /> : null}
      </View>
    )
  }

  return (
    <Page page="DiscoverPage" class="flex-1 bg-background" contentClass="pb-[calc(env(safe-area-inset-bottom)+32px)]" refreshing={goals.loading()} onRefresh={refreshAll} testID="discover">
      {empty() ? (
        <View class="items-center px-8 pt-10 gap-4">
          <Avatar size={64} />
          <Text class="text-muted-foreground text-[17px] text-center leading-6">{ms('discoverEmpty')(me()?.assistant.name ?? '')}</Text>
          <Btn kind="soft" label={ms('openChat')} onPress={props.onOpenThread} testID="discover-open-chat" />
        </View>
      ) : null}
      {pending().length ? (
        <View>
          <Heading text={str('needsYou')} testID="needs-you" />
          {pending().map((a) => (
            <View role="button" testID={`need-${a.eventId}`} onPress={props.onOpenThread} class="flex-row items-center gap-3 px-4 py-[10px] active:bg-black/[0.04] dark:active:bg-white/[0.06]">
              <View class="items-center justify-center -ml-1" style={{ width: 32, height: 22 }}><Glyph name={a.kind === 'approval' ? 'shield' : 'bell'} size={20} /></View>
              <View class="flex-1 min-w-0 gap-[2px]">
                <Text class="text-foreground text-[17px] leading-[22px] font-medium" numberOfLines={2}>{a.kind === 'approval' ? (a.request.reason || cm('needApproval')) : String(a.request.questions?.[0]?.prompt ?? a.request.questions?.[0]?.question ?? cm('needAnswer'))}</Text>
                <Text class="text-muted-foreground text-[15px] leading-5">{a.kind === 'approval' ? str('askApproval') : str('askQuestion')}</Text>
              </View>
              <Glyph name="chevron" size={18} color={muted()} />
            </View>
          ))}
        </View>
      ) : null}
      {tracked().length ? (
        <View>
          <Heading text={str('tracking')} testID="tracking" />
          {section('tracked', tracked(), true)}
        </View>
      ) : null}
      {upcoming().length ? (
        <View>
          <Heading text={cm('tabUpcoming')} testID="upcoming" />
          {section('upcoming', upcoming(), false)}
        </View>
      ) : null}
      {live().length ? (
        <View>
          <Heading text={str('ideas')} testID="ideas-heading" right={{ label: refreshing() ? str('thinking') : cm('newIdeas'), onPress: () => { newIdeas().catch(() => {}) }, testID: 'ideas-refresh' }} />
          {live().map((i, n) => (
            <View role="button" testID={`idea-${i.id}`} onPress={() => { idea(i).catch(() => {}) }} class="flex-row items-start gap-[13px] px-4 py-[14px] border-border active:bg-black/[0.04] dark:active:bg-white/[0.06]" style={n ? { borderTopWidth: 0.5 } : undefined}>
              <View class="items-center justify-center rounded-[10px] bg-secondary" style={{ width: 40, height: 40 }}><Glyph name="sparkles" size={22} /></View>
              <View class="flex-1 min-w-0 gap-[3px]">
                <Text class="text-foreground text-[17px] leading-[22px] font-semibold" numberOfLines={2}>{i.title}</Text>
                {i.body ? <Text class="text-muted-foreground text-[15px] leading-5" numberOfLines={3}>{i.body}</Text> : null}
              </View>
            </View>
          ))}
        </View>
      ) : null}
    </Page>
  )
}
