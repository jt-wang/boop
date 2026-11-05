// Test entry for the Ideas page alone (mobile/ideas.test.tsx): the real state
// and API, no App.tsx navigation. "Do it" flips a line so the test can see it.
import { mount, signal, Text, View } from 'nsh'
import { boot, me, str, toast } from './src/state.ts'
import { IdeasPage } from './src/ideas.tsx'

function Harness() {
  const sent = signal(false)
  boot().catch(() => {})
  return (
    <View class="flex-1 bg-background">
      <If when={me()} else={<Text>connecting</Text>}>
        {() => <If when={sent()} else={<IdeasPage onSent={() => sent.set(true)} />}>{() => <Text testID="sent">{str('sentToThread')}</Text>}</If>}
      </If>
      <If when={toast()}>{(m) => <Text testID="toast">{m()}</Text>}</If>
    </View>
  )
}

mount(Harness)
