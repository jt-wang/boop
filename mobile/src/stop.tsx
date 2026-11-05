// Stop: the one way to interrupt the assistant.
// `StopControl` is a red "Stop" button that exists only while it is working;
// `openStop()` opens the same confirm sheet from a long-press on the status
// line. Confirming posts /sessions/:id/cancel on the bot.
import { effect, Keyboard, signal, Text, View } from 'nsh'
import { Sheet } from 'nsh/base'
import { api, lang, running, sessionId, showToast, str } from './state.ts'
import { STOP_STRINGS } from './i18n.ts'
import { Btn, Glass } from './ui.tsx'

const s = (k: keyof (typeof STOP_STRINGS)['en']) => STOP_STRINGS[lang()][k]

/** The confirm sheet is open. Shared so a long-press elsewhere can open it. */
export const stopOpen = signal(false)
// the keyboard goes down first: on iOS the sheet came up under it, only the dim showed (iOS QA 2026-10-30)
export function openStop() { if (running()) { Keyboard.dismiss(); stopOpen.set(true) } }

/** POST the cancel; returns the HTTP status. Replaceable for headless tests. */
export type StopPoster = (path: string) => Promise<number>
const defaultPost: StopPoster = async (path) => {
  const { origin, token } = api().s
  const r = await fetch(origin + path, { method: 'POST', headers: { authorization: `Bearer ${token}` } })
  return r.status
}

export async function stopTask(post: StopPoster = defaultPost) {
  stopOpen.set(false)
  const id = sessionId()
  if (!id) return
  let status = 0
  try { status = await post(`/sessions/${encodeURIComponent(id)}/cancel`) } catch { status = 0 }
  if (status === 200) showToast(s('stopped'))
  else if (status === 404) showToast(s('stopUnsupported'))
  else showToast(str('failed'))
}

/**
 * A 44pt "Stop" button, visible only while the assistant works, plus its confirm sheet.
 * Place it in the chat header, between the name/status block and the settings gear.
 */
export function StopControl(props: { post?: StopPoster } = {}) {
  // the turn it would stop has ended: the question is gone, so is the sheet (as iOS and Android dismiss an action
  // sheet whose subject disappears; QA 2026-10-28 H7)
  effect(() => { if (!running()) stopOpen.set(false) })
  return (
    <View class="flex-row items-center">
      <If when={running()}>
        {() => (
          <Glass role="button" testID="stop" accessibilityLabel={s('stop')} onPress={openStop} class="h-11 min-w-11 px-[14px] items-center justify-center rounded-full active:opacity-60">
            <Text class="text-destructive font-semibold text-[15px]">{s('stop')}</Text>
          </Glass>
        )}
      </If>
      <Sheet open={stopOpen()} onOpenChange={(o) => stopOpen.set(o)} side="bottom" closeOnSwipe
        popupClass="bg-background dark:bg-card rounded-t-[28px] px-4 pt-5 pb-[calc(env(safe-area-inset-bottom)+16px)] gap-3" backdropClass="bg-black/40">
        <Text class="text-foreground font-semibold text-[17px] text-center">{s('stopTitle')}</Text>
        <Text class="text-muted-foreground text-[15px] text-center leading-5">{s('stopBody')}</Text>
        <View class="gap-2 mt-1">
          <Btn kind="danger" label={s('stopConfirm')} testID="stop-confirm" onPress={() => { stopTask(props.post).catch(() => {}) }} />
          <Btn kind="quiet" label={s('keepGoing')} testID="stop-keep" onPress={() => stopOpen.set(false)} />
        </View>
      </Sheet>
    </View>
  )
}
