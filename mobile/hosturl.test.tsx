// Where Start goes: the shell's launch parameter wins (iOS Info.plist, the Android manifest from
// scripts/android-build.sh --host, the browser page's meta tag); a build may carry a default host; else none.
import { expect, test } from 'nsh/test'
import { pickHostUrl } from './src/hosted.ts'

test('the launch parameter wins, then the built-in default, else no hosted path', () => {
  expect(pickHostUrl({ hostUrl: 'https://a.example/' }, 'https://b.example')).toBe('https://a.example')
  expect(pickHostUrl({}, 'https://b.example/')).toBe('https://b.example')
  expect(pickHostUrl(undefined, '')).toBe(null)
  expect(pickHostUrl({ hostUrl: 'not a url' }, '')).toBe(null)
})
