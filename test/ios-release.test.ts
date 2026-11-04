import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// What a TestFlight build must carry and must not carry, found on the first archive (2026-11-05).
const ROOT = join(import.meta.dirname, '..')

test('the archive step clears the home folder and the NSH checkout from the app binary before it exports', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ios-release-'))
  try {
    mkdirSync(join(dir, 'scripts'))
    mkdirSync(join(dir, 'ios'), { recursive: true })
    mkdirSync(join(dir, 'bin'))
    for (const f of ['scripts/ios-build.sh', 'scripts/android-scrub-home.sh', 'ios/ExportOptions.plist']) cpSync(join(ROOT, f), join(dir, f))
    writeFileSync(join(dir, 'scripts/ios-bundle.sh'), '#!/bin/sh\nexit 0\n')
    chmodSync(join(dir, 'scripts/ios-bundle.sh'), 0o755)
    const home = ['', 'Users', 'somebody'].join('/')
    // Stands in for xcodebuild: the archive holds a binary with the paths, the export saves what it was given to sign.
    writeFileSync(join(dir, 'bin/xcodebuild'), `#!/bin/bash
args=("$@")
for ((i = 0; i < \${#args[@]}; i++)); do [ "\${args[i]}" = -archivePath ] && archive="\${args[i+1]}"; done
app="$archive/Products/Applications/DeepSeekBot.app"
case " $* " in
  *" -exportArchive "*) cp "$app/DeepSeekBot" "${dir}/at-export" ;;
  *) mkdir -p "$app"; printf '${home}/.cargo/a.rs\\0/Volumes/Some Disk/work/nsh/target/b.rs\\0/usr/lib/keep\\0' > "$app/DeepSeekBot" ;;
esac
`)
    chmodSync(join(dir, 'bin/xcodebuild'), 0o755)
    const r = spawnSync('bash', [join(dir, 'scripts/ios-build.sh'), 'archive'], {
      encoding: 'utf8',
      env: { ...process.env, ASC_KEY_ID: undefined, HOME: home, PATH: `${join(dir, 'bin')}:${process.env.PATH}` },
    })
    assert.equal(r.status, 0, r.stderr)
    const signed = readFileSync(join(dir, 'at-export'), 'latin1')
    assert.equal(signed.includes(home), false)
    assert.equal(signed.includes('Some Disk'), false)
    assert.equal(signed.includes('/.cargo/a.rs'), true)
    assert.equal(signed.includes('/usr/lib/keep'), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the privacy manifest declares the boot-time clock: the release binary imports mach_absolute_time', () => {
  const manifest = readFileSync(join(ROOT, 'ios/DeepSeekBot/PrivacyInfo.xcprivacy'), 'utf8')
  assert.match(manifest, /<string>NSPrivacyAccessedAPICategorySystemBootTime<\/string>\s*<key>NSPrivacyAccessedAPITypeReasons<\/key>\s*<array>\s*<string>35F9\.1<\/string>/)
})

test('the export leaves out the symbols, which name folders on this Mac; the archive keeps them', () => {
  const options = readFileSync(join(ROOT, 'ios/ExportOptions.plist'), 'utf8')
  assert.match(options, /<key>uploadSymbols<\/key>\s*<false\/>/)
})

// Anyone can build this with their own Apple account: nothing of ours is needed, and what they fill in is one file.
function deviceBuild(local: string | null, args: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), 'ios-device-'))
  try {
    mkdirSync(join(dir, 'scripts'))
    mkdirSync(join(dir, 'ios/Config'), { recursive: true })
    mkdirSync(join(dir, 'bin'))
    cpSync(join(ROOT, 'scripts/ios-build.sh'), join(dir, 'scripts/ios-build.sh'))
    if (local !== null) writeFileSync(join(dir, 'ios/Config/Signing.local.xcconfig'), local)
    writeFileSync(join(dir, 'scripts/ios-bundle.sh'), '#!/bin/sh\nexit 0\n')
    chmodSync(join(dir, 'scripts/ios-bundle.sh'), 0o755)
    writeFileSync(join(dir, 'bin/xcodebuild'), `#!/bin/bash\nprintf '%s\\n' "$@" > "${dir}/args"\n`)
    chmodSync(join(dir, 'bin/xcodebuild'), 0o755)
    writeFileSync(join(dir, 'bin/xcrun'), `#!/bin/bash\nprintf '%s\\n' "$@" > "${dir}/xcrun"\n`)
    chmodSync(join(dir, 'bin/xcrun'), 0o755)
    const r = spawnSync('bash', [join(dir, 'scripts/ios-build.sh'), 'device', ...args], { encoding: 'utf8', env: { ...process.env, ASC_KEY_ID: undefined, PATH: `${join(dir, 'bin')}:${process.env.PATH}` } })
    const lines = (f: string) => { try { return readFileSync(join(dir, f), 'utf8').split('\n') } catch { return [] } }
    return { status: r.status, err: r.stderr, args: lines('args'), xcrun: lines('xcrun') }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('the project takes its bundle id and entitlements from settings a builder can fill in', () => {
  const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')
  const yml = read('ios/project.yml')
  assert.match(yml, /PRODUCT_BUNDLE_IDENTIFIER: "?\$\(BOOP_BUNDLE_ID\)"?\n/)
  assert.match(yml, /PRODUCT_BUNDLE_IDENTIFIER: "?\$\(BOOP_BUNDLE_ID\)\.uitests"?\n/)
  assert.match(yml, /CODE_SIGN_ENTITLEMENTS: "?\$\(BOOP_ENTITLEMENTS\)"?\n/)
  const pbx = read('ios/DeepSeekBot.xcodeproj/project.pbxproj')
  assert.doesNotMatch(pbx, /io\.jingtao\.boop/)
  const shared = read('ios/Config/Signing.shared.xcconfig')
  assert.ok(shared.indexOf('BOOP_BUNDLE_ID =') < shared.indexOf('#include?'), 'the local file overrides the default')
  const example = read('ios/Config/Signing.local.xcconfig.example')
  assert.match(example, /^DEVELOPMENT_TEAM = $/m)
  assert.match(example, /^BOOP_BUNDLE_ID = com\.example\.boop$/m)
  assert.match(example, /^\/\/ BOOP_ENTITLEMENTS =$/m)
})

test('a device build needs only the local file: signing is automatic, with no key, profile or team on the command line', () => {
  const r = deviceBuild('DEVELOPMENT_TEAM = ABCDE12345\nBOOP_BUNDLE_ID = com.example.boop\n')
  assert.equal(r.status, 0, r.err)
  assert.ok(r.args.includes('-allowProvisioningUpdates'))
  assert.ok(r.args.includes('generic/platform=iOS'))
  assert.ok(!r.args.some((a) => /authenticationKey|PROVISIONING_PROFILE|DEVELOPMENT_TEAM|ABCDE12345/.test(a)), r.args.join(' '))
})

test('a device build with a device id installs on it', () => {
  const r = deviceBuild('DEVELOPMENT_TEAM = ABCDE12345\n', ['00008130-AAAA'])
  assert.equal(r.status, 0, r.err)
  assert.ok(r.args.includes('id=00008130-AAAA'))
  assert.ok(r.xcrun.includes('install') && r.xcrun.includes('00008130-AAAA'), r.xcrun.join(' '))
})

test('a device build with no team says which file to fill in, before building', () => {
  for (const local of [null, 'DEVELOPMENT_TEAM = \n']) {
    const r = deviceBuild(local)
    assert.notEqual(r.status, 0)
    assert.match(r.err, /Signing\.local\.xcconfig/)
    assert.deepEqual(r.args, [])
  }
})
