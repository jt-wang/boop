// Screenshots the assistant takes with its browser show in the thread. They are not files in the workspace: the
// harness keeps them in its attachment store, and the bot folds each into an image row with the attachment's id
// (src/fold.ts). The app fetches it from the bot (GET /library/attachment) with the device's token, as it fetches a
// presented image, retries included; a reply that points at the same screenshot does not draw it twice.
import { expect, open, test } from 'nsh/test'

const ORIGIN = 'http://127.0.0.1:3850'
const TOKEN = 'tok_abcdefghijklmnopqrstuvwxyz0123456789'
const AT = 1700000000000
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
const meBody = { device: { id: 'd1', name: 'iPhone' }, assistant: { name: 'Nori' }, mainSessionId: 'main', connected: true, pushPublicKey: null }
const threads = [{ sessionId: 'main', title: '', updatedAt: AT, running: false, blank: false }]
const SHOT = '/home/me/.deepseek-bot/browser-output/page-2026-10-27T10-00-00-000Z.png'
const shotUrl = `${ORIGIN}/library/attachment?session=main&id=${encodeURIComponent('sha256:2fb3')}&format=json`
const snapshot = (rows: unknown[]) => ({ type: 'snapshot', sessionId: 'main', rows, running: false, statusText: '', title: '' })

test('a browser screenshot shows in the thread after its step, fetched from the bot with the device token', async () => {
  for (const lang of ['zh', 'en']) {
    let calls = 0
    const app = await open('./App.tsx', {
      storage: { origin: ORIGIN, token: TOKEN, lang },
      network: {
        [`GET ${ORIGIN}/me`]: { body: meBody }, [`GET ${ORIGIN}/threads`]: { body: threads },
        // the first answer is the harness not answering: it tries again, as for any image
        [`GET ${shotUrl}`]: () => (++calls === 1 ? { status: 502, body: { error: 'the assistant did not answer' } } : { body: { path: '', kind: 'image', mime: 'image/png', size: 70, truncated: false, base64: PNG } }),
      },
    })
    await app.waitFor('id:composer')
    await app.host.send('thread', [snapshot([
      { kind: 'you', id: 'u1', text: 'Open example.com and show me', at: AT },
      { kind: 'step', id: 'call_9', name: 'mcp__browser__browser_take_screenshot', output: '### Result', at: AT },
      { kind: 'file', id: 'call_9:img0', path: SHOT, name: 'page-2026-10-27T10-00-00-000Z.png', image: true, attachment: 'sha256:2fb3', at: AT },
      { kind: 'them', id: 'a1', text: `Here it is:\n\n![Example Domain](${SHOT})\n\nThe title is Example Domain.`, at: AT },
    ])])
    await app.waitFor('id:file-call_9:img0-image-loaded', { timeout: 8000 })
    expect(app.requests().find((r) => r.url === shotUrl.slice(0))!.headers.authorization).toBe(`Bearer ${TOKEN}`)
    expect(calls).toBe(2)
    // the reply's own mention of the same screenshot is not drawn a second time, nor fetched by its path
    expect(app.count('id:md-image-a1-0')).toBe(0)
    expect(app.requests().some((r) => r.url.includes('/library/file'))).toBe(false)
    expect(app.shows('text:/The title is Example Domain/')).toBe(true)
  }
})
