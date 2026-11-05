// What the phone's Settings show about this computer.
import { readFileSync } from 'node:fs'
import { hostname } from 'node:os'

/** The machine's name as its owner knows it: a Mac's hostname carries `.local`. */
export function computerName(host: string): string { return host.replace(/\.local$/i, '') }

const version = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version

export function computerInfo(): { name: string; version: string } { return { name: computerName(hostname()), version } }
