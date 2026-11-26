// Approval and question cards: the only two places the assistant waits for a
// human. A card is a row of the thread; answering it
// removes the card at once and leaves a grey one-line notice.
import type { Lang } from './locale.ts'
import { effect, Scroll, signal, Text, View, type JSX, type Signal } from 'nsh'
import { Input } from 'nsh/base'
import { toolWord } from './fold.ts'
import { addNotice, answerApproval, answerQuestion, asks, lang, str, t, toolPhrase, type Ask } from './state.ts'
import { Btn, Card, RADIUS } from './ui.tsx'

const SHORT_LINES = 8

type Draft = { selected: Signal<string[]>; custom: Signal<string> }
/**
 * A question's answer so far, by its event. The pager above the composer shows one card at a time (chat.tsx), so
 * paging away unmounts the card; its choices and typed answer wait here and are there again when it comes back.
 * They belong to the question as it was asked: when its parts change (another list of part ids), they start empty.
 * An event that leaves the waiting list (answered, cancelled, a reset) loses its draft at once, so a question that
 * comes again under the same event starts empty too.
 */
const answersSoFar = new Map<string, { parts: string; drafts: Draft[] }>()
effect(() => { const live = new Set(asks().map((a) => a.eventId)); for (const id of [...answersSoFar.keys()]) if (!live.has(id)) answersSoFar.delete(id) })
function draftsFor(ask: Ask, ids: string[]): Draft[] {
  const parts = JSON.stringify(ids)
  let d = answersSoFar.get(ask.eventId)
  if (!d || d.parts !== parts) { d = { parts, drafts: ids.map(() => ({ selected: signal<string[]>([]), custom: signal('') })) }; answersSoFar.set(ask.eventId, d) }
  return d.drafts
}

/**
 * Why it asks: the agent's own words, shown as it wrote them and never translated or edited. When it gave versions,
 * the person's language, else the one a reader of it reads best, else English; anything it wrote beats nothing.
 */
function reasonFor(r: { displayReason?: Record<string, string>; reason?: string }, l: Lang): string {
  const given = r.displayReason
  return given?.[l] || (NEAREST[l] && given?.[NEAREST[l]!]) || given?.en || r.reason || ''
}
/** A language whose reader reads this one better than English. */
const NEAREST: Partial<Record<Lang, Lang>> = { 'zh-Hant': 'zh' }

/**
 * `onFixed`: the height of what stays when the card is squeezed (its buttons), for the room above the composer (chat.tsx).
 * `pager`: with more than one card waiting, the pager, drawn at the right of the card's title row so it takes no row of
 * its own (a row more left the thread's last message half shown on an iPhone SE at the largest text); `onHead` its row's height.
 * `oneLine`: the title row keeps the title to one line (an ellipsis, the whole of it read aloud) when the room is so short
 * that a wrapped title would leave the thread no line; `onBody`: the height of what it asks, which is always shown whole.
 */
export function AskCard(props: { ask: Ask; onFixed?: (h: number) => void; pager?: () => JSX.Element | null; onHead?: (h: number) => void; oneLine?: () => boolean; onBody?: (h: number) => void }) {
  const paged = () => Boolean(props.pager?.())
  const ask = props.ask
  if (ask.kind === 'approval') {
    const r = ask.request
    const reason = reasonFor(r, lang())
    const long = reason.split('\n').length > SHORT_LINES || reason.length > 600
    const expanded = signal(false)
    // what it wants to do, in words (fold.ts toolWord); the tool's own name never shows
    const what = r.toolName ? toolWord(r.toolName, lang()) : ''
    const answer = (outcome: 'allowed-once' | 'rejected', remember?: 'task' | 'always') => {
      answerApproval(ask, outcome, remember)
      addNotice(outcome === 'rejected' ? str('declined') : t('allowed')(toolPhrase(r.toolName ?? '', lang())))
    }
    return (
      // Pinned above the composer the card may get less room than it needs (a small phone, large text, the keyboard up):
      // what it asks scrolls inside it, and Decline and Allow under it stay in view and in reach.
      <Card class={`${paged() ? 'pt-1' : 'pt-3'} pb-4 gap-2`} style={{ flexShrink: 1 }} testID={`ask-${ask.eventId}`}>
        {paged() ? <View testID="ask-head" class="flex-row items-center pl-4 pr-1" onLayout={({ bounds: b }) => props.onHead?.(b.size.height)}>
          <Text testID={props.oneLine?.() ? 'ask-title-one-line' : 'ask-title'} accessibilityLabel={what} class="flex-1 min-w-0 text-foreground font-semibold text-[17px] leading-[22px]" style={props.oneLine?.() ? { numberOfLines: 1 } : undefined}>{what}</Text>
          {props.pager?.()}
        </View> : null}
        <Scroll testID="ask-body" style={{ flexGrow: 0, flexShrink: 1 }} contentClass="px-4" keyboardShouldPersistTaps="handled">
        <View class="gap-2" onLayout={({ bounds: b }) => props.onBody?.(b.size.height)}>
        {what && !paged() ? <Text class="text-foreground font-semibold text-[17px] leading-[22px]">{what}</Text> : null}
        {reason ? <View testID="ask-reason" class="bg-black/[0.05] dark:bg-white/[0.07] px-3 py-2" style={{ borderRadius: RADIUS.inner }}><Text class="text-foreground text-[15px] leading-5" style={{ userSelect: 'text' }}>{expanded() || !long ? reason : reason.split('\n').slice(0, SHORT_LINES).join('\n') + '\n…'}</Text></View> : null}
        {long ? <View role="button" onPress={() => expanded.set(!expanded())} class="self-start py-1 active:opacity-60"><Text class="text-primary text-[15px]">{expanded() ? str('hideDetails') : str('viewDetails')}</Text></View> : null}
        </View>
        </Scroll>
        {/* Deny and Allow as two equal capsules, the plain one left, the filled one right. The two scoped allows stay as text under them. */}
        <View class="gap-2 mt-1" onLayout={({ bounds: b }) => props.onFixed?.(b.size.height)}>
          <View class="flex-row gap-2 px-4">
            <Btn wide kind="soft" label={str('decline')} onPress={() => answer('rejected')} />
            <Btn wide kind="primary" label={str('allowOnce')} onPress={() => answer('allowed-once')} />
          </View>
          <View class="flex-row justify-center gap-7 px-4">
            <View role="button" onPress={() => answer('allowed-once', 'task')} class="min-h-[36px] justify-center active:opacity-60"><Text class="text-muted-foreground text-[15px] leading-5">{str('allowTask')}</Text></View>
            <View role="button" onPress={() => answer('allowed-once', 'always')} class="min-h-[36px] justify-center active:opacity-60"><Text class="text-muted-foreground text-[15px] leading-5">{str('allowAlways')}</Text></View>
          </View>
        </View>
      </Card>
    )
  }
  props.onBody?.(0)
  const qs = ask.request.questions ?? []
  const drafts = draftsFor(ask, qs.map((q, i) => String(q.id ?? i)))
  const submit = (skip = false) => {
    answerQuestion(ask, qs.map((q, i) => {
      const a: { id: string; selected: string[]; custom?: string } = { id: q.id, selected: skip ? [] : drafts[i].selected() }
      const c = drafts[i].custom().trim(); if (!skip && c) { a.custom = c; a.selected = [] }
      return a
    }))
    addNotice(str(skip ? 'skipped' : 'answered'))
  }
  return (
    <Card class={`${paged() ? 'pt-1' : 'pt-3'} pb-4 gap-3`} style={{ flexShrink: 1 }} testID={`ask-${ask.eventId}`}>
      {paged() ? <View testID="ask-head" class="flex-row items-center justify-end pr-1" onLayout={({ bounds: b }) => props.onHead?.(b.size.height)}>{props.pager?.()}</View> : null}
      <Scroll testID="ask-body" style={{ flexGrow: 0, flexShrink: 1 }} contentClass="px-4 gap-3" keyboardShouldPersistTaps="handled">
      {qs.map((q, qi) => {
        const multi = Boolean(q.multiSelect || q.multiple)
        return (
          <View class="gap-2">
            <Text class="text-foreground font-semibold text-[17px] leading-[22px]">{q.prompt || q.question || q.text || q.title || ''}</Text>
            {q.detail ? <Text class="text-muted-foreground text-[15px] leading-5">{q.detail}</Text> : null}
            {(q.options ?? []).map((o, oi) => {
              const label = typeof o === 'string' ? o : (o.label ?? o.value ?? o.name ?? '')
              const desc = typeof o === 'string' ? '' : (o.description ?? '')
              const on = () => drafts[qi].selected().includes(label)
              return (
                <View role="button" onPress={() => { const cur = drafts[qi].selected(); drafts[qi].selected.set(multi ? (cur.includes(label) ? cur.filter((x) => x !== label) : [...cur, label]) : [label]); drafts[qi].custom.set('') }}
                  class="flex-row items-center gap-3 min-h-[44px] py-[10px] border-border active:opacity-70" style={oi > 0 ? { borderTopWidth: 0.5 } : undefined}>
                  <View class={`w-[22px] h-[22px] ${multi ? 'rounded-[6px]' : 'rounded-full'} border-2 items-center justify-center ${on() ? 'border-primary bg-primary' : 'border-input'}`}>
                    {on() ? <Text class="text-primary-foreground text-[13px] font-bold">✓</Text> : null}
                  </View>
                  <View class="flex-1 min-w-0">
                    <Text class="text-foreground text-[17px] leading-[22px]">{label}</Text>
                    {desc ? <Text class="text-muted-foreground text-[15px] leading-5" style={{ numberOfLines: 3 }}>{desc}</Text> : null}
                  </View>
                </View>
              )
            })}
            {q.allowCustom === false ? null : <Input testID={`ask-custom-${q.id}`} placeholder={str('custom')} value={drafts[qi].custom()} onChange={({ value: v }) => { drafts[qi].custom.set(v); if (v) drafts[qi].selected.set([]) }} class="rounded-[12px] px-3 min-h-[44px] bg-black/[0.04] dark:bg-white/[0.06] text-foreground text-[17px]" />}
          </View>
        )
      })}
      </Scroll>
      <View class="flex-row gap-2 mt-1 px-4" onLayout={({ bounds: b }) => props.onFixed?.(b.size.height)}>
        <Btn wide kind="primary" label={str('answer')} onPress={() => submit(false)} />
        <Btn wide kind="quiet" label={str('skip')} onPress={() => submit(true)} />
      </View>
    </Card>
  )
}
