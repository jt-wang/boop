import { fileURLToPath } from 'node:url'
// Absolute path of the Playwright MCP command-line entry, shared by the
// in-process browser row (development) and the out-of-cell broker (the image).
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

export function playwrightMcpCli(): string {
  const require = createRequire(import.meta.url)
  return join(dirname(require.resolve('@playwright/mcp/package.json')), 'cli.js')
}

/** Playwright MCP's --config: the switches that keep the browser off the network until a page asks. */
export const CHROME_QUIET_CONFIG = fileURLToPath(new URL('./chrome-quiet.json', import.meta.url))
