// 日本語. Same shape as en.ts.
import { joinFacts, type LegalCtx } from './util.ts'
import type { ServerWords } from './en.ts'

export const ja: ServerWords = {
  lines: {
    remembered: (f) => `覚えました：${f}`,
    forgot: (n, q) => `「${q}」に関する記憶を${n}件忘れました`,
    scheduled: (name, when) => `リマインダー「${name}」を設定しました：${when}`,
    scheduleUpdated: (name, next) => `リマインダー「${name}」を更新しました。次回：${next}`,
    scheduleDeleted: () => 'リマインダーを削除しました',
    goalNew: (t) => `新しい目標：${t}`,
    goalUpdated: (t, what) => `目標「${t}」：${what || '更新しました'}`,
    built: (t) => `画面を作成しました：${t}`,
    renamed: (n) => `名前を${n}に変更しました`,
    reminderFired: (n) => `リマインダーの時刻です：${n}`,
    connected: (n) => `${n}を接続しました`,
    ideas: (titles) => `新しいアイデア${titles.length}件：${titles.join('、')}`,
    brief: (t) => `朝のまとめ：${t}`,
    memoryUpdated: (facts) => `記憶を更新しました：${joinFacts(facts, '、')}`,
    needsYes: (n) => `${n}が承認を求めています`,
    hasQuestion: (n) => `${n}から質問があります`,
    done: (n) => `${n}の作業が終わりました`,
    openToAnswer: 'アプリを開いて回答',
    reminderDue: '時間です。',
    assistant: 'アシスタント',
  },
  status: {
    working: '作業中…', background: (what) => `バックグラウンド：${what}…`, backgroundPrefix: 'バックグラウンド：',
    readingResults: '結果を確認しています…', modelBusy: 'モデルが混み合っています。再試行しています…', tidying: 'チャットを整理しています…', thinking: '考え中…',
    stepSep: '：',
  },
  errors: {
    noKey: 'モデルのキーがまだ設定されていません。このアシスタントの管理者が追加する必要があります。',
    keyRefused: 'モデルのキーが拒否されました。このアシスタントの管理者が交換する必要があります。',
    noCredit: 'モデルのアカウントの残高がなくなりました。このアシスタントの管理者がチャージする必要があります。',
    busy: 'モデルが数分間混み合っていました。もう一度送信してください。',
    generic: 'うまくいきませんでした：モデルに接続できませんでした。もう一度送信してください。',
  },
  tools: { bash: 'コマンドの実行', pwsh: 'コマンドの実行', read: 'ファイルの読み取り', write: 'ファイルへの書き込み', edit: 'ファイルの編集', str_replace_editor: 'ファイルの編集', fs_search: 'ファイルの検索', grep: 'ファイルの検索', glob: 'ファイルの検索', web_search: 'ウェブ検索', web_fetch: 'ウェブページの読み取り', present: 'ファイルの準備', todo: '計画の更新', schedule_create: 'リマインダーの設定', schedule_update: 'リマインダーの変更', schedule_delete: 'リマインダーの削除', schedule_list: 'リマインダーの確認', subagent: 'サブタスクの処理', subagent_fork: 'バックグラウンドへの移動', send_message: 'バックグラウンドのタスクへの連絡', interrupt_agent: 'バックグラウンドのタスクの停止', list_agents: 'バックグラウンドのタスクの確認', skill: 'スキルの使用', mcp__bot__remember: '記憶への追加', mcp__bot__forget: '記憶の削除', mcp__bot__schedule_create: 'リマインダーの設定', mcp__bot__schedule_update: 'リマインダーの変更', mcp__bot__schedule_delete: 'リマインダーの削除', mcp__bot__schedule_list: 'リマインダーの確認', mcp__bot__goal_set: '目標の設定', mcp__bot__goal_update: '目標の更新', mcp__bot__goal_list: '目標の確認', mcp__bot__notify: 'あなたへの通知', mcp__bot__set_my_name: '名前の変更', mcp__bot__show: 'カードの表示', mcp__bot__ui: '画面の作成', mcp__browser__browser_navigate: 'ウェブページを開く操作', mcp__browser__browser_click: 'ページ上のクリック', mcp__browser__browser_type: 'ページへの入力', mcp__browser__browser_take_screenshot: 'スクリーンショットの撮影', mcp__browser__browser_snapshot: 'ページの読み取り', mcp__browser__browser_evaluate: 'ページの読み取り', read_image: 'スクリーンショットの確認' },
  toolUsing: (service) => `${service}の使用`,
  toolFallback: '作業',
  oauth: {
    service: 'サービス', connected: (name) => `${name}を接続しました`, notConnected: '接続できませんでした',
    goBack: 'アプリに戻ってください。', tryAgain: 'アプリに戻って、もう一度「接続」をタップしてください。',
  },
  play: { done: '完了', back: 'アプリに戻ってください。', failed: 'この画面を開けませんでした。', opening: '開いています…' },
  legal: {
    aiCompany: 'AI提供元', aiModel: 'モデル', hostingProvider: 'ホスティング事業者', itsPolicy: 'プライバシーポリシー',
    privacyTitle: 'プライバシーポリシー',
    privacy: (c: LegalCtx) => `<h1>プライバシーポリシー</h1><p class="muted">Boop · ${c.operator} · 更新日：${c.updated}</p>
<p>Boopはスマートフォンで使うアシスタントです。ログインすると、アシスタントがあなたのために作業するクラウド上のコンピューターをアカウントに割り当てます。このページでは、どのようなデータが私たちを経由し、誰が受け取り、どのくらいの期間保管され、どうすれば削除できるのかを説明します。</p>
<h2>保管するもの</h2><ul>
<li><b>アカウント</b>：メールアドレス（Sign in with Appleの場合は、Appleから提供されるユーザー識別子とメールアドレス）、アカウント番号、ログイントークンのハッシュ値。</li>
<li><b>コンピューター上の内容</b>：チャット、アシスタントが覚えたあなたに関すること、作成したファイル、リマインダーと目標、あなたのために作った画面、接続したサービスのログイン情報、ブラウザのデータ。これらはすべて、あなたのアカウント専用のクラウド上のコンピューターに保存され、他のアカウントからは見えません。</li>
<li><b>通知</b>：通知を送るための、スマートフォンのプッシュトークン。</li>
<li><b>通報</b>：通報した返信の文面または画面のコード、あなたのメモ、アカウント番号。</li>
<li><b>サーバーログ</b>：問題の修正と不正利用の防止のための、リクエスト時刻とアカウント番号。</li></ul>
<p>広告はありません。第三者による分析や追跡もなく、データを販売することもありません。</p>
<h2>AI提供元に送られるもの</h2>
<p>同意すると、あなたのメッセージ、アシスタントがタスクのために読み取るファイルとウェブページ、あなたについて覚えている内容が<b>${c.company}</b>${c.policy}に送信されます。${c.company}は<b>${c.model}</b>を実行して返信を書きます。アプリは最初のメッセージの前に確認します。同意はアプリの「設定 → AI提供元」でいつでも撤回でき、撤回後は何も送信されません。${c.filter ? `返信は<b>${c.filter}</b>のモデレーションサービスでも確認され、問題があると判定された返信は非表示になります。` : ''}</p>
<h2>その他のデータの受け取り先</h2><ul><li>${c.hosting}：私たちのサーバーと、あなたのクラウド上のコンピューターを運用します。</li><li>AppleとGoogle：通知を配信します。</li><li>あなたが自分で接続するサービス（NotionやGmailなど）：あなたの依頼に応じてアシスタントが使用します。各サービスの規約が適用されます。</li></ul>
<p>これらの受け取り先は、上記の機能を提供する目的でのみデータを処理します。また、少なくとも本ポリシーと同等にデータを保護するよう求めています。</p>
<h2>保管期間と削除</h2>
<p>データはアカウントを削除するまで保管します。削除はアプリ（設定 → アカウントを削除）またはウェブの<a href="${c.hostUrl}/account/delete">${c.hostUrl}/account/delete</a>で行えます。削除すると、クラウド上のコンピューターとそのディスク、アカウントの記録、通報を直ちに削除します。ホスティング事業者の毎日のディスクスナップショットは5日以内に失効します。法律で義務付けられている場合を除き、他には何も保管しません。</p>
<h2>自分のコンピューターを使う場合</h2><p>アプリを自分のコンピューターに接続すると、データはそのコンピューターにとどまり、私たちには届きません。届くのは、あなたが送ることを選んだ通報だけです。</p>
<h2>セキュリティ</h2><p>すべての通信はHTTPSで行われます。ログイントークンはハッシュ値としてのみ保存されます。各アカウントのコンピューターは互いに分離されています。</p>
<h2>年齢</h2><p>Boopは18歳以上の方を対象としています。</p>
<h2>お問い合わせ</h2><p>${c.contact}。ご自身のデータの閲覧、訂正、削除はいつでもご依頼いただけます。</p>
`,
    termsTitle: '利用規約',
    terms: (c: LegalCtx) => `<h1>利用規約</h1><p class="muted">Boop · ${c.operator} · 更新日：${c.updated}</p>
<h2>利用できる方</h2><p>18歳以上の方のみご利用いただけます。</p>
<h2>禁止事項</h2><p>アシスタントを使って、次のものを作成、保管、拡散しないでください：未成年者に関わる性的な内容や児童に対するあらゆる搾取、同意なく共有された私的な画像、脅迫・嫌がらせ・いじめ、保護された集団に対する憎悪、暴力・テロ・自傷を扇動または美化する内容、違法行為への具体的な手助け（武器、薬物、詐欺を含む）、マルウェア、他人へのなりすましや欺瞞、他者の知的財産権やプライバシーの侵害。</p>
<h2>通報と対応</h2><p>返信を長押しするか、画面のメニューから通報できます。通報には24時間以内に対応し、コンテンツの削除や非表示、画面のブロック、アカウントの停止や閉鎖を行うことがあります。</p>
<h2>AIは間違えることがあります</h2><p>返信はAIが書いており、誤りを含むことがあります。重要なことはご自身で確認してください。</p>
<h2>削除</h2><p>アカウントはアプリまたは<a href="${c.hostUrl}/account/delete">ウェブ</a>からいつでも削除できます。<a href="${c.hostUrl}/privacy${c.langQuery}">プライバシーポリシー</a>もご覧ください。</p>
<h2>お問い合わせ</h2><p>${c.contact}</p>`,
    deleteTitle: 'Boopアカウントの削除', deleted: '削除しました',
    deletedBody: 'そのメールアドレスのアカウントがあった場合は、クラウド上のコンピューター、ディスク、通報とともに削除しました（ホスティング事業者のディスクスナップショットは5日以内に失効します）。',
    wrongCode: 'アクセスコードが正しくありません。', tooMany: '試行回数が多すぎます。数分待ってください。',
    deleteBody: 'アカウント、クラウド上のコンピューターとその中のすべて（チャット、記憶、ファイル、画面、接続したサービス）、通報を、直ちに完全に削除します。アプリの「設定 → アカウントを削除」からも行えます。',
    emailPlaceholder: 'ログインに使うメールアドレス', codePlaceholder: 'アクセスコード', deleteButton: 'アカウントを削除', questions: 'お問い合わせ：',
    openBody: 'これはアシスタントがあなたのために作った画面です。Boopアプリで開きます。アプリが入っているスマートフォンでこのリンクをタップしてください。',
    openInBrowser: 'ブラウザでBoopを開く',
  },
}
