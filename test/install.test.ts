import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'

// install.sh is what a stranger pipes into sh. People who only want to use Boop install from the release's files: no clone
// and no build, so no git and no Go (owner, 2026-11-04). It runs here with stand-ins for curl and npm that write down
// what they were asked; tar is the real one, on a real archive.
const ROOT = join(import.meta.dirname, '..')
const sha256 = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex')

function archive(dir: string, marker = true) {
  const src = join(dir, 'pack', 'boop'); mkdirSync(join(src, 'src'), { recursive: true })
  writeFileSync(join(src, 'src', 'main.ts'), 'new')
  writeFileSync(join(src, 'package.json'), '{}')
  if (marker) writeFileSync(join(src, '.boop-release'), '0.1.0\n')
  const tgz = join(dir, 'release.tgz')
  assert.equal(spawnSync('tar', ['czf', tgz, '-C', join(dir, 'pack'), 'boop']).status, 0)
  return tgz
}

function run(env: Record<string, string> = {}, o: { before?: (home: string) => void; curlFails?: boolean; npm?: boolean; sed?: boolean } = {}) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'install-')))
  const bin = join(home, 'fake-bin'); mkdirSync(bin)
  const log = join(home, 'calls.log'); writeFileSync(log, '')
  const tgz = archive(home)
  const sums = join(home, 'SHA256SUMS')
  writeFileSync(sums, `${sha256(tgz)}  boop-${platform()}.tgz\n`)
  const script = (name: string, body: string) => { const p = join(bin, name); writeFileSync(p, `#!/bin/sh\n${body}\n`); chmodSync(p, 0o755) }
  script('curl', `echo "curl $*" >> "${log}"
${o.curlFails ? 'exit 22' : ''}
case "$2" in */SHA256SUMS) source="${sums}" ;; *) source="${tgz}" ;; esac
while [ $# -gt 0 ]; do if [ "$1" = -o ]; then cp "$source" "$2"; fi; shift; done`)
  if (o.npm !== false) script('npm', `echo "npm $* in $PWD" >> "${log}"`)
  if (o.sed === false) script('tar', 'exit 1')
  symlinkSync(process.execPath, join(bin, 'node'))
  script('git', `echo "git $*" >> "${log}"; exit 1`)
  script('go', `echo "go $*" >> "${log}"; exit 1`)
  o.before?.(home)
  const r = spawnSync('/bin/sh', [join(ROOT, 'install.sh')], { cwd: home, encoding: 'utf8', env: { PATH: o.sed === false ? bin : `${bin}:/usr/bin:/bin`, HOME: home, ...env } })
  return { home, status: r.status, out: r.stdout + r.stderr, calls: readFileSync(log, 'utf8'), done: () => rmSync(home, { recursive: true, force: true }) }
}

const platform = () => {
  const os = spawnSync('uname', ['-s'], { encoding: 'utf8' }).stdout.trim() === 'Darwin' ? 'darwin' : 'linux'
  const arch = /arm64|aarch64/.test(spawnSync('uname', ['-m'], { encoding: 'utf8' }).stdout) ? 'arm64' : 'amd64'
  return `${os}-${arch}`
}

test('a plain install downloads this platform\'s file from the latest release into ~/boop', () => {
  const r = run()
  try {
    assert.equal(r.status, 0, r.out)
    assert.match(r.calls, new RegExp(`^curl .*https://github\\.com/jt-wang/boop/releases/latest/download/boop-${platform()}\\.tgz`, 'm'))
    assert.equal(readFileSync(join(r.home, 'boop', 'src', 'main.ts'), 'utf8'), 'new')
    assert.match(r.calls, new RegExp(`^npm ci --omit=dev .* in .*/boop$`, 'm'))
    assert.match(r.out, new RegExp(`Installed Boop to ${r.home}/boop`))
    assert.match(r.out, /scan it in the Boop app/)
    assert.doesNotMatch(r.out, /deepseek-bot/)
  } finally { r.done() }
})

test('it never runs git or Go', () => {
  const r = run()
  try {
    assert.equal(r.status, 0, r.out)
    assert.doesNotMatch(r.calls, /^(git|go) /m)
  } finally { r.done() }
})

test('Node.js and npm are the only things it asks for', () => {
  const r = run({}, { npm: false })
  try {
    assert.notEqual(r.status, 0)
    assert.match(r.out, /needs npm/)
    assert.doesNotMatch(r.out, /\bGo\b|\bgit\b/)
  } finally { r.done() }
})

test('missing sed is reported before downloading or running npm', () => {
  const r = run({}, { sed: false })
  try {
    assert.notEqual(r.status, 0)
    assert.match(r.out, /Boop needs sed/)
    assert.equal(r.calls, '')
  } finally { r.done() }
})

test('installing again replaces the code and leaves nothing of the old version', () => {
  const r = run({}, { before: (home) => {
    mkdirSync(join(home, 'boop', 'src'), { recursive: true })
    writeFileSync(join(home, 'boop', '.boop-release'), '0.0.9\n')
    writeFileSync(join(home, 'boop', 'src', 'gone.ts'), 'old')
  } })
  try {
    assert.equal(r.status, 0, r.out)
    assert.equal(existsSync(join(r.home, 'boop', 'src', 'gone.ts')), false)
    assert.equal(readFileSync(join(r.home, 'boop', '.boop-release'), 'utf8'), '0.1.0\n')
  } finally { r.done() }
})

test('a folder that is not a Boop install is left alone', () => {
  const r = run({}, { before: (home) => {
    mkdirSync(join(home, 'boop', 'src'), { recursive: true })
    writeFileSync(join(home, 'boop', 'src', 'mine.ts'), 'keep')
  } })
  try {
    assert.notEqual(r.status, 0)
    assert.equal(readFileSync(join(r.home, 'boop', 'src', 'mine.ts'), 'utf8'), 'keep')
    assert.match(r.out, /not a Boop install/)
  } finally { r.done() }
})

test('an upgrade follows parent symlinks before interpreting ..', () => {
  const physical = "physical team's files"
  const r = run({ DEEPSEEK_BOT_DIR: 'link/../boop/' }, { before: (home) => {
    const nested = join(home, physical, 'nested')
    mkdirSync(nested, { recursive: true })
    symlinkSync(nested, join(home, 'link'))
    for (const parent of [home, join(home, physical)]) {
      mkdirSync(join(parent, 'boop'))
      writeFileSync(join(parent, 'boop', '.boop-release'), '0.0.9\n')
    }
  } })
  try {
    assert.equal(r.status, 0, r.out)
    assert.equal(readFileSync(join(r.home, 'boop', '.boop-release'), 'utf8'), '0.0.9\n', 'the unrelated install must stay untouched')
    const installed = join(r.home, physical, 'boop')
    assert.equal(readFileSync(join(installed, '.boop-release'), 'utf8'), '0.1.0\n')
    const cd = r.out.match(/^  (cd .+) && DEEPSEEK_API_KEY=.* npm start$/m)?.[1]
    assert.ok(cd, r.out)
    const pasted = spawnSync('sh', ['-c', `${cd} && pwd -P`], { encoding: 'utf8' })
    assert.equal(pasted.status, 0, pasted.stderr)
    assert.equal(pasted.stdout.trimEnd(), installed)
  } finally { r.done() }
})

test('an install destination that is itself a symlink is left alone', () => {
  const r = run({ DEEPSEEK_BOT_DIR: 'link/' }, { before: (home) => {
    mkdirSync(join(home, 'boop'))
    writeFileSync(join(home, 'boop', '.boop-release'), '0.0.9\n')
    symlinkSync(join(home, 'boop'), join(home, 'link'))
  } })
  try {
    assert.notEqual(r.status, 0)
    assert.match(r.out, /not a Boop install/)
    assert.equal(readFileSync(join(r.home, 'link', '.boop-release'), 'utf8'), '0.0.9\n')
  } finally { r.done() }
})

test('a download that fails stops the install and says so', () => {
  const r = run({}, { curlFails: true })
  try {
    assert.notEqual(r.status, 0)
    assert.equal(existsSync(join(r.home, 'boop')), false)
    assert.match(r.out, /Could not download/)
  } finally { r.done() }
})

test('the folder and where the files come from can be chosen', () => {
  const r = run({ DEEPSEEK_BOT_DIR: '/tmp/install-test-elsewhere', DEEPSEEK_BOT_RELEASE_URL: 'https://example.com/files' })
  try {
    assert.equal(r.status, 0, r.out)
    assert.match(r.calls, new RegExp(`^curl .*https://example\\.com/files/boop-${platform()}\\.tgz`, 'm'))
    assert.equal(existsSync('/tmp/install-test-elsewhere/src/main.ts'), true)
  } finally { r.done(); rmSync('/tmp/install-test-elsewhere', { recursive: true, force: true }) }
})

test('a local release installs and upgrades with real npm, leaving the old install working on failure', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'boop install-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const release = join(home, 'release')
  const source = join(home, 'pack', 'boop')
  const installed = join(home, 'installs', 'boop')
  const file = `boop-${platform()}.tgz`
  const tgz = join(release, file)
  const sums = join(release, 'SHA256SUMS')
  mkdirSync(release)
  mkdirSync(join(source, 'src'), { recursive: true })
  const publish = (version: string, brokenLock = false) => {
    const pkg = { name: 'boop-fixture', version }
    writeFileSync(join(source, 'package.json'), JSON.stringify({ ...pkg, scripts: { start: 'node src/main.ts' } }))
    const lock = join(source, 'package-lock.json')
    if (brokenLock) rmSync(lock, { force: true })
    else writeFileSync(lock, JSON.stringify({ ...pkg, lockfileVersion: 3, packages: { '': pkg } }))
    writeFileSync(join(source, '.boop-release'), version)
    writeFileSync(join(source, 'src', 'main.ts'), `console.log('${version}')\n`)
    assert.equal(spawnSync('tar', ['czf', tgz, '-C', join(home, 'pack'), 'boop']).status, 0)
    writeFileSync(sums, `${'0'.repeat(64)}  other-platform.tgz\n${sha256(tgz)}  ${file}\n`)
  }
  const env = { ...process.env, HOME: home, DEEPSEEK_BOT_DIR: installed + '/', DEEPSEEK_BOT_RELEASE_URL: pathToFileURL(release).href, npm_config_offline: 'true' }
  const install = () => spawnSync('sh', [join(ROOT, 'install.sh')], { encoding: 'utf8', env })
  const works = (version: string) => {
    const r = spawnSync('npm', ['start', '--silent'], { cwd: installed, encoding: 'utf8', env })
    assert.equal(r.status, 0, r.stderr)
    assert.equal(r.stdout.trim(), version)
    assert.deepEqual(readdirSync(join(home, 'installs')), ['boop'])
  }
  const fails = (error: RegExp) => {
    const r = install()
    assert.notEqual(r.status, 0, r.stdout + r.stderr)
    assert.match(r.stderr, error)
    works('1.0.0')
  }

  publish('1.0.0')
  let r = install()
  assert.equal(r.status, 0, r.stdout + r.stderr)
  works('1.0.0')

  publish('2.0.0')
  rmSync(sums)
  fails(/Could not download .*SHA256SUMS/)
  writeFileSync(sums, `${sha256(tgz)}  ${file}.other\n`)
  fails(/SHA256SUMS has no unique valid checksum/)
  publish('2.0.0')
  writeFileSync(tgz, Buffer.concat([readFileSync(tgz), Buffer.from('tampered')]))
  fails(/SHA256 checksum mismatch/)
  publish('2.0.0', true)
  fails(/EUSAGE/)

  publish('2.0.0')
  r = install()
  assert.equal(r.status, 0, r.stdout + r.stderr)
  works('2.0.0')
})

test('the release files carry what the server runs and the helper for their platform, and nothing else', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pack-'))
  try {
    const tree = join(dir, 'tree'), helper = join(dir, 'helpers'), out = join(dir, 'out')
    for (const d of ['bin', 'src', 'app', 'vendor/tailpocket', 'scripts', 'mobile', 'test', 'docs', 'ios']) { mkdirSync(join(tree, d), { recursive: true }); writeFileSync(join(tree, d, 'x'), 'x') }
    for (const f of ['package.json', 'package-lock.json', 'README.md', 'SETUP.md', 'LICENSE']) writeFileSync(join(tree, f), '{"version":"1.2.3"}')
    mkdirSync(helper)
    const platforms = ['darwin-arm64', 'darwin-amd64', 'linux-arm64', 'linux-amd64']
    for (const p of platforms) writeFileSync(join(helper, `tailpocket-host-${p}`), p)
    const r = spawnSync('sh', [join(ROOT, 'scripts/release-pack.sh'), tree, out], { encoding: 'utf8', env: { ...process.env, TAILPOCKET_HELPERS: helper } })
    assert.equal(r.status, 0, r.stdout + r.stderr)
    for (const p of platforms) {
      const names = spawnSync('tar', ['tzf', join(out, `boop-${p}.tgz`)], { encoding: 'utf8' }).stdout.split('\n')
      assert.ok(names.includes(`boop/vendor/tailpocket/bin/tailpocket-host-${p}`), p)
      assert.equal(names.filter((n) => n.includes('tailpocket-host-')).length, 1, p)
      for (const n of ['boop/src/x', 'boop/app/x', 'boop/bin/x', 'boop/package-lock.json', 'boop/LICENSE', 'boop/SETUP.md', 'boop/.boop-release']) assert.ok(names.includes(n), n)
      assert.equal(names.some((n) => /^boop\/(mobile|test|docs|ios)\//.test(n)), false, p)
    }
    assert.match(spawnSync('tar', ['xzOf', join(out, 'boop-linux-amd64.tgz'), 'boop/.boop-release'], { encoding: 'utf8' }).stdout, /^1\.2\.3$/m)
    // A relative tree and output folder, as someone types them from the folder that holds them.
    const rel = spawnSync('sh', [join(ROOT, 'scripts/release-pack.sh'), relative(dir, tree), 'rel-out'], { cwd: dir, encoding: 'utf8', env: { ...process.env, TAILPOCKET_HELPERS: helper } })
    assert.equal(rel.status, 0, rel.stdout + rel.stderr)
    assert.ok(existsSync(join(dir, 'rel-out', 'boop-linux-amd64.tgz')))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('what a user reads installs from the release; building is its own guide', () => {
  const setup = readFileSync(join(ROOT, 'SETUP.md'), 'utf8')
  assert.doesNotMatch(setup, /git clone|go\.dev|Needs Go|with Go/)
  assert.match(setup, /raw\.githubusercontent\.com\/jt-wang\/boop\/main\/install\.sh/)
  assert.match(setup, /docs\/BUILD\.md/)
  const tryIt = readFileSync(join(ROOT, 'README.md'), 'utf8').split('## Try it')[1].split('## What it does')[0]
  assert.doesNotMatch(tryIt, /git clone|\bGo\b/)
  assert.match(tryIt, /releases\/latest\/download\/Boop\.dmg/)
  assert.match(tryIt, /docs\/BUILD\.md/)
  assert.match(readFileSync(join(ROOT, 'docs/BUILD.md'), 'utf8'), /git clone https:\/\/github\.com\/jt-wang\/boop\.git/)
})

test('what readers follow names the public repository', () => {
  for (const f of ['README.md', 'SETUP.md', 'install.sh', 'docs/hosting.md', 'src/tiles.ts']) {
    const s = readFileSync(join(ROOT, f), 'utf8')
    assert.doesNotMatch(s, /jt-wang\/deepseek-bot|<owner>\/deepseek-bot|cd deepseek-bot\b/, f)
  }
})

test('npm install leaves the checkout clean, so the next install can pull: the lockfile agrees with package.json', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const root = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8')).packages['']
  assert.equal(root.license, pkg.license)
})

test('a developer finds TailPocket at ../tailpocket, the name a clone of the public repository gets', () => {
  assert.match(readFileSync(join(ROOT, 'scripts/tailpocket-sync.sh'), 'utf8'), /\$ROOT\/\.\.\/tailpocket\}/)
  assert.match(readFileSync(join(ROOT, 'ios/project.yml'), 'utf8'), /path: \.\.\/\.\.\/tailpocket\/sdk\/apple\/NSH/)
  assert.match(readFileSync(join(ROOT, 'ios/DeepSeekBot.xcodeproj/project.pbxproj'), 'utf8'), /relativePath = "?\.\.\/\.\.\/tailpocket\/sdk\/apple\/NSH/)
})

test('Android asks for TailPocket under the group and version public TailPocket publishes', () => {
  const read = (f: string) => readFileSync(join(ROOT, f), 'utf8')
  const gradle = read('android/app/build.gradle')
  assert.match(gradle, /implementation 'io\.jingtao\.tailpocket:tailpocket:0\.3\.6'/)
  assert.match(gradle, /implementation 'io\.jingtao\.tailpocket:tailpocket-ui:0\.3\.6'/)
  assert.match(read('scripts/tailpocket-sync.sh'), /build\/android\/m2\/io\/jingtao\/tailpocket/)
  // A clean machine has no Gradle cache and no local.properties in a fresh TailPocket clone.
  assert.match(read('scripts/tailpocket-sync.sh'), /export ANDROID_HOME="\$\{ANDROID_HOME:-\$HOME\/Library\/Android\/sdk\}"/)
  assert.doesNotMatch(read('scripts/tailpocket-sync.sh'), /gradlew --offline/)
  assert.match(read('android/app/src/main/java/dev/deepseekbot/app/MainActivity.java'), /io\.jingtao\.tailpocket\.nsh/)
})

test('the app is io.jingtao.boop everywhere the OS or a store reads its id', () => {
  const read = (f: string) => readFileSync(join(ROOT, f), 'utf8')
  assert.equal(JSON.parse(read('mobile/nsh.json')).id, 'io.jingtao.boop')
  assert.equal(JSON.parse(read('mac/nsh.json')).id, 'io.jingtao.boop.mac')
  // The iOS id comes from one setting, so someone signing with their own account changes only ios/Config/Signing.local.xcconfig.
  assert.match(read('ios/Config/Signing.shared.xcconfig'), /^BOOP_BUNDLE_ID = io\.jingtao\.boop$/m)
  assert.match(read('ios/project.yml'), /PRODUCT_BUNDLE_IDENTIFIER: \$\(BOOP_BUNDLE_ID\)\n/)
  assert.match(read('ios/DeepSeekBot.xcodeproj/project.pbxproj'), /PRODUCT_BUNDLE_IDENTIFIER = "\$\(BOOP_BUNDLE_ID\)";/)
  for (const f of ['ios/project.yml', 'ios/DeepSeekBot.xcodeproj/project.pbxproj', 'ios/DeepSeekBot/Info.plist', 'src/host-main.ts', 'mobile/nsh.json', 'mac/nsh.json']) {
    assert.doesNotMatch(read(f), /dev\.deepseekbot\.(app|mac)/, f)
  }
})
