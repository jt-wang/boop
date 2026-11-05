// 한국어. Same shape as en.ts.
import { joinFacts, type LegalCtx } from './util.ts'
import type { ServerWords } from './en.ts'

export const ko: ServerWords = {
  lines: {
    remembered: (f) => `기억했어요: ${f}`,
    forgot: (n, q) => `“${q}”에 관한 기억 ${n}개를 잊었어요`,
    scheduled: (name, when) => `“${name}” 리마인더를 설정했어요: ${when}`,
    scheduleUpdated: (name, next) => `“${name}” 리마인더를 바꿨어요. 다음: ${next}`,
    scheduleDeleted: () => '리마인더를 삭제했어요',
    goalNew: (t) => `새 목표: ${t}`,
    goalUpdated: (t, what) => `목표 “${t}”: ${what || '업데이트됨'}`,
    built: (t) => `화면을 만들었어요: ${t}`,
    renamed: (n) => `이름을 ${n}(으)로 바꿨어요`,
    reminderFired: (n) => `리마인더 시간이 됐어요: ${n}`,
    connected: (n) => `${n} 연결됨`,
    ideas: (titles) => `새 아이디어 ${titles.length}개: ${titles.join('; ')}`,
    brief: (t) => `아침 브리핑: ${t}`,
    memoryUpdated: (facts) => `기억 업데이트: ${joinFacts(facts, '; ')}`,
    needsYes: (n) => `${n}에게 승인이 필요해요`,
    hasQuestion: (n) => `${n}에게 질문이 있어요`,
    done: (n) => `${n}이(가) 작업을 마쳤어요`,
    openToAnswer: '앱을 열어 답해 주세요',
    reminderDue: '시간이 됐어요.',
    assistant: '비서',
  },
  status: {
    working: '작업 중…', background: (what) => `백그라운드: ${what}…`, backgroundPrefix: '백그라운드:',
    readingResults: '결과 읽는 중…', modelBusy: '모델이 바빠서 다시 시도하는 중…', tidying: '채팅 정리 중…', thinking: '생각 중…',
    stepSep: ': ',
  },
  errors: {
    noKey: '아직 모델 키가 없어요. 이 비서를 운영하는 분이 키를 추가해야 해요.',
    keyRefused: '모델 키가 거부됐어요. 이 비서를 운영하는 분이 키를 교체해야 해요.',
    noCredit: '모델 계정의 크레딧이 떨어졌어요. 이 비서를 운영하는 분이 충전해야 해요.',
    busy: '모델이 몇 분째 바빠요. 다시 보내 주세요.',
    generic: '처리하지 못했어요. 모델에 연결할 수 없었어요. 다시 보내 주세요.',
  },
  tools: { bash: '명령 실행', pwsh: '명령 실행', read: '파일 읽기', write: '파일 쓰기', edit: '파일 수정', str_replace_editor: '파일 수정', fs_search: '파일 검색', grep: '파일 검색', glob: '파일 검색', web_search: '웹 검색', web_fetch: '웹페이지 읽기', present: '파일 준비', todo: '계획 업데이트', schedule_create: '리마인더 설정', schedule_update: '리마인더 변경', schedule_delete: '리마인더 삭제', schedule_list: '리마인더 확인', subagent: '하위 작업 처리', subagent_fork: '백그라운드로 옮기기', send_message: '백그라운드 작업에 전달', interrupt_agent: '백그라운드 작업 중지', list_agents: '백그라운드 작업 확인', skill: '스킬 사용', mcp__bot__remember: '기억하기', mcp__bot__forget: '잊기', mcp__bot__schedule_create: '리마인더 설정', mcp__bot__schedule_update: '리마인더 변경', mcp__bot__schedule_delete: '리마인더 삭제', mcp__bot__schedule_list: '리마인더 확인', mcp__bot__goal_set: '목표 설정', mcp__bot__goal_update: '목표 업데이트', mcp__bot__goal_list: '목표 확인', mcp__bot__notify: '알림 보내기', mcp__bot__set_my_name: '이름 바꾸기', mcp__bot__show: '카드 보여 주기', mcp__bot__ui: '화면 만들기', mcp__browser__browser_navigate: '웹페이지 열기', mcp__browser__browser_click: '페이지에서 클릭', mcp__browser__browser_type: '페이지에 입력', mcp__browser__browser_take_screenshot: '스크린샷 찍기', mcp__browser__browser_snapshot: '페이지 읽기', mcp__browser__browser_evaluate: '페이지 읽기', read_image: '스크린샷 보기' },
  toolUsing: (service) => `${service} 사용`,
  toolFallback: '처리 중',
  oauth: {
    service: '서비스', connected: (name) => `${name} 연결됨`, notConnected: '연결되지 않음',
    goBack: '이제 앱으로 돌아가도 돼요.', tryAgain: '앱으로 돌아가서 연결을 다시 눌러 주세요.',
  },
  play: { done: '완료', back: '이제 앱으로 돌아가도 돼요.', failed: '이 화면을 열 수 없어요.', opening: '여는 중…' },
  legal: {
    aiCompany: 'AI 제공업체', aiModel: '모델', hostingProvider: '호스팅 업체', itsPolicy: '해당 업체의 개인정보 처리방침',
    privacyTitle: '개인정보 처리방침',
    privacy: (c: LegalCtx) => `<h1>개인정보 처리방침</h1><p class="muted">Boop · ${c.operator} · ${c.updated} 업데이트</p>
<p>Boop은 휴대폰에서 쓰는 비서예요. 로그인하면 회원님의 계정에 클라우드 컴퓨터를 하나 드리고, 비서가 그 컴퓨터에서 회원님을 위해 일해요. 이 페이지에서는 어떤 데이터가 저희를 거치는지, 누가 받는지, 얼마나 보관하는지, 어떻게 삭제하는지 설명해요.</p>
<h2>보관하는 정보</h2><ul>
<li><b>계정</b>: 이메일 주소(Apple로 로그인하면 Apple이 제공하는 사용자 식별자와 이메일), 계정 번호, 로그인 토큰의 해시값.</li>
<li><b>컴퓨터에 있는 내용</b>: 대화, 비서가 회원님에 대해 기억하는 내용, 비서가 만든 파일, 리마인더와 목표, 비서가 만들어 준 화면, 연결한 서비스의 로그인 정보, 비서의 브라우저 데이터. 모두 회원님 계정 전용 클라우드 컴퓨터에 저장되고, 다른 계정은 볼 수 없어요.</li>
<li><b>알림</b>: 알림을 보내기 위한 휴대폰의 푸시 토큰.</li>
<li><b>신고</b>: 신고한 답변의 내용이나 화면의 코드, 회원님이 쓴 메모, 계정 번호.</li>
<li><b>서버 로그</b>: 문제 해결과 악용 방지를 위한 요청 시간과 계정 번호.</li></ul>
<p>광고도, 제3자 분석이나 추적도 없고, 데이터를 판매하지 않아요.</p>
<h2>AI 제공업체로 전송되는 내용</h2>
<p>동의하면 회원님의 메시지, 비서가 작업을 위해 읽은 파일과 웹페이지, 비서가 회원님에 대해 기억하는 내용이 <b>${c.company}</b>${c.policy}에 전송돼요. 이 업체가 <b>${c.model}</b>을(를) 실행해 답변을 작성해요. 앱은 첫 메시지를 보내기 전에 먼저 물어봐요. 앱의 설정 → AI 제공업체에서 언제든 철회할 수 있고, 철회하면 더 이상 아무것도 전송되지 않아요.${c.filter ? ` 답변은 <b>${c.filter}</b>의 콘텐츠 검토 서비스로도 확인하며, 문제가 있다고 표시된 답변은 숨겨져요.` : ''}</p>
<h2>그 밖에 데이터를 받는 곳</h2><ul><li>${c.hosting}: 저희 서버와 회원님의 클라우드 컴퓨터를 운영해요.</li><li>Apple과 Google: 알림을 전달해요.</li><li>회원님이 직접 연결한 서비스(예: Notion, Gmail): 비서가 회원님의 요청에 따라 사용하며, 해당 서비스의 약관이 적용돼요.</li></ul>
<p>이들은 이 기능을 제공하는 데 필요한 범위에서만 데이터를 처리하며, 저희는 이 방침 이상의 수준으로 데이터를 보호하도록 요구해요.</p>
<h2>보관 기간과 삭제</h2>
<p>데이터는 회원님이 계정을 삭제할 때까지 보관해요. 앱(설정 → 계정 삭제) 또는 웹 <a href="${c.hostUrl}/account/delete">${c.hostUrl}/account/delete</a>에서 삭제하면 클라우드 컴퓨터와 디스크, 계정 기록, 신고 내역을 즉시 삭제해요. 호스팅 업체의 일일 디스크 스냅샷은 5일 이내에 만료돼요. 법률에서 요구하는 경우를 제외하고 그 밖의 정보는 보관하지 않아요.</p>
<h2>회원님 소유의 컴퓨터</h2><p>앱을 회원님 소유의 컴퓨터에 연결하면 데이터는 그 컴퓨터에 남고 저희에게 전달되지 않아요. 회원님이 직접 보내기로 한 신고만 저희에게 전달돼요.</p>
<h2>보안</h2><p>모든 데이터는 HTTPS로 전송되고, 로그인 토큰은 해시값으로만 저장하며, 계정별 컴퓨터는 서로 분리되어 있어요.</p>
<h2>나이</h2><p>Boop은 만 18세 이상만 이용할 수 있어요.</p>
<h2>문의</h2><p>${c.contact}. 언제든 데이터 열람, 수정, 삭제를 요청할 수 있어요.</p>
`,
    termsTitle: '이용약관',
    terms: (c: LegalCtx) => `<h1>이용약관</h1><p class="muted">Boop · ${c.operator} · ${c.updated} 업데이트</p>
<h2>이용 대상</h2><p>만 18세 이상이어야 해요.</p>
<h2>금지 사항</h2><p>비서를 이용해 다음을 만들거나 보관하거나 퍼뜨리면 안 돼요: 미성년자가 등장하는 성적 콘텐츠나 모든 형태의 아동 착취, 동의 없이 공유된 사적인 이미지, 협박·괴롭힘·따돌림, 보호 대상 집단에 대한 혐오, 폭력·테러·자해를 부추기거나 미화하는 콘텐츠, 불법 행위에 대한 구체적인 도움(무기, 마약, 사기 포함), 악성 코드, 다른 사람을 사칭하거나 속이는 행위, 다른 사람의 지식재산권이나 개인정보 침해.</p>
<h2>신고와 조치</h2><p>답변을 길게 누르거나 화면의 메뉴를 사용해 신고할 수 있어요. 신고는 24시간 이내에 처리하며, 콘텐츠를 삭제하거나 숨기고, 화면을 차단하고, 계정을 정지하거나 해지할 수 있어요.</p>
<h2>AI는 실수할 수 있어요</h2><p>답변은 AI가 작성하므로 틀릴 수 있어요. 중요한 내용은 직접 확인해 주세요.</p>
<h2>삭제</h2><p>앱이나 <a href="${c.hostUrl}/account/delete">웹</a>에서 언제든 계정을 삭제할 수 있어요. <a href="${c.hostUrl}/privacy${c.langQuery}">개인정보 처리방침</a>도 함께 확인해 주세요.</p>
<h2>문의</h2><p>${c.contact}</p>`,
    deleteTitle: 'Boop 계정 삭제', deleted: '삭제 완료',
    deletedBody: '이 이메일로 된 계정이 있었다면 클라우드 컴퓨터, 디스크, 신고 내역과 함께 삭제됐어요(호스팅 업체의 디스크 스냅샷은 5일 이내에 만료돼요).',
    wrongCode: '접속 코드가 맞지 않아요.', tooMany: '시도 횟수가 너무 많아요. 몇 분 후에 다시 시도해 주세요.',
    deleteBody: '계정, 클라우드 컴퓨터와 그 안의 모든 것(대화, 기억, 파일, 화면, 연결된 서비스), 신고 내역이 즉시 영구 삭제돼요. 앱의 설정 → 계정 삭제에서도 할 수 있어요.',
    emailPlaceholder: '로그인에 쓰는 이메일', codePlaceholder: '접속 코드', deleteButton: '계정 삭제', questions: '문의:',
    openBody: '비서가 회원님을 위해 만든 화면이에요. Boop 앱에서 열려요. 앱이 설치된 휴대폰에서 이 링크를 눌러 주세요.',
    openInBrowser: '브라우저에서 Boop 열기',
  },
}
