// Shared pieces: glass, cards, buttons, avatar, inset-grouped lists, empty
// states. Sizes follow
// Apple HIG (17 body, 15 secondary, 13 footnote, 44pt targets, 16pt margins);
// hierarchy comes from material and elevation, not lines.
import { cleanup, colorScheme, createMotion, effect, Image, platform, safeAreaInsets, Scroll, signal, Storage, Text, View, type Easing, type JSX, type ScrollProps, type StyleProp, type ViewStyle, type YNode } from 'nsh'
import menuIcon from '../assets/menu.png'
import gearIcon from '../assets/gear.png'
import chatIcon from '../assets/chat.png'
import gridIcon from '../assets/grid.png'
import { Switch } from 'nsh/base'
import { me } from './state.ts'

export const initial = () => (me()?.assistant.name || '•').trim().slice(0, 1).toUpperCase()

/** Apple's Liquid Glass draws on iOS 26 and later; elsewhere `Glass` falls back to a thin blur with a tint. */
export const liquid = (() => { try { return platform.os === 'ios' && parseFloat(platform.version) >= 26 } catch { return false } })()

/** Concentric radii: a card's outer corner, a row or field inside it. Buttons, bubbles and pills are capsules. */
export const RADIUS = { card: 20, inner: 12 }

/** The one entrance curve: `cubic-bezier(.16,1,.3,1)`, read from air.build's home css (2026-10-27): all the travel in the first third, a long settle. */
export const EASE_OUT: Easing = [0.16, 1, 0.3, 1]

/**
 * A row, a card or a pill fades in, 240 ms on EASE_OUT, without sliding (the owner's list of 2026-10-29: no busy
 * entrance motion). `when` false draws it at rest, for things already on screen when the thread opened.
 */
export function Appear(props: { when?: boolean; class?: string; style?: StyleProp<ViewStyle>; children?: JSX.Element; testID?: string }) {
  const m = props.when === false ? null : createMotion({ enter: { keyframes: { opacity: [0, 1] }, duration: 240, easing: EASE_OUT } })
  return <View testID={props.testID} class={props.class} style={m ? [m.style, props.style] : props.style}>{props.children}</View>
}

/** A breathing dot, the one sign that it is working. */
export function Pulse(props: { size?: number; class?: string }) {
  const pulse = createMotion()
  effect(() => { pulse.play('breathe') })
  const size = props.size ?? 8
  return <View style={{ width: size, height: size, ...pulse.style }} class={`rounded-full bg-primary ${props.class ?? ''}`} />
}

/** A surface's elevation on the grouped background: one soft shadow in light mode; dark mode separates by a lighter surface instead. */
export const lift = () => (colorScheme() === 'dark' ? undefined : '0 1px 3px rgba(0,0,0,0.06)')

type Press = { onPress?: () => void; onLongPress?: () => void; role?: 'button'; accessibilityLabel?: string; testID?: string; disabled?: boolean }

/**
 * A glass element (bar, pill, button). Liquid Glass on iOS 26; a thin material
 * blur with a 60% tint and a hairline elsewhere. Give it a shape with `class`
 * (`rounded-full`, `rounded-[20px]`); never put glass on glass.
 */
export function Glass(props: Press & { children?: JSX.Element; class?: string; style?: StyleProp<ViewStyle>; pointerEvents?: 'auto' | 'none' | 'box-none' | 'box-only' }) {
  // Over a flat background glass is nearly invisible (measured on the iOS 26.3 simulator, 2026-10-27), so every piece
  // gets a hairline and a soft shadow for its edge; off iOS 26 it also gets a 60% tint.
  const fallback = liquid ? 'border-black/[0.08] dark:border-white/[0.12]' : 'bg-white/60 dark:bg-card/60 border-black/[0.08] dark:border-white/[0.12]'
  return (
    <View role={props.role} testID={props.testID} accessibilityLabel={props.accessibilityLabel} onPress={props.onPress} onLongPress={props.onLongPress} disabled={props.disabled} pointerEvents={props.pointerEvents}
      ios={{ backdropMaterial: 'thin' }}
      style={[{ glassEffect: 'regular', backdropFilter: 'blur(20px)', borderWidth: 0.5, boxShadow: colorScheme() === 'dark' ? '0 2px 10px rgba(0,0,0,0.35)' : '0 2px 10px rgba(0,0,0,0.08)' }, props.style]}
      class={`overflow-hidden ${fallback} ${props.class ?? ''}`}>
      {props.children}
    </View>
  )
}

/** A blur that fades out, at the edge content scrolls under (iOS 26's scroll edge): no line, the content just softens. */
export function EdgeFade(props: { edge: 'top' | 'bottom'; height: number }) {
  const dir = props.edge === 'top' ? 'to bottom' : 'to top'
  return (
    <View pointerEvents="none" class="bg-background/80" style={{ position: 'absolute', left: 0, right: 0, [props.edge]: 0, height: props.height, backdropFilter: 'blur(14px)', maskImage: `linear-gradient(${dir}, black 45%, transparent 100%)` }} />
  )
}

/** A surface on the grouped background: white with a soft shadow in light mode, a lighter grey in dark mode, 20pt corners, no line. */
export function Card(props: { children?: JSX.Element; class?: string; style?: StyleProp<ViewStyle>; testID?: string; onPress?: () => void; onLongPress?: () => void; accessibilityLabel?: string }) {
  return (
    <View role={props.onPress ? 'button' : undefined} testID={props.testID} onPress={props.onPress} onLongPress={props.onLongPress} accessibilityLabel={props.accessibilityLabel}
      style={[{ boxShadow: lift(), borderRadius: RADIUS.card }, props.style]} class={`bg-background dark:bg-card ${props.onPress ? 'active:opacity-80' : ''} ${props.class ?? ''}`}>
      {props.children}
    </View>
  )
}

/** A letter in a circle of `size` points, on the app's type scale (28/17/15/13). */
export const letterSize = (size: number): number => (size >= 56 ? 28 : size >= 36 ? 17 : size >= 30 ? 15 : 13)

/** The assistant's avatar. `dot` shows presence; `busy` breathes while it works. */
export function Avatar(props: { size?: number; dot?: 'online' | 'busy' | 'off'; label?: string }) {
  const size = props.size ?? 40
  const pulse = createMotion()
  effect(() => { if (props.dot === 'busy') pulse.play('breathe'); else pulse.reset() })
  const dotClass = () => (props.dot === 'online' ? 'bg-muted-foreground' : props.dot === 'busy' ? 'bg-primary' : 'bg-input')
  const dotSize = Math.max(10, Math.round(size * 0.3))
  return (
    <View style={{ width: size, height: size }} class="rounded-full bg-primary items-center justify-center">
      <Text style={{ fontSize: letterSize(size) }} class="text-primary-foreground font-semibold">{props.label ?? initial()}</Text>
      {props.dot ? <View testID={`dot-${props.dot}`} style={{ position: 'absolute', right: -1, bottom: -1, width: dotSize, height: dotSize, ...pulse.style }} class={`rounded-full border-2 border-background dark:border-card ${dotClass()}`} /> : null}
    </View>
  )
}

/**
 * A capsule button. `primary` is the one filled action; `soft` is tinted
 * (secondary); `quiet` is plain accent text (tertiary); `danger` is plain red.
 * `wide` makes it share a row.
 */
export function Btn(props: { label: string; kind?: 'primary' | 'soft' | 'quiet' | 'danger'; wide?: boolean; disabled?: boolean; onPress: () => void; testID?: string }) {
  const kind = () => props.kind ?? 'soft'
  const cls = () => (kind() === 'primary' ? 'bg-primary' : kind() === 'soft' ? 'bg-primary/10 dark:bg-primary/20' : 'bg-transparent')
  const tcls = () => (kind() === 'primary' ? 'text-primary-foreground' : kind() === 'danger' ? 'text-destructive' : 'text-primary')
  return (
    <View role="button" testID={props.testID} disabled={props.disabled} onPress={() => { if (!props.disabled) props.onPress() }}
      class={`rounded-full px-4 min-h-[44px] items-center justify-center active:opacity-70 ${cls()} ${props.wide ? 'flex-1' : ''} ${props.disabled ? 'opacity-50' : ''}`}>
      <Text class={`font-semibold ${props.wide ? 'text-[15px]' : 'text-[17px]'} ${tcls()}`} numberOfLines={1}>{props.label}</Text>
    </View>
  )
}

/** One inset group: optional header and footer (13pt), rows on one card. */
export function Group(props: { header?: string; footer?: string; children?: JSX.Element; testID?: string }) {
  return (
    <View class="px-4" testID={props.testID}>
      {props.header ? <View class="px-4"><Text class="text-muted-foreground text-[13px] leading-[18px] pb-[7px]">{props.header}</Text></View> : null}
      <Card class="overflow-hidden">
        {/* rows draw their separator on top; the first one's sits half a point above the card, where the card clips it
            (a strip painted over it was not clipped by Android's rounded corners and showed above the card) */}
        <View style={{ marginTop: -0.5 }}>{props.children}</View>
      </Card>
      {props.footer ? <View class="px-4"><Text class="text-muted-foreground text-[13px] leading-[18px] pt-[7px]">{props.footer}</Text></View> : null}
    </View>
  )
}

/** One row of a group: title (+ subtitle), a value or custom view on the right, a chevron when it navigates. */
export function Cell(props: { title: string; subtitle?: string; value?: string; right?: JSX.Element; chevron?: boolean; destructive?: boolean; centered?: boolean; tint?: boolean; onPress?: () => void; onLongPress?: () => void; testID?: string; mono?: boolean }) {
  const titleClass = () => `text-[17px] leading-[22px] ${props.destructive ? 'text-destructive' : props.tint ? 'text-primary' : 'text-foreground'} ${props.mono ? 'font-mono text-[15px]' : ''}`
  return (
    <View role={props.onPress ? 'button' : undefined} testID={props.testID} onPress={props.onPress} onLongPress={props.onLongPress} class={`pl-4 ${props.onPress ? 'active:bg-secondary' : ''}`}>
      <View style={{ borderTopWidth: 0.5 }} class={`flex-row items-center gap-3 min-h-[44px] pr-4 py-[11px] border-border ${props.centered ? 'justify-center' : ''}`}>
        <View class={`min-w-0 ${props.centered ? '' : 'flex-1'}`}>
          <Text class={titleClass()} numberOfLines={props.subtitle ? 2 : 3}>{props.title}</Text>
          {props.subtitle ? <Text class="text-muted-foreground text-[15px] leading-5 mt-[2px]" numberOfLines={3}>{props.subtitle}</Text> : null}
        </View>
        {props.value ? <Text class="text-muted-foreground text-[17px]" numberOfLines={1}>{props.value}</Text> : null}
        {props.right ?? null}
        {props.chevron ? <Text class="text-input text-[17px] font-semibold -mr-[2px]">›</Text> : null}
      </View>
    </View>
  )
}

/** A 24pt line icon drawn in the tint color (PNG with alpha; `assets/*.png` at 1x/2x/3x). */
const ICONS = { menu: menuIcon, gear: gearIcon, chat: chatIcon, grid: gridIcon }
export function Icon(props: { name: keyof typeof ICONS; size?: number; color?: string }) {
  const size = props.size ?? 24
  return <Image src={ICONS[props.name]} style={{ width: size, height: size, tintColor: props.color ?? (colorScheme() === 'dark' ? '#EDECEC' : '#26251E') }} />
}

export function Hint(props: { text: string }) { return <Text class="text-muted-foreground text-[15px] leading-5">{props.text}</Text> }

/** A finished-looking empty state: a glyph in a muted circle, one line, an optional action. */
export function Empty(props: { text: string; action?: { label: string; onPress: () => void; testID?: string } }) {
  return (
    <View class="items-center justify-center px-8 pt-14 gap-4">
      <Text class="text-muted-foreground text-[17px] text-center leading-6">{props.text}</Text>
      {props.action ? <View class="pt-1"><Btn kind="soft" label={props.action.label} onPress={props.action.onPress} testID={props.action.testID} /></View> : null}
    </View>
  )
}

/**
 * The system header's colors on a pushed page (NavPage `headerClass`: `bg-*`, `text-*` title, `tint-*` buttons; the
 * theme's tokens, so `dark:` follows the scheme). Android draws its toolbar opaque in the color given, so it takes
 * the grouped page's background (Material 3: the top app bar is the surface it sits on). iOS keeps UIKit's bar
 * background, transparent at the scroll edge and the system material once content scrolls under it.
 */
export function systemHeaderClass(os: string = platform.os, surface: 'grouped' | 'plain' = 'grouped'): string {
  if (os !== 'android') return 'text-foreground tint-foreground'
  return `${surface === 'plain' ? 'bg-background' : 'bg-card dark:bg-background'} text-foreground tint-foreground`
}

/**
 * The system tab bar's icons, chat then Discover, by the platform's name (nsh/mobile `TabBarItem.icon`): SF Symbols
 * on iOS; on Android the shell's own drawables (android/app/src/main/res/drawable-*: the app's chat and grid glyphs,
 * which the TabBar tints).
 */
export function tabIcons(os: string = platform.os): [string, string] {
  return os === 'android' ? ['tab_chat', 'tab_discover'] : ['message', 'square.grid.2x2']
}

/**
 * The system tab bar's style. On iOS a height from its first layout: NSH 0.3.0's bar fills its host, which is 0 tall
 * until the bar reports its height, and items set while it is 0 tall keep no label on the tab that is not selected
 * (QA 2026-10-28 #17: Discover's icon without 「发现」). 49 is UIKit's bar, plus the home indicator's inset. Android's
 * navigation bar keeps the system's height.
 */
export function systemTabBarStyle(os: string = platform.os, bottomInset = 0): { height: number } | undefined {
  return os === 'ios' ? { height: 49 + bottomInset } : undefined
}

/** The pages on the plain background; every other page is grouped (App.tsx). */
const PLAIN_PAGES = new Set(['chat', 'discover', 'profile'])

/** The strip under the tab bar: the background of the page above it, so no band shows between them. */
export function underBarClass(route?: string): string {
  return route && !PLAIN_PAGES.has(route) ? 'bg-card dark:bg-background' : 'bg-background'
}

/** A grouped page's scroll root: grouped background, 16pt gaps between groups. */
export const pageClass = 'flex-1 bg-card dark:bg-background'
export const pageContentClass = 'gap-6 pt-4 pb-[calc(env(safe-area-inset-bottom)+24px)]'

/**
 * Large titles are iOS's (HIG); Material has none. NSH lays a large-title page out under the system header and
 * leaves the inset to the scroll view, which UIKit does (contentInsetAdjustmentBehavior) and Android's does not:
 * on Android every list page started under the toolbar (2026-10-27). So only iOS asks for them.
 */
export const largeTitles = platform.os === 'ios'

/** The shortest system header there is: UINavigationBar's 44pt (Material's top app bar is 56dp). */
const MIN_BAR = 44

/**
 * The layout guard: started with `layoutGuard: '1'` in storage (layout.test.tsx, headless and `nsh test --target`),
 * each page writes where its content starts and where the header ends to storage (`layout`, a JSON list); the test
 * fails when content starts above the header. Storage, because a device run has no host handlers (NSH 0.3.0).
 */
const layoutGuard = signal(false)
Storage.getItem('layoutGuard').then((v) => layoutGuard.set(v === '1')).catch(() => {})
const layoutReports: { page: string; top: number; headerBottom: number }[] = []
function reportLayout(r: { page: string; top: number; headerBottom: number }) {
  layoutReports.push(r); Storage.setItem('layout', JSON.stringify(layoutReports)).catch(() => {})
}

/**
 * A mark at the top of a page's content (absolute, out of the layout): where the first row starts as the screen
 * shows it. The header ends where NSH starts the page (`root`, padded by the header it lays out), and never above
 * the status bar plus the shortest bar: a page laid out under its header (a large title, a transparent header)
 * must be inset by its scroll view, as UIKit does. The chat's header is its own (`headerBottom`). It measures again
 * every second, so a page that was hidden (the other tab) reports where it is once shown.
 */
export function TopProbe(props: { page: string; root?: () => YNode | undefined; headerBottom?: () => number }) {
  return <If when={layoutGuard()}><Probe {...props} /></If>
}
function Probe(props: { page: string; root?: () => YNode | undefined; headerBottom?: () => number }) {
  const insets = safeAreaInsets()
  let ref: YNode | undefined
  let last = ''
  let timer: ReturnType<typeof setInterval> | undefined
  const check = async () => {
    const m = await ref?.measure(); if (!m) return
    // iOS: a pushed page's safe area is UIKit's, which ends at the navigation bar's bottom (152 on the iPhone 17 Pro
    // simulator with a large title, matching the hairline in its screenshot, 2026-10-27); the scroll view's own frame
    // is not where it draws there. Elsewhere the safe area stops at the status bar, and NSH starts the page below the
    // header it lays out: the header ends at the page's top, never above the status bar plus the shortest bar.
    const headerBottom = props.headerBottom ? props.headerBottom()
      : platform.os === 'ios' ? insets().top
      : Math.max((await props.root?.()?.measure())?.pagePosition.y ?? 0, insets().top + MIN_BAR)
    const report = { page: props.page, top: Math.round(m.pagePosition.y), headerBottom: Math.round(headerBottom) }
    const key = JSON.stringify(report); if (key === last) return
    last = key; reportLayout(report)
  }
  const start = () => { if (!timer) { setTimeout(check, 300); timer = setInterval(check, 1000) } }
  cleanup(() => { if (timer) clearInterval(timer) })
  return <View ref={ref} pointerEvents="none" style={{ position: 'absolute', top: 0, left: 0, width: 1, height: 1 }} onLayout={start} />
}

/** A list page: the grouped scroll root every pushed page uses, with the layout guard's mark at its top. */
export function Page(props: Pick<ScrollProps, 'class' | 'contentClass' | 'refreshing' | 'onRefresh' | 'testID' | 'keyboardShouldPersistTaps' | 'keyboardDismissMode' | 'onLayout'> & { page: string; children?: JSX.Element }) {
  // props are read where they are used (not destructured), so what the page binds stays reactive
  let root: YNode | undefined
  return (
    <Scroll ref={root} class={props.class ?? pageClass} contentClass={props.contentClass ?? pageContentClass} refreshing={props.refreshing} onRefresh={props.onRefresh} testID={props.testID} keyboardShouldPersistTaps={props.keyboardShouldPersistTaps} keyboardDismissMode={props.keyboardDismissMode} onLayout={props.onLayout}>
      <TopProbe page={props.page} root={() => root} />
      {props.children}
    </Scroll>
  )
}

/** A stand-alone card row (older pages); new pages use `Group` + `Cell`. */
export function RowItem(props: { title: string; subtitle?: string; right?: JSX.Element | string; onPress?: () => void; testID?: string }) {
  return (
    <Card testID={props.testID} onPress={props.onPress} class="flex-row items-center gap-3 px-4 min-h-[44px] py-[11px]">
      <View class="flex-1 min-w-0">
        <Text class="text-foreground text-[17px] leading-[22px]" numberOfLines={2}>{props.title}</Text>
        {props.subtitle ? <Text class="text-muted-foreground text-[15px] leading-5" numberOfLines={3}>{props.subtitle}</Text> : null}
      </View>
      {typeof props.right === 'string' ? <Text class="text-muted-foreground text-[17px]">{props.right}</Text> : (props.right ?? null)}
    </Card>
  )
}

/** An iOS-style switch (51×31, green when on). */
export function Toggle(props: { checked: boolean; onChange: (v: boolean) => void; label?: string; testID?: string }) {
  return (
    <Switch checked={props.checked} onChange={props.onChange} accessibilityLabel={props.label} testID={props.testID}
      trackClass="w-[51px] h-[31px] rounded-full bg-input checked:bg-primary justify-center px-[2px]"
      thumbClass="w-[27px] h-[27px] rounded-full bg-white shadow-sm checked:translate-x-5" style={{ transitionProperty: 'all', transitionDuration: 200 }} />
  )
}
