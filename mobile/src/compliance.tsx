// [compliance] The screens App Store and Google Play review asks for:
//   - the age question and, for under-18s, the adults-only screen (App Review 4.7.5, 1.2.1(a));
//   - the AI-provider disclosure before the first message, and Settings → AI provider to withdraw (5.1.2(i), 5.1.1(ii),
//     Google Play prominent disclosure and consent);
//   - Report on a reply (long-press) and on an interface, with an acknowledgement (1.2, 4.7.1, Google Play AI-Generated
//     Content); the reply menu copies ChatGPT's (a report from the message itself) and Character.AI-style long-press;
//   - the index of interfaces with a link to each, hide, and per-interface permissions (4.7.3, 4.7.4), asked the way
//     WeChat mini programs ask for a scope: when it is needed, with the reason, and changeable later;
//   - Delete account (5.1.1(v), Google Play account deletion), and the privacy policy and terms (5.1.1(i)).
import { formatDate } from './locale.ts'
import { AlertDialog, Input } from 'nsh/base'
import { Clipboard, openUrl, resource, signal, Text, View } from 'nsh'
import { api, disconnect, hostedBy, lang, me, refreshMe, session, copiedToast, setConsent, showToast, str, t } from './state.ts'
import { hostUrl } from './hosted.ts'
import { Avatar, Btn, Card, Cell, Empty, Group, Hint, Page, pageClass, Toggle } from './ui.tsx'
import { Scroll } from 'nsh'

const setupContent = 'px-4 gap-4 pt-[calc(env(safe-area-inset-top)+44px)] pb-[calc(env(safe-area-inset-bottom)+32px)]'

export type Permission = 'openUrl' | 'clipboard' | 'picker'
export type ReportTarget =
  | { kind: 'reply'; rowId: string; excerpt: string; sessionId?: string | null }
  | { kind: 'interface'; moduleId: string; title: string }
export interface InterfaceItem { id: string; title: string; at: number; answered: boolean; hidden: boolean; blocked: boolean; permissions: Permission[]; grants: Permission[]; link: string | null }

/** Something asked to open the report page or one interface (a reply's menu, a module card, a link); App.tsx pushes it. */
export const pendingReport = signal<ReportTarget | null>(null)
export const pendingInterface = signal<string | null>(null)

/** The pages for a computer the person runs. A computer's own pages are no use: through TailPocket its address only works inside this app, and the browser opens the link. */
export const PUBLIC_SITE = 'https://boop.jingtao.io'
export const ISSUES_URL = 'https://github.com/jt-wang/boop/issues'
/** The host this build signs in to has its own pages (they name its operator); anyone else reads the public ones. */
export const legalUrl = (page: 'privacy' | 'terms') => { const h = hostedBy() ?? hostUrl(); return h ? `${h}/${page}?lang=${lang()}` : `${PUBLIC_SITE}/${page}/` }
export const openLegal = (page: 'privacy' | 'terms') => { openUrl(legalUrl(page)).catch(() => {}) }

export const permissionWord = (p: Permission) => str(p === 'openUrl' ? 'permOpenUrl' : p === 'clipboard' ? 'permClipboard' : 'permPicker')

// ---------------------------------------------------------------- first run

export function AgeScreen() {
  const busy = signal(false)
  const pick = async (age: 'adult' | 'minor') => { busy.set(true); try { await setConsent({ age }) } catch { showToast(str('failed')) } finally { busy.set(false) } }
  return (
    <Scroll class={pageClass} contentClass={setupContent}>
      <Avatar size={64} label="18" />
      <Text class="text-foreground text-[28px] font-bold leading-[41px]">{str('ageTitle')}</Text>
      <Hint text={str('ageBody')} />
      <View class="gap-2 pt-4">
        <Btn kind="primary" testID="age-adult" label={str('ageAdult')} disabled={busy()} onPress={() => pick('adult')} />
        <Btn kind="quiet" testID="age-minor" label={str('ageMinor')} disabled={busy()} onPress={() => pick('minor')} />
      </View>
      <View class="px-4"><Text class="text-muted-foreground text-[13px] leading-[18px] text-center">{str('ageTerms')}</Text></View>
      <LegalLinks />
    </Scroll>
  )
}

export function AdultsOnlyScreen() {
  const leave = async () => { try { await api().send('DELETE', `/devices/${me()?.device.id}`) } catch {} await disconnect() }
  return (
    <Scroll class={pageClass} contentClass={setupContent}>
      <Avatar size={64} label="18" />
      <Text testID="adults-only" class="text-foreground text-[28px] font-bold leading-[41px]">{str('adultsTitle')}</Text>
      <Hint text={str('adultsBody')} />
      <View class="pt-4"><Btn kind="soft" testID="adults-leave" label={str('adultsLeave')} onPress={leave} /></View>
    </Scroll>
  )
}

/** The disclosure before the first message (5.1.2(i)): who receives what, nothing until they agree, where to stop it. */
export function ConsentScreen() {
  const ai = () => me()?.ai
  const busy = signal(false)
  const declined = signal(false)
  const agree = async () => { busy.set(true); try { await setConsent({ ai: true }) } catch { showToast(str('failed')) } finally { busy.set(false) } }
  return (
    <Scroll class={pageClass} contentClass={setupContent}>
      <Avatar size={64} />
      <Text class="text-foreground text-[28px] font-bold leading-[41px]" testID="consent-title">{str('consentTitle')}</Text>
      <Card class="p-4 gap-3">
        <Text class="text-foreground text-[17px] leading-6 font-semibold" testID="consent-who">{t('consentWho')(ai()?.company ?? '', ai()?.model ?? '')}</Text>
        <Text class="text-foreground text-[15px] leading-[22px]">{str('consentWhat')}</Text>
        <If when={ai()?.filter}>{(f) => <Text class="text-foreground text-[15px] leading-[22px]">{t('consentFilter')(f())}</Text>}</If>
        <Text class="text-muted-foreground text-[15px] leading-[22px]">{str('consentWhen')}</Text>
      </Card>
      <View class="gap-1">
        <If when={ai()?.policyUrl}>{(u) => <Btn kind="quiet" testID="provider-policy" label={t('providerPolicy')(ai()?.company ?? '')} onPress={() => { openUrl(u()).catch(() => {}) }} />}</If>
        <Btn kind="quiet" testID="privacy-link" label={str('privacyPolicy')} onPress={() => openLegal('privacy')} />
      </View>
      <If when={declined()}><View class="px-4"><Text testID="consent-needed" class="text-muted-foreground text-[13px] leading-[18px]">{str('consentNeeded')}</Text></View></If>
      <View class="gap-2 pt-2">
        <Btn kind="primary" testID="consent-agree" label={str('consentAgree')} disabled={busy()} onPress={agree} />
        <Btn kind="quiet" testID="consent-not-now" label={str('consentNotNow')} onPress={() => declined.set(true)} />
      </View>
    </Scroll>
  )
}

function LegalLinks() {
  return (
    <View class="flex-row flex-wrap justify-center gap-x-4 pt-6">
      <View role="button" onPress={() => openLegal('privacy')} class="min-h-[44px] justify-center active:opacity-60"><Text class="text-muted-foreground text-[13px]">{str('privacyPolicy')}</Text></View>
      <View role="button" onPress={() => openLegal('terms')} class="min-h-[44px] justify-center active:opacity-60"><Text class="text-muted-foreground text-[13px]">{str('terms')}</Text></View>
    </View>
  )
}

// ---------------------------------------------------------------- settings

/** Settings → AI provider: who receives the messages, since when, and Stop sharing (withdrawing the consent). */
export function AiProviderPage(props: { onStopped?: () => void }) {
  const ai = () => me()?.ai
  const since = () => { const at = ai()?.consent?.at; if (!at) return ''; return formatDate(at, lang(), true) }
  const stop = async () => {
    const choice = await AlertDialog.show({ title: str('stopSharingTitle'), description: str('stopSharingBody'), actions: [{ label: str('cancel'), role: 'cancel', id: 'cancel' }, { label: str('stopSharing'), role: 'destructive', id: 'stop' }] })
    if (choice !== 'stop') return
    try { await setConsent({ ai: false }); props.onStopped?.() } catch { showToast(str('failed')) }
  }
  return (
    <Page page="AiProviderPage">
      <Group footer={str('aiProviderHint')}>
        <Cell title={str('aiCompany')} value={ai()?.company ?? ''} />
        <Cell title={str('aiModel')} value={ai()?.model ?? ''} />
        <If when={ai()?.filter}>{(f) => <Cell title={str('aiFilter')} value={f()} />}</If>
        <If when={since()}><Cell title={str('aiSince')} value={since()} /></If>
      </Group>
      <If when={ai()?.policyUrl}>{(u) => <Group><Cell title={t('providerPolicy')(ai()?.company ?? '')} chevron onPress={() => { openUrl(u()).catch(() => {}) }} /></Group>}</If>
      <Group><Cell title={str('stopSharing')} destructive centered onPress={stop} testID="stop-sharing" /></Group>
    </Page>
  )
}

/** Settings' About group: the AI provider, the privacy policy and terms, and Delete account on a hosted computer. */
export function AboutGroup(props: { onAiProvider: () => void }) {
  const remove = async () => {
    const first = await AlertDialog.show({ title: str('deleteTitle'), description: str('deleteBody'), actions: [{ label: str('cancel'), role: 'cancel', id: 'cancel' }, { label: str('deleteConfirm'), role: 'destructive', id: 'go' }] })
    if (first !== 'go') return
    const sure = await AlertDialog.show({ title: str('deleteSure'), description: str('deleteSureBody'), actions: [{ label: str('cancel'), role: 'cancel', id: 'cancel' }, { label: str('deleteAccount'), role: 'destructive', id: 'go' }] })
    if (sure !== 'go') return
    try {
      const r = await fetch(`${hostedBy()}/host/account`, { method: 'DELETE', headers: { authorization: `Bearer ${session()!.token}` } })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      await disconnect()
      showToast(str('deleted'))
    } catch { showToast(str('failed')) }
  }
  return (
    <Group header={str('aboutHeader')}>
      {me()?.ai ? <Cell title={str('aiProvider')} value={me()?.ai?.company} chevron onPress={props.onAiProvider} testID="ai-provider-row" /> : null}
      <Cell title={str('privacyPolicy')} chevron onPress={() => openLegal('privacy')} testID="privacy-row" />
      <Cell title={str('terms')} chevron onPress={() => openLegal('terms')} testID="terms-row" />
      {hostedBy() ? <Cell title={str('deleteAccount')} destructive onPress={remove} testID="delete-account" /> : null}
    </Group>
  )
}

// ---------------------------------------------------------------- reports

const REASONS = ['harmful', 'sexual', 'hate', 'violence', 'false', 'other'] as const
const reasonWord = (r: (typeof REASONS)[number]) => str(({ harmful: 'reasonHarmful', sexual: 'reasonSexual', hate: 'reasonHate', violence: 'reasonViolence', false: 'reasonFalse', other: 'reasonOther' } as const)[r])

/** Long-press on a reply: Copy or Report, as a sheet from the bottom. */
export async function replyMenu(row: { id: string; text: string }, sessionId: string | null) {
  const choice = await AlertDialog.show({ title: '', presentation: 'actionSheet', actions: [{ label: str('copy'), id: 'copy' }, { label: str('report'), role: 'destructive', id: 'report' }, { label: str('cancel'), role: 'cancel', id: 'cancel' }] })
  if (choice === 'copy') { try { await Clipboard.writeText(row.text); copiedToast(str('copied')) } catch {} }
  if (choice === 'report') pendingReport.set({ kind: 'reply', rowId: row.id, excerpt: row.text, sessionId })
}

/** Long-press on an interface card: Report or Hide. */
export async function interfaceMenu(i: { moduleId: string; title: string }) {
  const choice = await AlertDialog.show({ title: i.title, presentation: 'actionSheet', actions: [{ label: str('report'), role: 'destructive', id: 'report' }, { label: str('ifHide'), id: 'hide' }, { label: str('cancel'), role: 'cancel', id: 'cancel' }] })
  if (choice === 'report') pendingReport.set({ kind: 'interface', moduleId: i.moduleId, title: i.title })
  if (choice === 'hide') { try { await api().send('PATCH', `/ui/${encodeURIComponent(i.moduleId)}`, { hidden: true }); showToast(str('ifHidden')) } catch { showToast(str('failed')) } }
}

/**
 * The report: a reason, an optional note, and for an interface whether to hide it too. It goes to the computer
 * (POST /reports), which forwards it to the host; a computer that is not hosted cannot, so the phone sends it to the
 * host this build knows directly. Then a plain acknowledgement with the promised response time.
 */
export function ReportPage(props: { target: ReportTarget; onDone: () => void }) {
  // no host: nobody but the person ever reads it (src/compliance.ts keeps it on the computer), so it promises no answer
  const local = () => !hostedBy() && !hostUrl()
  const reason = signal<(typeof REASONS)[number] | null>(null)
  const note = signal('')
  const hide = signal(true)
  const busy = signal(false)
  const sent = signal(false)
  const send = async () => {
    const r = reason(); if (!r) return
    busy.set(true)
    const body = { ...props.target, reason: r, note: note().trim() || undefined, ...(props.target.kind === 'interface' ? { hide: hide() } : {}) }
    try {
      const res = await api().send<{ ok?: boolean; forwarded?: boolean; error?: string }>('POST', '/reports', body)
      if (!res?.ok) throw new Error(res?.error ?? 'not sent')
      const host = hostUrl()
      if (!res.forwarded && host) await fetch(`${host}/host/reports`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {})
      sent.set(true)
    } catch { showToast(str('failed')) } finally { busy.set(false) }
  }
  return (
    <If when={!sent()} else={
      <Page page="ReportSentPage">
        <View class="items-center px-8 pt-10 gap-4" testID="report-sent">
          <View class="w-16 h-16 rounded-full bg-primary/10 dark:bg-primary/20 items-center justify-center"><Text class="text-primary text-[28px]">✓</Text></View>
          <Text class="text-foreground text-[17px] font-semibold leading-7 text-center">{str(local() ? 'reportLocalSent' : 'reportSent')}</Text>
          <Text class="text-muted-foreground text-[17px] leading-6 text-center">{str(local() ? 'reportLocalSentBody' : 'reportSentBody')}</Text>
          <If when={local()}><View class="pt-2 self-stretch"><Btn kind="soft" testID="report-issue" label={str('reportOpenIssue')} onPress={() => { openUrl(ISSUES_URL).catch(() => {}) }} /></View></If>
          <View class="pt-2 self-stretch"><Btn kind="primary" testID="report-done" label={str('done')} onPress={props.onDone} /></View>
        </View>
      </Page>
    }>
      <Page page="ReportPage" keyboardShouldPersistTaps="handled" class={`${pageClass} pb-[env(keyboard-inset-height)]`}>
        <If when={props.target.kind === 'reply'}>
          <View class="px-8"><Text class="text-muted-foreground text-[15px] leading-5" numberOfLines={4} testID="report-excerpt">{props.target.kind === 'reply' ? props.target.excerpt : ''}</Text></View>
        </If>
        <Group footer={local() ? str('reportLocalHint') : props.target.kind === 'reply' ? str('reportReplyHint') : str('reportInterfaceHint')}>
          {REASONS.map((r) => <Cell title={reasonWord(r)} testID={`reason-${r}`} onPress={() => reason.set(r)} right={reason() === r ? <Text class="text-primary text-[17px] font-semibold">✓</Text> : undefined} />)}
        </Group>
        <Group>
          <Input testID="report-note" placeholder={str('reportNote')} value={note()} onChange={(v) => note.set(v)} multiline maxLength={1000} class="min-h-[88px] px-4 py-3 text-foreground text-[17px] bg-transparent" />
        </Group>
        <If when={props.target.kind === 'interface'}>
          <Group><Cell title={str('reportHide')} right={<Toggle checked={hide()} onChange={(v) => hide.set(v)} label={str('reportHide')} testID="report-hide" />} /></Group>
        </If>
        <View class="px-4"><Btn kind="primary" testID="report-send" label={str('reportSend')} disabled={!reason() || busy()} onPress={send} /></View>
      </Page>
    </If>
  )
}

// ---------------------------------------------------------------- interfaces

/** Menu → Interfaces: everything it built, newest first (4.7.4). */
export function InterfacesPage(props: { onOpen: (id: string) => void }) {
  const list = resource(() => session(), async () => api().get<InterfaceItem[]>('/ui'))
  const fmt = (at: number) => formatDate(at, lang())
  const state = (i: InterfaceItem) => (i.blocked ? str('ifBlocked') : i.hidden ? str('ifHidden') : i.answered ? str('ifAnswered') : undefined)
  return (
    <Page page="InterfacesPage" refreshing={list.loading()} onRefresh={() => list.refetch()}>
      <If when={!list.loading() && (list() ?? []).length === 0}><Empty text={str('noInterfaces')} /></If>
      <If when={(list() ?? []).length > 0}>
        <Group footer={str('interfacesHint')}>
          <Each of={list() ?? []} key={(i) => i.id}>{(i) => <Cell title={i().title} subtitle={fmt(i().at)} value={state(i())} chevron onPress={() => props.onOpen(i().id)} testID={`if-${i().id}`} />}</Each>
        </Group>
      </If>
    </Page>
  )
}

/** One interface: Open, what it may use (each a switch), its link, Hide, Report. */
export function InterfacePage(props: { id: string; onOpen: (i: InterfaceItem) => Promise<unknown> | void; onReport: (t: ReportTarget) => void }) {
  const list = resource(() => session(), async () => api().get<InterfaceItem[]>('/ui'))
  const item = () => (list() ?? []).find((x) => x.id === props.id)
  const patch = async (body: Record<string, unknown>) => { try { await api().send('PATCH', `/ui/${encodeURIComponent(props.id)}`, body); list.refetch() } catch { showToast(str('failed')) } }
  const setGrant = (p: Permission, on: boolean) => { const i = item(); if (!i) return; patch({ grants: on ? [...new Set([...i.grants, p])] : i.grants.filter((g) => g !== p) }) }
  const copyLink = async () => { const l = item()?.link; if (!l) return; try { await Clipboard.writeText(l); copiedToast(str('ifLinkCopied')) } catch {} }
  return (
    <Page page="InterfacePage">
      <If when={item()}>{(i) => (
        <View class="gap-6">
          <View class="px-8 gap-1"><Text testID="if-title" class="text-foreground text-[17px] font-semibold leading-7">{i().title}</Text>
            <If when={i().blocked || i().hidden}><Text class="text-muted-foreground text-[15px]">{i().blocked ? str('ifBlocked') : str('ifHidden')}</Text></If></View>
          <If when={!i().hidden}><View class="px-4"><Btn kind="primary" testID="if-open" label={str('ifOpen')} onPress={() => { Promise.resolve(props.onOpen(i())).catch(() => {}).finally(() => list.refetch()) }} /></View></If>
          {i().permissions.length ? (
            <Group header={str('ifAsks')}>
              {i().permissions.map((p) => <Cell title={permissionWord(p)} right={<Toggle checked={i().grants.includes(p)} onChange={(v) => setGrant(p, v)} label={permissionWord(p)} testID={`grant-${p}`} />} />)}
            </Group>
          ) : <View class="px-8"><Text class="text-muted-foreground text-[13px] leading-[18px]">{str('ifNoPermissions')}</Text></View>}
          <Group>
            {i().link ? <Cell title={str('ifCopyLink')} tint onPress={copyLink} testID="if-link" /> : null}
            {i().blocked ? null : <Cell title={i().hidden ? str('ifShow') : str('ifHide')} tint onPress={() => patch({ hidden: !i().hidden })} testID="if-hide" />}
            <Cell title={str('report')} destructive onPress={() => props.onReport({ kind: 'interface', moduleId: i().id, title: i().title })} testID="if-report" />
          </Group>
        </View>
      )}</If>
    </Page>
  )
}

/**
 * Before an interface opens: anything it asked for that the person has not allowed is asked for now, by name, with
 * Allow / Don't allow (4.7.3: consent per interface; WeChat asks for a scope the same way, when it is needed). A yes is
 * kept for that interface (Interfaces → it → the switches); a no is not, so the next open asks again.
 */
export async function askPermissions(m: { id: string; title: string; permissions?: Permission[]; grants?: Permission[] }): Promise<Permission[]> {
  const grants = [...(m.grants ?? [])]
  const missing = (m.permissions ?? []).filter((p) => !grants.includes(p))
  if (!missing.length) return grants
  const choice = await AlertDialog.show({ title: t('permTitle')(m.title), description: missing.map((p) => `• ${permissionWord(p)}`).join('\n'), actions: [{ label: str('permDeny'), role: 'cancel', id: 'deny' }, { label: str('permAllow'), id: 'allow' }] })
  if (choice !== 'allow') return grants
  const next = [...grants, ...missing]
  try { await api().send('PATCH', `/ui/${encodeURIComponent(m.id)}`, { grants: next }) } catch {}
  return next
}

/** A link to an interface (universal link, App Link or deepseekbot://ui/…): its id, when it belongs to this account or computer. */
export function interfaceFromLink(url: string, origin: string): string | null | 'elsewhere' {
  try {
    const u = new URL(url)
    if (u.protocol === 'deepseekbot:') {
      const id = u.host === 'ui' ? /^\/([\w-]{1,40})$/.exec(u.pathname)?.[1] : undefined
      if (!id) return null
      const from = u.searchParams.get('origin')?.replace(/\/$/, '') ?? ''
      const onLoopback = (o: string) => /^http:\/\/127\.0\.0\.1:\d+$/.test(o) // through TailPocket: the computer's port, and the phone's, new at each launch
      return from === origin.replace(/\/$/, '') || (onLoopback(from) && onLoopback(origin.replace(/\/$/, ''))) ? id : 'elsewhere'
    }
    const m = /^\/open\/([a-z0-9][a-z0-9-]{2,40})\/ui\/([\w-]{1,40})$/.exec(u.pathname)
    if (!m) return null
    return origin.replace(/\/$/, '') === `${u.origin}/s/${m[1]}` ? m[2] : 'elsewhere'
  } catch { return null }
}

export { refreshMe }
