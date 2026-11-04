// Try it (src/try.ts): the words around the sample and the made-up data itself, which follows the interface's language.
import type { Lang } from './locale.ts'
import { es as esLocale } from './locales/es.ts'
import { ja as jaLocale } from './locales/ja.ts'
import { ko as koLocale } from './locales/ko.ts'
import { ru as ruLocale } from './locales/ru.ts'
import { zhHant as zhHantLocale } from './locales/zh-Hant.ts'

const tryEn = {
  tryIt: 'Try it without a computer',
  sampleStatus: 'Sample',
  sampleNotice: 'This is a sample. Everything here is made up and stays on this phone. To use your own assistant, connect a computer running Boop.',
  sampleLeave: 'Connect a computer',
  sampleLeaveHint: 'Leaves the sample. Nothing from it is kept.',
  sampleComputer: 'Sample computer',
  sampleYou1: 'Remind me to call the dentist tomorrow at 9',
  sampleThem1: 'Done. I will remind you tomorrow at 9:00.',
  sampleYou2: 'Watch the price of a flight to Lisbon and tell me when it drops',
  sampleThem2: 'I will check it every morning and message you when it drops.',
  sampleAsk: 'Delete 3 old files in Downloads',
  sampleApproved: 'That is how asking works: with a computer connected, nothing hard to undo happens until you answer.',
  sampleReply: 'This is a sample reply. With a computer connected, I would do this there and message you when it is done.',
  sampleGoal: 'Run 10 km by March',
  sampleGoalStep1: 'Run three times a week',
  sampleGoalStep2: 'Add 1 km every two weeks',
  sampleTask: 'Morning pills',
  sampleTaskDo: 'Remind me to take my pills',
  sampleMemory: 'Likes short answers',
  sampleIdea: 'Plan the Lisbon trip',
  sampleIdeaBody: 'You asked about flights. I can draft three days there.',
  sampleIdeaDo: 'Plan three days in Lisbon',
  sampleFile: 'A plan for three days in Lisbon.',
  sampleActivity: 'Set a reminder for tomorrow at 9:00',
}
export type TryWords = typeof tryEn
export const TRY_STRINGS: Record<Lang, TryWords> = {
  en: tryEn,
  zh: {
    tryIt: '不连电脑先试试',
    sampleStatus: '示例',
    sampleNotice: '这是示例。这里的内容都是编的，只留在这台手机上。要用你自己的助理，请连接一台运行 Boop 的电脑。',
    sampleLeave: '连接电脑',
    sampleLeaveHint: '离开示例，里面的内容不会保留。',
    sampleComputer: '示例电脑',
    sampleYou1: '提醒我明天 9 点给牙医打电话',
    sampleThem1: '好了，明天 9:00 提醒你。',
    sampleYou2: '盯着去里斯本的机票价格，降了告诉我',
    sampleThem2: '我每天早上看一次，降价了发消息给你。',
    sampleAsk: '删除下载文件夹里的 3 个旧文件',
    sampleApproved: '它就是这样先问你的：连上电脑后，难撤销的事要等你回答才会做。',
    sampleReply: '这是一条示例回复。连上电脑后，我会在电脑上把这件事做了，做完发消息给你。',
    sampleGoal: '3 月前跑完 10 公里',
    sampleGoalStep1: '每周跑三次',
    sampleGoalStep2: '每两周多跑 1 公里',
    sampleTask: '早上吃药',
    sampleTaskDo: '提醒我吃药',
    sampleMemory: '喜欢简短的回答',
    sampleIdea: '安排里斯本之行',
    sampleIdeaBody: '你问过机票。我可以先排一份三天的行程。',
    sampleIdeaDo: '排一份里斯本三天的行程',
    sampleFile: '里斯本三天的行程。',
    sampleActivity: '设了明天 9:00 的提醒',
  },
  'zh-Hant': zhHantLocale.tryit,
  es: esLocale.tryit,
  ko: koLocale.tryit,
  ja: jaLocale.tryit,
  ru: ruLocale.tryit,
}
