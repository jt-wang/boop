// Interface copy. English and Chinese here, the other five in src/locales/; the person's choice is kept in Storage.
import { locale } from 'nsh'
import { COMPLIANCE_STRINGS } from './i18n-compliance.ts' // [compliance]
import { TRY_STRINGS } from './i18n-try.ts'
import { normalizeLang, type Lang } from './locale.ts'
import { es as esLocale } from './locales/es.ts'
import { ja as jaLocale } from './locales/ja.ts'
import { ko as koLocale } from './locales/ko.ts'
import { ru as ruLocale } from './locales/ru.ts'
import { zhHant as zhHantLocale } from './locales/zh-Hant.ts'
export type { Lang }

const en = {
  welcomeTitle: 'Boop', welcomeBody: 'It works while the app is closed, remembers you, and asks before anything hard to undo.', start: 'Start', ownComputer: 'I have my own computer',
  signInTitle: 'Sign in', signInBody: 'Your assistant and its computer belong to this account.', email: 'Email', accessCode: 'Access code', accessCodeHint: 'This host lets in people its owner approved. Ask them for the code.', accessCodeWrong: 'That access code is not right.', tooManyTries: 'Too many tries. Wait a few minutes.', hostFull: 'This host has no room for new accounts.', signIn: 'Continue', signInFailed: 'Could not sign in. Check the address and try again.',
  showWork: 'Show steps', showWorkHint: 'Commands and outputs inside the activity list. Off, the chat only says what it is doing in plain words.',
  preparingTitle: 'Setting up its computer…', preparingBody: 'About half a minute the first time. Its files, memory and logins will live there.', preparingFailed: 'The computer did not come up. Try again.', retry: 'Try again',
  connectTitle: 'Connect to your computer', connectBody: 'Open Boop on your computer and scan the code it shows. You pair once; after that it works from any network.', connectBodyWeb: 'Start the assistant on your computer, then paste the address it shows, or the whole pairing link.', scanCode: 'Scan the code', orAddress: 'Or enter your server\'s address.', pocketExpired: 'This code has expired. Make a new one on the computer.', pocketInvalid: 'That is not a Boop pairing code.', pocketUnreachable: 'The computer did not answer. Check that Boop is running on it.', pocketDenied: 'The computer said no.', pocketNoCamera: 'This phone has no camera to scan with. Paste the code from the computer instead.', address: 'Address, e.g. http://192.168.1.20:3850', code: 'Pairing code', connect: 'Connect', connecting: 'Connecting…',
  connectFailed: 'Could not reach that address.', codeWrong: 'That code did not work. Codes expire after 10 minutes — press p on the computer for a new one.',
  nameTitle: 'What will you call your assistant?', nameHint: 'You can change it later in settings.', nameGo: 'Continue', nameSuggestion: 'Nori',
  online: 'Online', offline: 'Not connected', reconnecting: 'Reconnecting…', working: 'Working…', waitingYou: 'Waiting for you',
  compose: 'Message', send: 'Send', sayHi: 'Say hi',
  emptyThread: (n: string) => `Say hi to ${n || 'your assistant'}. It remembers you, keeps working while the app is closed, and asks before anything hard to undo.`,
  cardYes: 'Yes', cardNo: 'No', askApproval: 'Needs your approval', askQuestion: 'Has a question', allowOnce: 'Allow once', allowTask: 'Allow for this task', allowAlways: 'Always allow', decline: 'Decline', answer: 'Send answer', skip: 'Skip', custom: 'Something else',
  autoApproved: (t: string) => `Allowed ${t} (standing rule)`,
  menu: 'Menu', mainThread: 'Main chat', sideChats: 'Other chats', newSideChat: 'New chat', noSideChats: 'No other chats yet. Start one for a project you want kept apart.',
  identity: 'Identity', identityHint: 'Three plain files. The assistant reads them; you can edit them.', soul: 'Soul', user: 'About you', memory: 'Memory', save: 'Save', saved: 'Saved',
  upcoming: 'Upcoming', noUpcoming: 'Nothing scheduled. Ask for a reminder in the chat.', next: 'Next', paused: 'Paused', pause: 'Pause', resume: 'Resume', remove: 'Remove',
  goals: 'Goals', noGoals: 'No goals yet. Tell the assistant what you want over the next weeks.', done: 'Done', active: 'Active', markDone: 'Mark done', reopen: 'Reopen',
  activity: 'Activity', noActivity: 'Nothing yet. Actions, approvals and memory changes show up here.',
  devices: 'Devices', thisDevice: 'this phone', revoke: 'Remove', revoked: 'Removed',
  settings: 'Settings', assistantName: 'Assistant name', language: 'Language', unpair: 'Unpair this phone', computer: 'Computer', connectionStatus: 'Status', connectionLabel: 'Connection', stateOnline: 'Connected', stateReconnecting: 'Reconnecting', stateOffline: 'Disconnected', connE2e: 'End-to-end encrypted', pathPocket: 'Through TailPocket to your computer', pathPocketDirect: 'Directly to your computer, through TailPocket', pathPocketRelay: (relay: string) => `Through a relay${relay ? ` (${relay})` : ''} to your computer. The relay cannot read it.`, notePocket: 'Only this phone and your computer hold the keys.', connPlain: 'Not encrypted', connTls: 'Encrypted in transit (HTTPS)', pathLan: (host: string) => `Direct to your computer over the local network (${host})`, pathInternet: (host: string) => `Over the internet to ${host}`, pathCloudflare: 'Through a Cloudflare tunnel to your computer', pathHosted: 'Through the hosting service to your cloud computer', pathUnknown: 'Finding the route…', notePlain: 'Anyone on the network between this phone and the computer can read what they send.', noteCloudflare: 'Cloudflare can read what passes through it.', noteHosted: 'The hosting service can read what passes through it.', cloudComputer: 'Cloud computer', appVersion: 'App version', computerVersion: 'Computer version', unpairBodyHosted: 'You will need to sign in again to reach your cloud computer.',
  notifications: 'Notifications', notificationsHint: 'It tells you when it needs a yes or finished something.', notificationsDenied: 'Allow notifications for this app in your phone\'s Settings.', // [agent:ios]
  failed: 'Could not reach the assistant.', stopped: 'Stopped', back: 'Back', close: 'Close',
  every: (s: number) => (s % 3600 === 0 ? `Every ${s / 3600} h` : `Every ${Math.round(s / 60)} min`), daily: (t: string) => `Daily at ${t}`, weekly: (t: string, d: number[]) => `Weekly ${d.map((x) => ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][x - 1]).join(' ')} at ${t}`, once: 'Once',
  // [agent:library]
  library: 'Library', fileNew: 'New file', fileEdited: 'Edited', fileUnavailable: 'This file cannot be opened.', imageRetry: 'Couldn’t load. Tap to try again.', screenshot: 'Screenshot', libraryRoot: 'Files', noLibrary: 'Nothing here yet. Files the assistant makes show up here.', noPreview: 'No preview for this kind of file.', truncated: 'Showing the first 1 MB.',
  deleteFile: 'Delete file', deleteFileAsk: (n: string) => `Delete ${n}? The assistant will not see it any more.`, cancel: 'Cancel', deleteGo: 'Delete', deleted: 'Deleted', justNow: 'now',
  // [agent:proactive]
  ideas: 'Ideas', ideasHint: 'Things it could do for you now, from what it knows about you. Tap one to send it.', noIdeas: 'No ideas yet. Tap Refresh — it looks at your notes, goals and reminders and suggests three things.',
  doIt: 'Do it', notNow: 'Not now', refresh: 'Refresh', thinking: 'Thinking…', sentToThread: 'Sent to the main chat', updatingMemory: 'Updating memory…', morningBrief: 'Morning ideas', morningBriefHint: (h: number) => `One notification a day at ${String(h).padStart(2, '0')}:00 with the first idea.`,
  // [agent:ui] chat interactions, cards, grouped pages
  newMessages: '↓ New messages', copied: 'Copied', ok: 'OK',
  allowed: (t: string) => `Allowed ${t}`, declined: 'Declined', answered: 'Answered', skipped: 'Skipped', viewDetails: 'View details', hideDetails: 'Hide details',
  codeHint: 'Six digits, shown next to the QR code on the computer.', name: 'Name', assistant: 'Assistant', current: 'Current', threads: 'Chats', more: 'More',
  unpairTitle: 'Unpair this phone?', unpairBody: 'You will need a new pairing code to connect again.',
  kindMemory: 'Memory', kindSchedule: 'Reminder', kindApproval: 'Approval', kindNotify: 'Notification', kindGoal: 'Goal', kindShow: 'Card', kindUi: 'Interface', kindIdeas: 'Ideas', kindConnector: 'Connector', kindName: 'Name',
  agoMin: (n: number) => `${n}m`, agoHour: (n: number) => `${n}h`, agoDay: (n: number) => `${n}d`,
  plan: 'Plan', latest: 'Latest', when: 'When',
  usage: 'Usage', usageToday: 'Today', usageInput: 'Read', usageCached: 'Read from cache', usageOutput: 'Written', usageThreads: 'By chat', usageHint: 'How much the assistant read and wrote, counted the way the model counts. Reading from its cache costs less.', noUsage: 'Nothing used yet today.',
  exportMemory: 'Export memory', exported: (kb: number) => `Copied to the clipboard (${kb} KB). Paste it into a note or a file.`,
  style: 'Its style', styleHint: 'Tell it in the chat: “be brief”, “no emoji”, “call me Sam”.',
  tabChat: 'Chat', tabDiscover: 'Discover',
  // [agent:connectors]
  connectors: 'Connectors', connectorsHint: 'Services the assistant can use.', noConnectors: 'Nothing connected yet.',
  servicesHint: 'Sign in once on your phone. The assistant uses the service from its computer; you can disconnect any time.',
  connected: 'Connected', disconnect: 'Disconnect', unavailableHere: 'Not available on this computer yet.', needsSetup: 'Needs setting up first', connectStartFailed: 'Could not start the sign-in. Try again.',
  otherConnectors: 'Also connected', advanced: 'Advanced', advancedHint: 'A folder on this computer, or any MCP server by command or address.',
  addConnector: 'Add', add: 'Add', added: 'Added.', removed: 'Removed', connectorOn: 'On', connectorOff: 'Off',
  restartToApply: 'Restart Boop on your computer to apply these changes.',
  setEnvHint: (names: string) => `On your computer, set ${names}, then restart Boop.`, needsEnv: (names: string) => `Needs ${names}`, envSet: 'set', envMissing: 'not set',
  folderPath: 'Folder on your computer, e.g. /Users/you/Documents', addFolder: 'Add this folder',
  customName: 'Name', transportCommand: 'A command', transportUrl: 'An address', customCommand: 'Command on your computer, e.g. my-mcp-server', customArgs: 'Arguments, one per line', customUrl: 'Address, e.g. https://example.com/mcp', customBearer: 'Env var holding its access key (optional), e.g. MY_KEY', customEnv: 'Env vars it needs, one name per line, e.g. MY_KEY',
  customConfirmTitle: 'Add this server?', customConfirmBody: 'It runs on your computer every time Boop starts, and the assistant can call its tools. Only add servers you trust.',
  presetText: (_id: string): { name?: string; description?: string; hint?: string } | undefined => undefined,
}
const zh: typeof en = {
  welcomeTitle: 'Boop', welcomeBody: 'App 关了它也在干活，记得你，难撤销的事会先问你。', start: '开始', ownComputer: '我有自己的电脑',
  signInTitle: '登录', signInBody: '助理和它的电脑属于这个账号。', email: '邮箱', accessCode: '邀请码', accessCodeHint: '这里只对主人批准的人开放，向主人要邀请码。', accessCodeWrong: '邀请码不对。', tooManyTries: '尝试次数太多，过几分钟再试。', hostFull: '这里已经满了，不再接受新账号。', signIn: '继续', signInFailed: '登录失败，检查地址后再试。',
  showWork: '显示步骤', showWorkHint: '在活动清单里显示命令和输出。关掉时对话里只用人话说它在做什么。',
  preparingTitle: '正在准备它的电脑…', preparingBody: '第一次大约半分钟。它的文件、记忆和登录态都放在那里。', preparingFailed: '电脑没起来，再试一次。', retry: '再试一次',
  connectTitle: '连接你的电脑', connectBody: '在电脑上打开 Boop，扫它显示的二维码。只配对一次，之后换了网络也能连上。', connectBodyWeb: '在电脑上启动助理，把它显示的地址粘贴到这里，或者直接粘整条配对链接。', scanCode: '扫二维码', orAddress: '或者输入你服务器的地址。', pocketExpired: '这个二维码过期了，在电脑上重新生成一个。', pocketInvalid: '这不是 Boop 的配对码。', pocketUnreachable: '电脑没有回应。看看电脑上的 Boop 是否在运行。', pocketDenied: '电脑拒绝了。', pocketNoCamera: '这台手机没有可用的相机，把电脑上的配对码粘贴过来。', address: '地址，例如 http://192.168.1.20:3850', code: '配对码', connect: '连接', connecting: '连接中…',
  connectFailed: '连不上这个地址。', codeWrong: '配对码不对。配对码 10 分钟过期，在电脑上按 p 再生成一个。',
  nameTitle: '给助理起个名字', nameHint: '以后可以在设置里改。', nameGo: '继续', nameSuggestion: '小诺',
  online: '在线', offline: '未连接', reconnecting: '重新连接中…', working: '工作中…', waitingYou: '等你回复',
  compose: '发消息', send: '发送', sayHi: '打个招呼',
  emptyThread: (n) => `跟${n ? ' ' + n : '助理'}打个招呼。它记得你，App 关了也在干活，难撤销的事会先问你。`,
  cardYes: '好', cardNo: '不用', askApproval: '需要你同意', askQuestion: '有个问题', allowOnce: '仅这次允许', allowTask: '本任务允许', allowAlways: '总是允许', decline: '拒绝', answer: '发送回答', skip: '跳过', custom: '其他',
  autoApproved: (t) => `已按规则允许${t}`,
  menu: '菜单', mainThread: '主对话', sideChats: '其他对话', newSideChat: '新建对话', noSideChats: '还没有其他对话。想单独放一个项目时新建一个。',
  identity: '身份', identityHint: '三个纯文本文件。助理会读它们，你可以直接改。', soul: '性格', user: '关于你', memory: '记忆', save: '保存', saved: '已保存',
  upcoming: '日程', noUpcoming: '没有安排。在聊天里让它提醒你。', next: '下次', paused: '已暂停', pause: '暂停', resume: '继续', remove: '删除',
  goals: '目标', noGoals: '还没有目标。告诉助理你接下来几周想做什么。', done: '完成', active: '进行中', markDone: '标记完成', reopen: '重新打开',
  activity: '活动', noActivity: '还没有记录。做过的动作、审批和记忆改动会显示在这里。',
  devices: '设备', thisDevice: '这部手机', revoke: '移除', revoked: '已移除',
  settings: '设置', assistantName: '助理名字', language: '语言', unpair: '解除配对', computer: '电脑', connectionStatus: '状态', connectionLabel: '连接', stateOnline: '已连接', stateReconnecting: '正在重连', stateOffline: '未连接', connE2e: '端到端加密', pathPocket: '通过 TailPocket 到你的电脑', pathPocketDirect: '通过 TailPocket 直连你的电脑', pathPocketRelay: (relay: string) => `经中继${relay ? `（${relay}）` : ''}到你的电脑，中继读不到内容。`, notePocket: '只有这台手机和你的电脑有密钥。', connPlain: '未加密', connTls: '传输中加密（HTTPS）', pathLan: (host) => `经局域网直连你的电脑（${host}）`, pathInternet: (host) => `经互联网连到 ${host}`, pathCloudflare: '经 Cloudflare 隧道连到你的电脑', pathHosted: '经托管服务连到你的云端电脑', pathUnknown: '正在查找路径…', notePlain: '这部手机和电脑之间网络上的任何人，都能读到它们发送的内容。', noteCloudflare: 'Cloudflare 能读到经过它的内容。', noteHosted: '托管服务能读到经过它的内容。', cloudComputer: '云端电脑', appVersion: '应用版本', computerVersion: '电脑版本', unpairBodyHosted: '要重新登录才能再连上你的云端电脑。',
  notifications: '通知', notificationsHint: '它需要你点头或做完一件事时提醒你。', notificationsDenied: '请在手机设置里允许这个 App 的通知。', // [agent:ios]
  failed: '连不上助理。', stopped: '已停止', back: '返回', close: '关闭',
  every: (s) => (s % 3600 === 0 ? `每 ${s / 3600} 小时` : `每 ${Math.round(s / 60)} 分钟`), daily: (t) => `每天 ${t}`, weekly: (t, d) => `每周${d.map((x) => '一二三四五六日'[x - 1]).join('')} ${t}`, once: '一次',
  // [agent:library]
  library: '文件库', fileNew: '新文件', fileEdited: '已修改', fileUnavailable: '这个文件打不开了。', imageRetry: '没加载出来，点一下重试。', screenshot: '截图', libraryRoot: '文件', noLibrary: '还没有东西。助理做出来的文件会显示在这里。', noPreview: '这种文件不能预览。', truncated: '只显示前 1 MB。',
  deleteFile: '删除文件', deleteFileAsk: (n) => `删除 ${n}？助理以后也看不到它了。`, cancel: '取消', deleteGo: '删除', deleted: '已删除', justNow: '刚刚',
  // [agent:proactive]
  ideas: '想法', ideasHint: '根据它对你的了解，现在可以帮你做的事。点一下就发给它。', noIdeas: '还没有想法。点「刷新」，它会看你的笔记、目标和提醒，给出三个建议。',
  doIt: '去做', notNow: '不用了', refresh: '刷新', thinking: '思考中…', sentToThread: '已发到主对话', updatingMemory: '正在更新记忆…', morningBrief: '早间想法', morningBriefHint: (h) => `每天 ${String(h).padStart(2, '0')}:00 推送一条通知，内容是第一个想法。`,
  // [agent:ui]
  newMessages: '↓ 新消息', copied: '已复制', ok: '好',
  allowed: (t) => `已允许${t}`, declined: '已拒绝', answered: '已回答', skipped: '已跳过', viewDetails: '查看详情', hideDetails: '收起详情',
  codeHint: '六位数字，在电脑的二维码旁边。', name: '名字', assistant: '助理', current: '当前', threads: '对话', more: '更多',
  unpairTitle: '解除这部手机的配对？', unpairBody: '以后要重新连接需要新的配对码。',
  kindMemory: '记忆', kindSchedule: '提醒', kindApproval: '审批', kindNotify: '通知', kindGoal: '目标', kindShow: '卡片', kindUi: '界面', kindIdeas: '想法', kindConnector: '连接器', kindName: '名字',
  agoMin: (n) => `${n} 分钟前`, agoHour: (n) => `${n} 小时前`, agoDay: (n) => `${n} 天前`,
  plan: '计划', latest: '最近', when: '时间',
  usage: '用量', usageToday: '今天', usageInput: '读取', usageCached: '缓存读取', usageOutput: '写出', usageThreads: '按对话', usageHint: '助理读和写的量，按模型的计法算。从缓存读取更便宜。', noUsage: '今天还没有用量。',
  exportMemory: '导出记忆', exported: (kb) => `已复制到剪贴板（${kb} KB）。粘贴到备忘录或文件里。`,
  style: '它的风格', styleHint: '在聊天里说：「简短一点」「别用表情」「叫我老王」。',
  tabChat: '对话', tabDiscover: '发现',
  // [agent:connectors]
  connectors: '连接器', connectorsHint: '助理能用的服务。', noConnectors: '还没有连接任何服务。',
  servicesHint: '在手机上登录一次。助理在它的电脑上使用这个服务；随时可以断开。',
  connected: '已连接', disconnect: '断开', unavailableHere: '这台电脑上还不能用。', needsSetup: '需要先设置', connectStartFailed: '没能开始登录，再试一次。',
  otherConnectors: '其他连接', advanced: '高级', advancedHint: '这台电脑上的一个文件夹，或任何一个 MCP 服务器（命令或地址）。',
  addConnector: '添加', add: '添加', added: '已添加。', removed: '已移除', connectorOn: '开', connectorOff: '关',
  restartToApply: '在电脑上重启 Boop 后生效。',
  setEnvHint: (names) => `在电脑上设置 ${names}，然后重启 Boop。`, needsEnv: (names) => `需要 ${names}`, envSet: '已设置', envMissing: '未设置',
  folderPath: '电脑上的文件夹，例如 /Users/you/Documents', addFolder: '添加这个文件夹',
  customName: '名字', transportCommand: '一条命令', transportUrl: '一个地址', customCommand: '电脑上的命令，例如 my-mcp-server', customArgs: '参数，一行一个', customUrl: '地址，例如 https://example.com/mcp', customBearer: '存放访问密钥的环境变量名（可选），例如 MY_KEY', customEnv: '它需要的环境变量名，一行一个，例如 MY_KEY',
  customConfirmTitle: '添加这个服务器？', customConfirmBody: '每次 Boop 启动它都会在电脑上运行，助理可以调用它的工具。只添加你信任的。',
  presetText: (id) => ({
    notion: { name: 'Notion', description: '搜索、读写你的页面和数据库。', hint: '' },
    linear: { name: 'Linear', description: 'Issue、项目和周期。', hint: '' },
    atlassian: { name: 'Jira 和 Confluence', description: '你的 Atlassian 站点里的 issue、看板和 wiki 页面。', hint: '' },
    github: { name: 'GitHub', description: '你的仓库里的 issue、PR 和代码。', hint: '' },
    slack: { name: 'Slack', description: '读频道、搜索、以你的身份发消息。', hint: '' },
    gmail: { name: 'Gmail', description: '读、搜索和起草你的邮件。', hint: '' },
    'google-calendar': { name: 'Google 日历', description: '查看、创建和修改日程。', hint: '' },
    'google-drive': { name: 'Google Drive', description: '查找和阅读你的文件与文档。', hint: '' },
    filesystem: { name: '电脑上的文件', description: '读写你选的一个文件夹里的文件。', hint: '选一个文件夹。助理只能看到这个文件夹里的文件。' },
    memory: { name: '笔记图谱', description: '助理放在这台电脑上的一份小知识图谱。', hint: '不用设置。笔记存在 Boop 的文件夹里。' },
    custom: { name: '自定义 MCP 服务器', description: '任何 MCP 服务器：电脑上的一条命令，或一个地址。', hint: '密钥留在电脑上：这里只填环境变量名，值在电脑上设。' },
  } as Record<string, { name?: string; description?: string; hint?: string }>)[id],
}

export type BaseWords = typeof en
export const STRINGS: Record<Lang, typeof en> = { en, zh, 'zh-Hant': zhHantLocale.base, es: esLocale.base, ko: koLocale.base, ja: jaLocale.base, ru: ruLocale.base }
export function detectLang(): Lang {
  try {
    // NSH's locale(): the platform's own tag on every target (Android has no navigator, and its Intl needs `new`)
    const l = locale() || (globalThis as { navigator?: { language?: string } }).navigator?.language || ''
    return normalizeLang(l)
  } catch { return 'en' }
}

// [agent:browser] Stop control (src/stop.tsx). Kept in its own table so this block stays append-only.
export type StopWords = { stop: string; stopTitle: string; stopBody: string; stopConfirm: string; keepGoing: string; stopUnsupported: string; stopped: string }
export const STOP_STRINGS: Record<Lang, StopWords> = {
  en: { stop: 'Stop', stopTitle: 'Stop this task?', stopBody: 'It stops what it is doing now. Anything already done stays done.', stopConfirm: 'Stop task', keepGoing: 'Keep going', stopUnsupported: 'This version cannot stop tasks.', stopped: 'Stopped' },
  zh: { stop: '停止', stopTitle: '停止这个任务？', stopBody: '它会停下手上的事。已经做完的不会撤销。', stopConfirm: '停止任务', keepGoing: '继续', stopUnsupported: '这个版本不支持停止。', stopped: '已停止' },
  'zh-Hant': zhHantLocale.stop,
  es: esLocale.stop,
  ko: koLocale.stop,
  ja: jaLocale.stop,
  ru: ruLocale.stop,
}

// [main] memory page + discover tab
const mainEn = {
    memoryTitle: 'Memory', memoryHint: 'What it keeps about you. Tap Forget to remove a line; to correct something, just tell it in the chat.',
    memAboutYou: 'About you', memTracking: 'Things it is tracking', memDecisions: 'Decisions and agreements', memPeople: 'People and places',
    forget: 'Forget', forgetTitle: 'Forget this?', forgotten: 'Forgotten', noMemory: 'Nothing remembered yet. It learns as you talk.',
    discover: 'Discover', chatTab: 'Chat', needsYou: 'Needs you', tracking: 'Tracking', recentlyDone: 'Recently done', doIt: 'Do it', notNow: 'Not now',
    openThread: 'Answer', checkIn: 'Ask how it is going', checkInMsg: (title: string) => `How is "${title}" going?`, goalWord: 'Goal', reminderWord: 'Reminder', ideaWord: 'Idea', openChat: 'Open the chat',
    discoverEmpty: (n: string) => `${n || 'Your assistant'} is not tracking anything yet. Give it a goal or ask for a reminder in the chat.`,
}
export type MainWords = typeof mainEn
export const MAIN_STRINGS: Record<Lang, MainWords> = {
  en: mainEn,
  zh: {
    memoryTitle: '记忆', memoryHint: '它记住的关于你的事。点「忘掉」删除一条；要纠正，直接在聊天里说。',
    memAboutYou: '关于你', memTracking: '它在追踪的事', memDecisions: '决定和约定', memPeople: '人和地方',
    forget: '忘掉', forgetTitle: '忘掉这条？', forgotten: '已忘掉', noMemory: '还没有记住什么。聊着聊着它就会记。',
    discover: '发现', chatTab: '对话', needsYou: '需要你', tracking: '在追踪', recentlyDone: '最近做了', doIt: '去做', notNow: '不用了',
    openThread: '去回答', checkIn: '问问进展', checkInMsg: (title: string) => `「${title}」进展怎么样了？`, goalWord: '目标', reminderWord: '提醒', ideaWord: '想法', openChat: '去聊天',
    discoverEmpty: (n: string) => `${n || '助理'}还没有在追踪任何事。在聊天里给它一个目标，或者让它提醒你。`,
  },
  'zh-Hant': zhHantLocale.main,
  es: esLocale.main,
  ko: koLocale.main,
  ja: jaLocale.main,
  ru: ruLocale.main,
}

// [cards] Cards the assistant shows.
export type CardWords = { notConnected: string; cardDone: string; cardSubmit: string; cardOpenLink: string }
export const CARD_STRINGS: Record<Lang, CardWords> = {
  en: { notConnected: 'Not connected', cardDone: 'Done', cardSubmit: 'Submit', cardOpenLink: 'Open link' },
  zh: { notConnected: '没连上', cardDone: '选好了', cardSubmit: '提交', cardOpenLink: '打开链接' },
  'zh-Hant': zhHantLocale.card,
  es: esLocale.card,
  ko: koLocale.card,
  ja: jaLocale.card,
  ru: ruLocale.card,
}

// [chat] The activity block and its receipt.
export type ChatWords = { didThings: (n: number, seconds: number) => string; today: string; starters: string[] }
export const CHAT_STRINGS: Record<Lang, ChatWords> = {
  en: { didThings: (n, s) => `Did ${n} ${n === 1 ? 'thing' : 'things'}${s >= 1 ? ` in ${s} s` : ''}`, today: 'Today',
    // the empty thread's three things to ask; one tap fills the composer
    starters: ['Remind me every morning at 8 to take my pills', 'Plan the next three months so I can run 10 km', 'Watch the price of a flight to Lisbon and tell me when it drops'] },
  zh: { didThings: (n, s) => `做了 ${n} 件事${s >= 1 ? `，用了 ${s} 秒` : ''}`, today: '今天',
    starters: ['每天早上 8 点提醒我吃药', '帮我排一个三个月跑完 10 公里的计划', '盯着去里斯本的机票价格，降了告诉我'] },
  'zh-Hant': zhHantLocale.chat,
  es: esLocale.chat,
  ko: koLocale.chat,
  ja: jaLocale.chat,
  ru: ruLocale.chat,
}

// [agent:genui] Modules the assistant wrote.
export type ModuleWords = { moduleOpen: string; moduleHint: string; moduleAnswered: string; moduleFailed: string; moduleNeedsShell: string; moduleExpand: string }
export const MODULE_STRINGS: Record<Lang, ModuleWords> = {
  en: { moduleOpen: 'Open', moduleHint: 'An interface it built for you.', moduleAnswered: 'Answered: ', moduleFailed: 'Could not open it.', moduleNeedsShell: 'Open this in the phone app.', moduleExpand: 'Full screen' },
  zh: { moduleOpen: '打开', moduleHint: '它为你做的一个界面。', moduleAnswered: '已回答：', moduleFailed: '打不开。', moduleNeedsShell: '请在手机 App 里打开。', moduleExpand: '全屏' },
  'zh-Hant': zhHantLocale.module,
  es: esLocale.module,
  ko: koLocale.module,
  ja: jaLocale.module,
  ru: ruLocale.module,
}

// [agent:ui] One table for `str()` / `t()` in state.ts: the base strings plus every module's own table (later tables win on a shared key).
const merged = (l: Lang) => ({ ...STRINGS[l], ...STOP_STRINGS[l], ...MAIN_STRINGS[l], ...CARD_STRINGS[l], ...CHAT_STRINGS[l], ...MODULE_STRINGS[l], ...COMPLIANCE_STRINGS[l], ...TRY_STRINGS[l] })
export const ALL: Record<Lang, ReturnType<typeof merged>> = { en: merged('en'), zh: merged('zh'), 'zh-Hant': merged('zh-Hant'), es: merged('es'), ko: merged('ko'), ja: merged('ja'), ru: merged('ru') }
