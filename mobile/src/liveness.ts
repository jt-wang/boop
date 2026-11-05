// A socket to a loopback port never breaks by itself: through TailPocket the phone's end stays open while the computer or
// the network is gone. So the phone asks: a ping left unanswered until the next one means the socket is gone.
export interface SocketWatch { answered(): void; stop(): void }

export function watchSocket(o: {
  every: number
  ping: () => void
  dead: () => void
  /** False while asking makes no sense, for example an app in the background. */
  may?: () => boolean
  setTimer?: (f: () => void, ms: number) => unknown
  clearTimer?: (t: unknown) => void
}): SocketWatch {
  const set = o.setTimer ?? ((f: () => void, ms: number) => setInterval(f, ms))
  const clear = o.clearTimer ?? ((t: unknown) => clearInterval(t as ReturnType<typeof setInterval>))
  let waiting = false
  let stopped = false
  const stop = () => { if (stopped) return; stopped = true; clear(timer) }
  const timer = set(() => {
    if (stopped) return
    if (o.may && !o.may()) { waiting = false; return }
    if (waiting) { stop(); o.dead(); return }
    waiting = true
    o.ping()
  }, o.every)
  return { answered: () => { waiting = false }, stop }
}
