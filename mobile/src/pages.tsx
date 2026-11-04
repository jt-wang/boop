// The pages behind the chat: menu (side chats + entries), identity files,
// upcoming, goals, activity, devices, settings, and the two setup screens.
// List pages are inset-grouped (iOS Settings style); setup screens use a
// large title with 16pt margins.
import { routeOf } from './route.ts'
import { APP_VERSION } from './version.ts'
import { LANGS, LANG_NAMES, formatDateTime, formatNumber } from './locale.ts'
import { cleanup, Clipboard, effect, Keyboard, keyboardFrame, resource, signal, Scroll, Storage, Text, View, type YNode } from 'nsh'
import { AlertDialog, Input } from 'nsh/base'
import { api, connection, joined, connect, deviceName, disconnect, follow, hostedBy, isSample, lang, me, sessionId, setAssistantName, setLang, showToast, startSample, str, t, type ThreadSummary } from './state.ts'
import { activityText } from './plain.ts'
import { pair, parseAddress, type Session } from './api.ts'
import { signIn, hostConfig, hostUrl, isHostedOrigin, waitForSandbox } from './hosted.ts'
import { setShowWork, showWork } from './prefs.ts'
import { Image } from 'nsh'
import { Progress } from 'nsh/base'
import mark from '../assets/mark.png'
import { AboutGroup, openLegal } from './compliance.tsx' // [compliance]
import { pairLink } from './native.ts'
import { canScan, isInvite, pairInvite, pocketPath, refreshPath, scanInvite, viaPocket } from './pocket.ts'
import { ago } from './library.tsx'
import { Avatar, Btn, Card, Cell, Empty, Group, Hint, Page, pageClass, Toggle, TopProbe } from './ui.tsx'

const fmt = (iso: string | null) => (iso && formatDateTime(iso, lang())) || '—'
// every kind the bot logs, in words; one it adds later shows no word rather than its id
const kindWord = (k: string) => ({ memory: str('kindMemory'), schedule: str('kindSchedule'), approval: str('kindApproval'), notify: str('kindNotify'), goal: str('kindGoal'), show: str('kindShow'), ui: str('kindUi'), ideas: str('kindIdeas'), connector: str('kindConnector'), name: str('kindName') } as Record<string, string>)[k] ?? ''

const fieldClass = 'min-h-[44px] px-4 text-foreground text-[17px] bg-transparent'
const setupContent = 'px-4 gap-4 pt-[calc(env(safe-area-inset-top)+44px)] pb-[calc(env(safe-area-inset-bottom)+32px)]'

export function ConnectScreen(props: { initial?: { origin?: string; code?: string } }) {
  const address = signal(props.initial?.origin ?? '')
  const code = signal(props.initial?.code ?? '')
  const busy = signal(false)
  const error = signal('')
  let codeInput: YNode | undefined
  // a pairing link opened while this screen shows (the shell's `pair` event) fills it in
  effect(() => { const p = parseAddress(pairLink() ?? ''); if (p && (p.code || isInvite(p.origin))) { address.set(p.origin); code.set(p.code ?? ''); error.set('') } })
  /** The computer's QR, from the camera or pasted: pair, then in (src/pocket.ts). */
  const attempt = async (invite: string | null) => {
    busy.set(true); error.set('')
    try {
      const s = await pairInvite(invite ?? await scanInvite(), deviceName())
      await connect(s, { hostedBy: null })
    } catch (e) {
      const code = (e as { code?: string }).code
      if (code !== 'cancelled') error.set(str(code === 'expired' ? 'pocketExpired' : code === 'invalid-invite' ? 'pocketInvalid' : code === 'denied' ? 'pocketDenied' : code === 'unsupported' ? 'pocketNoCamera' : 'pocketUnreachable'))
    } finally { busy.set(false) }
  }
  const go = async () => {
    if (isInvite(address())) return attempt(address())
    const parsed = parseAddress(address()); if (!parsed) { error.set(str('connectFailed')); return }
    const c = (parsed.code ?? code()).trim(); if (!/^\d{6}$/.test(c)) { error.set(str('codeWrong')); return }
    busy.set(true); error.set('')
    try {
      const r = await pair(parsed.origin, c, deviceName())
      if (!r.ok) { error.set(r.status === 403 ? str('codeWrong') : str('connectFailed')); return }
      await connect({ origin: parsed.origin, token: r.token }, { hostedBy: null })
    } catch { error.set(str('connectFailed')) } finally { busy.set(false) }
  }
  return (
    <Scroll class={`${pageClass} pb-[env(keyboard-inset-height)]`} contentClass={setupContent} keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive">
      <Avatar size={64} label="•" />
      <Text class="text-foreground text-[28px] font-bold leading-[41px]">{str('connectTitle')}</Text>
      <Hint text={str(canScan() ? 'connectBody' : 'connectBodyWeb')} />
      <If when={canScan()}>
        <Btn kind="primary" testID="scan" label={busy() ? str('connecting') : str('scanCode')} disabled={busy()} onPress={() => { attempt(null).catch(() => {}) }} />
        <View class="px-4 mt-3"><Text class="text-muted-foreground text-[13px] leading-[18px]">{str('orAddress')}</Text></View>
      </If>
      <Card class="overflow-hidden mt-2">
        <Input testID="address" placeholder={str('address')} value={address()} onChange={(v) => { address.set(v); error.set('') }} autoCapitalize="none" autoCorrect={false} keyboardType="url" returnKeyType="next" submitBehavior="submit" onSubmit={() => codeInput?.focus()} class={fieldClass} />
        <If when={!isInvite(address())}>
        <View class="ml-4 border-border" style={{ borderTopWidth: 0.5 }}>
          <Input ref={codeInput} testID="code" placeholder={str('code')} value={code()} onChange={(v) => { code.set(v.replace(/\D/g, '')); error.set('') }} keyboardType="number-pad" autoComplete="one-time-code" maxLength={6} returnKeyType="go" submitBehavior="blurAndSubmit" onSubmit={go} class={`${fieldClass} pl-0`} />
        </View>
        </If>
      </Card>
      <View class="px-4 -mt-2">
        <If when={error()} else={<If when={!isInvite(address())}><Text class="text-muted-foreground text-[13px] leading-[18px]">{str('codeHint')}</Text></If>}>
          <Text testID="connect-error" class="text-destructive text-[13px] leading-[18px]">{error()}</Text>
        </If>
      </View>
      <Btn kind={canScan() ? 'soft' : 'primary'} testID="connect" label={busy() ? str('connecting') : str('connect')} disabled={busy()} onPress={go} />
      <View role="button" testID="try-it" onPress={() => { startSample().catch(() => {}) }} class="min-h-[44px] items-center justify-center active:opacity-60"><Text class="text-primary text-[17px]">{str('tryIt')}</Text></View>
      <View role="button" testID="connect-privacy" onPress={() => openLegal('privacy')} class="min-h-[44px] items-center justify-center active:opacity-60"><Text class="text-muted-foreground text-[13px]">{str('privacyPolicy')}</Text></View>
    </Scroll>
  )
}
/** First run. One screen, two ways in: a hosted computer (Start) or your own (address + code). */
export function WelcomeScreen(props: { onStart: () => void; onOwn: () => void }) {
  return (
    <Scroll class={pageClass} contentClass="grow px-6 pt-[calc(env(safe-area-inset-top)+120px)] pb-[calc(env(safe-area-inset-bottom)+28px)]">
      <View class="flex-1 gap-5">
        <Image src={mark} style={{ width: 96, height: 96, }} class="rounded-[22px]" />
        <Text class="text-foreground text-[28px] font-bold leading-[41px] mt-5">{str('welcomeTitle')}</Text>
        <Text class="text-muted-foreground text-[17px] leading-[24px]">{str('welcomeBody')}</Text>
      </View>
      <View class="gap-3 pt-10">
        <Btn kind="primary" testID="start" label={str('start')} onPress={props.onStart} />
        <View role="button" testID="own-computer" onPress={props.onOwn} class="min-h-[44px] items-center justify-center active:opacity-60"><Text class="text-primary text-[17px]">{str('ownComputer')}</Text></View>
      </View>
    </Scroll>
  )
}

export function SignInScreen(props: { hostUrl: string; onSignedIn: (accountToken: string) => void }) {
  const email = signal('')
  const code = signal('')
  const needsCode = signal(false)
  hostConfig(props.hostUrl).then((c) => needsCode.set(c.codeRequired)).catch(() => {})
  const busy = signal(false)
  const error = signal('')
  const go = async () => {
    const e = email().trim(); if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) { error.set(str('signInFailed')); return }
    busy.set(true); error.set('')
    try { props.onSignedIn(await signIn(props.hostUrl, needsCode() ? { email: e, code: code().trim() } : { email: e })) }
    catch (err) { const why = (err as { why?: string }).why; error.set(str(why === 'code' ? 'accessCodeWrong' : why === 'busy' ? 'tooManyTries' : why === 'full' ? 'hostFull' : 'signInFailed')) }
    finally { busy.set(false) }
  }
  return (
    <Scroll class={`${pageClass} pb-[env(keyboard-inset-height)]`} contentClass={setupContent} keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive">
      <Text class="text-foreground text-[28px] font-bold leading-[41px]">{str('signInTitle')}</Text>
      <Hint text={str('signInBody')} />
      <Card class="overflow-hidden mt-2">
        <Input testID="email" placeholder={str('email')} value={email()} onChange={(v) => { email.set(v); error.set('') }} autoCapitalize="none" autoCorrect={false} keyboardType="email-address" autoComplete="email" autoFocus returnKeyType="go" submitBehavior="blurAndSubmit" onSubmit={go} class={fieldClass} />
      </Card>
      <If when={needsCode()}>
        <Card class="overflow-hidden">
          <Input testID="access-code" placeholder={str('accessCode')} value={code()} onChange={(v) => { code.set(v); error.set('') }} autoCapitalize="none" autoCorrect={false} masked autoComplete="one-time-code" returnKeyType="go" onSubmit={go} class="px-4 py-3 text-[17px] text-foreground" />
        </Card>
        <Hint text={str('accessCodeHint')} />
      </If>
      <If when={error()}><View class="px-4 -mt-2"><Text testID="sign-in-error" class="text-destructive text-[13px] leading-[18px]">{error()}</Text></View></If>
      <Btn kind="primary" testID="sign-in" label={str('signIn')} disabled={busy()} onPress={go} />
    </Scroll>
  )
}

/** While the host brings the computer up: one title, one line, a moving bar. */
export function PreparingScreen(props: { hostUrl: string; accountToken: string; onReady: (s: Session) => void; onBack: () => void }) {
  const failed = signal(false)
  const run = async () => {
    failed.set(false)
    try { props.onReady(await waitForSandbox(props.hostUrl, props.accountToken)) } catch { failed.set(true) }
  }
  run().catch(() => {})
  return (
    <Scroll class={pageClass} contentClass="grow px-6 pt-[calc(env(safe-area-inset-top)+120px)] pb-[calc(env(safe-area-inset-bottom)+28px)]">
      <View class="flex-1 gap-5">
        <Avatar size={64} label="…" />
        <Text class="text-foreground text-[28px] font-bold leading-[41px] mt-4">{failed() ? str('preparingFailed') : str('preparingTitle')}</Text>
        <If when={!failed()}>
          <Text class="text-muted-foreground text-[17px] leading-[24px]">{str('preparingBody')}</Text>
          <Progress indeterminate accessibilityLabel={str('preparingTitle')} class="mt-4" trackClass="h-1 rounded-full bg-secondary overflow-hidden" indicatorClass="h-1 w-1/3 rounded-full bg-primary" />
        </If>
      </View>
      <If when={failed()}>
        <View class="gap-2 pt-8">
          <Btn kind="primary" testID="retry" label={str('retry')} onPress={run} />
          <View role="button" testID="preparing-back" onPress={props.onBack} class="min-h-[44px] items-center justify-center active:opacity-60"><Text class="text-primary text-[17px]">{str('ownComputer')}</Text></View>
        </View>
      </If>
    </Scroll>
  )
}


export function NameScreen() {
  // the suggestion is the placeholder: one tap continues with it, typing gives exactly what was typed (a field filled
  // in with "Nori" turned a typed "Nori" into "NoriNori", QA 2026-10-28 #9); changeable in settings
  const name = signal('')
  const chosen = () => name().trim() || str('nameSuggestion')
  const busy = signal(false)
  const error = signal('')
  // The keyboard goes down before the chat takes this screen's place: on Android, the field's keyboard left up
  // while the screen went away stayed over the chat, where nothing could take it down (naming.test.tsx).
  const keyboardDown = async () => { Keyboard.dismiss(); for (let i = 0; i < 20 && keyboardFrame().height > 0; i++) await new Promise((r) => setTimeout(r, 50)) }
  const go = async () => { const n = chosen(); busy.set(true); error.set(''); try { await keyboardDown(); await setAssistantName(n) } catch { error.set(str('failed')) } finally { busy.set(false) } }
  return (
    <Scroll class={`${pageClass} pb-[env(keyboard-inset-height)]`} contentClass={setupContent} keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive">
      <Avatar size={64} label={chosen().slice(0, 1).toUpperCase()} />
      <Text class="text-foreground text-[28px] font-bold leading-[41px]">{str('nameTitle')}</Text>
      <Hint text={str('nameHint')} />
      <Card class="overflow-hidden mt-2">
        <Input testID="name" placeholder={str('nameSuggestion')} value={name()} onChange={(v) => name.set(v)} maxLength={40} autoFocus autoCapitalize="words" returnKeyType="done" submitBehavior="blurAndSubmit" onSubmit={go} class={fieldClass} />
      </Card>
      <If when={error()}><View class="px-4 -mt-2"><Text class="text-destructive text-[13px] leading-[18px]">{error()}</Text></View></If>
      <Btn kind="primary" testID="name-go" label={str('nameGo')} disabled={busy()} onPress={go} />
    </Scroll>
  )
}

/** The ☰ page: the main thread, side chats, and the entries to the other pages. */
export function MenuPage(props: { onPick: () => void; onUpcoming: () => void; onGoals: () => void; onActivity: () => void; onLibrary?: () => void; onInterfaces?: () => void }) {
  // The bot's threads (GET /threads): the harness's own session/list also has every background task and fork
  // the harness runs for a thread, titled with its instruction (QA 2026-10-30).
  const list = resource(() => 0, async () => (await api().get<ThreadSummary[]>('/threads')).filter((s) => s.sessionId !== me()?.mainSessionId && !s.blank).sort((a, b) => b.updatedAt - a.updatedAt))
  const open = async (id: string) => { await follow(id); props.onPick() }
  const create = async () => { try { const v = await api().rpc<{ sessionId: string }>('session/create', { request: {} }); await open(v.sessionId) } catch { showToast(str('failed')) } }
  return (
    <Page page="MenuPage">
      <Group>
        <Cell title={str('mainThread')} subtitle={me()?.assistant.name ?? ''} value={sessionId() === me()?.mainSessionId ? str('current') : undefined} onPress={() => open(me()!.mainSessionId!)} />
      </Group>
      <Group header={str('sideChats')} footer={!list.loading() && (list() ?? []).length === 0 ? str('noSideChats') : undefined}>
        <Each of={list() ?? []} key={(s) => s.sessionId}>
          {(s) => <Cell title={s().title || '…'} subtitle={ago(s().updatedAt)} value={s().running ? str('working') : sessionId() === s().sessionId ? str('current') : undefined} chevron onPress={() => open(s().sessionId)} />}
        </Each>
        <Cell title={str('newSideChat')} tint onPress={create} />
      </Group>
      <Group header={str('more')}>
        {props.onLibrary ? <Cell title={str('library')} chevron onPress={props.onLibrary} /> : null}
        {props.onInterfaces ? <Cell title={str('interfaces')} chevron onPress={props.onInterfaces} testID="interfaces-row" /> : null}
        <Cell title={str('upcoming')} chevron onPress={props.onUpcoming} />
        <Cell title={str('goals')} chevron onPress={props.onGoals} />
        <Cell title={str('activity')} chevron onPress={props.onActivity} />
        {/* menu rows added by other features go here */}
      </Group>
    </Page>
  )
}
/** Kept for callers that only want the side-chat list. */
export function SideChatsPage(props: { onPick: () => void }) { return <MenuPage onPick={props.onPick} onUpcoming={() => {}} onGoals={() => {}} onActivity={() => {}} /> }

export function IdentityPage() {
  const files = [['SOUL.md', 'soul'], ['USER.md', 'user'], ['MEMORY.md', 'memory']] as const
  const current = signal<'SOUL.md' | 'USER.md' | 'MEMORY.md'>('SOUL.md')
  const text = signal('')
  const load = async (f: typeof current extends { (): infer T } ? T : never) => { current.set(f); try { text.set(await api().text(`/files/${f}`)) } catch { showToast(str('failed')) } }
  load('SOUL.md').catch(() => {})
  return (
    <View class={`${pageClass} pb-[env(keyboard-inset-height)]`}>
      <TopProbe page="IdentityPage" />
      <View class="px-4 pt-3 gap-3">
        <View class="flex-row rounded-[9px] bg-secondary p-[2px]">
          {files.map(([f, k]) => <View role="button" onPress={() => load(f)} class={`flex-1 items-center justify-center min-h-[32px] rounded-[7px] ${current() === f ? 'bg-background dark:bg-accent shadow-sm' : ''}`}><Text class={`text-[13px] ${current() === f ? 'text-foreground font-semibold' : 'text-foreground'}`}>{str(k)}</Text></View>)}
        </View>
        <Hint text={str('identityHint')} />
      </View>
      <Card class="flex-1 mx-4 mt-3 overflow-hidden">
        <Input multiline value={text()} onChange={(v) => text.set(v)} autoCorrect={false} autoCapitalize="none" class="flex-1 px-4 py-3 text-foreground text-[17px] leading-6" />
      </Card>
      <View class="px-4 py-3 pb-[calc(env(safe-area-inset-bottom)+12px)]"><Btn kind="primary" label={str('save')} onPress={async () => { try { await api().send('PUT', `/files/${current()}`, text(), true); showToast(str('saved')) } catch { showToast(str('failed')) } }} /></View>
    </View>
  )
}

export function UpcomingPage() {
  type Task = { id: string; name: string; instruction: string; when: { kind: string; at?: string; seconds?: number; time?: string; weekdays?: number[] }; nextRunAt: string | null; active: boolean }
  const list = resource(() => 0, async () => api().get<Task[]>('/schedules'))
  const whenText = (w: Task['when']) => w.kind === 'every' ? t('every')(w.seconds ?? 0) : w.kind === 'daily' ? t('daily')(w.time ?? '') : w.kind === 'weekly' ? t('weekly')(w.time ?? '', w.weekdays ?? []) : str('once')
  const act = async (fn: () => Promise<unknown>) => { try { await fn(); list.refetch() } catch { showToast(str('failed')) } }
  return (
    <Page page="UpcomingPage">
      <If when={!list.loading() && (list() ?? []).length === 0}><Empty text={str('noUpcoming')} /></If>
      <Each of={list() ?? []} key={(x) => x.id}>
        {(task) => (
          <Group>
            <Cell title={task().name} />
            <Cell title={whenText(task().when)} value={task().active ? `${str('next')} ${fmt(task().nextRunAt)}` : str('paused')} />
            <If when={task().when.kind !== 'once' || task().active}><Cell title={task().active ? str('pause') : str('resume')} tint centered onPress={() => act(() => api().send('PATCH', `/schedules/${task().id}`, { active: !task().active }))} /></If>
            <Cell title={str('remove')} destructive centered onPress={() => act(() => api().send('DELETE', `/schedules/${task().id}`))} />
          </Group>
        )}
      </Each>
    </Page>
  )
}

export function GoalsPage() {
  type Goal = { id: string; title: string; plan: string[]; notes: { at: string; text: string }[]; status: 'active' | 'done' | 'paused' }
  const list = resource(() => 0, async () => api().get<Goal[]>('/goals'))
  const act = async (fn: () => Promise<unknown>) => { try { await fn(); list.refetch() } catch { showToast(str('failed')) } }
  return (
    <Page page="GoalsPage">
      <If when={!list.loading() && (list() ?? []).length === 0}><Empty text={str('noGoals')} /></If>
      <Each of={list() ?? []} key={(x) => x.id}>
        {(g) => (
          <Group footer={g().notes.length ? `${str('latest')}: ${g().notes[g().notes.length - 1].text}` : undefined}>
            <Cell title={g().title} value={g().status === 'done' ? str('done') : str('active')} />
            <Each of={g().plan} key="index">{(p, i) => <Cell title={`${i() + 1}. ${p()}`} />}</Each>
            <Cell title={g().status === 'done' ? str('reopen') : str('markDone')} tint centered onPress={() => act(() => api().send('PATCH', `/goals/${g().id}`, { status: g().status === 'done' ? 'active' : 'done' }))} />
            <Cell title={str('remove')} destructive centered onPress={() => act(() => api().send('DELETE', `/goals/${g().id}`))} />
          </Group>
        )}
      </Each>
    </Page>
  )
}

export function ActivityPage() {
  const list = resource(() => 0, async () => api().get<{ id: string; at: string; kind: string; text: string }[]>('/activity'))
  return (
    <Page page="ActivityPage">
      <If when={!list.loading() && (list() ?? []).length === 0}><Empty text={str('noActivity')} /></If>
      <If when={(list() ?? []).length > 0}>
        <Group>
          <Each of={list() ?? []} key={(x) => x.id}>{(a) => <Cell title={activityText(a().text, lang())} subtitle={joined(kindWord(a().kind), fmt(a().at))} />}</Each>
        </Group>
      </If>
    </Page>
  )
}

export function DevicesPage() {
  const list = resource(() => 0, async () => api().get<{ id: string; name: string; createdAt: string; revokedAt: string | null; current: boolean }[]>('/devices'))
  const active = () => (list() ?? []).filter((d) => !d.revokedAt)
  return (
    <Page page="DevicesPage">
      <Group>
        <Each of={active()} key={(d) => d.id}>
          {(d) => <Cell title={d().name} subtitle={fmt(d().createdAt)} value={d().current ? str('thisDevice') : undefined}
            right={d().current ? undefined : <View role="button" class="py-2 pl-2 active:opacity-60" onPress={async () => { try { await api().send('DELETE', `/devices/${d().id}`); showToast(str('revoked')); list.refetch() } catch { showToast(str('failed')) } }}><Text class="text-destructive text-[17px]">{str('revoke')}</Text></View>} />}
        </Each>
      </Group>
    </Page>
  )
}

const Check = () => <Text class="text-primary text-[17px] font-semibold">✓</Text>

/** Settings' first section: which computer, whether it is reached, and which way. */
function ComputerSection(props: { origin: string; hosted: boolean }) {
  const route = () => routeOf(props.origin, props.hosted, viaPocket())
  // the way a tunnel goes can change, and asking is what upgrades it to direct: only while this page shows
  if (viaPocket()) { refreshPath().catch(() => {}); const timer = setInterval(() => { refreshPath().catch(() => {}) }, 15_000); cleanup(() => clearInterval(timer)) }
  // a machine id or a container id means nothing to the person: the words for a hosted computer, the address of their server
  const name = () => {
    const r = route()
    if (r?.via === 'hosted') return str('cloudComputer')
    if (r?.via === 'internet' && r.encrypted) return r.host
    return me()?.computer?.name
  }
  const path = () => {
    const r = route()
    if (!r || connection() !== 'online') return str('pathUnknown')
    if (r.via === 'pocket') { const p = pocketPath(); return p?.kind === 'direct' ? str('pathPocketDirect') : p?.kind === 'relay' ? t('pathPocketRelay')(p.relay ?? '') : str('pathPocket') }
    if (r.via === 'lan') return t('pathLan')(r.host)
    if (r.via === 'cloudflare') return str('pathCloudflare')
    if (r.via === 'hosted') return str('pathHosted')
    return t('pathInternet')(r.host)
  }
  const note = () => {
    const r = route()
    if (!r) return undefined
    if (r.via === 'pocket') return str('notePocket')
    if (!r.encrypted) return str('notePlain')
    return r.via === 'cloudflare' ? str('noteCloudflare') : r.via === 'hosted' ? str('noteHosted') : undefined
  }
  const dot = () => connection() === 'online' ? 'bg-emerald-500' : connection() === 'offline' ? 'bg-destructive' : 'bg-amber-500'
  const state = () => str(connection() === 'online' ? 'stateOnline' : connection() === 'offline' ? 'stateOffline' : 'stateReconnecting')
  return (
    <Group header={str('computer')} footer={note()}>
      {name() ? <Cell title={str('name')} value={name()} testID="computer-name" /> : null}
      <Cell title={str('connectionStatus')} testID="computer-status" right={<View class="flex-row items-center gap-2"><View class={`w-[8px] h-[8px] rounded-full ${dot()}`} /><Text class="text-muted-foreground text-[17px]">{state()}</Text></View>} />
      <View class="pl-4"><View style={{ borderTopWidth: 0.5 }} class="flex-row items-start gap-3 min-h-[44px] pr-4 py-[11px] border-border">
        <Text class="text-foreground text-[17px] leading-[22px]">{str('connectionLabel')}</Text>
        <View class="flex-1 min-w-0 items-end gap-[2px]">
          <Text testID="computer-security" class="text-muted-foreground text-[17px] leading-[22px] text-right">{route() ? str(route()!.via === 'pocket' ? 'connE2e' : route()!.encrypted ? 'connTls' : 'connPlain') : ''}</Text>
          <Text testID="route" class="text-muted-foreground text-[13px] leading-[18px] text-right">{path()}</Text>
        </View>
      </View></View>
      <Cell title={str('appVersion')} value={APP_VERSION} testID="app-version" />
      {me()?.computer?.version ? <Cell title={str('computerVersion')} value={me()!.computer!.version} testID="computer-version" /> : null}
    </Group>
  )
}

export function SettingsPage(props: { onIdentity: () => void; onDevices: () => void; onActivity: () => void; onMemory?: () => void; onConnectors?: () => void; onUsage?: () => void; onAiProvider?: () => void }) {
  const name = signal(me()?.assistant.name ?? '')
  // a rename elsewhere (the chat, another phone) shows here: the field follows the bot's name
  effect(() => { const n = me()?.assistant.name; if (n) name.set(n) })
  const saveName = async () => { const n = name().trim(); if (!n || n === me()?.assistant.name) return; try { await setAssistantName(n); showToast(str('saved')) } catch { showToast(str('failed')) } }
  const origin = () => { try { return me() ? api().s.origin : '' } catch { return '' } }
  const hosted = () => isHostedOrigin(origin(), hostedBy(), hostUrl())
  const unpairBody = () => str(hosted() ? 'unpairBodyHosted' : 'unpairBody')
  const unpair = async () => {
    const choice = await AlertDialog.show({ title: str('unpairTitle'), description: unpairBody(), actions: [{ label: str('cancel'), role: 'cancel', id: 'cancel' }, { label: str('unpair'), role: 'destructive', id: 'unpair' }] })
    if (choice !== 'unpair') return
    try { await api().send('DELETE', `/devices/${me()?.device.id}`) } catch {}
    await disconnect()
  }
  // The morning brief switch: the bot has no GET for it, so the phone keeps its last choice.
  const brief = signal(false)
  Storage.getItem('morningBrief').then((v) => brief.set(v === '1')).catch(() => {})
  const setBrief = async (v: boolean) => { brief.set(v); try { await api().send('PUT', '/settings', { morningBrief: v }); await Storage.setItem('morningBrief', v ? '1' : '0') } catch { brief.set(!v); showToast(str('failed')) } }
  const exportMemory = async () => {
    try { const text = await api().text('/export'); await Clipboard.writeText(text); showToast(t('exported')(Math.max(1, Math.round(text.length / 1024)))) } catch { showToast(str('failed')) }
  }
  return (
    <Page page="SettingsPage" class={`${pageClass} pb-[env(keyboard-inset-height)]`} keyboardShouldPersistTaps="handled">
      <ComputerSection origin={origin()} hosted={hosted()} />
      <If when={isSample()} else={
        <Group footer={unpairBody()}>
          <Cell title={str('unpair')} destructive centered onPress={unpair} testID="unpair" />
        </Group>
      }>
        <Group footer={str('sampleLeaveHint')}>
          <Cell title={str('sampleLeave')} centered onPress={() => { disconnect().catch(() => {}) }} testID="demo-leave" />
        </Group>
      </If>
      <Group header={str('assistant')}>
        <View class="pl-4"><View class="flex-row items-center min-h-[44px] pr-4 gap-3">
          <Text class="text-foreground text-[17px]">{str('name')}</Text>
          <Input testID="assistant-name" value={name()} onChange={(v) => name.set(v)} maxLength={40} returnKeyType="done" onSubmit={saveName} onBlur={saveName} accessibilityLabel={str('assistantName')} class="flex-1 text-right text-muted-foreground text-[17px] min-h-[44px] bg-transparent" />
        </View></View>
      </Group>
      <Group footer={str('styleHint')}>
        <Cell title={str('style')} chevron onPress={() => showToast(str('styleHint'))} onLongPress={props.onIdentity} testID="style" />
      </Group>
      <Group>
        {props.onMemory ? <Cell title={str('memoryTitle')} chevron onPress={props.onMemory} testID="memory-row" /> : <Cell title={str('identity')} chevron onPress={props.onIdentity} />}
        {props.onConnectors ? <Cell title={str('connectors')} chevron onPress={props.onConnectors} /> : null}
        <Cell title={str('devices')} chevron onPress={props.onDevices} />
        <Cell title={str('activity')} chevron onPress={props.onActivity} />
        {props.onUsage ? <Cell title={str('usage')} chevron onPress={props.onUsage} /> : null}
      </Group>
      <Group header={str('notifications')} footer={t('morningBriefHint')(8)}>
        <Cell title={str('morningBrief')} right={<Toggle checked={brief()} onChange={setBrief} label={str('morningBrief')} testID="brief" />} />
      </Group>
      <Group footer={str('showWorkHint')}>
        <Cell title={str('showWork')} right={<Toggle checked={showWork()} onChange={setShowWork} label={str('showWork')} testID="show-work" />} />
      </Group>
      <Group>
        <Cell title={str('exportMemory')} tint onPress={exportMemory} testID="export" />
      </Group>
      <Group header={str('language')}>
        {LANGS.map((l) => <Cell title={LANG_NAMES[l]} right={lang() === l ? <Check /> : undefined} onPress={() => setLang(l)} testID={`lang-${l}`} />)}
      </Group>
      {/* settings groups added by other features go here */}
      <AboutGroup onAiProvider={() => props.onAiProvider?.()} />
    </Page>
  )
}

export function UsagePage() {
  type Usage = { today: { inputTokens: number; cachedTokens: number; outputTokens: number; sessions: number }; sessions: { sessionId: string; title?: string; updatedAt: number; inputTokens: number; cachedTokens: number; outputTokens: number; turns: number }[] }
  const data = resource(() => 0, async () => api().get<Usage>('/usage'))
  const n = (x: number) => formatNumber(x, lang())
  return (
    <Page page="UsagePage">
      <Group header={str('usageToday')} footer={str('usageHint')}>
        <Cell title={str('usageInput')} value={n(data()?.today.inputTokens ?? 0)} />
        <Cell title={str('usageCached')} value={n(data()?.today.cachedTokens ?? 0)} />
        <Cell title={str('usageOutput')} value={n(data()?.today.outputTokens ?? 0)} />
      </Group>
      <If when={(data()?.sessions ?? []).length > 0}>
        <Group header={str('usageThreads')}>
          <Each of={(data()?.sessions ?? []).slice(0, 20)} key={(x) => x.sessionId}>
            {(x) => <Cell title={x().title || str('mainThread')} subtitle={fmt(new Date(x().updatedAt).toISOString())} value={n(x().inputTokens + x().cachedTokens + x().outputTokens)} />}
          </Each>
        </Group>
      </If>
    </Page>
  )
}
