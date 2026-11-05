// Test entry for profile.test.tsx, memory.test.tsx and guard.test.tsx: the assistant's profile and the pages it
// opens (memory edit, connectors, one connector) on a nav stack, with the saved session from storage.
//   storage.tab   = activity | permissions | upcoming | memory (default activity)
//   storage.focus = text of a memory item to show first (what a chat note opens)
// What the profile asked to open goes to storage.opened, for the test to read.
import { mount, signal, Storage, Text, View } from 'nsh'
import { createNavStack, NavPage, NavStack } from 'nsh/base'
import { boot, me, toast } from './src/state.ts'
import { ProfilePage, type MemoryItem, type ProfileTab } from './src/profile.tsx'
import { MemoryEditPage } from './src/memory.tsx'
import { ConnectorPage, ConnectorsPage } from './src/connectors.tsx'

type Route = { name: 'profile' } | { name: 'memory-edit'; item: MemoryItem } | { name: 'connectors' } | { name: 'connector'; id: string }

function Harness() {
  const nav = createNavStack<Route>([{ name: 'profile' }])
  const tab = signal<ProfileTab | null>(null)
  const focus = signal<string | undefined>(undefined)
  Promise.all([Storage.getItem('tab'), Storage.getItem('focus')]).then(([t, f]) => { focus.set(f ?? undefined); tab.set((t as ProfileTab) || 'activity') }).catch(() => tab.set('activity'))
  boot().catch(() => {})
  const opened = (what: string) => { Storage.setItem('opened', what).catch(() => {}) }
  return (
    <View class="flex-1 bg-background">
      <If when={me() && tab()}>
        {() => (
          <NavStack state={nav} class="flex-1">
            {(route) => {
              switch (route.name) {
                case 'profile': return <NavPage title=""><ProfilePage tab={tab()!} focus={focus()} onEditName={() => opened('settings')} onConnectors={() => nav.push({ name: 'connectors' })} onConnector={(id) => nav.push({ name: 'connector', id })} onEditMemory={(item) => nav.push({ name: 'memory-edit', item })} /></NavPage>
                case 'memory-edit': return <NavPage title="Memory"><MemoryEditPage item={route.item} onDone={() => nav.pop()} /></NavPage>
                case 'connectors': return <NavPage title="Connectors"><ConnectorsPage onOpen={(id) => nav.push({ name: 'connector', id })} onAdd={() => opened('advanced')} /></NavPage>
                case 'connector': return <NavPage title=""><ConnectorPage id={route.id} onClose={() => nav.pop()} onTry={() => opened('chat')} /></NavPage>
              }
            }}
          </NavStack>
        )}
      </If>
      <If when={toast()}>{(m) => <View class="absolute left-0 right-0 items-center" style={{ bottom: 96 }}><Text testID="toast" class="text-foreground text-[14px]">{m()}</Text></View>}</If>
    </View>
  )
}

mount(Harness)
