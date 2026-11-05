// Test host for the Mac window (mac/App.test.tsx): the window with a state the
// test puts in storage (`state`, JSON of BotState) and a fixed 21×21 pattern in
// place of a real QR code. Quit is recorded in storage (`quit` = '1').
import { mount, signal, Storage } from 'nsh'
import { Window } from './src/window.tsx'
import type { BotState } from './src/supervisor.ts'

const pattern = (): number[][] => Array.from({ length: 21 }, (_, r) => Array.from({ length: 21 }, (_, c) => ((r * 7 + c * 3) % 5 < 2 ? 1 : 0)))

function Fixture() {
  const state = signal<BotState>({ phase: 'starting', pairUrl: null, code: null, port: 3850, failures: 0, restarts: 0 })
  const matrix = signal<number[][] | null>(null)
  Storage.getItem('state').then((raw) => {
    if (!raw) return
    const s = JSON.parse(raw) as BotState
    state.set(s)
    if (s.pairUrl) matrix.set(pattern())
  })
  return <Window state={state} matrix={matrix} onQuit={() => { Storage.setItem('quit', '1') }} />
}

mount(Fixture)
