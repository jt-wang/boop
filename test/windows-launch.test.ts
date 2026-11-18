// The Windows app's launch command is pure (windows/src/paths.ts), so the args can be
// checked here without a Windows host. NSH's spawn takes (command, args[]) and never a
// shell: a path with spaces or Japanese characters is one argv entry, with no quotes added.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { homeFromProfile, windowsLaunch } from '../windows/src/paths.ts'

test('Windows launch is absolute and shell-free, even with spaces and Japanese characters', () => {
  const res = 'C:\\Users\\山田 太郎\\My Boop\\Boop'
  const home = 'C:\\Users\\山田 太郎\\AppData\\Local\\DeepSeek Bot'
  const cmd = windowsLaunch(res, home, 3851)
  assert.equal(cmd.command, `${res}\\bot\\node.exe`)
  assert.deepEqual(cmd.args, [
    `${res}\\bot\\src\\main.ts`, '--home', home, '--port', '3851', '--supervised',
  ])
  // Quoting here would become part of the path on Windows, not group the arguments.
  assert.equal(cmd.command.includes('"'), false)
  assert.ok(cmd.args.every((a) => !a.includes('"')))
})

test('the bot home is derived from USERPROFILE, not LOCALAPPDATA', () => {
  assert.equal(homeFromProfile('C:\\Users\\me'), 'C:\\Users\\me\\AppData\\Local\\DeepSeek Bot')
  assert.equal(homeFromProfile('C:\\Users\\me\\'), 'C:\\Users\\me\\AppData\\Local\\DeepSeek Bot')
  assert.equal(homeFromProfile('  '), '')
})
