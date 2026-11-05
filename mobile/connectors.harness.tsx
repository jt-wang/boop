// Test entry for connectors.test.tsx: the two connector pages on a nav stack,
// with the saved session from storage. App.tsx wires the real routes.
import { mount, Text, View } from 'nsh'
import { createNavStack, NavPage, NavStack } from 'nsh/base'
import { boot, me, str, toast } from './src/state.ts'
import { ConnectorAddPage, ConnectorPage, ConnectorsPage } from './src/connectors.tsx'

type Route = { name: 'connectors' } | { name: 'connector-add' } | { name: 'connector'; id: string }

function Harness() {
  const nav = createNavStack<Route>([{ name: 'connectors' }])
  boot().catch(() => {})
  return (
    <View class="flex-1 bg-background">
      <If when={me()}>
        {() => (
          <NavStack state={nav} class="flex-1">
            {(route) => {
              switch (route.name) {
                case 'connectors': return <NavPage title={str('connectors')}><ConnectorsPage onOpen={(id) => nav.push({ name: 'connector', id })} onAdd={() => nav.push({ name: 'connector-add' })} /></NavPage>
                case 'connector': return <NavPage title=""><ConnectorPage id={route.id} onClose={() => nav.pop()} onTry={() => nav.popToRoot()} /></NavPage>
                case 'connector-add': return <NavPage title={str('advanced')}><ConnectorAddPage onDone={() => nav.pop()} /></NavPage>
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
