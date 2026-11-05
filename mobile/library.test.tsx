// Headless UI tests for the Library page (`nsh test library.test.tsx`). The bot is mocked with network routes.
import { expect, open, test } from 'nsh/test'

const ORIGIN = 'http://127.0.0.1:3850'
const now = Date.now()
const base = {
  storage: { origin: ORIGIN, token: 'tok_abcdefghijklmnopqrstuvwxyz0123456789' },
  network: {
    [`GET ${ORIGIN}/me`]: { body: { device: { id: 'd1', name: 'iPhone' }, assistant: { name: 'Nori' }, mainSessionId: 'main', connected: true, pushPublicKey: null } },
    [`POST ${ORIGIN}/ws-ticket`]: { body: { ticket: 'ticket' } },
  },
}
const files = [
  { path: 'notes/hello.md', size: 42, mtime: now - 5 * 60_000, kind: 'text' },
  { path: 'chart.png', size: 20480, mtime: now - 2 * 3600_000, kind: 'image', description: 'Sales chart' },
  { path: 'report.pdf', size: 3 * 1024 * 1024, mtime: now - 3 * 86400_000, kind: 'binary' },
]

test('files are grouped by folder with size and age; a tap opens the file as rendered Markdown', async () => {
  const app = await open('./library.harness.tsx', {
    ...base,
    network: {
      ...base.network,
      [`GET ${ORIGIN}/library`]: { body: files },
      [`GET ${ORIGIN}/library/file?path=notes%2Fhello.md&format=json`]: { body: { path: 'notes/hello.md', kind: 'text', mime: 'text/markdown; charset=utf-8', size: 42, truncated: false, text: '# Autumn\n\nold pond\nfrog jumps in\nsound of water\n' } },
    },
  })
  await app.waitFor('text:hello.md')
  expect(app.shows('text:notes')).toBe(true)          // folder header, as written (no all-caps)
  expect(app.shows('text:Files')).toBe(true)          // root group
  expect(app.shows('text:/42 B, 5m/')).toBe(true)    // size, age (no middle dots)
  expect(app.shows('text:/20 KB, 2h/')).toBe(true)
  expect(app.shows('text:/3.0 MB, 3d/')).toBe(true)
  expect(app.shows('text:/Sales chart/')).toBe(true)  // the present description
  await app.press('text:hello.md')
  await app.waitFor('text:/old pond/')
  expect(app.shows('text:/frog jumps in/')).toBe(true)
  // the line under a file says its size; its MIME type ("image/png, 44 KB") is a technical word (QA, 2026-10-30)
  expect(app.shows('text:/text\\/markdown/')).toBe(false)
  expect(app.shows('text:42 B')).toBe(true)
  const got = app.requests().find((r) => r.url.includes('/library/file'))
  expect(Boolean(got)).toBe(true)
  expect(got!.headers['authorization'] ?? got!.headers['Authorization']).toMatch(/^Bearer tok_/)
})

test('a file can be deleted from its page after a confirmation', async () => {
  const app = await open('./library.harness.tsx', {
    ...base,
    network: {
      ...base.network,
      [`GET ${ORIGIN}/library`]: { body: files },
      [`GET ${ORIGIN}/library/file?path=report.pdf&format=json`]: { body: { path: 'report.pdf', kind: 'binary', mime: 'application/pdf', size: 3 * 1024 * 1024, truncated: false, base64: '' } },
      [`DELETE ${ORIGIN}/library/file?path=report.pdf`]: { body: { ok: true } },
    },
  })
  await app.waitFor('text:report.pdf')
  await app.press('text:report.pdf')
  await app.waitFor('text:/No preview for this kind of file/')
  app.onDialog((d) => d.buttons.find((b) => b === 'Delete') ?? null)
  await app.press('id:delete-file')
  await app.waitFor('text:hello.md')               // back on the list
  expect(app.dialogs().length).toBe(1)
  expect(app.requests().some((r) => r.method === 'DELETE' && r.url.endsWith('/library/file?path=report.pdf'))).toBe(true)
})

test('an empty library says so', async () => {
  const app = await open('./library.harness.tsx', { ...base, network: { ...base.network, [`GET ${ORIGIN}/library`]: { body: [] } } })
  await app.waitFor('text:/Nothing here yet/')
})

// In Chinese the age is in words: "7m" showed in a Chinese session (QA pass, 2026-10-27, Android).
test('in Chinese the age reads 5 分钟前, 2 小时前, 3 天前', async () => {
  const app = await open('./library.harness.tsx', { ...base, storage: { ...base.storage, lang: 'zh' }, network: { ...base.network, [`GET ${ORIGIN}/library`]: { body: files } } })
  await app.waitFor('text:hello.md')
  expect(app.shows('text:/42 B，5 分钟前/')).toBe(true)
  expect(app.shows('text:/20 KB，2 小时前/')).toBe(true)
  expect(app.shows('text:/3.0 MB，3 天前/')).toBe(true)
})
