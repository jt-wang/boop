// Test host for module rows (mobile/modules.test.tsx): the real state and API
// against a mocked bot, showing the module rows of the thread and nothing else.
import { mount, Storage, Text, View } from 'nsh'
import { connect, connection, lang, rows, toast } from './src/state.ts'
import { ModulePlayer, ModuleView } from './src/cards.tsx'
import type { ModuleRow } from './src/fold.ts'

const ORIGIN = 'http://127.0.0.1:3850'

function Fixture() {
  Storage.getItem('lang').then((l) => { if (l === 'zh') lang.set('zh') })
  Storage.getItem('offline').then(async (off) => {
    await connect({ origin: ORIGIN, token: 'tok_test' })
    connection.set(off === '1' ? 'offline' : 'online')
  })
  const modules = () => rows().filter((r): r is ModuleRow => r.kind === 'module')
  return (
    <View class="flex-1 bg-background pt-12 px-4 gap-3">
      <Each of={modules()} key={(r) => r.id}>{(r) => <ModuleView row={r} />}</Each>
      <ModulePlayer />
      <If when={toast()}>{(m) => <View class="absolute left-0 right-0 items-center" style={{ bottom: 96 }}><View class="bg-foreground rounded-full px-4 py-[10px]"><Text class="text-background text-[14px]" testID="toast">{m()}</Text></View></View>}</If>
    </View>
  )
}

mount(Fixture)
