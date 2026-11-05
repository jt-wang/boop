// Test entry for library.test.tsx: mounts the Library pages alone (App.tsx owns the real routes).
import { mount, View } from 'nsh'
import { createNavStack, NavPage, NavStack } from 'nsh/base'
import { boot, me, str } from './src/state.ts'
import { fileName, LibraryFilePage, LibraryPage } from './src/library.tsx'

type Route = { name: 'library' } | { name: 'file'; path: string }

function Harness() {
  const nav = createNavStack<Route>([{ name: 'library' }])
  boot().catch(() => {})
  return (
    <View class="flex-1 bg-background">
      <If when={me()?.assistant.name}>
        {() => (
          <NavStack state={nav} class="flex-1">
            {(route) => route.name === 'library'
              ? <NavPage title={str('library')}><LibraryPage onOpen={(path) => nav.push({ name: 'file', path })} /></NavPage>
              : <NavPage title={fileName(route.path)}><LibraryFilePage path={route.path} onDeleted={() => nav.pop()} /></NavPage>}
          </NavStack>
        )}
      </If>
    </View>
  )
}

mount(Harness)
