// After naming the assistant the chat opens with the keyboard down. On Android the name field's keyboard stayed up
// over the new chat (QA pass, 2026-10-27, Android 15 emulator: `dumpsys input_method` mInputShown=true, the tab bar
// gone), left on NSH's root view where nothing could take it down. The keyboard hides the tab bar (App.tsx), so the
// tab bar is the test's view of it. For the devices: `nsh test --target android naming.test.tsx` (and ios); headless
// it returns at once, as there is no keyboard or system tab bar to look at.
import { expect, open, test } from 'nsh/test'

const ORIGIN = 'https://computer.example.com'
const TOKEN = 'tok_abcdefghijklmnopqrstuvwxyz0123456789'
const meBody = (name: string) => ({ device: { id: 'd1', name: 'Phone' }, assistant: { name }, mainSessionId: 'main', connected: true, pushPublicKey: null })

test('Continue on the naming screen: the chat opens with the keyboard down', async () => {
  const app = await open('./App.tsx', {
    storage: { origin: ORIGIN, token: TOKEN },
    network: {
      [`GET ${ORIGIN}/me`]: { body: meBody('') },
      [`PUT ${ORIGIN}/settings`]: { body: { assistantName: 'Nori', mainSessionId: 'main', language: 'auto' } },
      [`PUT ${ORIGIN}/me/context`]: { body: { ok: true } },
      [`GET ${ORIGIN}/threads`]: { body: [{ sessionId: 'main', title: '', updatedAt: 1700000000000, running: false, blank: false }] },
      [`POST ${ORIGIN}/ws-ticket`]: { status: 500, body: {} },
    },
  })
  await app.waitFor('id:name-go')
  // headless draws no keyboard and no system tab bar: only a real platform can say (a screenshot needs one)
  if (!(await app.screenshot().then(() => true, () => false))) return
  await app.wait(1500) // the field takes the focus and the keyboard comes up
  await app.press('id:name-go')
  await app.waitFor('id:composer')
  await app.wait(2500)
  expect(app.shows('id:tabbar')).toBe(true)
}, 60000)
