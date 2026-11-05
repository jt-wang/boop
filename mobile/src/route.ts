// Which way this phone reaches its computer, worked out from the address it actually uses. Boop has one route per
// pairing (no relay that picks a path at run time), so the address is the whole answer. docs/connection.md has what
// each route means and the sources. `encrypted` is the https of this one hop; through TailPocket the address is a loopback
// one on this phone that says nothing, so the session says it (`pocket`), and only that route is end-to-end encrypted.
export type Route = { encrypted: boolean; via: 'lan' | 'cloudflare' | 'hosted' | 'internet' | 'pocket'; host: string }

function isPrivate(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (h === 'localhost' || h.endsWith('.local') || h === '::1') return true
  if (/^f[cd]/.test(h) || /^fe[89ab]/.test(h)) return h.includes(':')
  const m = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(h)
  if (!m) return false
  const [a, b] = [Number(m[1]), Number(m[2])]
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)
}

export function routeOf(origin: string, hosted: boolean, pocket = false): Route | null {
  let u: URL
  try { u = new URL(origin) } catch { return null }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  if (pocket) return { encrypted: true, via: 'pocket', host: u.host }
  const encrypted = u.protocol === 'https:'
  const via: Route['via'] = hosted ? 'hosted' : isPrivate(u.hostname) ? 'lan' : encrypted && /^[a-z0-9-]+\.trycloudflare\.com$/i.test(u.hostname) ? 'cloudflare' : 'internet'
  return { encrypted, via, host: u.host }
}
