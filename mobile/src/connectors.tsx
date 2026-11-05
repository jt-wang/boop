// Connectors: a row per service with Connect, then "read the information",
// then Continue to authorise. Connected apps sit apart from the ones to add; a
// sign-in that is waiting can be reopened, one that failed retried; a service
// that lost its sign-in says so and offers Reconnect. Nothing is typed: no key, no address, no setting name. Services
// this computer cannot offer are not listed. The old path (a folder on the
// computer, any MCP server) is behind "Show its work". The same Connect runs
// from a `connect` card in the thread (cards.tsx).
import { effect, openUrl, resource, signal, Text, View } from 'nsh'
import { AlertDialog, Input, Switch } from 'nsh/base'
import { api, connectorChanged, send, showToast, str, t } from './state.ts'
import { showWork } from './prefs.ts'
import { serviceNames } from './fold.ts'
import { cm, service } from './i18n-cm.ts'
import { Btn, Cell, Group, Page, pageClass } from './ui.tsx'
import { AppIcon, BrandMark, Glyph, ListGroup, ListRow, SearchField, SectionTitle, TextAction, Tile, muted } from './kit.tsx'

export interface Connector { id: string; name: string; preset: string; transport: 'stdio' | 'streamable-http'; command?: string; args?: string[]; url?: string; envNames?: string[]; auth?: 'oauth'; enabled: boolean; missingEnv: string[]; connected?: boolean }
export interface Preset { id: string; name: string; description: string; transport: 'stdio' | 'streamable-http'; envNames: string[]; hint: string; needsPath?: boolean; custom?: boolean; auth?: 'oauth'; available?: boolean }
export interface ConnectorsView { connectors: Connector[]; catalog: Preset[]; env: Record<string, boolean>; restartNeeded: boolean }

/** Bumped after every change so the list page refetches when the person comes back to it. */
export const connectorsVersion = signal(0)
const bump = () => connectorsVersion.set(connectorsVersion() + 1)
/** Services that are signed in, by id; fed by every GET /connectors. Cards read it. */
export const connectedIds = signal<Set<string>>(new Set())
/** The service whose sign-in is open in the browser right now. */
export const connecting = signal<string | null>(null)
/** Services whose last sign-in did not finish, by id → the reason. */
export const failed = signal<Record<string, string>>({})
/** The sign-in page of the service being connected, for "Reopen". */
let openedUrl = ''

const presetText = (p: Preset | undefined, k: 'name' | 'description' | 'hint') => (p ? t('presetText')(p.id)?.[k] ?? p[k] : '')
const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/
const lines = (s: string) => s.split(/\r?\n/).map((x) => x.trim()).filter(Boolean)
const input = 'border-[0.5px] border-border rounded-[10px] px-4 min-h-[44px] py-[11px] bg-background dark:bg-card text-foreground text-[17px]'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
/** How often the app asks whether the sign-in finished while the browser is open. */
export const POLL_MS = { value: 1500 }
/** How long a sign-in may take. */
export const WAIT_MS = { value: 10 * 60_000 }

export async function fetchView(): Promise<ConnectorsView> {
  const v = await api().get<ConnectorsView>('/connectors')
  connectedIds.set(new Set(v.connectors.filter((c) => c.connected).map((c) => c.id)))
  for (const p of v.catalog) serviceNames[p.id] = service(p.id, p.name, p.description).name
  return v
}
let lastRefresh = 0
/** For cards: one GET, at most every 10 s. */
export async function refreshConnected() {
  if (Date.now() - lastRefresh < 10_000) return
  lastRefresh = Date.now()
  await fetchView().catch(() => {})
}

const setFailed = (id: string, why: string | null) => { const f = { ...failed() }; if (why === null) delete f[id]; else f[id] = why; failed.set(f) }

/** Connect one service: the bot gives the sign-in URL, the browser opens it, the app waits until the bot says it is connected. */
export async function startConnect(preset: string) {
  if (connecting()) return
  connecting.set(preset); setFailed(preset, null)
  try {
    const r = await api().send<{ url?: string; error?: string }>('POST', `/connectors/${encodeURIComponent(preset)}/connect`)
    if (!r.url) { setFailed(preset, r.error || str('connectStartFailed')); showToast(r.error || str('connectStartFailed')); return }
    openedUrl = r.url
    await openUrl(r.url)
    const end = Date.now() + WAIT_MS.value
    while (Date.now() < end && connecting() === preset) {
      await sleep(POLL_MS.value)
      const v = await fetchView().catch(() => null)
      if (v?.connectors.some((c) => c.id === preset && c.connected)) { bump(); showToast(cm('connDone')(service(preset, v.catalog.find((p) => p.id === preset)?.name ?? preset).name)); return }
    }
    if (connecting() === preset) setFailed(preset, cm('connFailedNote'))
  } catch { setFailed(preset, cm('connFailedNote')); showToast(str('failed')) } finally { if (connecting() === preset) connecting.set(null) }
}
/** "Reopen": the same sign-in page again. */
export function reopenConnect() { if (openedUrl) openUrl(openedUrl).catch(() => {}) }
/** "Cancel": stop waiting; the service stays as it was. */
export function cancelConnect() { connecting.set(null) }

export type ServiceState = 'connected' | 'needs-auth' | 'connecting' | 'failed' | 'idle'
/** One service's state: signed in; added but its sign-in is gone; waiting; failed; or not connected. */
export function stateOf(id: string, v: ConnectorsView | null | undefined): ServiceState {
  if (connectedIds().has(id)) return 'connected'
  if (connecting() === id) return 'connecting'
  if (failed()[id]) return 'failed'
  if (v?.connectors.some((c) => c.id === id && c.auth === 'oauth' && !c.connected)) return 'needs-auth'
  return 'idle'
}
const statusWord = (s: ServiceState) => (s === 'connected' ? cm('connStatusConnected') : s === 'needs-auth' ? cm('connNeedsAuth') : s === 'connecting' ? cm('connConnecting') : s === 'failed' ? cm('connFailedNote') : '')

/** The list: what is connected (tap for details), then what can be connected (Connect opens the information step). */
export function ConnectorsPage(props: { onOpen: (id: string) => void; onAdd: () => void }) {
  const view = resource(() => connectorsVersion() + connectorChanged(), fetchView)
  const query = signal('')
  const match = (name: string) => !query().trim() || name.toLowerCase().includes(query().trim().toLowerCase())
  const services = () => (view()?.catalog ?? []).filter((p) => p.auth === 'oauth' && (p.available !== false || connectedIds().has(p.id)) && match(service(p.id, p.name, p.description).name))
  const mine = () => services().filter((p) => { const s = stateOf(p.id, view()); return s === 'connected' || s === 'needs-auth' })
  const rest = () => services().filter((p) => !mine().includes(p))
  const others = () => (view()?.connectors ?? []).filter((c) => c.auth !== 'oauth' && match(title(c)))
  const title = (c: Connector) => (c.preset === 'custom' ? c.name : presetText((view()?.catalog ?? []).find((p) => p.id === c.preset), 'name') || c.name)
  const toggle = async (c: Connector, on: boolean) => { try { await api().send('PATCH', `/connectors/${c.id}`, { enabled: on }); bump() } catch { showToast(str('failed')) } }
  const remove = async (c: { id: string }) => { try { await api().send('DELETE', `/connectors/${c.id}`); showToast(str('removed')); bump() } catch { showToast(str('failed')) } }
  const mark = (p: Preset) => <AppIcon id={p.id} name={service(p.id, p.name, p.description).name} />
  return (
    <Page page="ConnectorsPage" class="flex-1 bg-card dark:bg-background pb-[env(keyboard-inset-height)]" contentClass="gap-6 pt-2 pb-[calc(env(safe-area-inset-bottom)+32px)]" keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" testID="connectors">
      <SearchField value={query()} onChange={(v) => query.set(v)} placeholder={cm('connSearch')} testID="connector-search" />
      {view()?.restartNeeded ? <View class="px-8 -mt-2" testID="restart-needed"><Text class="text-foreground text-[15px] leading-5">{str('restartToApply')}</Text></View> : null}
      <If when={mine().length > 0 || others().length > 0}>
        <ListGroup caption={cm('connConnected')}>
          {mine().map((p, i) => {
            const s = () => stateOf(p.id, view())
            return (
              <View testID={`service-${p.id}`}>
                <ListRow first={i === 0} lead={mark(p)} title={service(p.id, p.name, p.description).name} subtitle={s() === 'needs-auth' ? cm('connNeedsAuth') : undefined} onPress={() => props.onOpen(p.id)} testID={`open-${p.id}`}
                  chevron={s() !== 'needs-auth'} right={s() === 'needs-auth' ? <TextAction label={cm('connReconnect')} testID={`reconnect-${p.id}`} onPress={() => { startConnect(p.id) }} /> : <Text class="text-muted-foreground text-[17px]">{cm('connStatusConnected')}</Text>} />
              </View>
            )
          })}
          {others().map((c, i) => (
            <View testID={`connector-${c.id}`}>
              <ListRow first={i === 0 && mine().length === 0} lead={<View style={{ width: 32, height: 32, borderRadius: 8, borderWidth: 0.5 }} class="bg-background dark:bg-card border-black/[0.10] dark:border-white/[0.12] items-center justify-center"><Glyph name="file" size={20} /></View>} title={title(c)} subtitle={c.enabled ? cm('connCustom') : cm('connStatusOff')}
                right={<View class="flex-row items-center gap-1">
                  <Switch testID={`toggle-${c.id}`} checked={c.enabled} onChange={(on) => toggle(c, on)} accessibilityLabel={title(c)} class="w-[51px] h-[31px] rounded-full p-[2px] bg-secondary checked:bg-primary" thumbClass="w-[27px] h-[27px] rounded-full bg-background checked:translate-x-5" />
                  <View role="button" accessibilityLabel={str('remove')} testID={`remove-${c.id}`} onPress={() => remove(c)} class="items-center justify-center active:opacity-50" style={{ width: 36, height: 44 }}><Glyph name="dots" size={20} color={muted()} /></View>
                </View>} />
            </View>
          ))}
        </ListGroup>
      </If>
      <If when={rest().length > 0}>
        <ListGroup caption={cm('connAvailable')}>
          {rest().map((p, i) => {
            const s = () => stateOf(p.id, view())
            return (
              <View testID={`service-${p.id}`}>
                <ListRow first={i === 0} lead={mark(p)} title={service(p.id, p.name, p.description).name} subtitle={s() === 'connecting' || s() === 'failed' ? statusWord(s()) : undefined} onPress={() => props.onOpen(p.id)} testID={`open-${p.id}`}
                  right={s() === 'connecting' ? <Text class="text-muted-foreground text-[17px]">{cm('connConnecting')}</Text> : <TextAction label={s() === 'failed' ? cm('connRetry') : cm('connConnect')} testID={`connect-${p.id}`} onPress={() => props.onOpen(p.id)} />} />
              </View>
            )
          })}
        </ListGroup>
      </If>
      <If when={!view.loading() && services().length === 0 && others().length === 0 && query().trim()}>
        <View class="px-8"><Text class="text-muted-foreground text-[15px] leading-5">{cm('connNoMatch')}</Text></View>
      </If>
      <View class="px-8 -mt-3"><Text class="text-muted-foreground text-[13px] leading-[18px]">{cm('connHint')}</Text></View>
      <If when={showWork()}>
        <ListGroup><ListRow first lead={<Glyph name="plus" size={22} />} title={cm('connMore')} subtitle={cm('connMoreBody')} chevron onPress={props.onAdd} testID="add" /></ListGroup>
      </If>
    </Page>
  )
}

/**
 * One service: its mark and
 * name, its state, what it can do, where the sign-in lives, and the one action that fits the state.
 */
export function ConnectorPage(props: { id: string; onClose: () => void; onTry: () => void }) {
  const view = resource(() => connectorsVersion() + connectorChanged(), fetchView)
  const preset = () => (view()?.catalog ?? []).find((p) => p.id === props.id)
  const svc = () => service(props.id, preset()?.name ?? props.id, preset()?.description)
  const s = () => stateOf(props.id, view())
  // the page follows the sign-in: when it finishes, the page shows Connected
  effect(() => { connectedIds() })
  const disconnect = async () => {
    const ok = await AlertDialog.show({ title: cm('connDisconnectTitle')(svc().name), description: cm('connDisconnectBody'), actions: [{ id: 'cancel', label: cm('connCancel'), role: 'cancel' }, { id: 'ok', label: cm('connDisconnect'), role: 'destructive' }] }).then((r) => r === 'ok').catch(() => false)
    if (!ok) return
    try { await api().send('DELETE', `/connectors/${encodeURIComponent(props.id)}`); showToast(str('removed')); bump(); props.onClose() } catch { showToast(str('failed')) }
  }
  const tryIt = async () => { try { await send(cm('connTryPrompt')(svc().name)); props.onTry() } catch { showToast(str('failed')) } }
  return (
    <Page page="ConnectorPage" class="flex-1 bg-card dark:bg-background" contentClass="gap-6 pt-2 pb-[calc(env(safe-area-inset-bottom)+32px)]" testID={`connector-page-${props.id}`}>
      <View class="items-center gap-[6px]">
        <View style={{ width: 72, height: 72, borderRadius: 18 }} class="bg-background dark:bg-card items-center justify-center"><BrandMark id={props.id} name={svc().name} size={38} /></View>
        <Text class="text-foreground text-[28px] leading-[34px] font-bold mt-[9px]">{svc().name}</Text>
        <Text class={`text-[17px] leading-[22px] ${s() === 'needs-auth' || s() === 'failed' ? 'text-destructive' : 'text-muted-foreground'}`} testID="connector-state">{statusWord(s()) || svc().line}</Text>
      </View>
      <ListGroup caption={cm('connWhat')} footer={cm('connDataBody')(svc().name)}>
        {svc().can.map((c, i) => <ListRow first={i === 0} lead={<Glyph name="check" size={20} color={muted()} />} title={c} />)}
      </ListGroup>
      <View class="px-4 pt-2 gap-3">
        <If when={s() === 'connected'}>
          <Btn kind="soft" label={cm('connTry')} testID="connector-try" onPress={() => { tryIt().catch(() => {}) }} />
          <Btn kind="danger" label={cm('connDisconnect')} testID={`remove-${props.id}`} onPress={() => { disconnect().catch(() => {}) }} />
        </If>
        <If when={s() === 'connecting'}>
          <Text class="text-muted-foreground text-[15px] leading-5 text-center" testID="connector-waiting">{cm('connWaiting')(svc().name)}</Text>
          <Btn kind="primary" label={cm('connReopen')} testID="connector-reopen" onPress={reopenConnect} />
          <Btn kind="quiet" label={cm('connCancel')} testID="connector-cancel" onPress={cancelConnect} />
        </If>
        <If when={s() === 'failed'}>
          <Text class="text-destructive text-[15px] leading-5 text-center" testID="connector-failed">{failed()[props.id]}</Text>
          <Btn kind="primary" label={cm('connRetry')} testID="connector-retry" onPress={() => { startConnect(props.id) }} />
        </If>
        <If when={s() === 'needs-auth'}>
          <Btn kind="primary" label={cm('connReconnect')} testID="connector-reconnect" onPress={() => { startConnect(props.id) }} />
          <Btn kind="danger" label={cm('connDisconnect')} testID={`remove-${props.id}`} onPress={() => { disconnect().catch(() => {}) }} />
        </If>
        <If when={s() === 'idle'}>
          <Btn kind="primary" label={cm('connContinue')} testID="connector-continue" onPress={() => { startConnect(props.id) }} />
        </If>
      </View>
    </Page>
  )
}

export function ConnectorAddPage(props: { onDone: () => void }) {
  const view = resource(() => 0, () => api().get<ConnectorsView>('/connectors'))
  const picked = signal<Preset | null>(null)
  const path = signal('')
  const busy = signal(false)
  // the custom form
  const name = signal(''); const transport = signal<'stdio' | 'streamable-http'>('stdio'); const command = signal(''); const args = signal(''); const url = signal(''); const envNames = signal(''); const bearerEnv = signal('')
  const confirming = signal(false)
  const error = signal('')

  const post = async (body: Record<string, unknown>) => {
    busy.set(true); error.set('')
    try {
      const r = await api().send<{ id?: string; error?: string }>('POST', '/connectors', body)
      if (r.error) { error.set(r.error); return }
      bump(); showToast(str('added')); props.onDone()
    } catch { error.set(str('failed')) } finally { busy.set(false) }
  }
  const addPreset = (p: Preset) => post(p.needsPath ? { preset: p.id, path: path().trim() } : { preset: p.id })
  const customBody = () => {
    const b: Record<string, unknown> = { custom: true, name: name().trim(), transport: transport(), envNames: lines(envNames()) }
    if (transport() === 'stdio') { b.command = command().trim(); b.args = lines(args()) } else { b.url = url().trim(); if (bearerEnv().trim()) b.bearerEnv = bearerEnv().trim() }
    return b
  }
  const customValid = () => Boolean(name().trim()) && (transport() === 'stdio' ? Boolean(command().trim()) : /^https?:\/\//.test(url().trim())) && lines(envNames()).every((e) => ENV_NAME.test(e)) && (!bearerEnv().trim() || ENV_NAME.test(bearerEnv().trim()))
  const envLine = (p: Preset) => p.envNames.map((n) => `${n} (${view()?.env?.[n] ? str('envSet') : str('envMissing')})`).join(', ')
  const pick = (p: Preset) => { picked.set(picked()?.id === p.id ? null : p); confirming.set(false); error.set('') }
  const advanced = () => (view()?.catalog ?? []).filter((p) => p.auth !== 'oauth')

  return (
    <Page page="ConnectorAddPage" class={`${pageClass} pb-[env(keyboard-inset-height)]`} keyboardShouldPersistTaps="handled">
      {advanced().map((p) => (
        <Group footer={picked()?.id === p.id ? presetText(p, 'hint') : undefined}>
          <Cell testID={`preset-${p.id}`} title={presetText(p, 'name')} subtitle={presetText(p, 'description') + (p.envNames.length ? `\n${t('needsEnv')(envLine(p))}` : '')} chevron={picked()?.id !== p.id} value={picked()?.id === p.id ? '•' : undefined} onPress={() => pick(p)} />
          {picked()?.id === p.id ? (
            <View class="px-4 py-3 gap-2 border-border" style={{ borderTopWidth: 0.5 }} testID={`detail-${p.id}`}>
              {p.needsPath ? <Input testID="folder" placeholder={str('folderPath')} value={path()} onChange={(v) => path.set(v)} autoCapitalize="none" autoCorrect={false} class={input} /> : null}
              {p.custom ? (
                <View class="gap-2">
                  <Input testID="custom-name" placeholder={str('customName')} value={name()} onChange={(v) => name.set(v)} class={input} />
                  <View class="flex-row gap-2">
                    {(['stdio', 'streamable-http'] as const).map((k) => <View role="button" testID={`transport-${k}`} onPress={() => transport.set(k)} class={`px-4 min-h-[36px] justify-center rounded-full border-[0.5px] ${transport() === k ? 'bg-primary border-transparent' : 'bg-background dark:bg-card border-border'}`}><Text class={`text-[15px] ${transport() === k ? 'text-primary-foreground font-semibold' : 'text-foreground'}`}>{k === 'stdio' ? str('transportCommand') : str('transportUrl')}</Text></View>)}
                  </View>
                  {transport() === 'stdio' ? <Input testID="custom-command" placeholder={str('customCommand')} value={command()} onChange={(v) => command.set(v)} autoCapitalize="none" autoCorrect={false} class={input} /> : null}
                  {transport() === 'stdio' ? <Input testID="custom-args" multiline placeholder={str('customArgs')} value={args()} onChange={(v) => args.set(v)} autoCapitalize="none" autoCorrect={false} class={input} /> : null}
                  {transport() === 'streamable-http' ? <Input testID="custom-url" placeholder={str('customUrl')} value={url()} onChange={(v) => url.set(v)} autoCapitalize="none" autoCorrect={false} keyboardType="url" class={input} /> : null}
                  {transport() === 'streamable-http' ? <Input testID="custom-bearer" placeholder={str('customBearer')} value={bearerEnv()} onChange={(v) => bearerEnv.set(v)} autoCapitalize="characters" autoCorrect={false} class={input} /> : null}
                  <Input testID="custom-env" multiline placeholder={str('customEnv')} value={envNames()} onChange={(v) => envNames.set(v)} autoCapitalize="characters" autoCorrect={false} class={input} />
                  {confirming() ? (
                    <View class="gap-2 pt-1" testID="custom-confirm">
                      <Text class="text-foreground font-semibold text-[17px]">{str('customConfirmTitle')}</Text>
                      <Text class="text-muted-foreground text-[15px] leading-5">{str('customConfirmBody')}</Text>
                      <View class="flex-row gap-2"><Btn wide kind="primary" testID="custom-confirm-add" label={str('add')} disabled={busy()} onPress={() => post(customBody())} /><Btn wide label={str('cancel')} onPress={() => confirming.set(false)} /></View>
                    </View>
                  ) : <Btn kind="primary" testID="custom-add" label={str('add')} disabled={!customValid() || busy()} onPress={() => confirming.set(true)} />}
                </View>
              ) : <Btn kind="primary" testID={`add-${p.id}`} label={p.needsPath ? str('addFolder') : str('add')} disabled={busy() || (p.needsPath && !path().trim())} onPress={() => addPreset(p)} />}
              {error() ? <Text class="text-destructive text-[15px]">{error()}</Text> : null}
            </View>
          ) : null}
        </Group>
      ))}
    </Page>
  )
}
