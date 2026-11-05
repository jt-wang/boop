// What the bot itself writes to a person, in English. The other languages have this same shape (ServerWords).
// A translator: keep every ${…} blank and every HTML tag; write what a native speaker would, not word for word.
import { joinFacts, type LegalCtx } from './util.ts'

export const en = {
  /** Activity lines and notification titles (src/lang.ts). */
  lines: {
    remembered: (f: string) => `Remembered: ${f}`,
    forgot: (n: number, q: string) => `Forgot ${n} fact${n === 1 ? '' : 's'} about "${q}"`,
    scheduled: (name: string, when: string) => `Scheduled "${name}" for ${when}`,
    scheduleUpdated: (name: string, next: string) => `Updated "${name}" — next ${next}`,
    scheduleDeleted: () => 'Deleted a reminder',
    goalNew: (t: string) => `New goal: ${t}`,
    goalUpdated: (t: string, what: string) => `${t}: ${what || 'updated'}`,
    built: (t: string) => `Built an interface: ${t}`,
    renamed: (n: string) => `Renamed to ${n}`,
    reminderFired: (n: string) => `Reminder fired: ${n}`,
    connected: (n: string) => `Connected ${n}`,
    ideas: (titles: string[]) => `${titles.length} new idea${titles.length === 1 ? '' : 's'}: ${titles.join('; ')}`,
    brief: (t: string) => `Morning brief: ${t}`,
    memoryUpdated: (facts: string[]) => `Updated memory: ${joinFacts(facts, '; ')}`,
    needsYes: (n: string) => `${n} needs a yes`,
    hasQuestion: (n: string) => `${n} has a question`,
    done: (n: string) => `${n} is done`,
    openToAnswer: 'Open the app to answer',
    /** [push] A reminder's notification body; the title is the reminder's name. */
    reminderDue: 'It’s time.',
    assistant: 'Assistant',
  },
  /** What the thread says it is doing (src/fold.ts). */
  status: {
    working: 'Working…', background: (what: string) => `In the background: ${what}…`, backgroundPrefix: 'In the background',
    readingResults: 'Reading results…', modelBusy: 'Model busy, retrying…', tidying: 'Tidying up the chat…', thinking: 'Thinking…',
    /** Between a task's kind and its description ("Working on a sub-task: …"). */
    stepSep: ': ',
  },
  /** When a turn could not finish (src/fold.ts humanError). */
  errors: {
    noKey: 'It has no model key yet. Whoever runs this assistant needs to add one.',
    keyRefused: 'Its model key was refused. Whoever runs this assistant needs to replace it.',
    noCredit: 'Its model account is out of credit. Whoever runs this assistant needs to top it up.',
    busy: 'Its model stayed busy for several minutes. Send it again.',
    generic: 'That did not go through: it could not reach its model. Send it again.',
  },
  /** A tool in words, for the thread and notifications. */
  tools: { bash: 'Running a command', pwsh: 'Running a command', read: 'Reading a file', write: 'Writing a file', edit: 'Editing a file', str_replace_editor: 'Editing a file', fs_search: 'Searching files', grep: 'Searching files', glob: 'Searching files', web_search: 'Searching the web', web_fetch: 'Reading a web page', present: 'Preparing a file', todo: 'Updating the plan', schedule_create: 'Setting a reminder', schedule_update: 'Changing a reminder', schedule_delete: 'Removing a reminder', schedule_list: 'Checking reminders', subagent: 'Working on a sub-task', subagent_fork: 'Moving this to the background', send_message: 'Passing it to the background task', interrupt_agent: 'Stopping the background task', list_agents: 'Checking background tasks', skill: 'Using a skill', mcp__bot__remember: 'Remembering', mcp__bot__forget: 'Forgetting', mcp__bot__schedule_create: 'Setting a reminder', mcp__bot__schedule_update: 'Changing a reminder', mcp__bot__schedule_delete: 'Removing a reminder', mcp__bot__schedule_list: 'Checking reminders', mcp__bot__goal_set: 'Setting a goal', mcp__bot__goal_update: 'Updating a goal', mcp__bot__goal_list: 'Checking goals', mcp__bot__notify: 'Notifying you', mcp__bot__set_my_name: 'Changing my name', mcp__bot__show: 'Showing you a card', mcp__bot__ui: 'Building an interface', mcp__browser__browser_navigate: 'Opening a web page', mcp__browser__browser_click: 'Clicking on the page', mcp__browser__browser_type: 'Typing on the page', mcp__browser__browser_take_screenshot: 'Taking a screenshot', mcp__browser__browser_snapshot: 'Reading the page', mcp__browser__browser_evaluate: 'Reading the page', read_image: 'Looking at a screenshot' } as Record<string, string>,
  toolUsing: (service: string) => `Using ${service}`,
  toolFallback: 'Working',
  /** The browser page after connecting a service (src/oauth.ts). */
  oauth: {
    service: 'Service', connected: (name: string) => `${name} is connected`, notConnected: 'Not connected',
    goBack: 'You can go back to the app.', tryAgain: 'Go back to the app and tap Connect again.',
  },
  /** An interface's page in a browser (src/server.ts playPage). */
  play: { done: 'Done', back: 'You can go back to the app.', failed: 'This interface could not open.', opening: 'Opening…' },
  /** The public pages (src/legal.ts). */
  legal: {
    aiCompany: 'the AI provider', aiModel: 'the model', hostingProvider: 'our hosting provider', itsPolicy: 'its privacy policy',
    privacyTitle: 'Privacy policy',
    privacy: (c: LegalCtx) => `<h1>Privacy policy</h1><p class="muted">Boop · ${c.operator} · updated ${c.updated}</p>
<p>Boop is an assistant on your phone. When you sign in, we give your account a computer in the cloud where the assistant works for you. This page says what data passes through us, who receives it, how long it is kept and how to delete it.</p>
<h2>What we keep</h2><ul>
<li><b>Your account</b>: your email address (with Sign in with Apple, the user identifier and email Apple gives us), an account number, and hashes of your sign-in tokens.</li>
<li><b>What is on your computer</b>: your conversations, what the assistant remembers about you, files it makes, reminders and goals, interfaces it builds for you, sign-ins of services you connect, and its browser data. It all lives on your account's own cloud computer; no other account can see it.</li>
<li><b>Notifications</b>: your phone's push token, to send you notifications.</li>
<li><b>Reports</b>: the words of a reply or the code of an interface you report, your note, and your account number.</li>
<li><b>Server logs</b>: request times and account numbers, to fix problems and prevent abuse.</li></ul>
<p>No ads, no third-party analytics or tracking, and we sell no data.</p>
<h2>What goes to the AI provider</h2>
<p>Once you agree, your messages, the files and web pages the assistant reads for a task, and what it remembers about you are sent to <b>${c.company}</b>${c.policy}, which runs <b>${c.model}</b> to write the replies. The app asks you before the first message; you can withdraw at any time in the app under Settings → AI provider, and nothing more is sent.${c.filter ? ` Replies are also checked by <b>${c.filter}</b>'s moderation service; a reply it flags is hidden.` : ''}</p>
<h2>Who else receives data</h2><ul><li>${c.hosting}: runs our servers and your cloud computer.</li><li>Apple and Google: deliver notifications.</li><li>Services you connect yourself (for example Notion or Gmail): the assistant uses them as you ask; their terms apply.</li></ul>
<p>They process data only to provide these functions, and we require them to protect it at least as well as this policy does.</p>
<h2>How long, and deleting it</h2>
<p>We keep your data until you delete your account. Delete it in the app (Settings → Delete account) or on the web at <a href="${c.hostUrl}/account/delete">${c.hostUrl}/account/delete</a>: we delete your cloud computer and its disk, your account record and your reports at once. Our hosting provider's daily disk snapshots expire within 5 days. We keep nothing else unless the law requires it.</p>
<h2>Your own computer</h2><p>If you connect the app to a computer of your own, your data stays on that computer and never reaches us; only reports you choose to send do.</p>
<h2>Security</h2><p>Everything travels over HTTPS; sign-in tokens are stored only as hashes; each account's computer is kept apart from the others.</p>
<h2>Age</h2><p>Boop is for people aged 18 and over.</p>
<h2>Contact</h2><p>${c.contact}. You can ask us at any time to see, correct or delete your data.</p>
`,
    termsTitle: 'Terms of use',
    terms: (c: LegalCtx) => `<h1>Terms of use</h1><p class="muted">Boop · ${c.operator} · updated ${c.updated}</p>
<h2>Who may use it</h2><p>You must be 18 or older.</p>
<h2>What is not allowed</h2><p>Do not use the assistant to create, keep or spread: sexual content involving minors or any exploitation of children; intimate images shared without consent; threats, harassment or bullying; hate against protected groups; content that incites or glorifies violence, terrorism or self-harm; concrete help with illegal activity (including weapons, drugs and fraud); malware; impersonating or deceiving people; or infringing others' intellectual property or privacy.</p>
<h2>Reports and what we do</h2><p>Long-press a reply, or use an interface's menu, to report it. We act on reports within 24 hours and may remove or hide content, block an interface, or suspend or close an account.</p>
<h2>AI makes mistakes</h2><p>Replies are written by AI and can be wrong. Check anything important.</p>
<h2>Deleting</h2><p>You can delete your account at any time in the app or <a href="${c.hostUrl}/account/delete">on the web</a>. See also the <a href="${c.hostUrl}/privacy${c.langQuery}">privacy policy</a>.</p>
<h2>Contact</h2><p>${c.contact}</p>`,
    deleteTitle: 'Delete your Boop account', deleted: 'Deleted',
    deletedBody: "If that email had an account, it has been deleted with its cloud computer, its disk and its reports (our hosting provider's disk snapshots expire within 5 days).",
    wrongCode: 'That access code is not right.', tooMany: 'Too many tries. Wait a few minutes.',
    deleteBody: 'This deletes your account, your cloud computer and everything on it (conversations, memory, files, interfaces, connected services) and your reports, at once and for good. You can also do it in the app: Settings → Delete account.',
    emailPlaceholder: 'The email you sign in with', codePlaceholder: 'Access code', deleteButton: 'Delete account', questions: 'Questions:',
    openBody: 'This is an interface the assistant built for you. It opens in the Boop app: tap this link on a phone that has the app.',
    openInBrowser: 'Open Boop in the browser',
  },
}
export type ServerWords = typeof en
