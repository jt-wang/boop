// The main screen: one assistant, one thread, a status line, a composer.
// Rows are cells of a recycled List, so everything in a row reads
// `props.item()` where it is used.
//
// The thread never shows commands, arguments or outputs. A turn's step rows
// fold into one activity block: while it works, the block sits under the last
// row with the current step in words; when the turn ends it becomes a grey
// receipt above the reply. Tap either for the list of steps; commands and
// outputs appear in that list only with "show its work" on (prefs.ts).
//
// Motion and rhythm: rows that arrive after the thread
// opened appear once (opacity + 12pt up, EASE_OUT); a time label sits above
// the first row and wherever 15 minutes pass; the gap between rows depends on
// who spoke before.
import { formatDate, formatTime, labelSeparator, type Lang } from './locale.ts'
import { Clipboard, computed, createMotion, effect, Image, Keyboard, keyboardFrame, List, safeAreaInsets, Scroll, signal, Text, View, type YNode } from 'nsh'
import { Input, TextView } from 'nsh/base'
import { BackHandler } from 'nsh/mobile'
import { connectorOf, serviceName, toolWord, type CardRow, type FileRow, type ModuleRow, type Row } from './fold.ts'
import { FileView, isRemote, LibraryImage, splitImages } from './files.tsx'
import { asks, awaiting, threadLoaded, connection, follow, lang, me, memoryNoted, reflecting, rowKey, rows, running, sessionId, copiedToast, showToast, statusText, str, t, trySend, type Ask, isSample } from './state.ts'
import { showWork } from './prefs.ts'
import { openStop, StopControl } from './stop.tsx'
import { AskCard } from './asks.tsx'
import { CardView, ModulePlayer, ModuleView } from './cards.tsx'
import { replyMenu } from './compliance.tsx' // [compliance]
import { Appear, Avatar, Btn, Card, EASE_OUT, EdgeFade, Glass, Icon, lift, Pulse, TopProbe } from './ui.tsx'
import { BrandMark, Glyph, muted } from './kit.tsx'
import { cm } from './i18n-cm.ts'
import { memoryChanges } from './plain.ts'

type StepRow = Extract<Row, { kind: 'step' }>
/** One turn's steps. `live` while the turn runs (pinned under the last row); a receipt above the reply after. */
type Activity = { id: string; steps: StepRow[]; live: boolean; endAt: number }
type Item = { id: string; row?: Row; activity?: Activity; ack?: boolean }

const LINE = 22            // 17pt body line height
const MAX_LINES = 5
/** A time label appears above a row this long after the previous one (Messages' rule). */
const TIME_GAP = 15 * 60_000
/** Activity blocks whose step list is open, by activity id (kept outside the screen so it survives navigation). */
export const openActivities = signal<Set<string>>(new Set())

/**
 * What kind of thing a tool does, as one emoji. The iOS 26.3 simulator draws them as
 * boxes because its own Apple Color Emoji font fails to load (Apple FB22206123); devices, iOS 17 simulators,
 * Android, macOS and the web draw them in color (measured 2026-10-27). Take screenshots on another runtime.
 */
export function emojiFor(name: string): string {
  const n = name.toLowerCase()
  if (/web_search|web_fetch|browser/.test(n)) return '🔎'
  if (/^(read|write|edit|str_replace_editor|fs_search|grep|glob|present)$/.test(n) || /__(read|write|edit)/.test(n)) return '📝'
  if (/^(bash|pwsh)$/.test(n)) return '🛠️'
  if (/remember|forget/.test(n)) return '🧠'
  if (/schedule/.test(n)) return '⏰'
  if (/goal/.test(n)) return '🎯'
  if (/notify/.test(n)) return '🔔'
  return '✨'
}
/** The reaction under the person's bubble before the work starts. */
export const ACK = '👀'

/** Step rows → activity items: one per turn (a turn starts at a `you` row), placed where the first step was; the running turn's block goes last. */
export function foldActivities(all: Row[], live: boolean): Item[] {
  const out: Item[] = []
  let turn: Activity | null = null
  // the turn ends at its first reply after its last step; what the assistant says later on its own (after a service
  // connected, a reminder) does not stretch the receipt's time
  let answered = false
  let shown = false // anything after its steps (a reply, a card, a file, a notice): a later message starts a new turn
  for (const r of all) {
    // a message sent before the turn answered (mid-task) joins the work it was sent into; it does not end it
    if (r.kind === 'you') { if (shown) turn = null; out.push({ id: r.id, row: r }); continue }
    if (r.kind === 'step') {
      if (!turn) { turn = { id: `act-${r.id}`, steps: [], live: false, endAt: r.at }; out.push({ id: turn.id, activity: turn }) }
      turn.steps.push(r); turn.endAt = Math.max(turn.endAt, r.at); answered = false; shown = false
      continue
    }
    if (turn && !answered) { turn.endAt = Math.max(turn.endAt, r.at); if (r.kind === 'them') answered = true }
    shown = true
    out.push({ id: r.id, row: r })
  }
  if (live && turn) { const i = out.findIndex((x) => x.id === turn!.id); if (i >= 0) out.splice(i, 1); turn.live = true; out.push({ id: turn.id, activity: turn }) }
  return out
}

/** When a row happened, for the time label; cards and acks carry none. */
const atOf = (i: Item | undefined) => i?.row?.at ?? i?.activity?.endAt

/** "Today 9:41 AM" / "Oct 27 9:41 AM" / "Oct 27, 2025 9:41 AM". */
export function timeLabel(at: number, l: Lang, now = Date.now()): string {
  const d = new Date(at), n = new Date(now)
  const time = formatTime(at, l)
  if (d.toDateString() === n.toDateString()) return `${str('today')} ${time}`
  const day = formatDate(at, l, d.getFullYear() !== n.getFullYear())
  return `${day} ${time}`
}

export function ChatScreen(props: { onMenu: () => void; onIdentity: () => void; onMemory?: (focus?: string) => void; onSettings: () => void; onOpenFile?: (path: string) => void; tabbed?: boolean }) {
  const draft = signal('')
  const composerHeight = signal(LINE)
  const refreshing = signal(false)
  const atBottom = signal(true)
  const unseen = signal(0)
  const insets = safeAreaInsets()
  // The chrome floats over the thread: the list fills the
  // screen and pads its content by the measured height of the bars above and below.
  const chromeH = signal(0) // the whole top chrome: the bar and, while it works, the live activity
  // Messages start below all of it: the live activity floated over them and covered the newest text (2026-10-27).
  const chromeBottom = () => Math.max(topH(), chromeH())
  const topH = signal(0)
  const bottomH = signal(0)
  let list: YNode | undefined
  /** The person dragged the thread since it was last at its end. */
  let touched = false
  let contentH = 0
  let grewAt = 0
  let input: YNode | undefined

  // Oldest first; the 👀 ack sits at the very bottom. The list
  // follows its end while the person is there (`maintainVisibleContentPosition`),
  // so a reply streaming into the last row keeps the bottom in view. A running
  // turn's steps are not a row: they are the status pill floating at the top.
  const items = computed<Item[]>(() => {
    // a sent message keeps the key of the bubble drawn at Send after the bot's row replaced it
    const rowItems = foldActivities(rows(), running()).filter((i) => !i.activity?.live).map((i) => (i.row?.kind === 'you' ? { ...i, id: rowKey(i.id) } : i))
    if (awaiting()) rowItems.push({ id: 'ack', ack: true })
    return rowItems
  })
  // Approvals and questions wait for the person: pinned above the composer, outside the list, so scrolling up never
  // hides them. Telegram's reply keyboard and
  // Claude Code's permission prompt sit in the same place.
  const pending = computed<Ask[]>(() => asks().filter((a) => !a.sessionId || a.sessionId === sessionId()))
  const screenH = signal(0)
  const liveActivity = computed(() => foldActivities(rows(), running()).find((i) => i.activity?.live)?.activity ?? null)
  // New rows while scrolled up: count them for the pill.
  let seen = 0
  effect(() => { const n = rows().length; if (n > seen && !atBottom()) unseen.set(unseen() + (n - seen)); seen = n })
  // Rows on screen when the thread opened are old; what arrives after gets one appear motion.
  // Once per row id: the List rebuilds a cell's children while text streams in (seen on the simulator, 2026-10-27:
  // rows caught mid-fade seconds after they arrived), so a row that already appeared draws at rest.
  let baseline: Set<string> | null = null
  const appeared = new Set<string>()
  effect(() => { sessionId(); baseline = null; appeared.clear() })
  effect(() => { const r = rows(); if (baseline === null && r.length) baseline = new Set(r.map((x) => x.id)) })
  const fresh = (raw: string) => { const id = rowKey(raw); if (baseline === null || baseline.has(id) || appeared.has(id)) return false; appeared.add(id); return true }

  const waiting = computed(() => asks().some((a) => !a.sessionId || a.sessionId === sessionId()))
  // a card that waits for the person gets the room the keyboard had (on a small phone it slid under the header)
  let askCount = 0
  effect(() => { const n = asks().filter((a) => !a.sessionId || a.sessionId === sessionId()).length; if (n > askCount) Keyboard.dismiss(); askCount = n })
  const status = computed(() => {
    if (isSample() && !running()) return str('sampleStatus')
    if (waiting()) return str('waitingYou')
    if (running()) return statusText() || str('working')
    if (reflecting()) return str('updatingMemory')
    if (memoryNoted()) return cm('memNoted')(memoryNoted())
    const c = connection()
    return c === 'online' ? str('online') : c === 'reconnecting' ? str('reconnecting') : str('offline')
  })
  const live = computed(() => running() || waiting())
  const dot = computed<'online' | 'busy' | 'off'>(() => (running() ? 'busy' : connection() === 'online' ? 'online' : 'off'))
  const canSend = computed(() => Boolean(draft().trim()))
  // The send key pops in when there is something to send.
  const sendPop = createMotion()
  effect(() => { if (canSend()) sendPop.play('popIn', { duration: 220, easing: EASE_OUT }) })

  const submit = async () => {
    const text = draft(); if (!text.trim()) return
    draft.set(''); composerHeight.set(LINE)
    toBottom() // the person's own message: back to the end, wherever they had scrolled
    if (!(await trySend(text))) draft.set(text)
  }
  // Android's back button closes an open step list first; before, it left the app (Android pass, 2026-11-02)
  BackHandler.onBackPress(() => { if (!openActivities().size) return false; openActivities.set(new Set()); return true })
  const toggleActivity = (id: string) => { openActivities.update((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n }); if (atBottom()) setTimeout(() => list?.scrollToEnd({ animated: true }), 60) }
  const copy = async (text: string) => { try { await Clipboard.writeText(text); copiedToast(str('copied')) } catch {} }
  const refresh = async () => { const id = sessionId(); if (!id) return; refreshing.set(true); try { await follow(id) } catch {} finally { refreshing.set(false) } }
  const toBottom = () => { list?.scrollToEnd({ animated: true }); atBottom.set(true); unseen.set(0) }
  const bottomPad = () => 8 + (keyboardFrame().height > 0 || props.tabbed ? 0 : insets().bottom)
  // The keyboard coming up, or a new row (a card measures taller than its estimate), keeps the end in view while the person is there.
  effect(() => { if (keyboardFrame().height > 0 && atBottom()) setTimeout(() => list?.scrollToEnd({ animated: true }), 80) })
  effect(() => { const n = rows().length; if (n && atBottom()) setTimeout(() => { if (atBottom()) list?.scrollToEnd({ animated: true }) }, 150) })
  // a card pinned above the composer makes the room under the list taller: the last message stays above it
  effect(() => { pending().length; bottomH(); if (atBottom()) setTimeout(() => { if (atBottom()) list?.scrollToEnd({ animated: true }) }, 150) })
  return (
    <View class="flex-1 bg-background pb-[env(keyboard-inset-height)]" onLayout={(b) => screenH.set(b.size.height)}>
      <List ref={list} each={items()} keyExtractor={(i) => i.id} estimatedItemSize={64} maintainVisibleContentPosition={{ autoscrollToBottomThreshold: bottomH() + 60 }}  /* the end of the content sits under the floating composer: anywhere inside that padding is "at the bottom" */ style={{ flex: 1, marginBottom: -bottomH() }}
        contentStyle={{ paddingHorizontal: 16, paddingTop: chromeBottom() + 8, paddingBottom: bottomH() + 40 }}  /* 40: a markdown row that ends with a list measures one line short (NSH 0.3.0, 2026-10-27); the padding keeps that line visible. The gap between rows is each row's own (ItemView). */
        keyboardDismissMode="interactive" keyboardShouldPersistTaps="handled" scrollEventThrottle={50} testID="thread"
        refreshing={refreshing()} onRefresh={refresh}
        onScroll={(e) => {
          const near = e.offset.y + e.size.height >= e.contentSize.height - (bottomH() + 40)
          // Only the person's own scrolling takes the thread off its end. The app opens on the rows it kept and the
          // computer's copy then replaces them: the list stayed where the old rows had put it, rows above the end
          // (Android, a sandbox just woken, 3 of 3 starts, 2026-11-02).
          // Within a second of the content changing (and the scrolls to the end it starts, animated ones report the
          // way there), a position off the end is not the person's unless they dragged.
          if (e.contentSize.height !== contentH) { contentH = e.contentSize.height; grewAt = Date.now() }
          if (!near && atBottom() && !touched && Date.now() - grewAt < 1000) { setTimeout(() => { if (atBottom() && !touched) list?.scrollToEnd({ animated: false }) }, 50); return }
          if (near) touched = false
          if (near !== atBottom()) { atBottom.set(near); if (near) unseen.set(0) }
        }}
        onScrollDragStart={() => { touched = true }}
        header={<TopProbe page="ChatThread" headerBottom={chromeBottom} />}>
        {(item, index) => <ItemView item={item} prev={() => items()[index() - 1]} index={() => items().length - 1 - index()} fresh={fresh} open={openActivities} toggle={toggleActivity} copy={copy} onMemory={props.onMemory} onOpenFile={props.onOpenFile} />}
      </List>
      {/* The empty thread sits between the header and the composer and starts at the top, as a page does. Inside the
          list it followed the list's end and, on a short screen or with the keyboard up, slid under the header. */}
      {/* only once the bot said the thread is empty: before that it may have history this phone has not seen yet; and not
          while it writes its first message: the status line says it is working */}
      <If when={items().length === 0 && threadLoaded() && !running()}>
        <Scroll testID="empty-thread" style={{ position: 'absolute', top: topH(), left: 0, right: 0, bottom: bottomH() + keyboardFrame().height }} contentClass="px-4 pt-2 pb-4" keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive">
          <TopProbe page="ChatScreen" headerBottom={topH} />
          <EmptyThread onStarter={(text) => { draft.set(text); input?.focus() }} onSayHi={() => input?.focus()} />
        </Scroll>
      </If>

      {/* Top chrome: a scroll-edge fade, then three glass pieces (menu, identity, settings) and, while it works, the status pill. */}
      <EdgeFade edge="top" height={chromeBottom() + 24} />
      <View pointerEvents="box-none" onLayout={(b) => chromeH.set(b.size.height)} style={{ position: 'absolute', top: 0, left: 0, right: 0 }}>
        {/* the bar alone (topH) places the empty thread; the bar with the live activity (chromeH) is where messages start */}
        <View pointerEvents="box-none" onLayout={(b) => topH.set(b.size.height)} class="pb-2">
          <View class="flex-row items-center gap-2 px-3" style={{ paddingTop: insets().top + 6 }}>
            <Glass role="button" accessibilityLabel={str('menu')} onPress={props.onMenu} class="w-11 h-11 rounded-full items-center justify-center active:opacity-60"><Icon name="menu" /></Glass>
            <Glass role="button" onPress={props.onIdentity} onLongPress={openStop} testID="status" class="flex-1 min-w-0 h-11 rounded-full flex-row items-center gap-[10px] pl-[5px] pr-4 active:opacity-70">
              <Avatar size={34} dot={dot()} />
              <View class="flex-1 min-w-0">
                <Text class="text-foreground font-semibold text-[15px] leading-[18px]" numberOfLines={1}>{me()?.assistant.name ?? ''}</Text>
                <Text class={`text-[13px] leading-[14px] ${live() ? 'text-primary' : 'text-muted-foreground'}`} numberOfLines={1}>{status()}</Text>
              </View>
            </Glass>
            <StopControl />
            <Glass role="button" accessibilityLabel={str('settings')} onPress={props.onSettings} class="w-11 h-11 rounded-full items-center justify-center active:opacity-60"><Icon name="gear" /></Glass>
          </View>
        </View>
        <Each of={liveActivity() ? [liveActivity()!] : []} key={(a) => a.id}>
          {(a) => <View class="items-center px-4"><StatusPill activity={a} open={() => openActivities().has(a().id)} toggle={() => toggleActivity(a().id)} /></View>}
        </Each>
      </View>

      {/* Bottom chrome: the "new messages" pill, a scroll-edge fade, and the composer. */}
      <If when={!atBottom() && unseen() > 0}>
        <View class="absolute left-0 right-0 items-center" style={{ bottom: bottomH() + 8 }}>
          <View role="button" testID="new-messages" onPress={toBottom} class="rounded-full bg-primary px-4 py-[8px] active:opacity-80" style={{ boxShadow: '0 4px 12px rgba(0,0,0,0.18)' }}>
            <Text class="text-primary-foreground text-[15px] font-semibold">{str('newMessages')}</Text>
          </View>
        </View>
      </If>
      <EdgeFade edge="bottom" height={bottomH() + 16} />
      <ModulePlayer />
      {/* In flow, over the list's bottom edge (the list carries a negative margin of this height): taps land here, the content still scrolls under. */}
      <View onLayout={(b) => bottomH.set(b.size.height)} class="px-3 pt-2" style={{ paddingBottom: bottomPad() }}>
        <If when={pending().length > 0}>
          {/* at most half the screen; taller (several cards, a long question) scrolls inside */}
          <Scroll testID="pinned-asks" style={{ maxHeight: Math.max(240, screenH() * 0.5), flexGrow: 0 }} contentClass="gap-2 pb-2" keyboardShouldPersistTaps="handled">
            <Each of={pending()} key={(a) => a.eventId}>{(a) => <Appear when={fresh(`ask-${a().eventId}`)}><AskCard ask={a()} /></Appear>}</Each>
          </Scroll>
        </If>
        <Glass class="flex-row items-end rounded-[22px] px-[5px]" style={{ minHeight: 44 }}>
          {/* no + until attachments work: a button that only says "coming soon" does nothing */}
          <Input ref={input} placeholder={str('compose')} accessibilityLabel={str('compose')} value={draft()} onChange={(v) => draft.set(v)} multiline submitBehavior="submit" returnKeyType="send" onSubmit={submit} testID="composer"
            onContentSizeChange={(e) => composerHeight.set(Math.min(Math.max(e.height, LINE), LINE * MAX_LINES))}
            style={{ height: composerHeight() + 20 }}
            class="flex-1 bg-transparent pl-[12px] pr-[10px] py-[10px] text-foreground text-[17px] leading-[22px]" />
          <View role="button" accessibilityLabel={str('send')} onPress={submit} testID="send" class={`w-[34px] h-[34px] mb-[5px] rounded-full items-center justify-center ${canSend() ? 'bg-primary' : 'bg-black/[0.06] dark:bg-white/[0.10]'}`} style={[{ transitionProperty: 'background-color', transitionDuration: 150 }, sendPop.style]}>
            <Text class={`text-[17px] font-bold ${canSend() ? 'text-primary-foreground' : 'text-muted-foreground'}`}>↑</Text>
          </View>
        </Glass>
      </View>
    </View>
  )
}

/** The first run: the avatar and its name, one line, three things to ask. */
function EmptyThread(props: { onStarter: (text: string) => void; onSayHi: () => void }) {
  return (
    <View class="items-center px-2 pt-6 gap-3">
      <Avatar size={72} />
      <Text class="text-foreground text-[17px] font-semibold leading-7">{me()?.assistant.name ?? ''}</Text>
      <View class="px-4"><Text class="text-muted-foreground text-[15px] text-center leading-5">{t('emptyThread')(me()?.assistant.name ?? '')}</Text></View>
      <View class="w-full gap-2 pt-3">
        {t('starters').map((s, i) => (
          <Appear>
            <Card testID={`starter-${i}`} onPress={() => props.onStarter(s)} class="flex-row items-center px-4 min-h-[52px] py-3">
              <Text class="flex-1 text-foreground text-[15px] leading-5" numberOfLines={2}>{s}</Text>
            </Card>
          </Appear>
        ))}
      </View>
      <Btn kind="quiet" label={str('sayHi')} onPress={props.onSayHi} />
    </View>
  )
}

/** One cell. Everything reads `props.item()` where it is used, because the cell is reused for other rows. */
function ItemView(props: { item: () => Item; prev: () => Item | undefined; index: () => number; fresh: (id: string) => boolean; open: () => Set<string>; toggle: (id: string) => void; copy: (text: string) => void; onMemory?: (focus?: string) => void; onOpenFile?: (path: string) => void }) {
  const row = () => props.item().row
  const text = () => (row() as { text?: string } | undefined)?.text ?? ''
  const kindOf = (i: Item | undefined) => (!i ? '' : i.activity ? 'activity' : i.ack ? 'ack' : i.row?.kind ?? '')
  const kind = () => kindOf(props.item())
  // keyed on the row id, so a reused cell mounts a fresh card (its drafts) for another row, and the same row's `answer` updates in place
  const cardOf = () => { const r = row(); return r?.kind === 'card' ? [r as CardRow] : [] }
  const moduleOf = () => { const r = row(); return r?.kind === 'module' ? [r as ModuleRow] : [] } // [agent:genui]
  const fileOf = () => { const r = row(); return r?.kind === 'file' ? [r as FileRow] : [] }
  const activityOf = () => { const a = props.item().activity; return a ? [a] : [] }
  // keyed too, so a row that arrives later gets its own appear; their text is read through `row()`, because a delta changes the row in place
  const youOf = () => { const r = row(); return r?.kind === 'you' ? [r] : [] }
  const themOf = () => { const r = row(); return r?.kind === 'them' ? [r as Extract<Row, { kind: 'them' }>] : [] }
  const streaming = () => Boolean((row() as Extract<Row, { kind: 'them' }> | undefined)?.streaming)
  // a reply's words, and its images of the computer's files drawn under them; one the thread already shows as a presented file is left out
  const words = () => splitImages(text(), rows().filter((x): x is FileRow => x.kind === 'file').map((x) => x.path))
  // The time label: above the first row, and whenever 15 minutes passed since the row before.
  const divider = () => { const a = atOf(props.item()); if (a === undefined) return false; const p = atOf(props.prev()); return p === undefined || a - p >= TIME_GAP }
  // Rhythm: 16 between speakers, 8 inside a run of the assistant's rows, 10 around a grey line; the ack keeps its overlap on the bubble.
  const gap = () => {
    const p = kindOf(props.prev()), k = kind()
    if (!p) return 0
    if (k === 'ack') return 14
    if (k === 'notice' || p === 'notice') return 10
    if (k === p && k === 'them') return 8
    if ((p === 'them' || p === 'activity' || p === 'card' || p === 'file') && (k === 'them' || k === 'activity' || k === 'card' || k === 'file')) return 8
    return 16
  }
  return (
    <View style={{ marginTop: gap() }}>
      <If when={divider()}><Text testID="time-divider" class="self-center text-muted-foreground text-[13px] leading-4 font-medium pt-[6px] pb-[12px]">{timeLabel(atOf(props.item())!, lang())}</Text></If>
      <Each of={cardOf()} key={(r) => r.id}>{(r) => <Appear when={props.fresh(r().id)}><CardView row={r} /></Appear>}</Each>
      <Each of={moduleOf()} key={(r) => r.id}>{(r) => <Appear when={props.fresh(r().id)}><ModuleView row={r} /></Appear>}</Each>
      <Each of={fileOf()} key={(r) => r.id}>{(r) => <Appear when={props.fresh(r().id)}><FileView row={r} onOpen={props.onOpenFile} /></Appear>}</Each>
      <Each of={activityOf()} key={(a) => a.id}>{(a) => <Appear when={props.fresh(a().id)}><ActivityView activity={a} open={() => props.open().has(a().id)} toggle={() => props.toggle(a().id)} onMemory={props.onMemory} /></Appear>}</Each>
      <If when={kind() === 'ack'}><Ack /></If>
      <Each of={youOf()} key={(r) => r.id}>
        {(r) => (
          <Appear when={props.fresh(r().id)} class="items-end">
            <View class="max-w-[82%] bg-secondary rounded-[20px] px-4 py-[9px]" testID={`msg-${props.index()}`}>
              <Text class="text-foreground text-[17px] leading-[22px]" selectable>{text()}</Text>
            </View>
          </Appear>
        )}
      </Each>
      <Each of={themOf()} key={(r) => r.id}>
        {(r) => (
          // stretched, not shrink-wrapped: a markdown list's items are flex rows, and in a box sized by its content they
          // collapse to one word per line (rows that arrive live) or draw nothing (rows from a snapshot); simulator, 2026-10-27
          <Appear when={props.fresh(r().id)}>
            // [compliance] long-press: Copy or Report (ChatGPT reports from the message itself); a reply the content filter hid says so
            <View class="self-stretch max-w-[94%] active:opacity-70" testID={`msg-${props.index()}`} onLongPress={() => { replyMenu({ id: r().id, text: text() }, sessionId()).catch(() => {}) }} delayLongPress={400}>
              <If when={!r().filtered} else={<Text testID={`filtered-${r().id}`} class="text-muted-foreground text-[15px] leading-[22px]">{str('filtered')}</Text>}>
              <TextView markdown={words().text} options={{ streaming: streaming() }} links="open"
                // an image from the web stays in the words; the computer's files are drawn under them (splitImages)
                renderImage={(img) => (isRemote(img.src) ? <Image src={img.src} resizeMode="contain" style={{ width: '100%', aspectRatio: 1.6 }} /> : <LibraryImage path={img.src} alt={img.alt} onPress={() => props.onOpenFile?.(img.src)} />)}
                streamingCaret={streaming() ? <View class="ml-0.5 h-4 w-[2px] rounded-sm bg-primary" /> : undefined}
                classes={{ root: 'text-foreground text-[17px] leading-6', code: 'font-mono text-[15px]', codeBlock: 'font-mono text-[13px] bg-card rounded-[12px]' }} />
              <Each of={words().images} key={(im) => im.path}>
                {(im) => <View class="mt-2"><LibraryImage path={im().path} alt={im().alt || undefined} testID={`md-image-${r().id}-${words().images.findIndex((x) => x.path === im().path)}`} onPress={() => props.onOpenFile?.(im().path)} /></View>}
              </Each>
              </If>
            </View>
          </Appear>
        )}
      </Each>
      <If when={kind() === 'notice'}>
        <View class="self-center px-6"><Text class="text-muted-foreground text-[13px] text-center leading-[18px]">{text()}</Text></View>
      </If>
    </View>
  )
}

/** The 👀 reaction on the person's bubble: a small chip on the bubble's corner that fades in and out. */
function Ack() {
  const m = createMotion({ enter: 'fadeIn', duration: 180 })
  return (
    <View style={[{ boxShadow: lift() }, m.style]} class="self-end -mt-[22px] mr-2 rounded-full bg-background dark:bg-card border-black/5 dark:border-white/10 px-[8px] py-[2px]">
      <Text class="text-muted-foreground text-[13px] leading-[18px]" testID="ack">{ACK}</Text>
    </View>
  )
}

const phraseOf = (s: StepRow, l: Lang) => s.description || toolWord(s.name, l)
/** One line per thing done, as the person reads it: the same words twice in a row are one line (the later step, so a
 *  running one still shows running). Android pass 2026-11-02: 「查波拉美术馆门票价」 twice in a row. */
const onePerPhrase = (steps: StepRow[], l: Lang) => steps.filter((s, i) => i === steps.length - 1 || phraseOf(steps[i + 1], l) !== phraseOf(s, l))
const isDone = (s: StepRow) => s.output !== undefined

/**
 * The status pill: while a turn runs it floats under the header with
 * the current step in words and a breathing dot; tap for the list of steps,
 * ✓ on the finished ones. Commands and outputs only with showWork.
 * It fades in, and the phrase crossfades when the step changes.
 */
function StatusPill(props: { activity: () => Activity; open: () => boolean; toggle: () => void }) {
  const steps = () => props.activity().steps
  const current = () => steps().find((s) => !isDone(s)) ?? steps()[steps().length - 1]
  const enter = createMotion({ enter: { keyframes: { opacity: [0, 1] }, duration: 200, easing: EASE_OUT } })
  const swap = createMotion()
  let shown = ''
  effect(() => { const id = current().id; if (shown && id !== shown) swap.play({ keyframes: { opacity: [0, 1] }, duration: 200, easing: EASE_OUT }); shown = id })
  return (
    <View style={enter.style} class={props.open() ? 'w-full' : 'max-w-full'}>
      {/* solid, not glass: through a translucent panel the messages scrolled under it read as text drawn over text
          (Android has no backdrop blur; the owner's APK, 2026-10-27) */}
      <View role="button" testID="activity-live" onPress={props.toggle} class={`bg-background dark:bg-card border-black/[0.08] dark:border-white/[0.12] ${props.open() ? 'w-full rounded-[20px] px-4 py-3 gap-2' : 'rounded-full px-4 py-[9px]'} active:opacity-70`} style={{ borderWidth: 0.5 }}>
        {/* open, the list names every step, the current one too; the closed line on top of it said that step twice */}
        <If when={props.open()} else={
          <View class="flex-row items-center gap-2" style={swap.style}>
            <Text class="text-foreground text-[15px] leading-5">{emojiFor(current().name)}</Text>
            <Text class="text-foreground text-[15px] leading-5" style={{ flexShrink: 1 }} numberOfLines={1}>{phraseOf(current(), lang())}</Text>
            <Pulse />
          </View>
        }><StepList steps={steps} /></If>
      </View>
    </View>
  )
}

/**
 * The steps of one turn, in words, as an activity list: a glyph in a muted circle, the phrase,
 * and at the right a ✓ when done or the breathing dot on the one running.
 */
function StepList(props: { steps: () => StepRow[] }) {
  return (
    <View>
      {onePerPhrase(props.steps(), lang()).map((s, i) => (
        <View class="gap-1 border-black/[0.06] dark:border-white/[0.08]" style={i > 0 ? { borderTopWidth: 0.5 } : undefined}>
          <View class="flex-row items-center gap-3 min-h-[40px] py-[6px]" testID={`step-${s.id}-${isDone(s) ? 'done' : 'doing'}`}>
            <View class="w-7 h-7 rounded-full bg-primary/[0.08] dark:bg-primary/[0.14] items-center justify-center"><Text class="text-foreground text-[13px] leading-4">{emojiFor(s.name)}</Text></View>
            <Text class={`flex-1 text-[15px] leading-5 ${isDone(s) ? 'text-muted-foreground' : 'text-foreground'}`} numberOfLines={3}>{phraseOf(s, lang())}</Text>
            {isDone(s) ? <Text class="text-muted-foreground text-[13px] font-semibold">✓</Text> : <Pulse />}
          </View>
          <If when={showWork() && (s.command || s.output)}>
            <View class="bg-black/[0.05] dark:bg-white/[0.07] rounded-[12px] px-3 py-2 mb-2 gap-1">
              {s.command ? <Text class="font-mono text-[13px] leading-[18px] text-foreground" numberOfLines={4} selectable>{s.command}</Text> : null}
              {s.output ? <Text class="font-mono text-[13px] leading-4 text-muted-foreground" numberOfLines={30} selectable>{s.output}</Text> : null}
            </View>
          </If>
        </View>
      ))}
    </View>
  )
}

/** A finished turn's receipt in the thread ("Did 3 things · 40 s"); tap for the steps. */
function ActivityView(props: { activity: () => Activity; open: () => boolean; toggle: () => void; onMemory?: (focus?: string) => void }) {
  const steps = () => props.activity().steps
  const changes = () => memoryChanges(steps())
  /** The services this turn used, in order, with how many times. */
  const services = () => { const m = new Map<string, number>(); for (const st of steps()) { const c = connectorOf(st.name); if (c) m.set(c, (m.get(c) ?? 0) + 1) } return [...m.entries()] }
  const seconds = () => { const a = props.activity(); const first = a.steps[0]?.at ?? a.endAt; return Math.max(0, Math.round((a.endAt - first) / 1000)) }
  return (
    // open, the step list takes the full width: its rows are flex rows with a flex-1 phrase, which in a shrink-wrapped
    // (self-start) box collapse to one word per line and outgrow the cell's measured height (simulator, 2026-10-27)
    <View class={props.open() || services().length ? 'self-stretch' : 'self-start max-w-[94%]'}>
      <View role="button" testID={`activity-${props.activity().id}`} onPress={props.toggle} class="py-[2px] active:opacity-60">
        <Text class="text-muted-foreground text-[13px] leading-[18px]">{t('didThings')(onePerPhrase(steps(), lang()).length, seconds())}</Text>
      </View>
      <If when={props.open()}><View class="mt-1"><StepList steps={steps} /></View></If>
      {services().map(([id, n]) => (
        <View testID={`svc-card-${id}`} class="flex-row items-center gap-3 mt-2 rounded-[26px] bg-secondary px-4 self-stretch" style={{ minHeight: 72 }}>
          <View class="bg-background dark:bg-card rounded-[10px] items-center justify-center" style={{ width: 40, height: 40 }}><BrandMark id={id} name={serviceName(id)} size={22} /></View>
          <View class="flex-1 min-w-0">
            <Text class="text-foreground text-[17px] leading-5 font-semibold" numberOfLines={1}>{serviceName(id)}</Text>
            <Text class="text-muted-foreground text-[13px] leading-[18px]" numberOfLines={1}>{cm('svcUsed')(n)}</Text>
          </View>
        </View>
      ))}
      {/* What this turn remembered or forgot, one line each: tap opens it in the profile's Memory. */}
      {/* several in one turn: one line that says how many (ChatGPT says "Memory updated" once) */}
      {changes().length > 1 ? (
        <View role="button" testID="mem-note-many" onPress={() => props.onMemory?.()} class="flex-row items-center gap-[6px] py-[3px] active:opacity-60">
          <Glyph name="brain" size={14} color={muted()} />
          <Text class="text-muted-foreground text-[13px] leading-[18px]" style={{ flexShrink: 1 }} numberOfLines={1}>{changes().every((c) => c.kind === 'remembered') ? cm('memNoted')(changes().length) : cm('memChanged')(changes().length)}</Text>
        </View>
      ) : null}
      {(changes().length === 1 ? changes() : []).map((c) => (
        <View role="button" testID={`mem-note-${c.kind}`} onPress={() => props.onMemory?.(c.kind === 'remembered' ? c.text : undefined)} class="flex-row items-center gap-[6px] py-[3px] active:opacity-60">
          <Glyph name="brain" size={14} color={muted()} />
          <Text class="text-muted-foreground text-[13px] leading-[18px]" style={{ flexShrink: 1 }} numberOfLines={2}>{`${c.kind === 'remembered' ? cm('memRemembered') : cm('memForgot')}${labelSeparator(lang())}${c.text}`}</Text>
        </View>
      ))}
    </View>
  )
}
