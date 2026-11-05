// The browser is mounted only when it can actually launch: in a container the
// image ships without Chromium and scripts/install-browser.sh adds it later.
// In the container, the row points at the broker outside the cell, never at a
// stdio child running as the cell's uid.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { browserPatchYaml } from '../src/browser.ts'

const ctx = { root: '/tmp/x', opts: { model: { provider: 'deepseek-official', model: 'deepseek-flash' } } }

test('browserPatchYaml: with DEEPSEEK_BOT_BROWSER_EXECUTABLE pointing at a missing file, no browser row', () => {
  const prevExe = process.env.DEEPSEEK_BOT_BROWSER_EXECUTABLE
  const prevCell = process.env.DEEPSEEK_BOT_IN_CONTAINER
  try {
    process.env.DEEPSEEK_BOT_BROWSER_EXECUTABLE = '/nonexistent/chromium'
    assert.equal(browserPatchYaml(ctx), '')
    process.env.DEEPSEEK_BOT_BROWSER_EXECUTABLE = process.execPath
    assert.match(browserPatchYaml(ctx), /--executable-path/)
    assert.match(browserPatchYaml(ctx), new RegExp(JSON.stringify(process.execPath).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  } finally {
    if (prevExe === undefined) delete process.env.DEEPSEEK_BOT_BROWSER_EXECUTABLE; else process.env.DEEPSEEK_BOT_BROWSER_EXECUTABLE = prevExe
    if (prevCell === undefined) delete process.env.DEEPSEEK_BOT_IN_CONTAINER; else process.env.DEEPSEEK_BOT_IN_CONTAINER = prevCell
  }
})

test('browserPatchYaml: without the env var the system Chrome is used (unchanged single-user behaviour)', () => {
  const prev = process.env.DEEPSEEK_BOT_BROWSER_EXECUTABLE
  try {
    delete process.env.DEEPSEEK_BOT_BROWSER_EXECUTABLE
    assert.match(browserPatchYaml(ctx), /--browser, "chrome"|"--browser", "chrome"/)
  } finally { if (prev !== undefined) process.env.DEEPSEEK_BOT_BROWSER_EXECUTABLE = prev }
})

test('browserPatchYaml: inside the container the broker row is HTTP; with no broker there is no in-cell fallback', () => {
  const prev = process.env.DEEPSEEK_BOT_IN_CONTAINER
  try {
    process.env.DEEPSEEK_BOT_IN_CONTAINER = '1'
    assert.equal(browserPatchYaml(ctx), '')
    const y = browserPatchYaml({ root: '/tmp/x', opts: { model: { provider: 'deepseek-official', model: 'deepseek-flash' }, browserBroker: { url: 'http://127.0.0.1:4444', secret: 's' } } })
    assert.match(y, /transport: streamable-http/)
    assert.match(y, /authorization: Bearer s/)
    assert.doesNotMatch(y, /--user-data-dir/)
  } finally { if (prev === undefined) delete process.env.DEEPSEEK_BOT_IN_CONTAINER; else process.env.DEEPSEEK_BOT_IN_CONTAINER = prev }
})
