// Test host for the thread (mobile/guard.test.tsx, mobile/chatnotes.test.tsx): the real chat screen against a
// mocked bot. Thread frames arrive as the host sends them (`app.host.send('thread', …)`). What the screen asks to
// open (the memory a note points at) goes to storage.opened.
import { mount, Storage, Text, View } from 'nsh'
import { connect, connection, lang, toast } from './src/state.ts'
import { ChatScreen } from './src/chat.tsx'

const ORIGIN = 'http://127.0.0.1:3850'

function Fixture() {
  Storage.getItem('lang').then((l) => { if (l === 'zh' || l === 'en') lang.set(l) }).then(() => connect({ origin: ORIGIN, token: 'tok_test' })).then(() => connection.set('online')).catch(() => {})
  return (
    <View class="flex-1 bg-background">
      <ChatScreen onMenu={() => {}} onIdentity={() => { Storage.setItem('opened', 'profile').catch(() => {}) }} onMemory={(focus) => { Storage.setItem('opened', `memory:${focus ?? ''}`).catch(() => {}) }} onSettings={() => {}} />
      <If when={toast()}>{(m) => <View class="absolute left-0 right-0 items-center" style={{ bottom: 96 }}><Text testID="toast" class="text-foreground text-[14px]">{m()}</Text></View>}</If>
    </View>
  )
}

mount(Fixture)
