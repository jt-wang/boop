#!/usr/bin/env node
// chart <option.json> <out.png|out.svg> [--width N] [--height N]
// Draws an ECharts option (https://echarts.apache.org/en/option.html) to a PNG or SVG. ECharts renders the SVG on the
// server (ssr) and sharp makes the PNG; the chart is disposed so Node exits (it keeps running otherwise). The size is
// in points of a phone screen (390 wide) and the PNG has 3 pixels per point, so its labels read at phone size.
import { readFileSync, writeFileSync } from 'node:fs'
import * as echarts from 'echarts'
import sharp from 'sharp'

const args = process.argv.slice(2)
const flag = (name, d) => { const i = args.indexOf(name); if (i < 0) return d; const v = Number(args.splice(i, 2)[1]); return Number.isFinite(v) && v > 0 ? v : d }
const width = flag('--width', 390), height = flag('--height', 260)
const [input, out] = args
if (!input || !out || !/\.(png|svg)$/i.test(out)) {
  console.error('usage: chart <option.json> <out.png|out.svg> [--width 390] [--height 260]')
  process.exit(2)
}
const option = JSON.parse(readFileSync(input === '-' ? 0 : input, 'utf8'))
const chart = echarts.init(null, null, { renderer: 'svg', ssr: true, width, height })
try {
  chart.setOption({ animation: false, backgroundColor: '#fff', ...option })
  const svg = chart.renderToSVGString()
  if (/\.svg$/i.test(out)) writeFileSync(out, svg)
  else await sharp(Buffer.from(svg), { density: 72 * 3 }).png().toFile(out)
} finally { chart.dispose() }
console.log(`${out} ${width}x${height}`)
