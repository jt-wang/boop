// Words for the assistant's profile (activity, permissions, upcoming, memory)
// and the connectors flow. Kept apart from
// i18n.ts so the two tables can change independently.
import { lang } from './state.ts'
import type { Lang } from './locale.ts'
import { es as esLocale } from './locales/es.ts'
import { ja as jaLocale } from './locales/ja.ts'
import { ko as koLocale } from './locales/ko.ts'
import { ru as ruLocale } from './locales/ru.ts'
import { zhHant as zhHantLocale } from './locales/zh-Hant.ts'

const en = {
  // profile
  tabActivity: 'Activity', tabPermissions: 'Permissions', tabUpcoming: 'Upcoming', tabMemory: 'Memory',
  today: 'Today', yesterday: 'Yesterday', earlier: 'Earlier',
  editProfile: 'Edit name',
  noActivity: 'Nothing yet. What it does for you shows up here.',
  noUpcoming: 'Nothing scheduled. Ask it in the chat: “remind me at 6 to call Mom”.',
  stopTask: 'Stop',
  working: 'Working',
  // permissions
  permConnected: 'Connected services',
  permNone: 'No services connected yet.',
  permAsks: 'It asks you before anything hard to undo: sending, buying, deleting.',
  permMore: 'Connectors',
  // memory
  memCount: (n: number) => (n === 1 ? '1 thing it remembers about you' : `${n} things it remembers about you`),
  memAbout: 'It learns as you talk. Tap one to change it, or tell it in the chat.',
  memAboutYou: 'About you', memTracking: 'Tracking', memDecisions: 'Decisions', memPeople: 'People and places',
  memShowMore: (n: number) => `Show ${n} more`,
  memEmpty: 'Nothing remembered yet. It learns as you talk.',
  memEdit: 'Edit', memForget: 'Forget', memCancel: 'Cancel', memSave: 'Save', memForgetAll: 'Forget everything',
  memForgetTitle: 'Forget this?', memForgetBody: 'It will stop using it from now on.',
  memForgetAllTitle: 'Forget everything?', memForgetAllBody: 'Everything listed here is deleted. Your chats stay.',
  memForgotten: 'Forgotten', memSaved: 'Saved', memFailed: 'That did not go through. Try again.',
  memEditTitle: 'Memory', memGroup: 'Group', memLearned: (d: string) => `Learned ${d}`,
  memDuplicate: 'It already remembers that.',
  memNoted: (n: number) => (n === 1 ? 'Remembered 1 thing' : `Remembered ${n} things`),
  memRemembered: 'Remembered', memForgot: 'Forgot',
  // connectors
  connTitle: 'Connectors', connHint: 'Sign in once. It uses the service from its own computer; you can disconnect any time.',
  connConnected: 'Connected', connAvailable: 'Available', connConnect: 'Connect', connConnecting: 'Connecting…',
  connNeedsAuth: 'Needs sign-in', connReconnect: 'Reconnect', connDisconnect: 'Disconnect',
  connWhat: 'What it can do', connData: 'Your account',
  connDataBody: (name: string) => `You sign in on ${name}'s own page. The sign-in stays on its computer; it never sees your password. You can disconnect any time.`,
  connContinue: 'Continue', connReopen: 'Reopen sign-in', connCancel: 'Cancel', connRetry: 'Try again',
  connWaiting: (name: string) => `Waiting for you to finish signing in to ${name}. This works for about 10 minutes.`,
  connFailedNote: 'Sign-in did not finish.',
  connDone: (name: string) => `${name} connected`,
  connDisconnectTitle: (name: string) => `Disconnect ${name}?`,
  connDisconnectBody: 'It stops using this service right away. What it already learned from it stays in its memory until you forget it.',
  connTry: 'Try it', connTryPrompt: (name: string) => `What can you do with my ${name}?`,
  connMore: 'More services', connMoreBody: 'Other services and folders on its computer.',
  connCustom: 'Added on its computer',
  connStatusConnected: 'Connected', connStatusOff: 'Off',
  connSearch: 'Search connectors', connNoMatch: 'No service by that name here.',
  needApproval: 'Something needs your OK', needAnswer: 'A question for you', newIdeas: 'New ideas',
  svcUsed: (n: number) => (n === 1 ? 'Used once' : `Used ${n} times`),
  memChanged: (n: number) => `Updated memory (${n})`,
} as const

export type CmWords = { [K in keyof typeof en]: (typeof en)[K] extends (...a: infer A) => string ? (...a: A) => string : string }
const zh: CmWords = {
  tabActivity: '活动', tabPermissions: '权限', tabUpcoming: '日程', tabMemory: '记忆',
  today: '今天', yesterday: '昨天', earlier: '更早',
  editProfile: '改名字',
  noActivity: '还没有。它替你做的事会出现在这里。',
  noUpcoming: '还没有安排。在聊天里说「6 点提醒我给妈妈打电话」。',
  stopTask: '停止',
  working: '工作中',
  permConnected: '连接的服务',
  permNone: '还没有连接任何服务。',
  permAsks: '难撤销的事（发送、购买、删除）它会先问你。',
  permMore: '连接器',
  memCount: (n) => `它记得关于你的 ${n} 件事`,
  memAbout: '聊着聊着它就会记下。点一条可以改，或者直接在聊天里告诉它。',
  memAboutYou: '关于你', memTracking: '在追踪', memDecisions: '决定和约定', memPeople: '人和地方',
  memShowMore: (n) => `再看 ${n} 条`,
  memEmpty: '还没有记住什么。聊着聊着它就会记。',
  memEdit: '修改', memForget: '忘掉', memCancel: '取消', memSave: '保存', memForgetAll: '全部忘掉',
  memForgetTitle: '忘掉这条？', memForgetBody: '从现在起它不再用这条。',
  memForgetAllTitle: '全部忘掉？', memForgetAllBody: '这里列出的都会删除。聊天记录还在。',
  memForgotten: '已忘掉', memSaved: '已保存', memFailed: '没成功，再试一次。',
  memEditTitle: '记忆', memGroup: '分组', memLearned: (d) => `${d}记下`,
  memDuplicate: '它已经记得这条了。',
  memNoted: (n) => `记住了 ${n} 件事`,
  memRemembered: '记住了', memForgot: '忘掉了',
  connTitle: '连接器', connHint: '登录一次就好。它在自己的电脑上使用这个服务，随时可以断开。',
  connConnected: '已连接', connAvailable: '可以连接', connConnect: '连接', connConnecting: '连接中…',
  connNeedsAuth: '需要重新登录', connReconnect: '重新连接', connDisconnect: '断开',
  connWhat: '它能做什么', connData: '你的账号',
  connDataBody: (name) => `在 ${name} 自己的页面上登录。登录状态只放在它的电脑上，它看不到你的密码。随时可以断开。`,
  connContinue: '继续', connReopen: '重新打开登录页', connCancel: '取消', connRetry: '再试一次',
  connWaiting: (name) => `等你在 ${name} 完成登录。大约 10 分钟内有效。`,
  connFailedNote: '登录没有完成。',
  connDone: (name) => `${name} 已连接`,
  connDisconnectTitle: (name) => `断开 ${name}？`,
  connDisconnectBody: '它马上停止使用这个服务。已经记下的内容会留在记忆里，要删就在记忆里忘掉。',
  connTry: '试一试', connTryPrompt: (name) => `你能用我的 ${name} 做什么？`,
  connMore: '更多服务', connMoreBody: '其他服务，以及它电脑上的文件夹。',
  connCustom: '在它的电脑上添加的',
  connStatusConnected: '已连接', connStatusOff: '已关闭',
  connSearch: '搜索连接器', connNoMatch: '这里没有这个名字的服务。',
  needApproval: '有件事要你同意', needAnswer: '有个问题问你', newIdeas: '换一批',
  svcUsed: (n) => `用了 ${n} 次`,
  memChanged: (n) => `改了 ${n} 条记忆`,
}

/** Each one-tap service in both languages: a name, one line for the list, and what it can do (the information step before sign-in). */
export type ServiceWords = Record<string, { name: string; line: string; can: string[] }>
const servicesEn: ServiceWords = {
  notion: { name: 'Notion', line: 'Your pages and databases', can: ['Find and read your pages', 'Write and update pages you point it to', 'Add rows to your databases'] },
  linear: { name: 'Linear', line: 'Issues, projects and cycles', can: ['Find and read issues', 'Create and update issues', 'See projects and cycles'] },
  atlassian: { name: 'Jira and Confluence', line: 'Tickets, boards and wiki pages', can: ['Find and read tickets and pages', 'Create and update tickets', 'Write wiki pages'] },
  github: { name: 'GitHub', line: 'Issues, pull requests and code', can: ['Read your repositories', 'Open and comment on issues', 'Review pull requests'] },
  slack: { name: 'Slack', line: 'Channels and messages', can: ['Read and search channels', 'Draft and send messages as you'] },
  gmail: { name: 'Gmail', line: 'Your email', can: ['Read and search your email', 'Draft replies for you to send'] },
  'google-calendar': { name: 'Google Calendar', line: 'Your schedule', can: ['See your schedule', 'Add and change events'] },
  'google-drive': { name: 'Google Drive', line: 'Your files and documents', can: ['Find and read your files'] },
}
const servicesZh: ServiceWords = {
  notion: { name: 'Notion', line: '你的页面和数据库', can: ['查找、阅读你的页面', '按你说的写页面、改页面', '往数据库里加记录'] },
  linear: { name: 'Linear', line: '任务、项目和周期', can: ['查找、阅读任务', '新建和更新任务', '查看项目和周期'] },
  atlassian: { name: 'Jira 和 Confluence', line: '工单、看板和文档页', can: ['查找、阅读工单和文档', '新建和更新工单', '写文档页'] },
  github: { name: 'GitHub', line: '问题、合并请求和代码', can: ['读你的仓库', '提问题、写评论', '看合并请求'] },
  slack: { name: 'Slack', line: '频道和消息', can: ['读、搜索频道', '以你的名义起草和发送消息'] },
  gmail: { name: 'Gmail', line: '你的邮件', can: ['读、搜索你的邮件', '起草回复，由你决定发不发'] },
  'google-calendar': { name: 'Google 日历', line: '你的日程', can: ['查看你的日程', '添加和修改日程'] },
  'google-drive': { name: 'Google Drive', line: '你的文件和文档', can: ['查找、阅读你的文件'] },
}
export const SERVICES: Record<Lang, ServiceWords> = { en: servicesEn, zh: servicesZh, 'zh-Hant': zhHantLocale.services, es: esLocale.services, ko: koLocale.services, ja: jaLocale.services, ru: ruLocale.services }
/** A service the table does not know, by its name. */
export type ServiceFallback = (name: string, description?: string) => { name: string; line: string; can: string[] }
const FALLBACK: Record<Lang, ServiceFallback> = {
  en: (name, description) => ({ name, line: description || `Your ${name}`, can: [`Find and read what is in ${name}`, `Do things in ${name} when you ask`] }),
  zh: (name) => ({ name, line: `${name} 里的内容`, can: [`查找、阅读 ${name} 里的内容`, `按你说的在 ${name} 里做事`] }),
  'zh-Hant': zhHantLocale.serviceFallback, es: esLocale.serviceFallback, ko: koLocale.serviceFallback, ja: jaLocale.serviceFallback, ru: ruLocale.serviceFallback,
}
/** A service in the current language; services a host adds get their own name and a plain line. */
export function serviceFor(id: string, name: string, description: string | undefined, l: Lang) {
  return SERVICES[l][id] ?? FALLBACK[l](name, description)
}
export const service = (id: string, name: string, description?: string) => serviceFor(id, name, description, lang())

export const CM: Record<Lang, CmWords> = { en: en as unknown as CmWords, zh, 'zh-Hant': zhHantLocale.cm, es: esLocale.cm, ko: koLocale.cm, ja: jaLocale.cm, ru: ruLocale.cm }
/** A string of this table in the current language. */
export const cm = <K extends keyof typeof en>(k: K): CmWords[K] => CM[lang()][k]
