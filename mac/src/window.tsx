// The one window: what the assistant is doing, the pairing code to scan, Copy, Quit.
// Black and white only (the theme in nsh.json); nothing a developer would need to read.
import { Clipboard, Image, signal, Text, View, type Accessor } from 'nsh'
import mark from '../assets/mark.png'
import { QrCanvas } from './qr.tsx'
import { str } from './strings.ts'
import type { BotState } from './supervisor.ts'

const QR = 272

function Btn(props: { label: string; kind: 'soft' | 'quiet'; onPress: () => void; testID?: string }) {
  return (
    <View role="button" testID={props.testID} onPress={props.onPress}
      class={`rounded-full px-5 min-h-[40px] items-center justify-center active:opacity-70 ${props.kind === 'soft' ? 'bg-primary/10 dark:bg-primary/20' : 'bg-transparent'}`}>
      <Text class={`font-semibold text-[15px] ${props.kind === 'soft' ? 'text-primary' : 'text-muted-foreground'}`} numberOfLines={1}>{props.label}</Text>
    </View>
  )
}

export function Window(props: { state: Accessor<BotState>; matrix: Accessor<number[][] | null>; onQuit: () => void }) {
  const s = props.state
  const copied = signal(false)
  const running = () => s().phase === 'running'
  // A TailPocket code is scanned from inside Boop on the phone and runs to hundreds of characters; a link is scanned by the camera.
  const invite = () => (s().pairUrl ?? '').startsWith('tailpocket1:')
  const status = () => str(s().phase)
  const copy = async () => {
    const url = s().pairUrl
    if (!url) return
    await Clipboard.writeText(url)
    copied.set(true)
    setTimeout(() => copied.set(false), 2000)
  }
  return (
    <View class="flex-1 bg-background items-center justify-center px-10 py-8">
      <View class="items-center gap-4" style={{ width: 400 }}>
        <Image src={mark} style={{ width: 64, height: 64 }} class="rounded-[16px]" />
        <Text class="text-foreground text-[24px] font-bold">Boop</Text>
        <View class="flex-row items-center gap-2">
          <View class={`w-2 h-2 rounded-full ${running() ? 'bg-foreground' : 'bg-muted-foreground'}`} />
          <Text testID="status" class="text-foreground text-[15px] text-center">{status()}</Text>
        </View>

        <View class="items-center justify-center rounded-[20px] bg-card overflow-hidden mt-2" style={{ width: QR + 24, height: QR + 24 }}>
          <If when={running() ? props.matrix() : null} else={<Text class="text-muted-foreground text-[15px] text-center px-8 leading-5">{s().phase === 'failed' ? str('failed') : str('waiting')}</Text>}>
            {(m) => <View class="bg-white rounded-[12px] overflow-hidden"><QrCanvas testID="qr" matrix={m()} size={QR} /></View>}
          </If>
        </View>

        <If when={running()}>
          <View class="items-center gap-2 mt-1">
            <Text class="text-foreground text-[17px] font-semibold">{str('scanTitle')}</Text>
            <Text class="text-muted-foreground text-[15px] text-center leading-5">{str(invite() ? 'pocketScanBody' : 'scanBody')}</Text>
            <If when={!invite()}>
              <Text testID="link" class="text-foreground text-[13px] text-center mt-2">{s().pairUrl ?? ''}</Text>
              <Text testID="code" class="text-foreground text-[15px] font-semibold">{`${str('code')} ${s().code ?? ''}`}</Text>
            </If>
            <Btn kind="soft" testID="copy" label={copied() ? str('copied') : str(invite() ? 'copyCode' : 'copyLink')} onPress={copy} />
          </View>
        </If>

        <View class="items-center gap-1 mt-4">
          <Text class="text-muted-foreground text-[13px] text-center">{str('keepOpen')}</Text>
          <Btn kind="quiet" testID="quit" label={str('quit')} onPress={props.onQuit} />
        </View>
      </View>
    </View>
  )
}
