// Cards: the interface the assistant generates. Six kinds,
// drawn with native controls, the width of an assistant message. An answer
// goes to the bot as the words the person would have typed (`answerText`, the
// same function as src/cards.ts) with the card's id; the bot marks the card
// answered and the next `rows` frame shows it. The tap itself changes nothing.
import { colorScheme, nativeComponent, openUrl, signal, Text, View, WebView } from 'nsh'
import { Input, Sheet } from 'nsh/base'
import type { Card, CardField, CardRow, ModuleRow } from './fold.ts'
import { answerCard, answering, api, connection, labeled, me, session, sessionId, showToast, str } from './state.ts'
import { shellOpensModules, shellRunsInline, uiOpen } from './native.ts' // [agent:genui]
import { askPermissions, interfaceMenu, type Permission } from './compliance.tsx' // [compliance]
import { connectedIds, connecting, refreshConnected, startConnect } from './connectors.tsx' // [agent:connectors]
import { Btn, Card as Surface, Toggle } from './ui.tsx'

export type CardAnswer = Record<string, unknown>

/** The words the person would have typed. Same strings as src/cards.ts `answerText`. */
export function answerText(card: Card, value: CardAnswer): string {
  switch (card.kind) {
    case 'choices':
      if (Array.isArray(value.choices)) return (value.choices as unknown[]).map(String).join(', ')
      return String(value.choice ?? '')
    case 'confirm': return value.ok ? (card.yes ?? str('cardYes')) : (card.no ?? str('cardNo'))
    case 'table': return card.pick ? String(value.choice ?? '') : ''
    case 'form':
      return card.fields.filter((f) => value[f.name] !== undefined && value[f.name] !== '' && value[f.name] !== null).map((f) => `${f.label}: ${f.type === 'toggle' ? (value[f.name] ? 'yes' : 'no') : String(value[f.name])}`).join('\n')
    default: return ''
  }
}

type Props = { row: () => CardRow }
const SEP = { borderTopWidth: 0.5 }
/** Lock-in: the untapped options fade rather than vanish. */
const FADE = { transitionProperty: 'opacity', transitionDuration: 250 }

/** One card row. `row` is an accessor: the same card gets its `answer` later. */
export function CardView(props: Props) {
  const id = props.row().id
  const card = () => props.row().card
  const answered = () => props.row().answer !== undefined
  const kind = card().kind
  return (
    <Surface class="w-full p-4 gap-2" testID={answered() ? `card-${id}-answered` : `card-${id}`}>
      <Text class="text-foreground font-semibold text-[17px] leading-[22px]">{card().title}</Text>
      <If when={kind !== 'table' && kind !== 'progress' && kind !== 'summary' && (card() as { detail?: string }).detail}>
        <Text class="text-muted-foreground text-[15px] leading-5">{(card() as { detail?: string }).detail}</Text>
      </If>
      {kind === 'choices' ? <Choices {...props} /> : kind === 'form' ? <Form {...props} /> : kind === 'confirm' ? <Confirm {...props} /> : kind === 'table' ? <Table {...props} /> : kind === 'progress' ? <Progress {...props} /> : kind === 'connect' ? <Connect {...props} /> : <Summary {...props} />}
    </Surface>
  )
}

// [agent:connectors] "Connect Notion": the same sign-in as Settings → Connectors, from the thread.
// The card has no answer of its own; the bot tells the assistant when the browser comes back.
function Connect(props: Props) {
  const id = props.row().id
  const card = () => props.row().card as Extract<Card, { kind: 'connect' }>
  refreshConnected().catch(() => {})
  const state = () => (connectedIds().has(card().service) ? 'connected' : connecting() === card().service ? 'connecting' : 'idle')
  return (
    <View class="mt-1">
      <If when={state() === 'connected'} else={
        <If when={state() === 'connecting'} else={
          <View class={connection() !== 'online' ? 'opacity-50' : ''}><Btn kind="primary" testID={`connect-${id}`} label={str('connect')} onPress={() => { if (connection() === 'online') startConnect(card().service); else showToast(str('notConnected')) }} /></View>
        }>
          <Text class="text-muted-foreground text-[15px] leading-5" testID={`connecting-${id}`}>{str('connecting')}</Text>
        </If>
      }>
        <Text class="text-primary font-semibold text-[15px] leading-5" testID={`connected-${id}`}>{str('connected')}</Text>
      </If>
    </View>
  )
}

/** Shared by the answerable kinds: the answer, whether the card still takes a tap, and the send. */
function useAnswer(props: Props) {
  const answer = () => props.row().answer
  const answered = () => answer() !== undefined
  const busy = () => answering().has(props.row().id)
  const canAct = () => !answered() && !busy()
  const dim = () => (connection() !== 'online' ? 'opacity-50' : '')
  const reply = (value: CardAnswer) => { if (canAct()) answerCard(props.row().id, answerText(props.row().card, value)).catch(() => {}) }
  return { answer, answered, busy, canAct, dim, reply }
}

function Choices(props: Props) {
  const id = props.row().id
  const card = () => props.row().card as Extract<Card, { kind: 'choices' }>
  const { answer, answered, busy, canAct, dim, reply } = useAnswer(props)
  const multiple = Boolean(card().multiple)
  const picked = signal<string[]>([])
  const selected = () => { const a = answer(); if (a === undefined) return picked(); return multiple ? a.split(', ') : [a] }
  const isSel = (label: string) => selected().includes(label)
  const tap = (label: string) => {
    if (!canAct()) return
    if (multiple) picked.set(isSel(label) ? picked().filter((x) => x !== label) : [...picked(), label])
    else reply({ choice: label })
  }
  return (
    <View class="gap-2">
      <View class={dim()}>
        {card().options.map((o, i) => (
          <View role="button" testID={isSel(o.label) ? `opt-${id}-${i}-selected` : `opt-${id}-${i}`} disabled={answered()} onPress={() => tap(o.label)}
            class={`flex-row items-center gap-3 min-h-[44px] py-[10px] border-border ${answered() && !isSel(o.label) ? 'opacity-40' : ''} ${answered() ? '' : 'active:opacity-60'}`} style={i > 0 ? { ...SEP, ...FADE } : FADE}>
            <View class="flex-1 min-w-0">
              <Text class={`text-[15px] leading-5 ${isSel(o.label) ? 'text-primary font-semibold' : 'text-foreground'}`}>{o.label}</Text>
              {o.detail ? <Text class="text-muted-foreground text-[13px] leading-[18px]" numberOfLines={3}>{o.detail}</Text> : null}
            </View>
            {multiple
              ? <View class={`w-[22px] h-[22px] rounded-[6px] border-2 items-center justify-center ${isSel(o.label) ? 'border-primary bg-primary' : 'border-input'}`}>{isSel(o.label) ? <Text class="text-primary-foreground text-[13px] font-bold">✓</Text> : null}</View>
              : isSel(o.label) ? <Text class="text-primary text-[17px] font-semibold">✓</Text> : null}
          </View>
        ))}
      </View>
      <If when={multiple && !answered()}>
        <View class={dim()}><Btn kind="primary" testID={`done-${id}`} label={str('cardDone')} disabled={!picked().length || busy()} onPress={() => reply({ choices: card().options.filter((o) => picked().includes(o.label)).map((o) => o.label) })} /></View>
      </If>
    </View>
  )
}

const keyboardFor = (f: CardField) => (f.type === 'number' ? 'decimal-pad' : f.type === 'date' || f.type === 'time' ? 'numbers-and-punctuation' : 'default') as 'decimal-pad' | 'numbers-and-punctuation' | 'default'
const placeholderFor = (f: CardField) => f.placeholder ?? (f.type === 'date' ? 'YYYY-MM-DD' : f.type === 'time' ? 'HH:MM' : '')

function Form(props: Props) {
  const id = props.row().id
  const card = () => props.row().card as Extract<Card, { kind: 'form' }>
  const { answer, answered, busy, dim, reply } = useAnswer(props)
  const init: Record<string, string | boolean> = {}
  for (const f of card().fields) init[f.name] = f.type === 'toggle' ? /^(true|yes|1|on)$/i.test(f.value ?? '') : (f.value ?? '')
  const values = signal(init)
  const set = (name: string, v: string | boolean) => values.set({ ...values(), [name]: v })
  const complete = () => card().fields.every((f) => !f.required || f.type === 'toggle' || String(values()[f.name] ?? '').trim() !== '')
  const inputClass = 'rounded-[12px] px-3 min-h-[44px] bg-black/[0.04] dark:bg-white/[0.06] text-foreground text-[17px]'
  return (
    <View class="gap-3">
      <If when={answered()} else={
        <View class="gap-3">
          {card().fields.map((f) => (
            <View class="gap-1">
              {f.type === 'toggle'
                ? <View class="flex-row items-center justify-between min-h-[44px]"><Text class="text-foreground text-[15px] leading-5 flex-1">{f.label}</Text><Toggle checked={Boolean(values()[f.name])} onChange={(v) => set(f.name, v)} label={f.label} testID={`field-${id}-${f.name}`} /></View>
                : f.type === 'select'
                  ? <View><Text class="text-muted-foreground text-[13px] leading-[18px]">{f.label}</Text>
                      {(f.options ?? []).map((o, i) => (
                        <View role="button" testID={`field-${id}-${f.name}-${i}`} onPress={() => set(f.name, o)} class="flex-row items-center min-h-[44px] py-[10px] border-border active:opacity-60" style={i > 0 ? SEP : undefined}>
                          <Text class={`flex-1 text-[15px] leading-5 ${values()[f.name] === o ? 'text-primary font-semibold' : 'text-foreground'}`}>{o}</Text>
                          {values()[f.name] === o ? <Text class="text-primary text-[17px] font-semibold">✓</Text> : null}
                        </View>
                      ))}
                    </View>
                  : <View class="gap-1"><Text class="text-muted-foreground text-[13px] leading-[18px]">{f.label}{f.required ? ' *' : ''}</Text>
                      <Input testID={`field-${id}-${f.name}`} value={String(values()[f.name] ?? '')} onChange={(v) => set(f.name, v)} placeholder={placeholderFor(f)} keyboardType={keyboardFor(f)} class={inputClass} />
                    </View>}
            </View>
          ))}
          <View class={dim()}><Btn kind="primary" testID={`submit-${id}`} label={card().submit ?? str('cardSubmit')} disabled={!complete() || busy()} onPress={() => reply(values())} /></View>
        </View>
      }>
        <View>{(answer() ?? '').split('\n').filter(Boolean).map((line) => <Text class="text-foreground text-[15px] leading-5">{line}</Text>)}</View>
      </If>
    </View>
  )
}

function Confirm(props: Props) {
  const card = () => props.row().card as Extract<Card, { kind: 'confirm' }>
  const { answer, answered, busy, dim, reply } = useAnswer(props)
  return (
    <If when={answered()} else={
      <View class={`flex-row gap-2 mt-1 ${dim()}`}>
        <Btn wide kind="primary" label={card().yes ?? str('cardYes')} disabled={busy()} onPress={() => reply({ ok: true })} />
        <Btn wide kind="quiet" label={card().no ?? str('cardNo')} disabled={busy()} onPress={() => reply({ ok: false })} />
      </View>
    }>
      <Text class="text-primary font-semibold text-[15px] leading-5">{answer()}</Text>
    </If>
  )
}

/** A table; with `pick` it is a comparison the person answers by tapping a row (the first cell is the answer). */
function Table(props: Props) {
  const id = props.row().id
  const card = () => props.row().card as Extract<Card, { kind: 'table' }>
  const { answer, answered, canAct, dim, reply } = useAnswer(props)
  const pick = Boolean(card().pick)
  const isSel = (r: string[]) => pick && answer() !== undefined && answer() === (r[0] ?? '')
  // Past three columns each would be about 80 points on a phone: a row is a record instead, its first cell, then the others by name.
  const wide = () => card().columns.length > 3
  return (
    <View class={`mt-1 ${pick ? dim() : ''}`}>
      {wide() ? null : (
        <View class="flex-row gap-2 pb-[6px]">
          {card().columns.map((c) => <Text class="flex-1 min-w-0 text-muted-foreground text-[13px] leading-[18px] font-semibold" numberOfLines={2}>{c}</Text>)}
        </View>
      )}
      {card().rows.map((r, j) => (
        <View role={pick ? 'button' : undefined} testID={pick ? (isSel(r) ? `row-${id}-${j}-selected` : `row-${id}-${j}`) : undefined} disabled={pick ? answered() : undefined} onPress={pick ? () => { if (canAct()) reply({ choice: r[0] ?? '' }) } : undefined}
          class={`flex-row gap-2 min-h-[44px] py-[10px] border-border items-center ${pick && answered() && !isSel(r) ? 'opacity-40' : ''} ${pick && !answered() ? 'active:opacity-60' : ''}`} style={{ ...SEP, ...(pick ? FADE : {}) }}>
          {wide() ? (
            <View class="flex-1 min-w-0 gap-[2px]">
              <Text class={`text-[15px] leading-5 font-semibold ${isSel(r) ? 'text-primary' : 'text-foreground'}`} numberOfLines={2}>{r[0] ?? ''}</Text>
              {card().columns.slice(1).map((c, i) => (r[i + 1] ? <Text class="text-muted-foreground text-[15px] leading-5" numberOfLines={2}>{labeled(c, r[i + 1])}</Text> : null))}
            </View>
          ) : card().columns.map((_, i) => <Text class={`flex-1 min-w-0 text-[15px] leading-5 ${isSel(r) ? 'text-primary font-semibold' : 'text-foreground'}`} numberOfLines={3}>{r[i] ?? ''}</Text>)}
          {pick ? <Text class={`w-5 text-center text-[17px] font-semibold ${isSel(r) ? 'text-primary' : 'text-input'}`}>{isSel(r) ? '✓' : answered() ? '' : '›'}</Text> : null}
        </View>
      ))}
    </View>
  )
}

function Progress(props: Props) {
  const id = props.row().id
  const card = () => props.row().card as Extract<Card, { kind: 'progress' }>
  const glyph = (s: 'done' | 'doing' | 'todo') => (s === 'done' ? '✓' : s === 'doing' ? '●' : '○')
  const color = (s: 'done' | 'doing' | 'todo') => (s === 'done' ? 'text-foreground' : s === 'doing' ? 'text-primary' : 'text-input')
  return (
    <View class="mt-1">
      {card().items.map((it, i) => (
        <View class="flex-row items-center gap-3 min-h-[44px] py-[10px] border-border" style={i > 0 ? SEP : undefined} testID={`progress-${id}-${i}-${it.state}`}>
          <Text class={`w-5 text-center text-[17px] ${color(it.state)}`}>{glyph(it.state)}</Text>
          <Text class={`flex-1 text-[15px] leading-5 ${it.state === 'todo' ? 'text-muted-foreground' : 'text-foreground'} ${it.state === 'doing' ? 'font-semibold' : ''}`}>{it.label}</Text>
        </View>
      ))}
    </View>
  )
}

function Summary(props: Props) {
  const id = props.row().id
  const card = () => props.row().card as Extract<Card, { kind: 'summary' }>
  return (
    <View class="mt-1 gap-2">
      <View>
        {card().items.map((it, i) => (
          <View class="flex-row items-start gap-3 min-h-[44px] py-[10px] border-border" style={i > 0 ? SEP : undefined}>
            <Text class="text-muted-foreground text-[15px] leading-5 flex-1" numberOfLines={2}>{it.label}</Text>
            <Text class="text-foreground text-[15px] leading-5 flex-[2] text-right" selectable>{it.value}</Text>
          </View>
        ))}
      </View>
      {card().link ? <Btn kind="soft" testID={`link-${id}`} label={str('cardOpenLink')} onPress={() => { openUrl(card().link!).catch(() => {}) }} /> : null}
    </View>
  )
}

// [agent:genui] ---------------------------------------------------------------
// Second layer: a module the assistant wrote. The row is a card with the title
// and Open; the shell downloads the signed package, verifies it against the
// bot's root key (GET /me uiRootPublicKey) and runs it in a sheet. The module
// posts its own result; the next `rows` frame shows it under the title.

/** Rows whose package is being fetched and opened (Open stays disabled meanwhile). */
const opening = signal<Set<string>>(new Set())

/** [compliance] Open one interface by id: a card in the thread, the Interfaces page, or a link. `busyId` is what shows it busy. */
export async function openInterface(m: { moduleId: string; title: string; url?: string; busyId?: string }) {
  if (connection() !== 'online') { showToast(str('notConnected')); return }
  const s = session(); if (!s) return
  const busyId = m.busyId ?? m.moduleId
  opening.update((x) => new Set(x).add(busyId))
  try {
    const meta = await api().get<{ token?: string; error?: string; permissions?: Permission[]; grants?: Permission[] }>(`/ui/${encodeURIComponent(m.moduleId)}/meta`)
    if (meta.error === 'hidden') { showToast(str('ifHiddenToast')); return }
    // [compliance] what it asked for beyond its own screen, allowed by the person now or before (4.7.3)
    const grants = await askPermissions({ id: m.moduleId, title: m.title, permissions: meta.permissions, grants: meta.grants })
    const sid = sessionId()
    if (!shellOpensModules()) {
      // No native shell to run the package (an app that does not say `ui`, such as the APK `nsh package` makes): the computer
      // makes a one-time play page for the module, bound to this thread (POST /ui/:id/play, src/server.ts), and a web view in a
      // sheet runs it, under a bar with the title and Done (ModulePlayer). `&app=1` tells the page to leave the bar to the
      // app; `&scheme=` gives it the app's light or dark.
      const r = await api().send<{ url?: string }>('POST', `/ui/${encodeURIComponent(m.moduleId)}/play`, sid ? { session: sid } : {})
      if (!r.url) throw new Error('no play page')
      playing.set({ url: `${s.origin}${r.url}&app=1&scheme=${colorScheme()}`, title: m.title })
      return
    }
    if (!meta.token) throw new Error(meta.error ?? 'no token')
    await uiOpen({
      url: `${s.origin}${m.url ?? `/ui/${encodeURIComponent(m.moduleId)}.nshpkg`}${sid ? `?session=${encodeURIComponent(sid)}` : ''}`,
      bundleUrl: `${s.origin}/ui/${encodeURIComponent(m.moduleId)}/bundle.nshc`,
      auth: s.token, token: meta.token, title: m.title,
      rootKey: (me() as { uiRootPublicKey?: string | null } | null)?.uiRootPublicKey ?? '',
      origin: s.origin, moduleId: m.moduleId, grants,
    })
  } catch { showToast(str('moduleFailed')) }
  finally { opening.update((x) => { const n = new Set(x); n.delete(busyId); return n }) }
}

/** The module running in the app's own sheet (no native shell): its play page and title. */
export const playing = signal<{ url: string; title: string } | null>(null)

function openModule(row: ModuleRow) { return openInterface({ moduleId: row.moduleId, title: row.title, url: row.url, busyId: row.id }) }

/**
 * The sheet a module runs in when the app has no native shell for it: nearly the whole screen, a bar with the
 * title and Done (black or white, never blue), the play page in a web view. The page says when the module closed
 * itself after sending its result (`closed`) or could not start (`failed`); Done, back and a swipe close it too.
 */
export function ModulePlayer() {
  const close = () => playing.set(null)
  const heard = (data: string) => { if (data === 'closed') close(); else if (data === 'failed') { close(); showToast(str('moduleFailed')) } }
  return (
    <Sheet open={playing() !== null} onOpenChange={(o) => { if (!o) close() }} side="bottom"
      popupClass="h-[94%] bg-background rounded-t-[14px] overflow-hidden" backdropClass="bg-black/40">
      <If when={playing()}>
        {(p) => (
          <View class="flex-1">
            <View class="flex-row items-center h-[52px] pl-4 pr-2 border-black/[0.08] dark:border-white/[0.10]" style={{ borderBottomWidth: 0.5 }}>
              <Text class="flex-1 text-foreground font-semibold text-[17px]" numberOfLines={1}>{p().title}</Text>
              <View role="button" testID="module-done" accessibilityLabel={str('done')} onPress={close} class="min-w-11 h-11 px-2 items-center justify-center active:opacity-60">
                <Text class="text-foreground font-semibold text-[17px]">{str('done')}</Text>
              </View>
            </View>
            <WebView testID="module-web" src={p().url} class="flex-1 bg-background" onMessage={(e) => heard(e.data)} onError={() => heard('failed')} />
          </View>
        )}
      </If>
    </Sheet>
  )
}

/** The shell's InlineModule (android/…/InlineModule.java): the signed package run where the card is. */
const ModuleBox = nativeComponent<{ url: string; auth: string; token: string; rootKey: string; origin: string; moduleId: string; title: string; grants: string[] }, { size: number; failed: string; close: null; ready: null }>('boop.module', { props: ['url', 'auth', 'token', 'rootKey', 'origin', 'moduleId', 'title', 'grants'], events: ['size', 'failed', 'close', 'ready'] })

/**
 * An interface inside the thread, as tall as what it draws (the build measures its root, src/ui.ts withSizeReport):
 * the person reads and uses it without opening anything; full screen is one tap away. It asks for nothing here: the
 * grants are the ones the person gave before; asking is for opening it full screen. A failure falls back to the card.
 */
const inlineHeights = new Map<string, number>() // by row: a row the list mounts again starts at the height it had

function InlineModule(props: { row: () => ModuleRow; failed: () => void }) {
  const row = props.row()
  const args = signal<{ url: string; auth: string; token: string; rootKey: string; origin: string; moduleId: string; title: string; grants: string[] } | null>(null)
  const height = signal(inlineHeights.get(row.id) ?? 0)
  ;(async () => {
    const s = session(); if (!s) return
    const meta = await api().get<{ token?: string; error?: string; grants?: Permission[] }>(`/ui/${encodeURIComponent(row.moduleId)}/meta`)
    if (!meta.token) { props.failed(); return }
    const sid = sessionId()
    args.set({
      url: `${s.origin}${row.url ?? `/ui/${encodeURIComponent(row.moduleId)}.nshpkg`}${sid ? `?session=${encodeURIComponent(sid)}` : ''}`,
      auth: s.token, token: meta.token, title: row.title,
      rootKey: (me() as { uiRootPublicKey?: string | null } | null)?.uiRootPublicKey ?? '',
      origin: s.origin, moduleId: row.moduleId, grants: meta.grants ?? [],
    })
  })().catch(() => props.failed())
  return (
    <View class="w-full gap-2" testID={`module-inline-${row.id}`} onLongPress={() => { interfaceMenu({ moduleId: row.moduleId, title: row.title }).catch(() => {}) }} delayLongPress={400}>
      <View class="flex-row items-center gap-2">
        <Text class="flex-1 text-foreground font-semibold text-[17px] leading-[22px]" numberOfLines={1}>{row.title}</Text>
        <View role="button" testID={`expand-${row.id}`} onPress={() => { openModule(props.row()) }} class="min-h-[32px] px-2 items-center justify-center active:opacity-60"><Text class="text-muted-foreground text-[15px] leading-5">{str('moduleExpand')}</Text></View>
      </View>
      <If when={props.row().answer !== undefined}><Text class="text-primary font-semibold text-[15px] leading-5" testID={`module-${row.id}-answer`}>{str('moduleAnswered')}{props.row().answer}</Text></If>
      <View class="w-full bg-card rounded-[12px] overflow-hidden" style={{ height: height() || 160 }}>
        <If when={args()}>{(a) => <ModuleBox {...a()} style={{ width: '100%', height: height() || 160 }} onSize={(h) => { inlineHeights.set(row.id, h); height.set(h) }} onFailed={() => props.failed()} />}</If>
      </View>
    </View>
  )
}

export function ModuleView(props: { row: () => ModuleRow }) {
  const inlineFailed = signal(false)
  if (shellRunsInline()) return <If when={!inlineFailed()} else={<ModuleCard row={props.row} />}><InlineModule row={props.row} failed={() => inlineFailed.set(true)} /></If>
  return <ModuleCard row={props.row} />
}

function ModuleCard(props: { row: () => ModuleRow }) {
  const id = props.row().id
  const answered = () => props.row().answer !== undefined
  const busy = () => opening().has(id)
  return (
    <View class="w-full bg-card rounded-[12px] p-4 gap-2" testID={answered() ? `module-${id}-answered` : `module-${id}`} onLongPress={() => { interfaceMenu({ moduleId: props.row().moduleId, title: props.row().title }).catch(() => {}) }} delayLongPress={400}>
      <Text class="text-foreground font-semibold text-[17px] leading-[22px]">{props.row().title}</Text>
      <If when={answered()} else={<Text class="text-muted-foreground text-[15px] leading-5">{str('moduleHint')}</Text>}>
        <Text class="text-primary font-semibold text-[15px] leading-5" testID={`module-${id}-answer`}>{str('moduleAnswered')}{props.row().answer}</Text>
      </If>
      <If when={!answered()}>
        <View class={connection() !== 'online' ? 'opacity-50' : ''}><Btn kind="primary" testID={`open-${id}`} label={str('moduleOpen')} disabled={busy()} onPress={() => { openModule(props.row()) }} /></View>
      </If>
    </View>
  )
}
