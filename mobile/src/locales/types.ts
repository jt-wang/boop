// The shape of one language's tables: en and zh live next to the code that uses them (i18n.ts, i18n-cm.ts, …), the
// other five in this folder. Only types are imported here, so these files load before those.
import type { BaseWords, CardWords, ChatWords, MainWords, ModuleWords, StopWords } from '../i18n.ts'
import type { ComplianceWords } from '../i18n-compliance.ts'
import type { CmWords, ServiceFallback, ServiceWords } from '../i18n-cm.ts'
import type { PlainWords } from '../plain.ts'
import type { ToolWords } from '../fold.ts'

export interface LocaleTables {
  base: BaseWords; stop: StopWords; main: MainWords; card: CardWords; chat: ChatWords; module: ModuleWords
  compliance: ComplianceWords; cm: CmWords; services: ServiceWords; serviceFallback: ServiceFallback
  plain: PlainWords; tools: ToolWords
}
