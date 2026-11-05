// Test host for the cards (mobile/cards.test.tsx): the real state and API
// against a mocked bot, showing the card rows of the thread and nothing else.
// Thread frames arrive as the app's host sends them (`app.host.send('thread', …)`).
//   storage.offline = '1' → the phone is not connected to the bot
//   storage.lang = 'zh'    → the person's language is Chinese
import { mount, Storage, Text, View } from 'nsh'
import { connect, connection, lang, rows, toast } from './src/state.ts'
import { CardView } from './src/cards.tsx'
import type { CardRow } from './src/fold.ts'

const ORIGIN = 'http://127.0.0.1:3850'

function Fixture() {
  Storage.getItem('lang').then((l) => { if (l === 'zh' || l === 'en') lang.set(l) }).catch(() => {})
  Storage.getItem('offline').then(async (off) => {
    await connect({ origin: ORIGIN, token: 'tok_test' })
    connection.set(off === '1' ? 'offline' : 'online')
  })
  const cards = () => rows().filter((r): r is CardRow => r.kind === 'card')
  return (
    <View class="flex-1 bg-background pt-12 px-4 gap-3">
      <Each of={cards()} key={(r) => r.id}>{(r) => <CardView row={r} />}</Each>
      <If when={toast()}>{(m) => <View class="absolute left-0 right-0 items-center" style={{ bottom: 96 }}><View class="bg-foreground rounded-full px-4 py-[10px]"><Text class="text-background text-[14px]" testID="toast">{m()}</Text></View></View>}</If>
    </View>
  )
}

mount(Fixture)
