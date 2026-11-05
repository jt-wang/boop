// DeepSeek Bot for Mac: one window that runs the assistant on this Mac and shows
// the code a phone scans to pair. The bot (src/), Node and the app's files live
// inside the bundle (scripts/mac-build.sh); the assistant's home is
// ~/Library/Application Support/DeepSeek Bot, so it remembers across launches.
import { mount } from 'nsh'
import { App, bundleResources } from './src/app.tsx'

mount(App, { locate: bundleResources })
