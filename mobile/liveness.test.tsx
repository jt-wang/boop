// A socket to a loopback port never breaks by itself: through TailPocket the phone's end stays open while the computer or the
// network is gone, so "Online" stayed up after 30 s offline and replies stopped arriving (emulator, 2026-11-03).
import { expect, test } from 'nsh/test'
import { watchSocket } from './src/liveness.ts'

function clock() {
  let tick: (() => void) | null = null
  return { set: (f: () => void) => { tick = f; return 1 as never }, clear: () => { tick = null }, fire: () => tick?.(), running: () => tick !== null }
}

test('an answered ping keeps it alive; a ping left unanswered until the next one means it is gone', () => {
  const c = clock(); let pings = 0, dead = 0
  const w = watchSocket({ every: 10_000, ping: () => { pings++ }, dead: () => { dead++ }, setTimer: c.set, clearTimer: c.clear })
  c.fire(); expect(pings).toBe(1); w.answered()
  c.fire(); expect(pings).toBe(2); expect(dead).toBe(0)
  c.fire(); expect(pings).toBe(2); expect(dead).toBe(1)
  expect(c.running()).toBe(false)
})

test('stopped, it says nothing more', () => {
  const c = clock(); let pings = 0, dead = 0
  const w = watchSocket({ every: 10_000, ping: () => { pings++ }, dead: () => { dead++ }, setTimer: c.set, clearTimer: c.clear })
  w.stop(); c.fire()
  expect(pings).toBe(0); expect(dead).toBe(0)
})

test('while it may not be asked (the app in the background) it neither pings nor gives up', () => {
  const c = clock(); let pings = 0, dead = 0
  let may = false
  const w = watchSocket({ every: 10_000, ping: () => { pings++ }, dead: () => { dead++ }, may: () => may, setTimer: c.set, clearTimer: c.clear })
  c.fire(); c.fire(); expect(pings).toBe(0); expect(dead).toBe(0)
  may = true
  c.fire(); expect(pings).toBe(1); w.answered(); c.fire(); expect(dead).toBe(0)
})
