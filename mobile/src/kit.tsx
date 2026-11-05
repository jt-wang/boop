// Shared pieces:
// line icons, the 44pt icon tile, the four-segment icon control, section
// titles and the two-line rows with a time under them. Icons are vendored:
// Lucide 0.460.0 (ISC) for the interface, Simple Icons 13.21.0 (CC0) for the
// services' marks (assets/icons/LICENSES.md).
import { colorScheme, Image, Text, View, type JSX } from 'nsh'
import { Input } from 'nsh/base'
import { letterSize } from './ui.tsx'
import list from '../assets/icons/list.svg'
import shield from '../assets/icons/shield-check.svg'
import clock from '../assets/icons/clock.svg'
import fingerprint from '../assets/icons/fingerprint.svg'
import chevron from '../assets/icons/chevron-right.svg'
import dots from '../assets/icons/ellipsis-vertical.svg'
import pencil from '../assets/icons/pencil.svg'
import plus from '../assets/icons/plus.svg'
import alert from '../assets/icons/circle-alert.svg'
import brain from '../assets/icons/brain.svg'
import bell from '../assets/icons/bell.svg'
import target from '../assets/icons/target.svg'
import calendar from '../assets/icons/calendar.svg'
import globe from '../assets/icons/globe.svg'
import file from '../assets/icons/file-text.svg'
import sparkles from '../assets/icons/sparkles.svg'
import link from '../assets/icons/link.svg'
import check from '../assets/icons/check.svg'
import plug from '../assets/icons/plug.svg'
import search from '../assets/icons/search.svg'
import notion from '../assets/icons/brand-notion.svg'
import linear from '../assets/icons/brand-linear.svg'
import github from '../assets/icons/brand-github.svg'
import slack from '../assets/icons/brand-slack.svg'
import gmail from '../assets/icons/brand-gmail.svg'
import gcal from '../assets/icons/brand-googlecalendar.svg'
import gdrive from '../assets/icons/brand-googledrive.svg'
import atlassian from '../assets/icons/brand-atlassian.svg'

export const ICONS = { list, shield, clock, fingerprint, chevron, dots, pencil, plus, alert, brain, bell, target, calendar, globe, file, sparkles, link, check, plug, search }
const BRANDS: Record<string, typeof notion> = { notion, linear, github, slack, gmail, 'google-calendar': gcal, 'google-drive': gdrive, atlassian }
export type IconName = keyof typeof ICONS

/** The theme's foreground and muted-foreground (nsh.json), for icons, which take a color rather than a class. */
export const ink = () => (colorScheme() === 'dark' ? '#EDECEC' : '#26251E')
export const muted = () => (colorScheme() === 'dark' ? '#8E8D88' : '#85847E')

/** A line icon in the text color (or `color`), 24pt by default. */
export function Glyph(props: { name: IconName; size?: number; color?: string }) {
  const size = props.size ?? 24
  return <Image src={ICONS[props.name]} style={{ width: size, height: size, tintColor: props.color ?? ink() }} />
}

/** Each mark's own color (simple-icons 13.21.0 data); near-black marks take the text color so they show in dark mode. */
const BRAND_HEX: Record<string, string> = { notion: '#000000', linear: '#5E6AD2', github: '#181717', slack: '#4A154B', gmail: '#EA4335', 'google-calendar': '#4285F4', 'google-drive': '#4285F4', atlassian: '#0052CC' }
const dim = (hex: string) => { const n = parseInt(hex.slice(1), 16); return ((n >> 16) * 299 + ((n >> 8) & 255) * 587 + (n & 255) * 114) / 1000 < 60 }
/** A service's own mark in its own color, else its first letter. */
export function BrandMark(props: { id: string; name: string; size?: number }) {
  const size = props.size ?? 22
  const b = BRANDS[props.id]
  const hex = BRAND_HEX[props.id]
  const color = () => (!hex || (colorScheme() === 'dark' && dim(hex)) ? ink() : hex)
  return b ? <Image src={b} style={{ width: size, height: size, tintColor: color() }} /> : <View style={{ width: size, height: size, borderRadius: size * 0.27 }} class="bg-primary items-center justify-center"><Text class="text-primary-foreground font-semibold" style={{ fontSize: letterSize(size), lineHeight: size }}>{(props.name.trim()[0] ?? '•').toUpperCase()}</Text></View>
}

/** A 44pt rounded tile that holds a row's icon (#F2F3F5 on the page; ours from the DSH greys). */
export function Tile(props: { children?: JSX.Element; size?: number }) {
  const size = props.size ?? 44
  return <View style={{ width: size, height: size, borderRadius: 12 }} class="bg-secondary items-center justify-center">{props.children}</View>
}

/**
 * The four-icon segmented control under the avatar: a 38pt capsule track, the
 * selected segment a white 32pt capsule with a soft shadow, thin dividers between
 * the others, icons 24pt (grey when not selected).
 */
export function IconSegments<K extends string>(props: { items: { key: K; icon: IconName; label: string }[]; value: K; onChange: (k: K) => void }) {
  return (
    <View class="flex-row items-center rounded-full bg-muted p-[3px]" style={{ height: 38 }} role="tablist">
      {props.items.map((it, i) => {
        const on = () => props.value === it.key
        const nextOn = () => props.items[i + 1]?.key === props.value
        return (
          <View class="flex-1 flex-row items-center" style={{ height: 32 }}>
            <View role="tab" accessibilityLabel={it.label} accessibilityState={{ selected: on() }} testID={`seg-${it.key}`} onPress={() => props.onChange(it.key)}
              class={`flex-1 items-center justify-center rounded-full ${on() ? 'bg-background dark:bg-accent' : 'active:opacity-60'}`}
              style={{ height: 32, boxShadow: on() ? (colorScheme() === 'dark' ? '0 1px 3px rgba(0,0,0,0.4)' : '0 1px 3px rgba(0,0,0,0.10)') : undefined }}>
              <Glyph name={it.icon} size={20} color={on() ? ink() : muted()} />
            </View>
            {i < props.items.length - 1 && !on() && !nextOn() ? <View class="bg-black/[0.12] dark:bg-white/[0.14]" style={{ width: 0.5, height: 16 }} /> : null}
          </View>
        )
      })}
    </View>
  )
}

/** A section title on a plain page: 17pt semibold, 16pt from the edge. */
export function SectionTitle(props: { text: string; testID?: string }) {
  return (
    // one line: on a page pushed from the chat, Android broke "Today" as "Toda / y" however wide its box was
    // (column, w-full, flex-1 all tried on the emulator, 2026-10-30); a single line draws it whole
    <View class="flex-row px-4 pt-6 pb-2" testID={props.testID}>
      <Text class="flex-1 text-foreground text-[17px] leading-[25px] font-semibold" numberOfLines={1}>{props.text}</Text>
    </View>
  )
}

/**
 * One row of activity, goals or ideas: a leading tile or mark, a 17pt title,
 * a 15pt grey line, an optional 15pt grey time, and something at the right (a button, ⋮, a chevron).
 * `highlight` is the running row's grey plate.
 */
export function Row(props: { lead?: JSX.Element; title: string; line?: string; time?: string; right?: JSX.Element; onPress?: () => void; onLongPress?: () => void; highlight?: boolean; testID?: string; titleLines?: number; accessibilityLabel?: string }) {
  return (
    <View role={props.onPress ? 'button' : undefined} testID={props.testID} onPress={props.onPress} onLongPress={props.onLongPress} accessibilityLabel={props.accessibilityLabel}
      class={`flex-row items-center gap-3 mx-[6px] px-[10px] py-[11px] rounded-[14px] ${props.highlight ? 'bg-muted' : ''} ${props.onPress ? 'active:bg-black/[0.04] dark:active:bg-white/[0.06]' : ''}`}>
      {props.lead ?? null}
      <View class="flex-1 min-w-0 gap-[2px]">
        <Text class="text-foreground text-[17px] leading-[22px] font-medium" numberOfLines={props.titleLines ?? 2}>{props.title}</Text>
        {props.line ? <Text class="text-muted-foreground text-[15px] leading-5" numberOfLines={2}>{props.line}</Text> : null}
        {props.time ? <Text class="text-muted-foreground text-[15px] leading-5">{props.time}</Text> : null}
      </View>
      {props.right ?? null}
    </View>
  )
}

/** A capsule action at the right of a row: 32pt, grey fill, 15pt semibold. */
export function Pill(props: { label: string; onPress: () => void; testID?: string; strong?: boolean; disabled?: boolean }) {
  return (
    <View role="button" testID={props.testID} disabled={props.disabled} onPress={() => { if (!props.disabled) props.onPress() }}
      class={`rounded-full px-[14px] items-center justify-center active:opacity-70 ${props.strong ? 'bg-primary' : 'bg-secondary'} ${props.disabled ? 'opacity-50' : ''}`} style={{ height: 32 }}>
      <Text class={`text-[15px] font-semibold ${props.strong ? 'text-primary-foreground' : 'text-foreground'}`} numberOfLines={1}>{props.label}</Text>
    </View>
  )
}

/**
 * The Connectors list is an inset-grouped list on the grey page:
 * a 13pt grey caption, then one white card of rows — the service's mark, its name, and at the right a chevron
 * (connected) or a "Connect" text button (available). Separators start where the text starts.
 */
export function ListGroup(props: { caption?: string; children?: JSX.Element; testID?: string; footer?: string }) {
  return (
    <View class="px-4" testID={props.testID}>
      {props.caption ? <View class="px-4"><Text class="text-muted-foreground text-[15px] leading-[18px] font-medium pb-[8px]">{props.caption}</Text></View> : null}
      <View class="bg-background dark:bg-card overflow-hidden" style={{ borderRadius: 20 }}>{props.children}</View>
      {props.footer ? <View class="px-4"><Text class="text-muted-foreground text-[13px] leading-[18px] pt-[7px]">{props.footer}</Text></View> : null}
    </View>
  )
}
export function ListRow(props: { lead?: JSX.Element; title: string; subtitle?: string; right?: JSX.Element; chevron?: boolean; first?: boolean; onPress?: () => void; testID?: string; destructive?: boolean; centered?: boolean }) {
  return (
    <View role={props.onPress ? 'button' : undefined} testID={props.testID} onPress={props.onPress} class={`flex-row items-center ${props.onPress ? 'active:bg-black/[0.05] dark:active:bg-white/[0.07]' : ''}`} style={{ minHeight: 56 }}>
      {/* The hairline starts 15pt inside the card and runs to its edge */}
      {props.first ? null : <View class="bg-border" style={{ position: 'absolute', top: 0, left: 15, right: 0, height: 0.5 }} />}
      {props.lead ? <View class="items-center justify-center" style={{ marginLeft: 12, width: 32 }}>{props.lead}</View> : null}
      <View class={`flex-1 min-w-0 flex-row items-center gap-3 pr-4 py-[9px] ${props.lead ? 'ml-3' : 'ml-4'} ${props.centered ? 'justify-center' : ''}`}>
        <View class={`min-w-0 ${props.centered ? '' : 'flex-1'}`}>
          <Text class={`text-[17px] leading-[22px] ${props.destructive ? 'text-destructive' : 'text-foreground'}`} numberOfLines={2}>{props.title}</Text>
          {props.subtitle ? <Text class="text-muted-foreground text-[15px] leading-5 mt-[1px]" numberOfLines={2}>{props.subtitle}</Text> : null}
        </View>
        {props.right ?? null}
        {props.chevron ? <Glyph name="chevron" size={17} color={muted()} /> : null}
      </View>
    </View>
  )
}

/** A text button at the right of a list row: 17pt semibold, the primary ink. */
export function TextAction(props: { label: string; onPress: () => void; testID?: string; muted?: boolean }) {
  return (
    <View role="button" testID={props.testID} onPress={props.onPress} class="min-h-[44px] justify-center pl-2 active:opacity-50">
      <Text class={`text-[17px] font-semibold ${props.muted ? 'text-muted-foreground' : 'text-foreground'}`}>{props.label}</Text>
    </View>
  )
}

/** A search field over a list: a white capsule, a magnifier, 17pt placeholder. */
export function SearchField(props: { value: string; onChange: (v: string) => void; placeholder: string; testID?: string }) {
  return (
    <View class="mx-6 flex-row items-center gap-2 rounded-full bg-background dark:bg-card px-4" style={{ height: 48 }}>
      <Glyph name="search" size={18} color={muted()} />
      <Input testID={props.testID} value={props.value} onChange={props.onChange} placeholder={props.placeholder} autoCapitalize="none" autoCorrect={false} returnKeyType="search" submitBehavior="blurAndSubmit" class="flex-1 bg-transparent text-foreground text-[17px] min-h-[44px]" />
    </View>
  )
}

/** A 32pt app icon in a list row: the service's mark on a white rounded square with a hairline. */
export function AppIcon(props: { id: string; name: string; size?: number }) {
  const size = props.size ?? 32
  return <View style={{ width: size, height: size, borderRadius: size * 0.25, borderWidth: 0.5 }} class="bg-background dark:bg-card border-black/[0.10] dark:border-white/[0.12] items-center justify-center"><BrandMark id={props.id} name={props.name} size={Math.round(size * 0.62)} /></View>
}
