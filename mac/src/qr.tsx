// Draws a QR code from its modules (rows of 0/1, as mac/bot/qr.mjs prints them).
import { Canvas, colorScheme } from 'nsh'

export function QrCanvas(props: { matrix: number[][]; size: number; testID?: string }) {
  return (
    <Canvas testID={props.testID} style={{ width: props.size, height: props.size }} draw={(cx, size) => {
      const n = props.matrix.length
      if (!n) return
      const dark = colorScheme() === 'dark'
      // A quiet zone of one module on each side; the code itself is black on white in both appearances,
      // since phone cameras read dark-on-light best.
      cx.fillStyle = '#FFFFFF'
      cx.fillRect(0, 0, size.width, size.height)
      const cell = size.width / (n + 2)
      cx.fillStyle = dark ? '#0F1115' : '#000000'
      for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (props.matrix[r][c]) cx.fillRect((c + 1) * cell, (r + 1) * cell, cell + 0.5, cell + 0.5)
    }} />
  )
}

/** The lines qr.mjs prints → modules. */
export function parseMatrix(text: string): number[][] | null {
  const rows = text.trim().split('\n').map((l) => l.trim()).filter(Boolean)
  if (!rows.length || rows.some((r) => r.length !== rows.length || /[^01]/.test(r))) return null
  return rows.map((r) => [...r].map((ch) => (ch === '1' ? 1 : 0)))
}
