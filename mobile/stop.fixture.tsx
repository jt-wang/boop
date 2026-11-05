// Test host for StopControl (mobile/stop.test.tsx): the chat header's right side
// with the control, driven by storage flags instead of a live bot.
//   storage.running = '1'  → the assistant is working
//   storage.status   = HTTP status the fake bot answers to POST /sessions/main/cancel
//   storage.endAfter = ms after which the turn ends by itself (running goes false)
import { mount, Storage, Text, View } from 'nsh'
import { StopControl } from './src/stop.tsx'
import { running, sessionId, toast } from './src/state.ts'

const ORIGIN = 'http://127.0.0.1:3850'

function Fixture() {
  Storage.getItem('running').then((v) => { sessionId.set('main'); running.set(v === '1') })
  Storage.getItem('endAfter').then((ms) => { if (ms) setTimeout(() => running.set(false), Number(ms)) })
  const post = async (path: string) => (await fetch(ORIGIN + path, { method: 'POST', headers: { authorization: 'Bearer tok_test' } })).status
  return (
    <View class="flex-1 bg-background pt-12">
      <View class="flex-row items-center gap-3 px-[14px] py-[10px] border-b border-border">
        <View class="flex-1"><Text class="text-foreground font-semibold text-[17px]">Nori</Text><Text class="text-[14px] text-primary">{running() ? 'Working…' : 'Online'}</Text></View>
        <StopControl post={post} />
      </View>
      <If when={toast()}>{(m) => <View class="absolute left-0 right-0 items-center" style={{ bottom: 96 }}><View class="bg-foreground rounded-full px-4 py-[10px]"><Text class="text-background text-[14px]">{m()}</Text></View></View>}</If>
    </View>
  )
}

mount(Fixture)
