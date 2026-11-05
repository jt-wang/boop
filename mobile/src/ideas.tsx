// Ideas: three things the assistant could do for you now, each one tap from
// the main thread. "Do it" sends the idea's message; "Not now" hides it.
import { resource, signal, Scroll, Text, View } from 'nsh'
import { api, send, showToast, str } from './state.ts'
import { Btn, Card, Empty, Hint, Page } from './ui.tsx'

export interface Idea { id: string; title: string; body: string; action: string; createdAt: string; dismissed: boolean }

export function IdeasPage(props: { onSent: () => void }) {
  const list = resource(() => 0, async () => api().get<Idea[]>('/ideas'))
  const busy = signal(false)
  const refresh = async () => {
    if (busy()) return
    busy.set(true)
    try { list.mutate(await api().send<Idea[]>('POST', '/ideas/refresh')) } catch { showToast(str('failed')) } finally { busy.set(false) }
  }
  const doIt = async (i: Idea) => {
    try { await send(i.action); props.onSent() } catch { showToast(str('failed')) }
  }
  const notNow = async (i: Idea) => {
    list.mutate((list() ?? []).filter((x) => x.id !== i.id))
    try { await api().send('POST', `/ideas/${encodeURIComponent(i.id)}/dismiss`) } catch { showToast(str('failed')); list.refetch() }
  }
  return (
    <Page page="IdeasPage" contentClass="gap-3 px-4 py-3 pb-[calc(env(safe-area-inset-bottom)+24px)]" refreshing={busy()} onRefresh={refresh} testID="ideas">
      <View class="flex-row items-center gap-3">
        <View class="flex-1"><Hint text={str('ideasHint')} /></View>
        <Btn testID="ideas-refresh" label={busy() ? str('thinking') : str('refresh')} disabled={busy()} onPress={refresh} />
      </View>
      {list.loading() && !list() ? null : (list() ?? []).length === 0 ? <View class="py-16"><Empty text={str('noIdeas')} /></View> : (list() ?? []).map((i) => (
        <Card class="px-4 py-4 gap-1" testID={`idea-${i.id}`}>
          <Text class="text-foreground font-semibold text-[17px]">{i.title}</Text>
          {i.body ? <Text class="text-muted-foreground text-[15px] leading-5">{i.body}</Text> : null}
          <Text class="text-muted-foreground text-[13px] mt-1" numberOfLines={2}>“{i.action}”</Text>
          <View class="flex-row gap-2 mt-2">
            <Btn wide kind="primary" testID={`idea-${i.id}-do`} label={str('doIt')} onPress={() => doIt(i)} />
            <Btn wide kind="quiet" testID={`idea-${i.id}-dismiss`} label={str('notNow')} onPress={() => notNow(i)} />
          </View>
        </Card>
      ))}
    </Page>
  )
}
