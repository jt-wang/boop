import { host, platform, signal, Text, View } from 'nsh'
import { AlertDialog } from 'nsh/base'
import { lang, str } from './state.ts'
import { Cell, Group, Page, pageClass, Toggle } from './ui.tsx'
import { categories, noCategories, type Category } from './diagnostic-log.ts'
import { clearDiagnostics, configureDiagnostics, diagnosticError, diagnosticLog, diagnosticState, exportDiagnostics, flushDiagnostics } from './diagnostics.ts'
import { DIAGNOSTIC_WORDS } from './locales/diagnostics.ts'

export const diagnosticTitle = () => DIAGNOSTIC_WORDS[lang()].title
export const diagnosticStatus = () => { diagnosticState(); return DIAGNOSTIC_WORDS[lang()][diagnosticLog.enabled ? 'recording' : 'off'] }
export function DiagnosticsPage(props: { onBack?: () => void }) {
  const words = () => DIAGNOSTIC_WORDS[lang()]
  const current = () => { diagnosticState(); return diagnosticLog }
  const minutes = signal(15)
  const selected = signal<Record<Category, boolean>>(noCategories())
  const status = signal('')
  const busy = signal(false)
  const share = async () => {
    busy.set(true); status.set('')
    try {
      await flushDiagnostics()
      const report = exportDiagnostics(minutes(), selected())
      const range = report.actualRange ? `${new Date(report.actualRange.from).toISOString()} — ${new Date(report.actualRange.to).toISOString()}` : words().empty
      const choice = await AlertDialog.show({ title: words().confirm,
        description: `${categories.filter(c => selected()[c]).map(c => words()[c]).join(', ')}\n${range}\n${report.events.length} ${words().eventNote}`,
        actions: [{ id: 'cancel', label: str('cancel'), role: 'cancel' }, { id: 'share', label: words().share }],
      })
      if (choice.action === 'share') {
        await host.call('diagnostics.share', { text: JSON.stringify(report) })
        status.set(platform.os === 'web' ? words().download : words().opened)
      }
    } catch { status.set(words().failed) }
    finally { busy.set(false) }
  }
  return <Page page="DiagnosticsPage" class={`${pageClass} ${props.onBack ? 'pt-[env(safe-area-inset-top)]' : ''}`}>
    {props.onBack ? <Group><Cell title={str('back')} onPress={props.onBack} testID="diagnostics-back" /></Group> : null}
    <Group header={diagnosticTitle()} footer={words().privacy}>
      <Cell title={words().record} value={current().enabled ? words().recording : words().off} right={<Toggle label={words().record} testID="diagnostics-enabled" checked={current().enabled} onChange={v => { void configureDiagnostics(v, v ? noCategories() : current().selected) }} />} />
      <Cell title={words().retain} right={<Toggle label={words().retain} testID="diagnostics-retain" disabled={!current().enabled} checked={current().enabled && current().retain} onChange={v => { void configureDiagnostics(current().enabled, current().selected, v) }} />} />
    </Group>
    <Group header={words().capture} footer={words().bounds}>
      {categories.map(c => <Cell title={words()[c]} right={<Toggle label={words()[c]} testID={`diagnostics-${c}`} disabled={!current().enabled} checked={current().enabled && current().selected[c]} onChange={v => { void configureDiagnostics(current().enabled, { ...current().selected, [c]: v }) }} />} />)}
    </Group>
    <Group footer={words().measures}>
      <Cell title={words().clear} destructive onPress={() => { void clearDiagnostics().then(() => status.set(diagnosticLog.error ? words().clearFailed : words().cleared)) }} testID="diagnostics-clear" />
    </Group>
    <Group header={words().exports}>
      {categories.map(c => <Cell title={words()[c]} right={<Toggle label={`${words().exports}: ${words()[c]}`} testID={`diagnostics-export-${c}`} checked={selected()[c]} onChange={v => selected.set({ ...selected(), [c]: v })} />} />)}
    </Group>
    <Group header={words().range}>
      {[15, 60, 0].map(m => <Cell title={m ? `${m} ${words().minutes}` : words().all} value={minutes() === m ? '✓' : undefined} onPress={() => minutes.set(m)} testID={`diagnostics-range-${m}`} />)}
      <Cell title={busy() ? words().preparing : words().review} tint onPress={() => { if (!busy()) void share() }} testID="diagnostics-share" />
    </Group>
    <If when={diagnosticError()}><View class="px-8"><Text class="text-destructive">{words().error}</Text></View></If>
    <If when={status()}><View class="px-8"><Text testID="diagnostics-status" class="text-muted-foreground">{status()}</Text></View></If>
  </Page>
}
