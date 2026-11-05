import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writtenLanguage, personLanguage, uiLang, languageName, words } from '../src/lang.ts'

test('writtenLanguage tells the script of what the person wrote', () => {
  assert.equal(writtenLanguage('你叫大鲸鱼'), 'zh')
  assert.equal(writtenLanguage('今天美股盘前如何？'), 'zh')
  assert.equal(writtenLanguage('Wait I should have called you Whale'), 'en')
  assert.equal(writtenLanguage('明日の天気はどうですか'), 'ja')
  assert.equal(writtenLanguage('오늘 날씨 어때'), 'ko')
  assert.equal(writtenLanguage('ok 👍'), null, 'too little to tell')
  assert.equal(writtenLanguage('帮我 check 一下 GitHub 的 PR'), 'zh', 'Chinese with English tech words is Chinese')
})

test('personLanguage: the phone locale first, then what they write, then the setting, then English', () => {
  assert.equal(personLanguage({ language: 'auto', person: { locale: 'zh-CN' }, spokenLanguage: 'en' }), 'zh-CN')
  assert.equal(personLanguage({ language: 'auto', spokenLanguage: 'zh' }), 'zh')
  assert.equal(personLanguage({ language: 'zh' }), 'zh')
  assert.equal(personLanguage({ language: 'auto' }), 'en')
  assert.equal(personLanguage({}), 'en')
})

test('uiLang folds a language to the seven the bot writes; languageName names it for a model prompt', () => {
  assert.equal(uiLang('zh-Hans-CN'), 'zh'); assert.equal(uiLang('zh'), 'zh'); assert.equal(uiLang('en-US'), 'en'); assert.equal(uiLang('ja'), 'ja'); assert.equal(uiLang('fr'), 'en')
  assert.match(languageName('zh-CN'), /Chinese/); assert.match(languageName('ja'), /Japanese/)
  assert.equal(languageName('not a tag!'), 'not a tag!')
})

test('templated lines come in the person\'s language', () => {
  assert.equal(words('zh').remembered('喜欢燕麦奶'), '记住了：喜欢燕麦奶')
  assert.equal(words('en').remembered('Prefers oat milk'), 'Remembered: Prefers oat milk')
  for (const l of ['zh', 'en'] as const) {
    const w = words(l)
    for (const s of [w.forgot(2, 'x'), w.scheduled('a', 'b'), w.scheduleUpdated('a', 'b'), w.scheduleDeleted(), w.goalNew('a'), w.goalUpdated('a', 'b'), w.built('a'), w.renamed('a'), w.reminderFired('a'), w.connected('a'), w.ideas(['a', 'b']), w.brief('a'), w.memoryUpdated(['a']), w.needsYes('N'), w.hasQuestion('N'), w.done('N'), w.openToAnswer, w.assistant]) {
      assert.ok(s.length > 0)
      if (l === 'zh') assert.match(s, /[一-鿿]/, s)
      else assert.doesNotMatch(s, /[一-鿿]/, s)
    }
  }
})

test('activity entries keep their template, so the list reads in the person\'s language now, also for lines written before it was known', async () => {
  const { line, activityView } = await import('../src/lang.ts')
  const stored = [{ id: 'a', at: 't', kind: 'memory', ...line('en', 'remembered', 'Prefers oat milk') }, { id: 'b', at: 't', kind: 'notify', text: '提醒 — 起来拉伸' }]
  assert.equal(stored[0].text, 'Remembered: Prefers oat milk')
  assert.deepEqual(activityView(stored, 'zh'), [{ id: 'a', at: 't', kind: 'memory', text: '记住了：Prefers oat milk' }, { id: 'b', at: 't', kind: 'notify', text: '提醒 — 起来拉伸' }])
})

// Facts end in their own full stop; joined, they read 做页面。；连接… (QA pass, 2026-10-27, Activity on iOS).
test('a memory update joins its facts without doubled punctuation', () => {
  assert.equal(words('zh').memoryUpdated(['用 Acme Pages 做页面。', '连接工具时希望小墨帮他连上。']), '记忆更新：用 Acme Pages 做页面；连接工具时希望小墨帮他连上。')
  assert.equal(words('en').memoryUpdated(['Uses Acme Pages.', 'Likes short answers.']), 'Updated memory: Uses Acme Pages; Likes short answers.')
})
