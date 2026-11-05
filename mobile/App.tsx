// DeepSeek Bot — the phone app. One assistant, one thread. Two tabs: the
// thread, and Discover.
import { effect, Keyboard, keyboardFrame, mount, platform, safeAreaInsets, signal, Text, View, host } from 'nsh'
import { createNavStack, NavPage, NavStack } from 'nsh/base'
import { boot, connect, me, session, str, toast } from './src/state.ts'
import { ChatScreen } from './src/chat.tsx'
import { ActivityPage, ConnectScreen, DevicesPage, GoalsPage, IdentityPage, MenuPage, NameScreen, PreparingScreen, SettingsPage, SignInScreen, UpcomingPage, UsagePage, WelcomeScreen } from './src/pages.tsx'
import { hostUrl, setHostUrl } from './src/hosted.ts'
import { Glass, Icon, largeTitles, systemHeaderClass, systemTabBarStyle, tabIcons, underBarClass } from './src/ui.tsx'
import { muted } from './src/kit.tsx'
import { isAvailable as mobileHost, TabBar } from 'nsh/mobile'
import { DiscoverPage } from './src/discover.tsx'
import { fileName, LibraryFilePage, LibraryPage } from './src/library.tsx'
import { IdeasPage } from './src/ideas.tsx'
import { ConnectorAddPage, ConnectorPage, ConnectorsPage } from './src/connectors.tsx'
import { MemoryEditPage, type MemoryItem } from './src/memory.tsx'
import { ProfilePage, type ProfileTab } from './src/profile.tsx'
import { parseAddress } from './src/api.ts'
import { AdultsOnlyScreen, AgeScreen, AiProviderPage, ConsentScreen, InterfacePage, InterfacesPage, ReportPage, interfaceFromLink, pendingInterface, pendingReport, type ReportTarget } from './src/compliance.tsx' // [compliance]
import { openInterface } from './src/cards.tsx'
import { notificationTarget, notificationUrl, openLink, pairLink } from './src/native.ts'
import { needsAge, needsConsent, openThread, showToast, underAge } from './src/state.ts'

type Route =
  | { name: 'chat' } | { name: 'menu' } | { name: 'identity' } | { name: 'upcoming' } | { name: 'goals' } | { name: 'activity' } | { name: 'devices' } | { name: 'settings' }
  | { name: 'library' } | { name: 'file'; path: string } | { name: 'ideas' } | { name: 'connectors' } | { name: 'connector-add' } | { name: 'memory' } | { name: 'usage' }
  | { name: 'discover' }
  | { name: 'profile'; tab?: ProfileTab; focus?: string } | { name: 'memory-edit'; item: MemoryItem } | { name: 'connector'; id: string }
  | { name: 'report'; target: ReportTarget } | { name: 'interfaces' } | { name: 'interface'; id: string } | { name: 'ai-provider' } // [compliance]
// routes added by other features go here (extend `Route` and `page()` below)

type Tab = 'chat' | 'discover'
const TAB_BAR = 49

function App() {
  const nav = createNavStack<Route>([{ name: 'chat' }])
  const discoverNav = createNavStack<Route>([{ name: 'discover' }])
  const tab = signal<Tab>('chat')
  const insets = safeAreaInsets()
  // First run: welcome → Start (a hosted computer: sign in, wait) or own computer (address + code).
  type Setup = { step: 'welcome' } | { step: 'connect' } | { step: 'sign-in' } | { step: 'preparing'; account: string }
  // A native host (the iOS/Android shell) may hand over a pairing link: straight to the connect screen.
  let initial: { origin?: string; code?: string } | undefined
  try { const p = (host.params as { pairUrl?: string } | undefined)?.pairUrl; if (p) { const parsed = parseAddress(p); if (parsed) initial = parsed } } catch {}
  const setup = signal<Setup>({ step: initial ? 'connect' : 'welcome' })
  const hosted = signal(hostUrl())
  // In the browser the page answers `launch.params` (mobile/web/host.js): a pairing link and the page's host.
  if (platform.os === 'web') host.call<{ pairUrl?: string; hostUrl?: string; notificationUrl?: string }>('launch.params').then((p) => {
    setHostUrl(p?.hostUrl); hosted.set(hostUrl())
    if (p?.notificationUrl) notificationUrl.set(p.notificationUrl) // [push] a tap that opened this window (web/sw.js)
    if (p?.pairUrl) { const parsed = parseAddress(p.pairUrl); if (parsed) { initial = parsed; setup.set({ step: 'connect' }) } }
  }).catch(() => {})
  const step = () => setup().step
  // a pairing link opened while the app runs (the shell's `pair` event): the connect screen, filled in (pages.tsx)
  effect(() => { const p = parseAddress(pairLink() ?? ''); if (!p) return; initial = p; if (step() !== 'connect') setup.set({ step: 'connect' }) })
  const SetupFlow = () => (
    <If when={step() === 'connect'} else={
      <If when={step() === 'sign-in'} else={
        <If when={step() === 'preparing'} else={<WelcomeScreen onStart={() => setup.set({ step: hosted() ? 'sign-in' : 'connect' })} onOwn={() => setup.set({ step: 'connect' })} />}>
          {() => <PreparingScreen hostUrl={hosted()!} accountToken={(setup() as { account: string }).account} onReady={(s) => { connect(s, { hostedBy: hosted() }).catch(() => {}) }} onBack={() => setup.set({ step: 'connect' })} />}
        </If>
      }>
        {() => <SignInScreen hostUrl={hosted()!} onSignedIn={(account) => setup.set({ step: 'preparing', account })} />}
      </If>
    }>
      {() => <ConnectScreen initial={initial} />}
    </If>
  )
  boot().catch(() => {}) // boot() loads prefs first

  // Headless tests have no system tab bar: the embedding host can pick a tab (`app.host.send('tab', 1)`).
  try { host.on('tab', (i) => pick(Number(i))) } catch {}
  const pick = (i: number) => { const next: Tab = i === 0 ? 'chat' : 'discover'; if (tab() === next) (next === 'chat' ? nav : discoverNav).popToRoot(); tab.set(next) }
  // The keyboard belongs to the screen that asked for it: any navigation (a push, a pop, the other tab) takes it
  // down. On Android the composer kept its focus under a pushed page, so every page opened with the keyboard up.
  effect(() => { nav.routes(); discoverNav.routes(); tab(); Keyboard.dismiss() })
  // [compliance] a report or an interface asked for from anywhere (a reply's menu, a card, a link) opens on the chat's stack
  effect(() => { const r = pendingReport(); if (!r) return; pendingReport.set(null); tab.set('chat'); nav.push({ name: 'report', target: r }) })
  effect(() => { const id = pendingInterface(); if (!id) return; pendingInterface.set(null); tab.set('chat'); nav.push({ name: 'interface', id }) })
  effect(() => {
    const url = openLink(); const s = session(); if (!url || !s || !me()?.assistant.name) return
    openLink.set(null)
    const id = interfaceFromLink(url, s.origin)
    if (id === 'elsewhere') showToast(str('linkElsewhere')); else if (id) pendingInterface.set(id)
  })
  // [push] a tapped notification: the chat on the thread it is about (its card sits at the bottom), or Discover
  effect(() => {
    const url = notificationUrl(); if (!url || !session() || !me()?.assistant.name) return
    notificationUrl.set(null)
    const to = notificationTarget(url)
    if (to.tab === 'discover') { discoverNav.popToRoot(); tab.set('discover'); return }
    nav.popToRoot(); tab.set('chat')
    if (to.thread) openThread(to.thread).catch(() => {})
  })
  // Unpaired: the next pairing starts at the chat, whatever page this one ended on.
  effect(() => { if (session()) return; nav.popToRoot(); discoverNav.popToRoot(); tab.set('chat') })
  // List pages: a large title on iOS (ui.tsx `largeTitles`), grouped background behind the system header.
  const grouped = 'bg-card dark:bg-background'
  // The system header in the theme's colors, light and dark (ui.tsx).
  const HEADER = systemHeaderClass()
  // The profile and Discover are plain pages: their header takes that background.
  const PLAIN_HEADER = systemHeaderClass(undefined, 'plain')

  /** One page of either stack. `nav` is the stack the route lives in. */
  const page = (route: Route, nav: ReturnType<typeof createNavStack<Route>>) => {
    switch (route.name) {
      case 'chat': return <NavPage headerClass={HEADER} headerVisible={false} headerBackTitle={me()?.assistant.name ?? ''}><ChatScreen tabbed onMenu={() => nav.push({ name: 'menu' })} onIdentity={() => nav.push({ name: 'profile' })} onMemory={(focus) => nav.push({ name: 'profile', tab: 'memory', focus })} onSettings={() => nav.push({ name: 'settings' })} onOpenFile={(path) => nav.push({ name: 'file', path })} /></NavPage>
      case 'discover': return <NavPage headerClass={PLAIN_HEADER} title={str('tabDiscover')} headerLargeTitle={largeTitles} class="bg-background"><DiscoverPage onOpenThread={() => { nav.popToRoot(); tab.set('chat') }} /></NavPage>
      case 'menu': return <NavPage headerClass={HEADER} title={str('menu')} headerLargeTitle={largeTitles} class={grouped}><MenuPage onPick={() => nav.popToRoot()} onLibrary={() => nav.push({ name: 'library' })} onUpcoming={() => nav.push({ name: 'upcoming' })} onGoals={() => nav.push({ name: 'goals' })} onActivity={() => nav.push({ name: 'activity' })} onInterfaces={() => nav.push({ name: 'interfaces' })} /></NavPage>
      case 'identity': return <NavPage headerClass={HEADER} title={str('identity')} class={grouped}><IdentityPage /></NavPage>
      case 'memory': return page({ name: 'profile', tab: 'memory' }, nav)
      case 'profile': return <NavPage headerClass={PLAIN_HEADER} title="" headerBackTitle={me()?.assistant.name ?? ''} class="bg-background"><ProfilePage tab={route.tab} focus={route.focus} onEditName={() => nav.push({ name: 'settings' })} onConnectors={() => nav.push({ name: 'connectors' })} onConnector={(id) => nav.push({ name: 'connector', id })} onEditMemory={(item) => nav.push({ name: 'memory-edit', item })} /></NavPage>
      case 'memory-edit': return <NavPage headerClass={HEADER} title={str('memoryTitle')} class={grouped}><MemoryEditPage item={route.item} onDone={() => nav.pop()} /></NavPage>
      case 'connector': return <NavPage headerClass={HEADER} title="" class={grouped}><ConnectorPage id={route.id} onClose={() => nav.pop()} onTry={() => { nav.popToRoot(); tab.set('chat') }} /></NavPage>
      case 'upcoming': return <NavPage headerClass={HEADER} title={str('upcoming')} headerLargeTitle={largeTitles} class={grouped}><UpcomingPage /></NavPage>
      case 'goals': return <NavPage headerClass={HEADER} title={str('goals')} headerLargeTitle={largeTitles} class={grouped}><GoalsPage /></NavPage>
      case 'activity': return <NavPage headerClass={HEADER} title={str('activity')} headerLargeTitle={largeTitles} class={grouped}><ActivityPage /></NavPage>
      case 'devices': return <NavPage headerClass={HEADER} title={str('devices')} headerLargeTitle={largeTitles} class={grouped}><DevicesPage /></NavPage>
      case 'usage': return <NavPage headerClass={HEADER} title={str('usage')} headerLargeTitle={largeTitles} class={grouped}><UsagePage /></NavPage>
      case 'library': return <NavPage headerClass={HEADER} title={str('library')} headerLargeTitle={largeTitles} class={grouped}><LibraryPage onOpen={(path) => nav.push({ name: 'file', path })} /></NavPage>
      case 'file': return <NavPage headerClass={HEADER} title={fileName(route.path)} class={grouped}><LibraryFilePage path={route.path} onDeleted={() => nav.pop()} /></NavPage>
      case 'ideas': return <NavPage headerClass={HEADER} title={str('ideas')} headerLargeTitle={largeTitles} class={grouped}><IdeasPage onSent={() => { nav.popToRoot(); tab.set('chat') }} /></NavPage>
      case 'connectors': return <NavPage headerClass={HEADER} title={str('connectors')} class={grouped}><ConnectorsPage onOpen={(id) => nav.push({ name: 'connector', id })} onAdd={() => nav.push({ name: 'connector-add' })} /></NavPage>
      case 'connector-add': return <NavPage headerClass={HEADER} title={str('advanced')} class={grouped}><ConnectorAddPage onDone={() => nav.pop()} /></NavPage>
      case 'report': return <NavPage headerClass={HEADER} title={str('reportTitle')} class={grouped}><ReportPage target={route.target} onDone={() => nav.pop()} /></NavPage>
      case 'interfaces': return <NavPage headerClass={HEADER} title={str('interfaces')} headerLargeTitle={largeTitles} class={grouped}><InterfacesPage onOpen={(id) => nav.push({ name: 'interface', id })} /></NavPage>
      case 'interface': return <NavPage headerClass={HEADER} title="" class={grouped}><InterfacePage id={route.id} onOpen={(i) => openInterface({ moduleId: i.id, title: i.title })} onReport={(target) => nav.push({ name: 'report', target })} /></NavPage>
      case 'ai-provider': return <NavPage headerClass={HEADER} title={str('aiProvider')} class={grouped}><AiProviderPage onStopped={() => nav.popToRoot()} /></NavPage>
      case 'settings': return <NavPage headerClass={HEADER} title={str('settings')} headerLargeTitle={largeTitles} class={grouped}><SettingsPage onAiProvider={() => nav.push({ name: 'ai-provider' })} onIdentity={() => nav.push({ name: 'identity' })} onMemory={() => nav.push({ name: 'memory' })} onConnectors={() => nav.push({ name: 'connectors' })} onUsage={() => nav.push({ name: 'usage' })} onDevices={() => nav.push({ name: 'devices' })} onActivity={() => nav.push({ name: 'activity' })} /></NavPage>
      // routes added by other features go here
    }
  }

  return (
    <View class="flex-1 bg-background">
      <If when={session()} else={<SetupFlow />}>
        {() => (
          // until /me (or the copy of it from the last launch) says who it is, nothing: never a flash of the naming screen
          <If when={me()} else={<View class="flex-1 bg-background" />}>{() => (
          // [compliance] before naming and the first message: the age, then the AI provider
          <If when={!needsAge()} else={<AgeScreen />}>{() => (
          <If when={!underAge()} else={<AdultsOnlyScreen />}>{() => (
          <If when={!needsConsent()} else={<ConsentScreen />}>{() => (
          <If when={me()?.assistant.name} else={<NameScreen />}>
            {() => (
              <View class="flex-1">
                {/* Both stacks stay mounted; the inactive one is hidden. */}
                <View class="flex-1" style={{ display: tab() === 'chat' ? 'flex' : 'none' }} testID="tab-chat-content">
                  <NavStack state={nav} class="flex-1">{(route) => page(route, nav)}</NavStack>
                </View>
                <View class="flex-1" style={{ display: tab() === 'discover' ? 'flex' : 'none' }} testID="tab-discover-content">
                  <NavStack state={discoverNav} class="flex-1">{(route) => page(route, discoverNav)}</NavStack>
                </View>
                {/* The keyboard covers the tab bar, as in Messages. */}
                <If when={keyboardFrame().height === 0}>
                  <View class={underBarClass((tab() === 'chat' ? nav : discoverNav).routes().at(-1)?.name)}>
                    <If when={mobileHost} else={
                      <View class="px-4 pt-1" style={{ paddingBottom: Math.max(insets().bottom, 8) }} testID="tabbar">
                        <Glass class="flex-row rounded-full px-1" style={{ boxShadow: '0 4px 14px rgba(0,0,0,0.10)' }}>
                          <TabItem icon="chat" label={str('tabChat')} active={tab() === 'chat'} onPress={() => pick(0)} testID="tab-chat" />
                          <TabItem icon="grid" label={str('tabDiscover')} active={tab() === 'discover'} onPress={() => pick(1)} testID="tab-discover" />
                        </Glass>
                      </View>
                    }>
                      {/* The system's own tab bar (Liquid Glass on iOS 26; Material on Android): SF Symbols, Android's own drawables (ui.tsx tabIcons). */}
                      <TabBar testID="tabbar" style={systemTabBarStyle(platform.os, insets().bottom)} items={[{ title: str('tabChat'), icon: tabIcons()[0] }, { title: str('tabDiscover'), icon: tabIcons()[1] }]} selectedIndex={tab() === 'chat' ? 0 : 1} onChange={pick} />
                    </If>
                  </View>
                </If>
              </View>
            )}
          </If>
          )}</If>
          )}</If>
          )}</If>
          )}</If>
        )}
      </If>
      <If when={toast()}>{(m) => <View class="absolute left-0 right-0 items-center px-8" style={{ bottom: 100 }}><View class="bg-primary rounded-full px-5 py-[10px]" style={{ boxShadow: '0 6px 18px rgba(0,0,0,0.22)' }}><Text class="text-primary-foreground text-[15px] font-medium" numberOfLines={2}>{m()}</Text></View></View>}</If>
    </View>
  )
}

/** One tab: glyph over a 10pt label, the foreground when selected, grey otherwise (HIG tab bar, 49pt). Used where there is no system tab bar. */
function TabItem(props: { icon: 'chat' | 'grid'; label: string; active: boolean; onPress: () => void; testID: string }) {
  return (
    <View role="tab" accessibilityLabel={props.label} accessibilityState={{ selected: props.active }} testID={props.testID} onPress={props.onPress} class="flex-1 items-center justify-center gap-[3px] active:opacity-60" style={{ height: TAB_BAR }}>
      <Icon name={props.icon} size={24} color={props.active ? undefined : muted()} />
      <Text class={`text-[13px] leading-4 font-medium ${props.active ? 'text-primary' : 'text-muted-foreground'}`}>{props.label}</Text>
    </View>
  )
}

mount(App)
