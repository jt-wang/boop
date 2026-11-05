// 繁體中文（台灣用語）. Same shape as en.ts.
import { joinFacts, type LegalCtx } from './util.ts'
import type { ServerWords } from './en.ts'

export const zhHant: ServerWords = {
  lines: {
    remembered: (f) => `記住了：${f}`,
    forgot: (n, q) => `忘掉了 ${n} 條和「${q}」有關的記憶`,
    scheduled: (name, when) => `設好了提醒「${name}」：${when}`,
    scheduleUpdated: (name, next) => `改了提醒「${name}」，下次 ${next}`,
    scheduleDeleted: () => '刪了一個提醒',
    goalNew: (t) => `新目標：${t}`,
    goalUpdated: (t, what) => `目標「${t}」：${what || '已更新'}`,
    built: (t) => `做了一個介面：${t}`,
    renamed: (n) => `改名為 ${n}`,
    reminderFired: (n) => `提醒時間到了：${n}`,
    connected: (n) => `連結了 ${n}`,
    ideas: (titles) => `${titles.length} 個新建議：${titles.join('；')}`,
    brief: (t) => `晨間簡報：${t}`,
    memoryUpdated: (facts) => `記憶更新：${joinFacts(facts, '；')}`,
    needsYes: (n) => `${n}需要你同意`,
    hasQuestion: (n) => `${n}有個問題`,
    done: (n) => `${n}做完了`,
    openToAnswer: '開啟 App 回答',
    reminderDue: '時間到了。',
    assistant: '助理',
  },
  status: {
    working: '工作中…', background: (what) => `背景：${what}…`, backgroundPrefix: '背景：',
    readingResults: '正在看結果…', modelBusy: '模型忙碌中，正在重試…', tidying: '正在整理對話…', thinking: '思考中…',
    stepSep: '：',
  },
  errors: {
    noKey: '還沒有連上模型：管理這個助理的人需要新增模型金鑰。',
    keyRefused: '模型金鑰被拒絕了：管理這個助理的人需要更換一組。',
    noCredit: '模型帳戶的額度用完了：管理這個助理的人需要儲值。',
    busy: '模型太忙了，等了幾分鐘還是沒空。再傳一次試試。',
    generic: '這一步沒有完成：它連不上模型。再傳一次試試。',
  },
  tools: { bash: '執行指令', pwsh: '執行指令', read: '讀取檔案', write: '寫入檔案', edit: '編輯檔案', str_replace_editor: '編輯檔案', fs_search: '搜尋檔案', grep: '搜尋檔案', glob: '搜尋檔案', web_search: '搜尋網路', web_fetch: '閱讀網頁', present: '準備檔案', todo: '更新計畫', schedule_create: '設定提醒', schedule_update: '修改提醒', schedule_delete: '刪除提醒', schedule_list: '查看提醒', subagent: '處理子任務', subagent_fork: '轉到背景', send_message: '轉告背景任務', interrupt_agent: '停止背景任務', list_agents: '查看背景任務', skill: '使用技能', mcp__bot__remember: '記下來', mcp__bot__forget: '忘掉', mcp__bot__schedule_create: '設定提醒', mcp__bot__schedule_update: '修改提醒', mcp__bot__schedule_delete: '刪除提醒', mcp__bot__schedule_list: '查看提醒', mcp__bot__goal_set: '設定目標', mcp__bot__goal_update: '更新目標', mcp__bot__goal_list: '查看目標', mcp__bot__notify: '通知你', mcp__bot__set_my_name: '改名字', mcp__bot__show: '給你一張卡片', mcp__bot__ui: '建立介面', mcp__browser__browser_navigate: '開啟網頁', mcp__browser__browser_click: '點一下頁面', mcp__browser__browser_type: '在頁面上輸入', mcp__browser__browser_take_screenshot: '截圖', mcp__browser__browser_snapshot: '讀取頁面', mcp__browser__browser_evaluate: '讀取頁面', read_image: '查看截圖' },
  toolUsing: (service) => `使用 ${service}`,
  toolFallback: '處理中',
  oauth: {
    service: '服務', connected: (name) => `${name} 已連結`, notConnected: '沒有連結成功',
    goBack: '可以回到 App 了。', tryAgain: '回到 App，再點一下「連結」。',
  },
  play: { done: '完成', back: '可以回到 App 了。', failed: '打不開這個介面。', opening: '正在開啟…' },
  legal: {
    aiCompany: 'AI 供應商', aiModel: '模型', hostingProvider: '我們的代管服務供應商', itsPolicy: '它的隱私權政策',
    privacyTitle: '隱私權政策',
    privacy: (c: LegalCtx) => `<h1>隱私權政策</h1><p class="muted">Boop · ${c.operator} · 更新於 ${c.updated}</p>
<p>Boop 是你手機上的助理。你登入後，我們會為你的帳號開一台雲端電腦，助理在上面替你做事。這一頁說明哪些資料會經過我們、誰會收到、保留多久，以及如何刪除。</p>
<h2>我們保存什麼</h2><ul>
<li><b>你的帳號</b>：你的電子郵件地址（使用 Apple 登入時，是 Apple 提供給我們的使用者識別碼和電子郵件）、帳號編號，以及登入權杖的雜湊值。</li>
<li><b>你電腦上的內容</b>：你的對話、助理記得的關於你的事、它做的檔案、提醒和目標、它為你做的介面、你連結的服務的登入資料，以及它的瀏覽器資料。這些都放在你帳號專屬的雲端電腦上，其他帳號看不到。</li>
<li><b>通知</b>：你手機的推播權杖，用來傳送通知給你。</li>
<li><b>檢舉</b>：你檢舉的回覆內容或介面程式碼、你寫的說明，以及你的帳號編號。</li>
<li><b>伺服器記錄</b>：請求時間和帳號編號，用來排除問題和防止濫用。</li></ul>
<p>沒有廣告，沒有第三方分析或追蹤，我們也不販售任何資料。</p>
<h2>哪些內容會傳給 AI 供應商</h2>
<p>你同意之後，你的訊息、助理為了完成任務讀取的檔案和網頁，以及它對你的記憶，都會傳給 <b>${c.company}</b>${c.policy}，由它執行 <b>${c.model}</b> 來撰寫回覆。App 會在你傳第一則訊息前先問你；你可以隨時在 App 的「設定 → AI 供應商」撤回同意，之後就不會再傳送任何內容。${c.filter ? `回覆也會由 <b>${c.filter}</b> 的內容審核服務檢查，被標記的回覆會被隱藏。` : ''}</p>
<h2>還有誰會收到資料</h2><ul><li>${c.hosting}：執行我們的伺服器和你的雲端電腦。</li><li>Apple 和 Google：傳遞通知。</li><li>你自己連結的服務（例如 Notion 或 Gmail）：助理依你的要求使用它們，並適用它們的條款。</li></ul>
<p>它們只為了提供這些功能而處理資料，我們也要求它們提供不低於本政策的保護。</p>
<h2>保留多久，以及如何刪除</h2>
<p>我們會保留你的資料，直到你刪除帳號為止。你可以在 App 裡（設定 → 刪除帳號）或到網頁 <a href="${c.hostUrl}/account/delete">${c.hostUrl}/account/delete</a> 刪除：我們會立即刪除你的雲端電腦和它的磁碟、你的帳號紀錄和你的檢舉。代管服務供應商每天的磁碟快照會在 5 天內過期。除非法律要求，否則我們不會保留其他資料。</p>
<h2>你自己的電腦</h2><p>如果你把 App 連到自己的電腦，你的資料都留在那台電腦上，不會傳到我們這裡；只有你主動送出的檢舉才會。</p>
<h2>安全</h2><p>所有傳輸都透過 HTTPS；登入權杖只以雜湊值保存；每個帳號的電腦彼此隔離。</p>
<h2>年齡</h2><p>Boop 僅供年滿 18 歲的人使用。</p>
<h2>聯絡我們</h2><p>${c.contact}。你可以隨時要求查看、更正或刪除你的資料。</p>
`,
    termsTitle: '使用條款',
    terms: (c: LegalCtx) => `<h1>使用條款</h1><p class="muted">Boop · ${c.operator} · 更新於 ${c.updated}</p>
<h2>誰可以使用</h2><p>你必須年滿 18 歲。</p>
<h2>哪些事不允許</h2><p>不得利用助理製作、保存或散布：涉及未成年人的性內容或任何對兒童的剝削；未經同意分享的私密影像；威脅、騷擾或霸凌；針對受保護群體的仇恨言論；煽動或美化暴力、恐怖主義或自殘的內容；對違法活動的具體協助（包括武器、毒品和詐騙）；惡意軟體；冒充或欺騙他人；侵犯他人的智慧財產權或隱私。</p>
<h2>檢舉和處理方式</h2><p>長按回覆，或使用介面的選單，就能檢舉。我們會在 24 小時內處理檢舉，並可能移除或隱藏內容、封鎖介面，或停用、關閉帳號。</p>
<h2>AI 會出錯</h2><p>回覆由 AI 撰寫，可能有誤。重要的事請自行查證。</p>
<h2>刪除</h2><p>你可以隨時在 App 裡或<a href="${c.hostUrl}/account/delete">網頁上</a>刪除帳號。另請參閱<a href="${c.hostUrl}/privacy${c.langQuery}">隱私權政策</a>。</p>
<h2>聯絡我們</h2><p>${c.contact}</p>`,
    deleteTitle: '刪除你的 Boop 帳號', deleted: '已刪除',
    deletedBody: '如果這個電子郵件有帳號，該帳號已連同它的雲端電腦、磁碟和檢舉一起刪除（代管服務供應商的磁碟快照會在 5 天內過期）。',
    wrongCode: '邀請碼不對。', tooMany: '嘗試太多次了，請過幾分鐘再試。',
    deleteBody: '這會立即且永久刪除你的帳號、你的雲端電腦和上面的所有內容（對話、記憶、檔案、介面、已連結的服務），以及你的檢舉。你也可以在 App 裡操作：設定 → 刪除帳號。',
    emailPlaceholder: '你登入用的電子郵件', codePlaceholder: '邀請碼', deleteButton: '刪除帳號', questions: '有問題請寫信到',
    openBody: '這是助理為你做的介面，要在 Boop App 裡開啟：請在裝了 App 的手機上點一下這個連結。',
    openInBrowser: '在瀏覽器開啟 Boop',
  },
}
