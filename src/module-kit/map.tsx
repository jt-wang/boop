// A map for the interfaces the assistant writes: `import { MapView } from './map'` (src/ui.ts copies this file next
// to the module's App.tsx). OpenStreetMap tiles through the bot (GET /ui/:id/tiles/z/x/y.png, src/tiles.ts: a module may
// only fetch the bot), drawn on a Canvas with the places numbered in order and, with `route`, a line through them.
// It fits the places in the view; one place is shown at street level.
import { Canvas, host, signal } from 'nsh'

export type Place = { name: string; lat: number; lng: number }

const TILE = 128 // points per 256 px tile: sharp on 2x and 3x screens
const MAX_ZOOM = 16
const params = signal<{ origin: string; moduleId: string; token: string } | null>(null)
let asked = false
function askOrigin() {
  if (asked) return
  asked = true
  host.call<{ origin: string; moduleId: string; token: string }>('launch.params').then((p) => params.set(p)).catch(() => {})
}

/** Web Mercator: the point's position in points on the world at zoom z. */
function project(lat: number, lng: number, z: number) {
  const world = TILE * 2 ** z
  const s = Math.sin((Math.max(-85, Math.min(85, lat)) * Math.PI) / 180)
  return { x: ((lng + 180) / 360) * world, y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * world }
}

function fitZoom(places: Place[], w: number, h: number, pad: number) {
  if (places.length < 2) return 14
  for (let z = MAX_ZOOM; z > 1; z--) {
    const pts = places.map((p) => project(p.lat, p.lng, z))
    const dx = Math.max(...pts.map((p) => p.x)) - Math.min(...pts.map((p) => p.x))
    const dy = Math.max(...pts.map((p) => p.y)) - Math.min(...pts.map((p) => p.y))
    if (dx <= w - 2 * pad && dy <= h - 2 * pad) return z
  }
  return 1
}

/**
 * The places on a map, numbered 1, 2, 3… in the order given; `route` draws a line through them in that order;
 * `selected` (an index) draws that one larger. `height` in points (default 220); the width is the parent's.
 */
export function MapView(props: { places: Place[]; route?: boolean; selected?: number; height?: number; class?: string }) {
  askOrigin()
  return (
    <Canvas
      class={props.class}
      style={{ width: '100%', height: props.height ?? 220, borderRadius: 12, overflow: 'hidden' }}
      draw={(cx, size) => {
        const { width: w, height: h } = size
        const places = props.places.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng))
        cx.fillStyle = '#e8e6e1'
        cx.fillRect(0, 0, w, h)
        if (!places.length) return
        const z = fitZoom(places, w, h, 28)
        const pts = places.map((p) => project(p.lat, p.lng, z))
        const cxw = (Math.max(...pts.map((p) => p.x)) + Math.min(...pts.map((p) => p.x))) / 2
        const cyw = (Math.max(...pts.map((p) => p.y)) + Math.min(...pts.map((p) => p.y))) / 2
        const left = cxw - w / 2, top = cyw - h / 2
        const p = params()
        if (p) {
          const token = encodeURIComponent(p.token)
          const n = 2 ** z
          for (let ty = Math.floor(top / TILE); ty <= Math.floor((top + h) / TILE); ty++) {
            if (ty < 0 || ty >= n) continue
            for (let tx = Math.floor(left / TILE); tx <= Math.floor((left + w) / TILE); tx++) {
              cx.drawImage(`${p.origin}/ui/${p.moduleId}/tiles/${z}/${((tx % n) + n) % n}/${ty}.png?token=${token}`, tx * TILE - left, ty * TILE - top, TILE, TILE)
            }
          }
        }
        const at = pts.map((p) => ({ x: p.x - left, y: p.y - top }))
        if (props.route && at.length > 1) {
          cx.lineJoin = 'round'; cx.lineCap = 'round'
          for (const [color, width] of [['#ffffff', 6], ['#1f1f1f', 3]] as const) {
            cx.beginPath()
            at.forEach((p, i) => (i ? cx.lineTo(p.x, p.y) : cx.moveTo(p.x, p.y)))
            cx.strokeStyle = color; cx.lineWidth = width
            cx.stroke()
          }
        }
        cx.textAlign = 'center'; cx.textBaseline = 'middle'
        // the selected one last, so a place next to it does not cover it
        const order = at.map((_, i) => i).sort((a, b) => Number(a === props.selected) - Number(b === props.selected))
        order.forEach((i) => {
          const p = at[i]!
          const r = props.selected === i ? 14 : 11
          cx.beginPath(); cx.arc(p.x, p.y, r + 2, 0, Math.PI * 2); cx.fillStyle = '#ffffff'; cx.fill()
          cx.beginPath(); cx.arc(p.x, p.y, r, 0, Math.PI * 2); cx.fillStyle = '#1f1f1f'; cx.fill()
          cx.font = `600 ${props.selected === i ? 14 : 12}px sans-serif`; cx.fillStyle = '#ffffff'
          cx.fillText(String(i + 1), p.x, p.y + 0.5)
        })
        // the tile usage policy asks for this on the map itself
        cx.font = '10px sans-serif'; cx.textAlign = 'right'; cx.textBaseline = 'bottom'
        const credit = '© OpenStreetMap contributors'
        const tw = cx.measureText(credit).width
        cx.fillStyle = 'rgba(255,255,255,0.8)'; cx.fillRect(w - tw - 8, h - 16, tw + 8, 16)
        cx.fillStyle = '#333333'; cx.fillText(credit, w - 4, h - 3)
      }}
    />
  )
}
