// mac/bot/qr.mjs prints the QR modules of a link for the Mac window (mac/src/qr.tsx draws them).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

const script = new URL('../mac/bot/qr.mjs', import.meta.url).pathname
const LINK = 'http://192.168.1.23:3850/pair?code=123456'

test('qr.mjs prints a square 0/1 matrix with the three finder patterns', () => {
  const out = execFileSync(process.execPath, [script, LINK], { encoding: 'utf8' })
  const rows = out.trim().split('\n')
  const n = rows.length
  assert.ok(n >= 21 && (n - 21) % 4 === 0, `a QR side is 21 + 4k, got ${n}`)
  for (const r of rows) assert.match(r, new RegExp(`^[01]{${n}}$`))
  const finder = ['1111111', '1000001', '1011101', '1011101', '1011101', '1000001', '1111111']
  assert.deepEqual(rows.slice(0, 7).map((r) => r.slice(0, 7)), finder)
  assert.deepEqual(rows.slice(0, 7).map((r) => r.slice(n - 7)), finder)
  assert.deepEqual(rows.slice(n - 7).map((r) => r.slice(0, 7)), finder)
})

test('qr.mjs encodes exactly what the terminal QR in src/main.ts encodes (same library, level L)', () => {
  const require = createRequire(import.meta.url)
  const QRCode = require('qrcode-terminal/vendor/QRCode')
  const { L } = require('qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel')
  const qr = new QRCode(-1, L)
  qr.addData(LINK); qr.make()
  const n = qr.getModuleCount()
  const expected = Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => (qr.isDark(r, c) ? '1' : '0')).join(''))
  const rows = execFileSync(process.execPath, [script, LINK], { encoding: 'utf8' }).trim().split('\n')
  assert.deepEqual(rows, expected)
})

test('qr.mjs without a link exits 2 and prints nothing on stdout', () => {
  const r = spawnSync(process.execPath, [script], { encoding: 'utf8' })
  assert.equal(r.status, 2)
  assert.equal(r.stdout, '')
})
