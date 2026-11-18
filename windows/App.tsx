// DeepSeek Bot for Windows: one window that runs the assistant on this PC and shows
// the code a phone scans to pair. The bot (src/), Node and the app's files live beside
// Boop.exe (scripts/windows-build.ps1); the assistant's home is
// %LOCALAPPDATA%\DeepSeek Bot, so it remembers across launches.
import { mount } from 'nsh'
import { App, bundleResources } from './src/app.tsx'

mount(App, { locate: bundleResources })
