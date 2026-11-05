// One language, no internals: what the bot logs and what the harness calls a tool reach a person
// only in their own words. Pure functions here; the screens are checked in guard.test.tsx.
import { expect, test } from 'nsh/test'
import { activityText, memoryChanges } from './src/plain.ts'
import { serviceNames, toolWord } from './src/fold.ts'

test('activity entries the bot writes in English read in Chinese, without ids or timestamps', () => {
  expect(activityText('Updated memory: 咖啡只喝燕麦奶拿铁', 'zh')).toBe('记下了：咖啡只喝燕麦奶拿铁')
  expect(activityText('Remembered: 女儿小雨，学钢琴', 'zh')).toBe('记下了：女儿小雨，学钢琴')
  expect(activityText('Forgot 2 fact(s) matching "房东"', 'zh')).toBe('忘掉了关于「房东」的事')
  expect(activityText('Scheduled "交房租" for 2026-10-29T11:00:00.000Z', 'zh')).toBe('设了提醒：交房租')
  expect(activityText('Deleted reminder 3f2a9c1e', 'zh')).toBe('删掉了一个提醒')
  expect(activityText('Reminder fired: 交房租', 'zh')).toBe('提醒了你：交房租')
  expect(activityText('Connected Acme Pages', 'zh')).toBe('连接了 Acme Pages')
  expect(activityText('3 new ideas: 找咖啡店; 回顾这周; 设个提醒', 'zh')).toBe('想到 3 件可以做的事：找咖啡店；回顾这周；设个提醒')
  const changed = activityText('Updated "交房租" — next 2026-10-29T11:00:00.000Z', 'zh')
  expect(changed.startsWith('改了提醒「交房租」，下次 ')).toBe(true)
  expect(/\d{4}-\d{2}-\d{2}T/.test(changed)).toBe(false)
  expect(activityText('Deleted reminder 3f2a9c1e', 'en')).toBe('Removed a reminder')
  expect(activityText('something new', 'zh')).toBe('something new')
})

test('a turn that remembered or forgot something says what; already-known facts and empty forgets do not count', () => {
  expect(memoryChanges([
    { name: 'mcp__bot__remember', command: '咖啡只喝燕麦奶拿铁', output: 'Saved (preference).' },
    { name: 'mcp__bot__remember', command: '称呼他老王', output: 'Already known; nothing changed.' },
    { name: 'mcp__bot__forget', command: '房东', output: 'Removed:\n- 在等房东回复' },
    { name: 'mcp__bot__forget', command: '猫', output: 'Nothing matched.' },
    { name: 'mcp__bot__remember', command: '还在跑' },
    { name: 'web_search', command: '燕麦奶', output: '…' },
  ])).toEqual([{ kind: 'remembered', text: '咖啡只喝燕麦奶拿铁' }, { kind: 'forgot', text: '房东' }])
})

test("a connected service's step names the service, in the person's language, never the tool's English name", () => {
  expect(toolWord('mcp__acme-pages__search_pages', 'zh')).toBe('使用 Acme Pages')
  expect(toolWord('mcp__acme-pages__search_pages', 'en')).toBe('Using Acme Pages')
  serviceNames.atlassian = 'Jira 和 Confluence'
  expect(toolWord('mcp__atlassian__getJiraIssue', 'zh')).toBe('使用 Jira 和 Confluence')
  expect(toolWord('mcp__bot__brand_new_tool', 'zh')).toBe('处理中')
  expect(toolWord('apply_patch', 'zh')).toBe('处理中')
})
