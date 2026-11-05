// The Library: everything the assistant made, grouped by folder, with a
// preview page per file (Markdown and text rendered, images shown, anything
// else named) and a delete action. Data: GET /library, GET /library/file,
// DELETE /library/file on the bot.
import { Image, resource, Scroll, signal, Text, View } from 'nsh'
import { AlertDialog, TextView } from 'nsh/base'
import { api, joined, showToast, str, t } from './state.ts'
import { Glyph, muted } from './kit.tsx'
import { Btn, Card, Empty, Page } from './ui.tsx'

export interface LibraryEntry { path: string; size: number; mtime: number; kind: 'text' | 'image' | 'binary'; description?: string }
type FileBody = { path: string; kind: 'text' | 'image' | 'binary'; mime: string; size: number; truncated: boolean; text?: string; base64?: string }

export const fileName = (p: string) => p.split('/').pop() || p
const folderOf = (p: string) => p.split('/').slice(0, -1).join('/')
export const fileSize = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / (1024 * 1024)).toFixed(1)} MB`)
export const ago = (ts: number) => { const m = Math.round((Date.now() - ts) / 60000); if (m < 1) return str('justNow'); if (m < 60) return t('agoMin')(m); const h = Math.round(m / 60); if (h < 24) return t('agoHour')(h); return t('agoDay')(Math.round(h / 24)) }

/** Folders in display order: the workspace root first, then by name; files newest first. */
export function groupByFolder(items: LibraryEntry[]): { folder: string; files: LibraryEntry[] }[] {
  const map = new Map<string, LibraryEntry[]>()
  for (const f of items) { const k = folderOf(f.path); (map.get(k) ?? map.set(k, []).get(k)!).push(f) }
  return [...map.entries()].sort(([a], [b]) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b))).map(([folder, files]) => ({ folder, files: files.sort((a, b) => b.mtime - a.mtime) }))
}

export function LibraryPage(props: { onOpen: (path: string) => void }) {
  const list = resource(() => 0, async () => { try { return await api().get<LibraryEntry[]>('/library') } catch { showToast(str('failed')); return [] as LibraryEntry[] } })
  return (
    <Page page="LibraryPage" contentClass="px-4 py-2 pb-[calc(env(safe-area-inset-bottom)+24px)] gap-6 grow" refreshing={list.loading()} onRefresh={() => list.refetch()}>
      {list.loading() && !list() ? null : (list() ?? []).length === 0 ? <Empty text={str('noLibrary')} /> : groupByFolder(list() ?? []).map((g) => (
        <View class="gap-2">
          <View class="px-4"><Text class="text-muted-foreground text-[13px]">{g.folder || str('libraryRoot')}</Text></View>
          <Card class="overflow-hidden">
            {g.files.map((f, i) => (
              <View role="button" testID={`file:${f.path}`} onPress={() => props.onOpen(f.path)} class={`flex-row items-center gap-3 pl-[16px] pr-[14px] min-h-[44px] py-[10px] active:opacity-70 ${i > 0 ? 'border-t border-border' : ''}`} style={i > 0 ? { borderTopWidth: 0.5 } : undefined}>
                <View class="w-7 items-center"><Glyph name="file" size={22} color={muted()} /></View>
                <View class="flex-1 min-w-0">
                  <Text class="text-foreground text-[17px]" numberOfLines={1}>{fileName(f.path)}</Text>
                  <Text class="text-muted-foreground text-[15px]" numberOfLines={1}>{joined(f.description, fileSize(f.size), ago(f.mtime))}</Text>
                </View>
                <Text class="text-input text-[17px] font-semibold">›</Text>
              </View>
            ))}
          </Card>
        </View>
      ))}
    </Page>
  )
}

export function LibraryFilePage(props: { path: string; onDeleted: () => void }) {
  const body = resource(() => props.path, async (p) => { try { return await api().get<FileBody>(`/library/file?path=${encodeURIComponent(p)}&format=json`) } catch { showToast(str('failed')); return null } })
  const width = signal(0)
  const ratio = signal(0.75) // height / width until the image reports its size
  const name = fileName(props.path)
  const remove = async () => {
    const choice = await AlertDialog.show({ title: str('deleteFile'), description: t('deleteFileAsk')(name), actions: [{ label: str('cancel'), role: 'cancel', id: 'cancel' }, { label: str('deleteGo'), role: 'destructive', id: 'delete' }] })
    if (choice !== 'delete') return
    try { await api().send('DELETE', `/library/file?path=${encodeURIComponent(props.path)}`); showToast(str('deleted')); props.onDeleted() } catch { showToast(str('failed')) }
  }
  const isMarkdown = /\.(md|markdown)$/i.test(props.path)
  return (
    <Page page="LibraryFilePage" contentClass="px-4 py-3 pb-[calc(env(safe-area-inset-bottom)+24px)] gap-4 grow" onLayout={(e: unknown) => { const l = e as { width?: number; layout?: { width?: number } }; const w = l.width ?? l.layout?.width; if (w) width.set(w - 32) }}>
      {body.loading() ? null : !body() ? <Empty text={str('failed')} /> : body()!.kind === 'text' ? (
        <Card class="px-4 py-3">
          <TextView markdown={isMarkdown ? body()!.text ?? '' : `\`\`\`\n${body()!.text ?? ''}\n\`\`\``} selectable links="open" classes={{ root: 'text-foreground text-[17px] leading-6' }} />
        </Card>
      ) : body()!.kind === 'image' ? (
        <Card class="overflow-hidden items-center">
          <Image src={`data:${body()!.mime};base64,${body()!.base64 ?? ''}`} resizeMode="contain" style={{ width: width() || 300, height: (width() || 300) * ratio() }} onLoad={(s) => { if (s.width > 0) ratio.set(Math.min(s.height / s.width, 2)) }} />
        </Card>
      ) : (
        <Card class="px-4 py-6 items-center gap-2">
          <Glyph name="file" size={40} />
          <Text class="text-foreground text-[17px]" numberOfLines={2}>{name}</Text>
          <Text class="text-muted-foreground text-[15px] text-center">{str('noPreview')}</Text>
        </Card>
      )}
      {body() ? <View class="px-4"><Text class="text-muted-foreground text-[13px]">{joined(fileSize(body()!.size), body()!.truncated && str('truncated'))}</Text></View> : null}
      <Btn kind="danger" testID="delete-file" label={str('deleteFile')} onPress={remove} />
    </Page>
  )
}
