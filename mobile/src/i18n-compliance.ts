// [compliance] Copy for the screens the stores ask for: the age question,
// the AI-provider disclosure, reports, interfaces and their permissions, account deletion, the legal links.
import type { Lang } from './locale.ts'
import { es as esLocale } from './locales/es.ts'
import { ja as jaLocale } from './locales/ja.ts'
import { ko as koLocale } from './locales/ko.ts'
import { ru as ruLocale } from './locales/ru.ts'
import { zhHant as zhHantLocale } from './locales/zh-Hant.ts'

const complianceEn = {
    ageTitle: 'How old are you?', ageBody: 'Boop is for people aged 18 and over.', ageAdult: "I'm 18 or older", ageMinor: "I'm under 18", ageTerms: 'Continuing means you accept the terms of use, which say what it may not be used for.',
    adultsTitle: 'Boop is for adults', adultsBody: 'You said you are under 18, so this account cannot use the assistant.', adultsLeave: 'Unpair this phone',
    consentTitle: 'Before your first message',
    consentWho: (company: string, model: string) => `${company} runs ${model}, the model that writes the replies. Your messages go to ${company}.`,
    consentWhat: 'What is sent: what you write, files and web pages it reads for a task, and what it remembers about you.',
    consentFilter: (name: string) => `Replies are also checked by ${name}'s content filter.`,
    consentWhen: 'Nothing is sent until you agree. You can stop it any time in Settings → AI provider.',
    consentAgree: 'Agree and continue', consentNotNow: 'Not now', consentNeeded: 'It cannot answer without this. Agree when you are ready.',
    providerPolicy: (company: string) => `${company}'s privacy policy`, privacyPolicy: 'Privacy policy', terms: 'Terms of use',
    aiProvider: 'AI provider', aiProviderHint: 'Your messages, files and web pages it reads for a task, and its memory of you go to this provider to write replies.',
    aiModel: 'Model', aiCompany: 'Provider', aiFilter: 'Content filter', aiSince: 'Agreed', stopSharing: 'Stop sharing',
    stopSharingTitle: 'Stop sending messages to the AI provider?', stopSharingBody: 'The assistant stops answering and nothing more is sent. You can agree again later.',
    report: 'Report', copy: 'Copy', reportTitle: 'Report', reportReplyHint: 'The reply and your note go to the people who run Boop. They answer within 24 hours.',
    reportInterfaceHint: 'The interface, its code and your note go to the people who run Boop. They answer within 24 hours.',
    reasonHarmful: 'Harmful or unsafe', reasonSexual: 'Sexual content', reasonHate: 'Hateful or harassing', reasonViolence: 'Violent', reasonFalse: 'False or misleading', reasonOther: 'Something else',
    reportNote: 'Add a note (optional)', reportHide: 'Also hide this interface', reportSend: 'Send report', reportSent: 'Thanks for reporting', reportSentBody: 'We look at every report within 24 hours and remove what breaks the rules.', done: 'Done',
    filtered: 'This reply was hidden by the content filter.',
    interfaces: 'Interfaces', interfacesHint: 'Interfaces it built for you. Each one runs on its own and gets only what you allow.', noInterfaces: 'No interfaces yet. Ask for a calculator, a checklist or a quiz in the chat.',
    ifOpen: 'Open', ifHide: 'Hide', ifShow: 'Show again', ifHidden: 'Hidden', ifBlocked: 'Removed after a report', ifAnswered: 'Answered', ifCopyLink: 'Copy link', ifLinkCopied: 'Link copied', ifAllowed: 'Allowed',
    ifAsks: 'It can ask to', ifNoPermissions: 'It asks for nothing beyond its own screen.', ifHiddenToast: 'This interface is hidden.',
    permOpenUrl: 'Open links in your browser', permClipboard: 'Copy and paste', permPicker: 'Choose photos',
    permTitle: (title: string) => `“${title}” would like to`, permAllow: 'Allow', permDeny: "Don't allow",
    linkElsewhere: 'That link is for another account or computer.',
    deleteAccount: 'Delete account', deleteTitle: 'Delete your account?', deleteBody: 'This deletes your account, its cloud computer and everything on it: conversations, memory, files, interfaces and connected services. It cannot be undone.',
    deleteConfirm: 'Delete', deleteSure: 'Delete for good?', deleteSureBody: 'Your assistant and its computer are deleted now.', deleted: 'Your account was deleted.', aboutHeader: 'About',
}
export type ComplianceWords = typeof complianceEn
export const COMPLIANCE_STRINGS: Record<Lang, ComplianceWords> = {
  en: complianceEn,
  zh: {
    ageTitle: '你多大了？', ageBody: 'Boop 只面向 18 岁及以上的人。', ageAdult: '我已满 18 岁', ageMinor: '我未满 18 岁', ageTerms: '继续即表示你接受使用条款，条款写明了哪些用途不允许。',
    adultsTitle: 'Boop 只面向成年人', adultsBody: '你说你未满 18 岁，这个账号不能使用助理。', adultsLeave: '解除这部手机的配对',
    consentTitle: '发第一条消息之前',
    consentWho: (company: string, model: string) => `${company} 运行写回复的模型 ${model}。你的消息会发给 ${company}。`,
    consentWhat: '会发送：你写的内容、它为完成任务读取的文件和网页、它对你的记忆。',
    consentFilter: (name: string) => `回复还会经过 ${name} 的内容审核。`,
    consentWhen: '你同意之前什么都不发。随时可以在「设置 → AI 服务商」里停止。',
    consentAgree: '同意并继续', consentNotNow: '暂不', consentNeeded: '不同意的话它没法回答。准备好了再点同意。',
    providerPolicy: (company: string) => `${company} 的隐私政策`, privacyPolicy: '隐私政策', terms: '使用条款',
    aiProvider: 'AI 服务商', aiProviderHint: '你的消息、它为完成任务读取的文件和网页、它对你的记忆，会发给这个服务商来生成回复。',
    aiModel: '模型', aiCompany: '服务商', aiFilter: '内容审核', aiSince: '同意于', stopSharing: '停止发送',
    stopSharingTitle: '停止向 AI 服务商发送消息？', stopSharingBody: '助理会停止回答，之后不再发送任何内容。以后可以再同意。',
    report: '举报', copy: '复制', reportTitle: '举报', reportReplyHint: '这条回复和你的说明会发给 Boop 的运营者，他们在 24 小时内处理。',
    reportInterfaceHint: '这个界面、它的代码和你的说明会发给 Boop 的运营者，他们在 24 小时内处理。',
    reasonHarmful: '有害或不安全', reasonSexual: '色情内容', reasonHate: '仇恨或骚扰', reasonViolence: '暴力', reasonFalse: '虚假或误导', reasonOther: '其他',
    reportNote: '补充说明（可选）', reportHide: '同时隐藏这个界面', reportSend: '发送举报', reportSent: '谢谢你的举报', reportSentBody: '每条举报我们都会在 24 小时内查看，违反规则的内容会被删除。', done: '完成',
    filtered: '这条回复被内容审核隐藏了。',
    interfaces: '界面', interfacesHint: '它为你做的界面。每个界面单独运行，只能用你允许的东西。', noInterfaces: '还没有界面。在聊天里让它做个计算器、清单或小测验。',
    ifOpen: '打开', ifHide: '隐藏', ifShow: '重新显示', ifHidden: '已隐藏', ifBlocked: '因举报已移除', ifAnswered: '已回答', ifCopyLink: '复制链接', ifLinkCopied: '链接已复制', ifAllowed: '已允许',
    ifAsks: '它可以请求', ifNoPermissions: '它只用自己的界面，不请求别的。', ifHiddenToast: '这个界面已隐藏。',
    permOpenUrl: '在浏览器里打开链接', permClipboard: '复制和粘贴', permPicker: '选择照片',
    permTitle: (title: string) => `「${title}」想要`, permAllow: '允许', permDeny: '不允许',
    linkElsewhere: '这个链接属于另一个账号或另一台电脑。',
    deleteAccount: '删除账号', deleteTitle: '删除你的账号？', deleteBody: '这会删除你的账号、它的云端电脑和上面的一切：对话、记忆、文件、界面和连接的服务。不能恢复。',
    deleteConfirm: '删除', deleteSure: '确定永久删除？', deleteSureBody: '你的助理和它的电脑会立即删除。', deleted: '账号已删除。', aboutHeader: '关于',
  },
  'zh-Hant': zhHantLocale.compliance,
  es: esLocale.compliance,
  ko: koLocale.compliance,
  ja: jaLocale.compliance,
  ru: ruLocale.compliance,
}
