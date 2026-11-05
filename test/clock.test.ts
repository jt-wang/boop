// H3: asked the time at 00:25, the assistant said 3:22 pm. The hosted computer's
// clock is UTC, so `date`, Python and every tool read UTC. A computer that belongs to the person keeps their time
// zone the way any computer does: /etc/localtime names the zone, and every new process reads it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readlinkSync, symlinkSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { personZone, setComputerZone } from '../src/clock.ts'

function fakeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'clock-'))
  mkdirSync(join(root, 'etc'))
  for (const z of ['Etc/UTC', 'America/New_York', 'Etc/GMT+4']) { mkdirSync(join(root, 'usr/share/zoneinfo', z, '..'), { recursive: true }); writeFileSync(join(root, 'usr/share/zoneinfo', z), 'TZif') }
  symlinkSync('/usr/share/zoneinfo/Etc/UTC', join(root, 'etc/localtime'))
  writeFileSync(join(root, 'etc/timezone'), 'Etc/UTC\n')
  return root
}

test('the computer takes the person\'s zone: /etc/localtime and /etc/timezone name it', async () => {
  const root = fakeRoot()
  assert.equal(await setComputerZone('America/New_York', root), true)
  assert.equal(readlinkSync(join(root, 'etc/localtime')), '/usr/share/zoneinfo/America/New_York')
  assert.equal(readFileSync(join(root, 'etc/timezone'), 'utf8'), 'America/New_York\n')
  // an Android phone's fixed offset (mobile/src/api.ts deviceTimeZone) is a zone too
  assert.equal(await setComputerZone('Etc/GMT+4', root), true)
  assert.equal(readlinkSync(join(root, 'etc/localtime')), '/usr/share/zoneinfo/Etc/GMT+4')
})

test('a zone that is not a real one, or has no zone file, leaves the clock alone', async () => {
  const root = fakeRoot()
  for (const z of ['Mars/Olympus', '../../etc/passwd', '+05:30', 'Europe/Paris', '']) assert.equal(await setComputerZone(z, root), false, z)
  assert.equal(readlinkSync(join(root, 'etc/localtime')), '/usr/share/zoneinfo/Etc/UTC')
  assert.ok(!existsSync(join(root, 'etc/localtime.tmp')))
})

test('the zone is the phone\'s, unless the phone only guessed UTC; then the one the person set', () => {
  assert.equal(personZone({ person: { timeZone: 'America/New_York' }, timeZone: '' }), 'America/New_York')
  assert.equal(personZone({ person: { timeZone: 'UTC', timeZoneGuessed: true }, timeZone: 'Europe/Lisbon' }), 'Europe/Lisbon')
  assert.equal(personZone({ person: { timeZone: 'UTC', timeZoneGuessed: true }, timeZone: '' }), null)
  assert.equal(personZone({ timeZone: '' }), null)
})
