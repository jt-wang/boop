// Test entry: the discover page alone, with a saved session.
import { mount, View } from 'nsh'
import { boot } from './src/state.ts'
import { DiscoverPage } from './src/discover.tsx'
function H() { boot().catch(() => {}); return <View class="flex-1 bg-background"><DiscoverPage onOpenThread={() => {}} /></View> }
mount(H)
