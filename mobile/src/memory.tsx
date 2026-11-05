// Memory as the person sees it:
// the profile's Memory segment lists it (profile.tsx); this page changes one
// item — its words and its group — or forgets it. The files stay the storage;
// nobody edits them here.
import { formatDate } from './locale.ts'
import { signal, Text, View } from 'nsh'
import { AlertDialog, Input } from 'nsh/base'
import { api, lang, showToast } from './state.ts'
import { cm } from './i18n-cm.ts'
import { Btn, Page } from './ui.tsx'
import { Glyph } from './kit.tsx'
import { GROUPS, memoryVersion, ProfilePage, type MemoryItem } from './profile.tsx'

export type { MemoryItem }

/** The memory list alone (the profile opened on its Memory segment). */
export function MemoryPage(props: { focus?: string; onEdit?: (it: MemoryItem) => void } = {}) {
  return <ProfilePage tab="memory" focus={props.focus} onEditName={() => {}} onConnectors={() => {}} onConnector={() => {}} onEditMemory={props.onEdit ?? (() => {})} />
}

const groupOf = (k: MemoryItem['kind']) => GROUPS.find((g) => g.kinds.includes(k))!.key
const kindFor = (group: (typeof GROUPS)[number]['key'], was: MemoryItem['kind']): MemoryItem['kind'] => (group === 'memAboutYou' ? (was === 'preference' || was === 'fact' ? was : 'fact') : group === 'memTracking' ? 'project' : group === 'memDecisions' ? 'decision' : 'person')

/** Change one item: its words (a text field, the keyboard's Done saves), its group (four rows, one checked), or forget it. */
export function MemoryEditPage(props: { item: MemoryItem; onDone: () => void }) {
  const text = signal(props.item.text)
  const group = signal(groupOf(props.item.kind))
  const busy = signal(false)
  const changed = () => text().trim() !== props.item.text || group() !== groupOf(props.item.kind)
  const save = async () => {
    if (!text().trim() || busy()) return
    if (!changed()) { props.onDone(); return }
    busy.set(true)
    try {
      const r = await api().send<{ id?: string; error?: string }>('PATCH', `/memory/${encodeURIComponent(props.item.id)}`, { text: text().trim(), kind: kindFor(group(), props.item.kind) })
      if (r.error && /already/.test(r.error)) { showToast(cm('memDuplicate')); return }
      if (!r.id) throw new Error(r.error ?? 'failed')
      memoryVersion.set(memoryVersion() + 1); showToast(cm('memSaved')); props.onDone()
    } catch { showToast(cm('memFailed')) } finally { busy.set(false) }
  }
  const forget = async () => {
    const ok = await AlertDialog.show({ title: cm('memForgetTitle'), description: props.item.text, actions: [{ id: 'cancel', label: cm('memCancel'), role: 'cancel' }, { id: 'ok', label: cm('memForget'), role: 'destructive' }] }).then((r) => r === 'ok').catch(() => false)
    if (!ok) return
    try { await api().send('DELETE', `/memory/${encodeURIComponent(props.item.id)}`); memoryVersion.set(memoryVersion() + 1); showToast(cm('memForgotten')); props.onDone() } catch { showToast(cm('memFailed')) }
  }
  const learned = () => formatDate(props.item.date, lang()) || props.item.date
  return (
    <Page page="MemoryEditPage" class="flex-1 bg-card dark:bg-background pb-[env(keyboard-inset-height)]" contentClass="px-4 pt-4 gap-2 pb-[calc(env(safe-area-inset-bottom)+32px)]" keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive" testID="memory-edit">
      <View class="rounded-[12px] bg-background dark:bg-card px-4 py-[11px]">
        <Input testID="memory-text" value={text()} onChange={(v) => text.set(v)} multiline maxLength={300} returnKeyType="done" submitBehavior="blurAndSubmit" onSubmit={() => { save().catch(() => {}) }} accessibilityLabel={cm('memEditTitle')}
          class="bg-transparent text-foreground text-[17px] leading-[22px] min-h-[66px]" />
      </View>
      <View class="px-4"><Text class="text-muted-foreground text-[13px] leading-[18px]">{cm('memLearned')(learned())}</Text></View>
      <View class="px-4"><Text class="text-muted-foreground text-[13px] leading-[18px] pt-5">{cm('memGroup')}</Text></View>
      <View class="rounded-[12px] bg-background dark:bg-card overflow-hidden">
        {GROUPS.map((g, i) => (
          <View role="button" accessibilityState={{ selected: group() === g.key }} testID={`group-${g.key}`} onPress={() => group.set(g.key)} class="pl-4 active:bg-black/[0.04] dark:active:bg-white/[0.06]">
            <View class="flex-row items-center min-h-[44px] pr-4 border-border" style={i ? { borderTopWidth: 0.5 } : undefined}>
              <Text class="flex-1 text-foreground text-[17px]">{cm(g.key)}</Text>
              {group() === g.key ? <Glyph name="check" size={20} /> : null}
            </View>
          </View>
        ))}
      </View>
      <View class="pt-8 gap-3">
        <Btn kind="primary" label={cm('memSave')} testID="memory-save" disabled={busy() || !text().trim()} onPress={() => { save().catch(() => {}) }} />
        <Btn kind="danger" label={cm('memForget')} testID="memory-forget" onPress={() => { forget().catch(() => {}) }} />
      </View>
    </Page>
  )
}
