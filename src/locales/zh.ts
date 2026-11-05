// 简体中文. Same shape as en.ts.
import { joinFacts, type LegalCtx } from './util.ts'
import type { ServerWords } from './en.ts'

export const zh: ServerWords = {
  lines: {
    remembered: (f) => `记住了：${f}`,
    forgot: (n, q) => `忘掉了 ${n} 条和「${q}」有关的记忆`,
    scheduled: (name, when) => `设好了提醒「${name}」：${when}`,
    scheduleUpdated: (name, next) => `改了提醒「${name}」，下次 ${next}`,
    scheduleDeleted: () => '删了一个提醒',
    goalNew: (t) => `新目标：${t}`,
    goalUpdated: (t, what) => `目标「${t}」：${what || '已更新'}`,
    built: (t) => `做了一个界面：${t}`,
    renamed: (n) => `改名为 ${n}`,
    reminderFired: (n) => `提醒到点了：${n}`,
    connected: (n) => `接上了 ${n}`,
    ideas: (titles) => `${titles.length} 个新建议：${titles.join('；')}`,
    brief: (t) => `早间简报：${t}`,
    memoryUpdated: (facts) => `记忆更新：${joinFacts(facts, '；')}`,
    needsYes: (n) => `${n}需要你点头`,
    hasQuestion: (n) => `${n}有个问题`,
    done: (n) => `${n}做完了`,
    openToAnswer: '打开 App 回答',
    reminderDue: '到点了。',
    assistant: '助理',
  },
  status: {
    working: '工作中…', background: (what) => `后台：${what}…`, backgroundPrefix: '后台：',
    readingResults: '正在看结果…', modelBusy: '模型忙，正在重试…', tidying: '正在整理对话…', thinking: '思考中…',
    stepSep: '：',
  },
  errors: {
    noKey: '还没有接上模型：运行这个助理的人需要加一个模型密钥。',
    keyRefused: '模型密钥被拒绝了：运行这个助理的人需要换一个。',
    noCredit: '模型账户的余额用完了：运行这个助理的人需要充值。',
    busy: '模型那边太忙了，等了几分钟还是没空。再发一次试试。',
    generic: '这一步没能完成：它连不上模型。再发一次试试。',
  },
  tools: { bash: '执行命令', pwsh: '执行命令', read: '读文件', write: '写文件', edit: '改文件', str_replace_editor: '改文件', fs_search: '搜索文件', grep: '搜索文件', glob: '搜索文件', web_search: '搜索网页', web_fetch: '读网页', present: '准备文件', todo: '更新计划', schedule_create: '设置提醒', schedule_update: '修改提醒', schedule_delete: '删除提醒', schedule_list: '查看提醒', subagent: '处理子任务', subagent_fork: '转到后台', send_message: '转告后台任务', interrupt_agent: '停下后台任务', list_agents: '查看后台任务', skill: '使用技能', mcp__bot__remember: '记下来', mcp__bot__forget: '忘掉', mcp__bot__schedule_create: '设置提醒', mcp__bot__schedule_update: '修改提醒', mcp__bot__schedule_delete: '删除提醒', mcp__bot__schedule_list: '查看提醒', mcp__bot__goal_set: '设定目标', mcp__bot__goal_update: '更新目标', mcp__bot__goal_list: '查看目标', mcp__bot__notify: '通知你', mcp__bot__set_my_name: '改名字', mcp__bot__show: '给你一张卡片', mcp__bot__ui: '生成界面', mcp__browser__browser_navigate: '打开网页', mcp__browser__browser_click: '点击页面', mcp__browser__browser_type: '在页面输入', mcp__browser__browser_take_screenshot: '截图', mcp__browser__browser_snapshot: '读网页', mcp__browser__browser_evaluate: '读网页', read_image: '看截图' },
  toolUsing: (service) => `使用 ${service}`,
  toolFallback: '处理中',
  oauth: {
    service: '服务', connected: (name) => `${name} 已连接`, notConnected: '没有连上',
    goBack: '可以回到 App 了。', tryAgain: '回到 App，再点一次连接。',
  },
  play: { done: '完成', back: '可以回到 App 了。', failed: '打不开这个界面。', opening: '正在打开…' },
  legal: {
    aiCompany: 'AI 服务商', aiModel: '模型', hostingProvider: '我们的托管服务商', itsPolicy: '它的隐私政策',
    privacyTitle: '隐私政策',
    privacy: (c: LegalCtx) => `<h1>隐私政策</h1><p class="muted">Boop · ${c.operator} · 更新于 ${c.updated}</p>
<p>Boop 是一个手机上的助理。你登录后，我们为你的账号开一台云端电脑，助理在上面替你干活。下面说明哪些数据经过我们、发给谁、留多久、怎么删除。</p>
<h2>我们保存什么</h2><ul>
<li><b>账号</b>：你的邮箱（用 Apple 登录时是 Apple 给的用户标识和邮箱）、账号编号，以及登录凭证的哈希值。</li>
<li><b>你的电脑上的内容</b>：对话、助理记住的关于你的事、它做的文件、提醒和目标、它为你做的界面、你连接的服务的登录凭证、它的浏览器数据。这些都在你账号自己的云端电脑上，别的账号看不到。</li>
<li><b>通知</b>：你手机的推送令牌，用来给你发通知。</li>
<li><b>举报</b>：你举报的回复原文或界面代码、你写的说明和你的账号编号。</li>
<li><b>服务器日志</b>：请求时间和账号编号，用来排查故障和防止滥用。</li></ul>
<p>没有广告，没有第三方统计或追踪，不出售任何数据。</p>
<h2>发给 AI 服务商的内容</h2>
<p>你同意之后，你的消息、助理为完成任务读取的文件和网页、它对你的记忆会发给 <b>${c.company}</b>${c.policy}，由它运行 <b>${c.model}</b> 生成回复。第一次使用时 App 会先问你；以后可以在 App 的「设置 → AI 服务商」里随时撤回，撤回后不再发送任何内容。${c.filter ? `回复还会交给 <b>${c.filter}</b> 的内容审核服务检查，被判定违规的回复会被隐藏。` : ''}</p>
<h2>其他接收方</h2><ul><li>${c.hosting}：运行我们的服务器和你的云端电脑。</li><li>Apple / Google：转发推送通知。</li><li>你自己连接的服务（例如 Notion、Gmail）：助理按你的要求使用它们，适用它们的条款。</li></ul>
<p>这些接收方只为提供上述功能处理数据；我们要求它们给予不低于本政策的保护。</p>
<h2>保留与删除</h2>
<p>数据保留到你删除账号为止。在 App 的「设置 → 删除账号」或网页 <a href="${c.hostUrl}/account/delete">${c.hostUrl}/account/delete</a> 删除后，我们立即删除你的云端电脑和它的磁盘、账号记录和你的举报。托管服务商每天的磁盘快照在 5 天内过期。法律要求保留的除外。</p>
<h2>使用自己电脑的情况</h2><p>如果你把 App 连到自己的电脑，数据都在你自己的电脑上，我们收不到；只有你主动发出的举报会到我们这里。</p>
<h2>安全</h2><p>所有传输都经过 HTTPS 加密；登录凭证只保存哈希值；每个账号的电脑互相隔离。</p>
<h2>年龄</h2><p>Boop 只面向 18 岁及以上的人。</p>
<h2>联系我们</h2><p>${c.contact}。你可以随时要求查看、更正或删除你的数据。</p>
`,
    termsTitle: '使用条款',
    terms: (c: LegalCtx) => `<h1>使用条款</h1><p class="muted">Boop · ${c.operator} · 更新于 ${c.updated}</p>
<h2>谁可以用</h2><p>你必须年满 18 岁。</p>
<h2>不允许的内容和行为</h2><p>不得让助理生成、保存或传播：涉及未成年人的性内容或对儿童的任何剥削；未经同意的私密影像；威胁、骚扰、霸凌；针对受保护群体的仇恨言论；煽动或美化暴力、恐怖主义、自残；违法活动的具体帮助（包括武器、毒品、诈骗）；恶意软件；冒充他人或欺骗他人；侵犯他人知识产权或隐私。</p>
<h2>举报和处理</h2><p>长按助理的回复或打开界面的菜单即可举报。我们在 24 小时内处理举报，可能删除或屏蔽内容、屏蔽界面、暂停或关闭账号。</p>
<h2>AI 会出错</h2><p>助理的回复由 AI 生成，可能不准确。重要的事请自行核实。</p>
<h2>删除</h2><p>你可以随时在 App 里或 <a href="${c.hostUrl}/account/delete">网页</a> 删除账号。另见 <a href="${c.hostUrl}/privacy${c.langQuery}">隐私政策</a>。</p>
<h2>联系</h2><p>${c.contact}</p>`,
    deleteTitle: '删除 Boop 账号', deleted: '已删除',
    deletedBody: '如果这个邮箱有账号，它和它的云端电脑、磁盘、举报已经删除（托管服务商的磁盘快照在 5 天内过期）。',
    wrongCode: '邀请码不对。', tooMany: '试错太多次了，过几分钟再试。',
    deleteBody: '这会删除你的账号、你的云端电脑和上面的一切（对话、记忆、文件、界面、连接的服务），以及你的举报，立即生效，不能恢复。也可以在 App 里：设置 → 删除账号。',
    emailPlaceholder: '登录用的邮箱', codePlaceholder: '邀请码', deleteButton: '删除账号', questions: '有问题请写信给',
    openBody: '这是助理为你做的一个界面，要在 Boop App 里打开。在装了 App 的手机上点这个链接即可。',
    openInBrowser: '在浏览器里打开 Boop',
  },
}
