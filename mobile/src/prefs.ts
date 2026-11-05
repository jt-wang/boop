// Per-phone preferences that never reach the bot (Storage only). Settings writes
// the keys; the thread reads the signals.
import { signal, Storage } from 'nsh'

/** "Show its work" (Settings): commands and outputs inside an expanded activity list. Off: the thread only speaks in human words. Storage key `showWork` = '1'. */
export const showWork = signal(false)

export async function loadPrefs() {
  try { showWork.set((await Storage.getItem('showWork')) === '1') } catch {}
}
export async function setShowWork(on: boolean) {
  showWork.set(on)
  try { await Storage.setItem('showWork', on ? '1' : '0') } catch {}
}
