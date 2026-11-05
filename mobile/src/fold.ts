// The rows of a thread, as bot's own protocol sends them (src/fold.ts on the
// bot; src/thread.ts frames them). The app never sees the harness's wire
// format: the bot folds it and the app only draws rows.

export type CardField = { name: string; label: string; type: 'text' | 'number' | 'date' | 'time' | 'toggle' | 'select'; placeholder?: string; value?: string; options?: string[]; required?: boolean }
export type Card =
  | { kind: 'choices'; title: string; detail?: string; options: { label: string; detail?: string }[]; multiple?: boolean }
  | { kind: 'form'; title: string; detail?: string; fields: CardField[]; submit?: string }
  | { kind: 'confirm'; title: string; detail?: string; yes?: string; no?: string }
  | { kind: 'table'; title: string; columns: string[]; rows: string[][]; pick?: boolean }
  | { kind: 'progress'; title: string; items: { label: string; state: 'done' | 'doing' | 'todo' }[] }
  | { kind: 'summary'; title: string; items: { label: string; value: string }[]; link?: string }
  /** [agent:connectors] one button that signs the person in to a service (the same flow as Settings → Connectors). */
  | { kind: 'connect'; title: string; detail?: string; service: string }

export type Row =
  | { kind: 'you'; id: string; text: string; at: number }
  | { kind: 'them'; id: string; text: string; at: number; streaming?: boolean; /** [compliance] hidden by the content filter (src/moderation.ts) */ filtered?: boolean }
  | { kind: 'step'; id: string; name: string; description?: string; command?: string; output?: string; at: number }
  | { kind: 'notice'; id: string; text: string; at: number }
  | { kind: 'card'; id: string; card: Card; answer?: string; at: number }
  /** [agent:genui] An interface the assistant wrote (src/ui.ts on the bot): a signed package the shell opens in a sheet. `url` is relative to the bot. */
  | { kind: 'module'; id: string; moduleId: string; title: string; url: string; answer?: string; at: number }
  /** A file the assistant handed over (`present`): an image shows in the thread, anything else is a card that opens. `path` is the computer's, for GET /library/file. */
  | { kind: 'file'; id: string; path: string; name: string; description?: string; image: boolean; at: number; /** An image the harness keeps in its attachment store (a browser screenshot): fetched by this id (GET /library/attachment), not by path. */ attachment?: string; /** A file the turn wrote (`new`) or changed (`edited`) with a file tool: a card after the reply. */ change?: 'new' | 'edited' }

export type CardRow = Extract<Row, { kind: 'card' }>
import type { Lang } from './locale.ts'
import { es } from './locales/es.ts'
import { ja } from './locales/ja.ts'
import { ko } from './locales/ko.ts'
import { ru } from './locales/ru.ts'
import { zhHant } from './locales/zh-Hant.ts'

export type ModuleRow = Extract<Row, { kind: 'module' }>
export type FileRow = Extract<Row, { kind: 'file' }>

/** Names of the services the bot knows (connectors.tsx fills it from GET /connectors): `atlassian` → `Jira and Confluence`. */
export const serviceNames: Record<string, string> = {}
/** A service id as a name: the catalog's name when known, else `acme-pages` → `Acme Pages`. */
export const serviceName = (id: string) => serviceNames[id] ?? id.split('-').filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ')
/** The connected service a tool belongs to (`mcp__notion__search` → `notion`); null for the bot's and the browser's own tools. */
export function connectorOf(tool: string): string | null {
  const svc = /^mcp__([a-z0-9-]+)__/i.exec(tool)?.[1]
  return svc && svc !== 'bot' && svc !== 'browser' ? svc : null
}

/** Human words for tool names; `description` from the tool arguments wins when present. */
export type ToolWords = { tools: Record<string, string>; using: (service: string) => string; fallback: string }
/** A tool in words; the same tables as the bot's (src/locales/, test/i18n.test.ts compares them). */
export const TOOL_WORDS: Record<Lang, ToolWords> = {
  en: { tools: { bash: 'Running a command', pwsh: 'Running a command', read: 'Reading a file', write: 'Writing a file', edit: 'Editing a file', str_replace_editor: 'Editing a file', fs_search: 'Searching files', grep: 'Searching files', glob: 'Searching files', web_search: 'Searching the web', web_fetch: 'Reading a web page', present: 'Preparing a file', todo: 'Updating the plan', schedule_create: 'Setting a reminder', schedule_update: 'Changing a reminder', schedule_delete: 'Removing a reminder', schedule_list: 'Checking reminders', subagent: 'Working on a sub-task', subagent_fork: 'Moving this to the background', send_message: 'Passing it to the background task', interrupt_agent: 'Stopping the background task', list_agents: 'Checking background tasks', skill: 'Using a skill', mcp__bot__remember: 'Remembering', mcp__bot__forget: 'Forgetting', mcp__bot__schedule_create: 'Setting a reminder', mcp__bot__schedule_update: 'Changing a reminder', mcp__bot__schedule_delete: 'Removing a reminder', mcp__bot__schedule_list: 'Checking reminders', mcp__bot__goal_set: 'Setting a goal', mcp__bot__goal_update: 'Updating a goal', mcp__bot__goal_list: 'Checking goals', mcp__bot__notify: 'Notifying you', mcp__bot__set_my_name: 'Changing my name', mcp__bot__show: 'Showing you a card', mcp__bot__ui: 'Building an interface', mcp__browser__browser_navigate: 'Opening a web page', mcp__browser__browser_click: 'Clicking on the page', mcp__browser__browser_type: 'Typing on the page', mcp__browser__browser_take_screenshot: 'Taking a screenshot', mcp__browser__browser_snapshot: 'Reading the page', mcp__browser__browser_evaluate: 'Reading the page', read_image: 'Looking at a screenshot' }, using: (service) => `Using ${service}`, fallback: 'Working' },
  zh: { tools: { bash: '执行命令', pwsh: '执行命令', read: '读文件', write: '写文件', edit: '改文件', str_replace_editor: '改文件', fs_search: '搜索文件', grep: '搜索文件', glob: '搜索文件', web_search: '搜索网页', web_fetch: '读网页', present: '准备文件', todo: '更新计划', schedule_create: '设置提醒', schedule_update: '修改提醒', schedule_delete: '删除提醒', schedule_list: '查看提醒', subagent: '处理子任务', subagent_fork: '转到后台', send_message: '转告后台任务', interrupt_agent: '停下后台任务', list_agents: '查看后台任务', skill: '使用技能', mcp__bot__remember: '记下来', mcp__bot__forget: '忘掉', mcp__bot__schedule_create: '设置提醒', mcp__bot__schedule_update: '修改提醒', mcp__bot__schedule_delete: '删除提醒', mcp__bot__schedule_list: '查看提醒', mcp__bot__goal_set: '设定目标', mcp__bot__goal_update: '更新目标', mcp__bot__goal_list: '查看目标', mcp__bot__notify: '通知你', mcp__bot__set_my_name: '改名字', mcp__bot__show: '给你一张卡片', mcp__bot__ui: '生成界面', mcp__browser__browser_navigate: '打开网页', mcp__browser__browser_click: '点击页面', mcp__browser__browser_type: '在页面输入', mcp__browser__browser_take_screenshot: '截图', mcp__browser__browser_snapshot: '读网页', mcp__browser__browser_evaluate: '读网页', read_image: '看截图' }, using: (service) => `使用 ${service}`, fallback: '处理中' },
  'zh-Hant': zhHant.tools, es: es.tools, ko: ko.tools, ja: ja.tools, ru: ru.tools,
}
export function toolWord(name: string, lang: Lang): string {
  const w = TOOL_WORDS[lang]
  if (w.tools[name]) return w.tools[name]
  // a connected service (mcp__<service>__<tool>): which service, never the tool's own English name
  const svc = connectorOf(name)
  if (svc) return w.using(serviceName(svc))
  return w.fallback
}
