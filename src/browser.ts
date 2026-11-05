// The assistant's own browser: a headless Chrome it drives through Playwright
// MCP (`@playwright/mcp`, pinned in package.json), mounted in the DSH profile
// patch as one more MCP server next to the bot tools. One browser for the whole
// bot; its profile lives under the bot home so logins survive restarts.
//
// In the image the browser is not in the cell. The bot starts the broker
// (src/browser-broker.ts) as uid 1001 outside the cell and the patch row is
// loopback HTTP MCP with a per-boot bearer. Outside the image (a laptop) the
// old stdio row is kept so development behaves as before.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { patchHooks, type HomeOptions } from './home.ts'
import { browserBrokerPatchYaml } from './browser-broker.ts'
import { CHROME_QUIET_CONFIG, playwrightMcpCli } from './playwright-mcp.ts'

export { CHROME_QUIET_CONFIG, playwrightMcpCli }

/** Where the browser keeps cookies, logins and local storage (laptop/stdio mode). */
export const browserProfileDir = (root: string) => join(root, 'browser-profile')
/** Where unnamed screenshots and page snapshots land (laptop/stdio mode). */
export const browserOutputDir = (root: string) => join(root, 'browser-output')

/** Tool results name each file the browser wrote by its absolute path, so the thread can tell it from a workspace file
 * of the same name. Relative links were relative to the browser's cwd. */
export const FILE_PATHS = ['--file-paths', 'absolute']

/** Patch rows that mount the browser, or '' when the config turns it off or no browser can launch. */
export function browserPatchYaml(ctx: { root: string; opts: HomeOptions }): string {
  if (ctx.opts.browser === false) return ''
  if (ctx.opts.browserBroker) return browserBrokerPatchYaml(ctx.opts.browserBroker)
  // In the image the browser is only reachable through the broker. Never fall
  // back to a stdio child running as the cell's uid.
  if (process.env.DEEPSEEK_BOT_IN_CONTAINER === '1') return ''
  const q = (s: string) => JSON.stringify(s)
  // DEEPSEEK_BOT_BROWSER_EXECUTABLE points at a Chromium binary where Google Chrome is not installed (the Docker image sets it).
  // The image ships without Chromium; until scripts/install-browser.sh has put it there, the browser is left out of the profile.
  const exe = process.env.DEEPSEEK_BOT_BROWSER_EXECUTABLE
  if (exe && !existsSync(exe)) return ''
  const args = [playwrightMcpCli(), ...(exe ? ['--browser', 'chromium', '--executable-path', exe, '--no-sandbox'] : ['--browser', 'chrome']), '--headless', '--user-data-dir', browserProfileDir(ctx.root), '--output-dir', browserOutputDir(ctx.root), '--viewport-size', '1280x720', '--config', CHROME_QUIET_CONFIG, ...FILE_PATHS]
  return `# The assistant's browser: headless Chrome through Playwright MCP, tools mcp__browser__*.
- insert:
    - id: bot-browser
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: browser
        transport: stdio
        command: ${q(process.execPath)}
        args: [${args.map(q).join(', ')}]
        cwd: ${q(join(ctx.root, 'workspace'))}
        toolCallTimeoutMs: 90000
        failOnStartupError: false
`
}

/** Register the browser rows with openHome. Idempotent. */
export function enableBrowser() {
  if (!patchHooks.includes(browserPatchYaml)) patchHooks.push(browserPatchYaml)
}
