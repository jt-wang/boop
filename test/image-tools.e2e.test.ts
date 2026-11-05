// The two tools that failed on the hosted computer once,
// run in the image the way the sandbox runs them, with the
// narrow Docker set from src/host-main.ts and the bot's own egress rules.
//
// - ui: the linux/amd64 image (Fly's; nsh has no Linux arm64 release). On an
//   Apple-silicon Docker the amd64 image runs under Rosetta, where bwrap cannot
//   make its user namespace (unshare: EINVAL), so the whole bot cannot boot
//   there; test/fixtures/ui-compile-in-image.ts runs the bot's compile path
//   alone: the egress proxy and kernel rules for uid 1000, then Ui.open and
//   Ui.create as root with runAs uid 1000.
// - read_image: the amd64 image with test/fixtures/read-image-in-image.ts (DSH's
//   storage call, which loads sharp, as uid 1000), and this machine's image
//   with the whole bot and a scripted model.
// - install_browser: the image for this machine's architecture (apt and the
//   script are the same on both), the whole bot and DSH with a scripted model.
//
// Needs Docker; runs with DEEPSEEK_BOT_E2E=1 (builds both images and installs
// Chromium from Debian: several minutes).
// Run: DEEPSEEK_BOT_E2E=1 node --test test/image-tools.e2e.test.ts
// DEEPSEEK_BOT_TOOLS_IMAGE / DEEPSEEK_BOT_TOOLS_IMAGE_AMD64 with
// DEEPSEEK_BOT_CONTAINMENT_NO_BUILD=1 run it against images built before.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { crc32, deflateSync } from 'node:zlib'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { agentEnv, agentLimits } from '../src/cell.ts'
import { runBreakout } from './fixtures/breakout-run.ts'

const IMAGE = process.env.DEEPSEEK_BOT_TOOLS_IMAGE ?? 'deepseek-bot:tools'
const IMAGE_AMD64 = process.env.DEEPSEEK_BOT_TOOLS_IMAGE_AMD64 ?? 'deepseek-bot:tools-amd64'
const run = process.env.DEEPSEEK_BOT_E2E === '1' && dockerReady()

function dockerReady(): boolean {
  try { execFileSync('docker', ['info'], { stdio: 'ignore' }); return true } catch { return false }
}

async function freePort(): Promise<number> {
  const s = createServer()
  s.listen(0, '127.0.0.1')
  await once(s, 'listening')
  const p = (s.address() as { port: number }).port
  await new Promise<void>((r) => s.close(() => r()))
  return p
}

// The sandbox container's narrow set (src/host-main.ts), instead of --privileged.
const dockerArgs = [
  '--cap-add=SYS_ADMIN', '--cap-add=NET_ADMIN', '--cap-add=SYSLOG',
  '--security-opt', 'systempaths=unconfined',
  '--security-opt', `seccomp=${join(import.meta.dirname, '..', 'deploy', 'seccomp-bwrap.json')}`,
  '--device', '/dev/loop-control', '--device-cgroup-rule', 'b 7:* rmw',
]

const built = new Set<string>()
function image(tag: string, platform?: string) {
  if (built.has(tag)) return tag
  if (process.env.DEEPSEEK_BOT_CONTAINMENT_NO_BUILD === '1') execFileSync('docker', ['image', 'inspect', tag], { stdio: 'ignore' })
  else execFileSync('docker', ['build', ...(platform ? ['--platform', platform] : []), '-t', tag, '.'], { stdio: 'inherit' })
  built.add(tag)
  return tag
}

const TIP = `import { host, mount, signal, Text, View } from 'nsh'
function App() {
  const pct = signal(10)
  const tip = () => Math.round(4200 * pct()) / 100
  const send = async () => {
    const p = await host.call<{ origin: string; moduleId: string; token: string }>('launch.params')
    await fetch(\`\${p.origin}/ui/\${p.moduleId}/result\`, { method: 'POST', headers: { authorization: \`Bearer \${p.token}\`, 'content-type': 'application/json' }, body: JSON.stringify({ value: { tip: tip() } }) })
    host.call('ui.close').catch(() => {})
  }
  return (
    <View class="flex-1 bg-background p-4 gap-4">
      <Text class="text-foreground text-[17px] font-semibold">Bill €4200</Text>
      <View class="flex-row gap-2">{[10, 15, 20].map((v) => (
        <View role="button" onPress={() => pct.set(v)} class="flex-1 items-center rounded-[10px] py-3 bg-card"><Text class="text-foreground">{v}%</Text></View>
      ))}</View>
      <Text class="text-foreground text-[34px] font-bold">€{tip()}</Text>
      <View role="button" onPress={send} class="rounded-[12px] bg-primary py-3 items-center"><Text class="text-primary-foreground font-semibold">Use this</Text></View>
    </View>
  )
}
mount(App)
`

test('ui in the amd64 image: a module type-checks, builds and signs as the cell user behind its egress rules, with no download and no loader warning', { skip: !run, timeout: 1_200_000 }, () => {
  const img = image(IMAGE_AMD64, 'linux/amd64')
  const dir = mkdtempSync(join(tmpdir(), 'ui-image-'))
  writeFileSync(join(dir, 'App.tsx'), TIP)
  writeFileSync(join(dir, 'Broken.tsx'), `import { mount, Text } from 'nsh'\nfunction App() { const bad: number = 'x'; return <Text>{bad}</Text> }\nmount(App)\n`)
  const name = `dsb-ui-${process.pid}`
  const docker = (...a: string[]) => execFileSync('docker', a, { encoding: 'utf8', maxBuffer: 16 << 20 })
  docker('run', '-d', '--name', name, '--platform', 'linux/amd64', ...dockerArgs, '-v', `${join(import.meta.dirname, 'fixtures')}:/fixtures:ro`, '-v', `${dir}:/in:ro`, '--entrypoint', 'sleep', img, 'infinity')
  try {
    const version = docker('exec', name, 'sh', '-c', 'nsh --version 2>&1')
    assert.doesNotMatch(version, /GLIBC/, `nsh runs on the image's C library without a warning: ${version}`)
    const out = docker('exec', name, 'node', '/fixtures/ui-compile-in-image.ts', '/in/App.tsx').trim().split('\n').at(-1)!
    const r = JSON.parse(out) as { ok: boolean; id?: string; errors?: string }
    assert.doesNotMatch(String(r.errors), /registry\.npmjs\.org|typescript-linux|GLIBC/, `nsh check needs no download and no newer C library: ${out}`)
    assert.ok(r.ok, `the module was built: ${out}`)
    const m = `/data/ui/${r.id}`
    const files = docker('exec', name, 'sh', '-c', `stat -c '%u %n' ${m}/${r.id}.nshpkg ${m}/build/bundle.js; ls -a ${m}`)
    assert.match(files, new RegExp(`^1000 ${m}/${r.id}\\.nshpkg$`, 'm'), `the package was written by the cell user: ${files}`)
    assert.doesNotMatch(files, /\.cache/, `nothing was downloaded into the module dir: ${files}`)
    // the shipped compiler really type-checks: a type error still comes back for the assistant to fix
    const broken = docker('exec', name, 'node', '/fixtures/ui-compile-in-image.ts', '/in/Broken.tsx').trim().split('\n').at(-1)!
    assert.match(broken, /TS2322/, broken)
  } finally { try { docker('rm', '-f', name) } catch {} }
})

/** An RGB PNG of w×h in stripes (small enough to pass in a shell argument), made without sharp. */
function png(w: number, h: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type), data])))
    return Buffer.concat([len, Buffer.from(type), data, crc])
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2
  // each row is stored with PNG's "Up" filter (the difference from the row above), so repeated rows deflate to almost nothing
  const pixel = (x: number, y: number) => [(x >> 7) & 1 ? 220 : 40, (y >> 7) & 1 ? 200 : 60, 128]
  const raw = Buffer.alloc((w * 3 + 1) * h)
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 2
    for (let x = 0; x < w; x++) {
      const cur = pixel(x, y), up = y ? pixel(x, y - 1) : [0, 0, 0]
      for (let c = 0; c < 3; c++) raw[y * (w * 3 + 1) + 1 + x * 3 + c] = (cur[c] - up[c]) & 255
    }
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

// read_image failed on the hosted computer ("Could not load the sharp module"):
// the image's prune step deleted node_modules/@img, sharp's native builds. 3000×2000 is over DSH's normalization
// limit (4,194,304 pixels), so the store decodes, resizes and re-encodes it with sharp.
test('read_image in the amd64 image: DSH stores a PNG with sharp as the cell user behind its egress rules', { skip: !run, timeout: 1_200_000 }, () => {
  const img = image(IMAGE_AMD64, 'linux/amd64')
  const dir = mkdtempSync(join(tmpdir(), 'read-image-'))
  chmodSync(dir, 0o755)
  writeFileSync(join(dir, 'shot.png'), png(3000, 2000), { mode: 0o644 })
  const name = `dsb-img-${process.pid}`
  const docker = (...a: string[]) => execFileSync('docker', a, { encoding: 'utf8', maxBuffer: 16 << 20 })
  docker('run', '-d', '--name', name, '--platform', 'linux/amd64', ...dockerArgs, '-v', `${join(import.meta.dirname, 'fixtures')}:/fixtures:ro`, '-v', `${dir}:/in:ro`, '--entrypoint', 'sleep', img, 'infinity')
  try {
    const out = docker('exec', name, 'node', '/fixtures/read-image-in-image.ts', '/in/shot.png').trim().split('\n').at(-1)!
    const r = JSON.parse(out) as { ok: boolean; uid?: number; error?: string; ref?: { mediaType: string; width: number; height: number; originalDimensions?: { width: number; height: number } } }
    assert.equal(r.uid, 1000, out)
    assert.ok(r.ok, `the image was stored: ${out}`)
    assert.deepEqual(r.ref?.originalDimensions, { width: 3000, height: 2000 }, out)
    assert.ok(r.ref!.width * r.ref!.height <= 4194304, `sharp downscaled it: ${out}`)
  } finally { try { docker('rm', '-f', name) } catch {} }
})

test('read_image through the real harness in the image: a PNG the assistant wrote comes back as an image', { skip: !run, timeout: 1_200_000 }, async () => {
  const b64 = png(3000, 2000).toString('base64')
  const r = await runBreakout(image(IMAGE), {
    probes: [
      { id: 'write', call: { name: 'bash', arguments: { command: `printf '%s' '${b64}' | base64 -d > shot.png && ls -l shot.png`, description: 'write a png' } } },
      { id: 'read', call: { name: 'read_image', arguments: { file_path: 'shot.png' } } },
    ],
    port: await freePort(), dockerArgs, timeoutMs: 300_000,
  })
  assert.match(r.results.write, /shot\.png/, r.results.write)
  assert.doesNotMatch(r.results.read, /sharp/i, r.results.read)
  assert.match(r.results.read, /<type>image<\/type>[\s\S]*image\/\w+ image, \d+x\d+ px[\s\S]*downscaled from 3000x2000/, r.results.read)
})

test('install_browser: one call waits for the whole install, one apt run, then the browser is mounted', { skip: !run, timeout: 1_800_000 }, async () => {
  const calls = Array.from({ length: 40 }, (_, i) => ({ id: `install-${i}`, call: { name: 'mcp__bot__install_browser', arguments: {} } }))
  const r = await runBreakout(image(IMAGE), {
    probes: calls, until: (results) => results.some((x) => /^Installed\.|Could not get lock/.test(x)),
    port: await freePort(), memory: '2g', dockerArgs, timeoutMs: 1_500_000, keep: true, restart: true,
  })
  try {
    const results = Object.values(r.results).filter((x) => x !== '(no result)')
    const all = results.join('\n---\n')
    assert.doesNotMatch(all, /Could not get lock|lock-frontend/, `no second apt-get raced the first: ${all}`)
    assert.doesNotMatch(all, /timed out|timeout/i, `every call answered before the harness's tool timeout: ${all}`)
    // one call: with 40 s calls the assistant tried Chromium in its own shell between them; a call now waits up to 4 minutes (src/browser-install.ts, BOT_TOOL_TIMEOUT_MS in src/home.ts)
    assert.match(results[0], /^Installed\./, `the first call waits for the install: ${all}`)
    // the bot mounts the browser while that call is open (src/main.ts), no restart
    let logs = ''
    for (let i = 0; i < 120 && !/browser broker on/.test(logs); i++) { await new Promise((x) => setTimeout(x, 1000)); try { logs = execFileSync('docker', ['logs', r.container], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) } catch { /* restarting */ } }
    assert.match(logs, /browser broker on .* as uid 1001/, 'after the restart the bot mounts the browser')
    const history = execFileSync('docker', ['exec', r.container, 'sh', '-c', 'grep -c "^Commandline: .*install.*chromium" /var/log/apt/history.log'], { encoding: 'utf8' }).trim()
    assert.equal(history, '1', 'apt installed Chromium once')
  } finally { await r.close() }
})

test('install-browser.sh twice at once: the second waits for the first and both succeed', { skip: !run, timeout: 1_800_000 }, () => {
  const out = execFileSync('docker', ['run', '--rm', '--entrypoint', 'sh', image(IMAGE), '-c',
    'sh scripts/install-browser.sh > /tmp/a.log 2>&1 & a=$!; sleep 2; sh scripts/install-browser.sh > /tmp/b.log 2>&1; b=$?; wait $a; echo "a=$? b=$b"; tail -2 /tmp/a.log; cat /tmp/b.log; grep -c "^Commandline: .*install.*chromium" /var/log/apt/history.log'], { encoding: 'utf8', maxBuffer: 16 << 20 })
  assert.match(out, /a=0 b=0/, out)
  assert.match(out, /step: waiting for the install that is already running/, out)
  assert.match(out, /browser already installed at \/usr\/bin\/chromium/, out)
  assert.doesNotMatch(out, /Could not get lock/, out)
  assert.match(out.trim().split('\n').at(-1)!, /^1$/, `apt installed Chromium once: ${out}`)
})

// A chart is one command: `chart option.json out.png` renders an ECharts option to SVG and makes the PNG with sharp,
// with a CJK font so Chinese labels are letters, not boxes. ECharts keeps Node running until the chart is disposed
// (measured 2026-10-29 in the image: a script without dispose() still ran after 15 s), so the command disposes and
// exits. A script can still import both by name. The hosted pass of 2026-10-29 spent 12 calls getting pip for
// matplotlib; Python's data libraries would add ~470 MB to the image, these a few MB.
test('a chart in Node: `chart` draws an ECharts option to PNG and exits, Chinese text draws, and scripts import echarts and sharp', { skip: !run, timeout: 1_200_000 }, () => {
  const ink = `import sharp from 'sharp'
const ink = async (text) => { // dark pixels in a PNG of just this text
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="60"><rect width="200" height="60" fill="#fff"/><text x="10" y="40" font-size="32" fill="#000">' + text + '</text></svg>'
  const { data } = await sharp(Buffer.from(svg)).greyscale().raw().toBuffer({ resolveWithObject: true })
  return data.filter((v) => v < 128).length
}
const { default: echarts } = await import('echarts').then((m) => ({ default: m }))
console.log('ink', await ink(''), await ink('里斯本'), await ink('Lisbon'), typeof echarts.init)`
  const option = JSON.stringify({ title: { text: '里斯本本周气温' }, xAxis: { type: 'category', data: ['一', '二', '三'] }, yAxis: { type: 'value' }, series: [{ type: 'line', data: [19, 20, 18] }] })
  const out = execFileSync('docker', ['run', '--rm', '--user', '1000:1000', '-e', 'HOME=/tmp/h', '--entrypoint', 'sh', image(IMAGE), '-c',
    `mkdir -p /tmp/h/w && cd /tmp/h/w && cat > ink.mjs <<'JS'\n${ink}\nJS\n` +
    `printf '%s' '${option}' > week.json && s=$(date +%s) && timeout 30 chart week.json week.png; echo "chart=$? $(( $(date +%s) - s ))s"; ` +
    `timeout 30 chart week.json week.svg --width 600 --height 300 >/dev/null; head -c 120 week.svg | tr -d '\n'; echo; ` +
    `node -e "require('sharp')('week.png').metadata().then((m) => console.log('png', m.width, m.height))"; timeout 30 node ink.mjs 2>&1`], { encoding: 'utf8', maxBuffer: 16 << 20 })
  const [, code, secs] = /^chart=(\d+) (\d+)s$/m.exec(out) ?? []
  assert.equal(code, '0', `chart exited by itself: ${out}`)
  assert.ok(Number(secs) < 15, out)
  assert.match(out, /^png 1170 780$/m, `a PNG of the default size, 390 × 260 points at 3 pixels per point: ${out}`)
  assert.match(out, /<svg[^>]*width="600"[^>]*height="300"/, `an SVG of the size asked: ${out}`)
  const m = /^ink (\d+) (\d+) (\d+) function$/m.exec(out)
  assert.ok(m, `a script imports sharp and echarts by name: ${out}`)
  assert.equal(Number(m![1]), 0, `an empty label draws nothing (the measure works): ${out}`)
  assert.ok(Number(m![3]) > 100, `Latin text draws: ${out}`)
  assert.ok(Number(m![2]) > 100, `Chinese text draws: ${out}`)
})

// The agent shell runs under an address-space cap (src/cell.ts). On Fly `chart` died there: "glib/gprintf.c:351:
// failed to allocate memory", then sharp segfaulted (hosted pass of 2026-10-30). Measured on a Fly cell that day:
// Node alone reaches 1.2 GB of address space and sharp's threads add 0.48 GB of malloc arenas, past the 1.5 GiB cap;
// with MALLOC_ARENA_MAX=2 the peak was 1.23 GB and the chart drew. Whether a capped run crashes depends on which
// allocation fails first (here on arm64 it survived the cap with a 1.72 GB peak; Rosetta's amd64 reserves terabytes and
// ignores it), so the test measures the peak itself: under the shell's environment it must leave room below the cap.
test('a chart fits the agent shell: under its environment the peak address space stays well below the cap', { skip: !run, timeout: 1_200_000 }, () => {
  const option = JSON.stringify({ xAxis: { type: 'category', data: ['一', '二'] }, yAxis: { type: 'value' }, series: [{ type: 'line', data: [1, 2] }] })
  const env = Object.entries(agentEnv).map(([k, v]) => `${k}=${v}`).join(' ')
  const cap = Number(/^--as=(\d+)$/m.exec(agentLimits.join('\n'))![1])
  const out = execFileSync('docker', ['run', '--rm', '--user', '1000:1000', '-e', 'HOME=/tmp/h', '--entrypoint', 'sh', image(IMAGE), '-c',
    `cd /tmp; printf '%s' '${option}' > o.json; env ${env} prlimit ${agentLimits.join(' ')} -- chart o.json o.png > o.log 2>&1 & p=$!; peak=0; ` +
    `while kill -0 $p 2>/dev/null; do v=$(grep VmPeak /proc/$p/status 2>/dev/null | tr -dc 0-9); [ -n "$v" ] && peak=$v; done; wait $p; echo "chart=$?"; cat o.log; echo "peak=$peak"`], { encoding: 'utf8', maxBuffer: 16 << 20 })
  assert.match(out, /^chart=0$/m, out)
  assert.match(out, /^o\.png 390x260$/m, out)
  assert.doesNotMatch(out, /Fontconfig error/, `fontconfig finds its config, so the assistant sees no warning: ${out}`)
  const peak = Number(/^peak=(\d+)$/m.exec(out)![1]) * 1024
  assert.ok(peak > 100 << 20, `the measure saw the process: ${out}`)
  assert.ok(peak < cap * 0.85, `peak ${(peak / 1e9).toFixed(2)} GB, cap ${(cap / 1e9).toFixed(2)} GB: ${out}`)
})
