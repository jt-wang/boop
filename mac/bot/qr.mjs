// Prints the QR code of argv[2] as rows of 0/1 (1 = dark), with the encoder
// qrcode-terminal ships: the same one that draws the terminal QR in src/main.ts.
// The Mac window runs it through bot/run.sh (`run.sh qr <link>`) and draws the rows.
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const QRCode = require('qrcode-terminal/vendor/QRCode')
const { L } = require('qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel')

const text = process.argv[2]
if (!text) { console.error('usage: qr.mjs <text>'); process.exit(2) }
const qr = new QRCode(-1, L)
qr.addData(text)
qr.make()
const n = qr.getModuleCount()
const rows = []
for (let r = 0; r < n; r++) {
  let line = ''
  for (let c = 0; c < n; c++) line += qr.isDark(r, c) ? '1' : '0'
  rows.push(line)
}
process.stdout.write(rows.join('\n') + '\n')
