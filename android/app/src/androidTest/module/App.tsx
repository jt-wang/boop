// The tip calculator of test/ui.test.ts: what a module the assistant writes looks like. scripts/android-test.sh signs it
// twice (by the bot's key and by another bot's) for ModuleOpenTest.
import { host, mount, signal, Text, View } from 'nsh'
const BILL = 42
function App() {
  const pct = signal(15)
  const tip = () => Math.round(BILL * pct()) / 100
  const send = async () => {
    const p = await host.call<{ origin: string; moduleId: string; token: string }>('launch.params')
    await fetch(`${p.origin}/ui/${p.moduleId}/result`, { method: 'POST', headers: { authorization: `Bearer ${p.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ value: { tip: tip(), pct: pct() }, text: `Tip €${tip().toFixed(2)} (${pct()}%)` }) })
    host.call('ui.close').catch(() => {})
  }
  return (
    <View class="flex-1 bg-background p-4 gap-4">
      <Text class="text-foreground text-[17px] font-semibold">Bill €{BILL.toFixed(2)}</Text>
      <View class="flex-row gap-2">{[10, 15, 20].map((v) => (
        <View role="button" onPress={() => pct.set(v)} class={`flex-1 items-center rounded-[10px] py-3 ${pct() === v ? 'bg-primary' : 'bg-card'}`}><Text class={pct() === v ? 'text-primary-foreground font-semibold' : 'text-foreground'}>{v}%</Text></View>
      ))}</View>
      <Text class="text-foreground text-[34px] font-bold">€{tip().toFixed(2)}</Text>
      <View role="button" onPress={send} class="rounded-[12px] bg-primary py-3 items-center"><Text class="text-primary-foreground font-semibold">Use this</Text></View>
    </View>
  )
}
mount(App)
