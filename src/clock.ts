// The computer's clock reads the person's local time. A computer that belongs to someone keeps its owner's time
// zone (macOS and Linux both: /etc/localtime names it, and every new process reads it), so `date`, Python and any
// tool the assistant runs answer in the person's time without being told. The phone says its zone on every
// connect (PUT /me/context); the hosted computer's image starts in UTC.
import { rename, symlink, writeFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

const IANA = /^(?:[A-Za-z][A-Za-z0-9_+-]*\/)+[A-Za-z0-9_+-]+$|^UTC$/

/** The person's zone: the phone's, unless the phone only guessed UTC; then the one set in Settings. Null when unknown. */
export function personZone(st: { person?: { timeZone?: string; timeZoneGuessed?: boolean }; timeZone?: string }): string | null {
  const real = (z?: string) => (z && IANA.test(z) && valid(z) && !(z === 'UTC' || /^Etc\/(UTC|GMT)$/.test(z)) ? z : null)
  return (st.person?.timeZoneGuessed ? null : real(st.person?.timeZone)) ?? real(st.timeZone)
}

/** Point `<root>/etc/localtime` at the zone's file and write `<root>/etc/timezone`. False (and nothing changed) for an unknown zone. */
export async function setComputerZone(zone: string, root = '/'): Promise<boolean> {
  if (!IANA.test(zone) || zone.split('/').includes('..') || !valid(zone)) return false
  const target = `/usr/share/zoneinfo/${zone}`
  if (!(await stat(join(root, target)).then((s) => s.isFile(), () => false))) return false
  const link = join(root, 'etc/localtime')
  const tmp = `${link}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  await rm(tmp, { force: true })
  await symlink(target, tmp)
  await rename(tmp, link)
  await writeFile(join(root, 'etc/timezone'), `${zone}\n`)
  return true
}

function valid(z: string) { try { new Intl.DateTimeFormat('en-US', { timeZone: z }); return true } catch { return false } }
