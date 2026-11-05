// Files the assistant hands over (DSH's `present`, a `file` row) and images its replies point at: shown from the
// computer's library (GET /library/file?path=…&format=json, with the device's token), so they come the same way
// from a computer on the desk and from one the host runs. A browser screenshot comes the same way from the harness's
// attachment store (GET /library/attachment?session=…&id=…). An image shows in the thread at the thread's width; any
// other file is a card; a tap opens the file's own page (library.tsx).
import { effect, Image, signal, Text, untracked, View, type Signal } from 'nsh'
import { api, connection, sessionId, str } from './state.ts'
import type { FileRow } from './fold.ts'
import { Card } from './ui.tsx'
import { Glyph, muted } from './kit.tsx'

type FileBody = { kind: 'text' | 'image' | 'binary'; mime: string; size: number; base64?: string }
type Outcome = { src: string } | 'gone' | 'retry'

/**
 * One fetch of an image from the computer. `gone`: the computer answered and there is no image to show (missing,
 * refused, another kind of file); another try will not change that. `retry`: no answer, a timeout or a server error,
 * which is what a slow or broken connection looks like.
 */
async function fetchImage(url: string): Promise<Outcome> {
  try {
    const bot = api()
    const r = await fetch(`${bot.s.origin}${url}`, { headers: { authorization: `Bearer ${bot.s.token}` } })
    if (r.status >= 500 || r.status === 408 || r.status === 429) return 'retry'
    if (r.status !== 200) return 'gone'
    const b = await r.json() as FileBody
    return b?.kind === 'image' && b.base64 ? { src: `data:${b.mime};base64,${b.base64}` } : 'gone'
  } catch { return 'retry' }
}

/** The waits between tries while the image is on screen (backoff, as chat apps do); after the last one it waits for a tap or a reconnect. */
export const RETRY_DELAYS = [1000, 2000, 4000, 8000, 16000]

type LoadState = 'loading' | 'ready' | 'failed' | 'gone'
/** One image's loading, shared by every view of it for the life of the app: a reused cell or a second mention draws from it. */
interface Load { state: Signal<LoadState>; src: Signal<string | null>; tries: number; inflight: boolean; timer: ReturnType<typeof setTimeout> | null; views: number; /** When the next try is due, and when the last one started (ms). */ due: number; last: number }
const loads = new Map<string, Load>()
const loadOf = (url: string) => {
  let l = loads.get(url)
  if (!l) { l = { state: signal<LoadState>('loading'), src: signal<string | null>(null), tries: 0, inflight: false, timer: null, views: 0, due: 0, last: 0 }; loads.set(url, l) }
  return l
}
function attempt(url: string, l: Load) {
  if (l.inflight || l.state() === 'ready') return
  l.inflight = true; l.last = Date.now()
  fetchImage(url).then((o) => {
    l.inflight = false
    if (typeof o === 'object') { l.src.set(o.src); l.state.set('ready'); return }
    if (o === 'gone') { l.state.set('gone'); return }
    if (l.tries >= RETRY_DELAYS.length) { l.state.set('failed'); return }
    l.due = Date.now() + RETRY_DELAYS[l.tries++]
    if (l.views > 0) schedule(url, l) // off screen: it goes on when it shows again
  })
}
function schedule(url: string, l: Load) {
  if (l.timer) clearTimeout(l.timer)
  l.timer = setTimeout(() => { l.timer = null; if (l.views > 0) attempt(url, l) }, Math.max(0, l.due - Date.now()))
}
/**
 * A view of it came on screen. The list draws a row again and again while a turn goes on, so this goes on from where
 * the backoff was, never from the start (11 fetches in 8 s on the Android emulator when it started over).
 */
function resume(url: string, l: Load) {
  if (l.state() !== 'loading' || l.timer || l.inflight) return
  if (Date.now() >= l.due) attempt(url, l); else schedule(url, l)
}
/** From the first try again: a tap on the failure line, a reconnect. */
function restart(url: string, l: Load) {
  if (l.state() === 'ready' || l.state() === 'gone') return
  if (l.timer) { clearTimeout(l.timer); l.timer = null }
  l.tries = 0; l.state.set('loading')
  attempt(url, l)
}
/**
 * The app reconnected: an image that could not load tries again at once. At launch the connection changes several
 * times in a moment (online, then the bot's hello); a try that started within the last second counts for it (on the
 * emulator each change started over: five fetches in 100 ms).
 */
function reconnected(url: string, l: Load) {
  if (l.state() === 'failed' || (l.state() === 'loading' && !l.inflight && Date.now() - l.last >= 1000)) restart(url, l)
}

/** An image from the computer (GET `url` with the device's token), as wide as it may be, at its own aspect; a grey plate while it loads, a line when it cannot. */
export function RemoteImage(props: { url: string; alt?: string; testID?: string; onPress?: () => void }) {
  const l = loadOf(props.url)
  const ratio = signal(0.62)
  // on screen: fetch it, or go on trying; off screen: no more tries
  effect(() => {
    l.views++
    untracked(() => resume(props.url, l))
    return () => { l.views--; if (l.views === 0 && l.timer) { clearTimeout(l.timer); l.timer = null } }
  })
  let was = connection()
  effect(() => { const c = connection(); if (c === 'online' && was !== 'online') untracked(() => reconnected(props.url, l)); was = c })
  const failed = () => l.state() === 'failed'
  return (
    <View role={props.onPress || failed() ? 'button' : undefined} accessibilityLabel={props.alt} testID={props.testID} onPress={() => (failed() ? restart(props.url, l) : props.onPress?.())} class="w-full rounded-[14px] overflow-hidden bg-card active:opacity-80" style={{ aspectRatio: 1 / ratio() }}>
      <If when={l.src()} else={
        <If when={failed() || l.state() === 'gone'}>
          <View class="flex-1 items-center justify-center px-4" testID={failed() && props.testID ? `${props.testID}-retry` : undefined}>
            <Text class="text-muted-foreground text-[15px] text-center">{failed() ? str('imageRetry') : str('fileUnavailable')}</Text>
          </View>
        </If>
      }>
        {(s) => <Image src={s()} testID={props.testID ? `${props.testID}-loaded` : undefined} resizeMode="contain" style={{ width: '100%', height: '100%' }} onLoad={(e) => { if (e.width > 0) ratio.set(Math.min(Math.max(e.height / e.width, 0.3), 1.6)) }} />}
      </If>
    </View>
  )
}

/** An image file on the computer, through its library. */
export function LibraryImage(props: { path: string; alt?: string; testID?: string; onPress?: () => void }) {
  return <RemoteImage url={`/library/file?path=${encodeURIComponent(props.path)}&format=json`} alt={props.alt} testID={props.testID} onPress={props.onPress} />
}

/** A presented file: the image itself, or a card with its name and what it is; a file the turn wrote or changed: a card that says which. */
export function FileView(props: { row: () => FileRow; onOpen?: (path: string) => void }) {
  const r = props.row
  const open = () => props.onOpen?.(r().path)
  return (
    <If when={r().image} else={
      <Card onPress={open} testID={`file-${r().id}`} accessibilityLabel={r().name} class="flex-row items-center gap-3 px-4 py-3">
        <View class="w-10 h-10 rounded-[10px] bg-secondary items-center justify-center"><Glyph name="file" size={22} /></View>
        <View class="flex-1 min-w-0 gap-[2px]">
          <Text class="text-foreground text-[17px] leading-[22px] font-semibold" numberOfLines={1}>{r().name}</Text>
          {r().description || r().change ? <Text class="text-muted-foreground text-[15px] leading-5" numberOfLines={2}>{r().description || (r().change === 'new' ? str('fileNew') : str('fileEdited'))}</Text> : null}
        </View>
        <Glyph name="chevron" size={18} color={muted()} />
      </Card>
    }>
      <View class="gap-[6px]">
        {r().attachment
          // a browser screenshot: kept by the harness, not a file in the library, so there is no file page to open
          ? <RemoteImage url={`/library/attachment?session=${encodeURIComponent(sessionId() ?? '')}&id=${encodeURIComponent(r().attachment!)}&format=json`} alt={r().description || str('screenshot')} testID={`file-${r().id}-image`} />
          : <LibraryImage path={r().path} alt={r().description || r().name} testID={`file-${r().id}-image`} onPress={open} />}
        {r().description ? <View class="px-1"><Text class="text-muted-foreground text-[13px] leading-[18px]">{r().description}</Text></View> : null}
      </View>
    </If>
  )
}

/** An image in a reply: from the web as it is; a path on the computer through its library. */
export const isRemote = (src: string) => /^(https?:|data:)/i.test(src)

const MD_IMAGE = /!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g
/** Whether `path` (absolute, as a file row has it) is the file a reply names as `src` (often relative to the working folder). */
const samePath = (path: string, src: string) => { const s = src.replace(/^\.\//, ''); return path === s || path.endsWith(`/${s}`) }

/**
 * A reply's words without its images of the computer's files, and those images, to draw under the words as views of
 * their own: NSH's markdown view on Android keeps the room of a view drawn in an image's place but shows nothing
 * (the owner's APK, 2026-10-27). An image the assistant also presented in the thread (`presented`, the file rows'
 * paths) is left out: its file row already shows it. Images from the web stay in the words.
 */
export function splitImages(markdown: string, presented: string[]): { text: string; images: { path: string; alt: string }[] } {
  const images: { path: string; alt: string }[] = []
  const text = markdown.replace(MD_IMAGE, (all, alt: string, src: string) => {
    if (isRemote(src)) return all
    if (!presented.some((p) => samePath(p, src)) && !images.some((i) => i.path === src)) images.push({ path: src, alt })
    return ''
  }).replace(/\n{3,}/g, '\n\n').trim()
  return { text, images }
}
