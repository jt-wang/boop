# Boop for Mac

The "I have my own computer" path without a terminal: download the `.dmg`, open the app, scan the code with your phone. The app runs the assistant on your Mac and shows the pairing code; your phone reaches it through TailPocket, from any network (`docs/connection.md`). Everything the assistant remembers lives in `~/Library/Application Support/DeepSeek Bot`, so the next launch is the same assistant.

## What is in the bundle

```
Boop.app/Contents/
  MacOS/DeepSeekBot            the NSH runtime (the window)                       26 MB
  Resources/nsh/               the window's bytecode, capabilities.json, icon
  Resources/bot/
    node                       Node 24.13.1 from nodejs.org (darwin-arm64)       114 MB
    src/  app/  package.json   the bot and its web client, as in the repo
    node_modules/              npm ci --omit=dev, pruned as in the Dockerfile    231 MB
    run.sh  qr.mjs             mac/bot/: how the window starts the bot and gets the QR
```

On an Apple silicon Mac: the `.app` is **389 MB**, the `.dmg` **194–200 MB** (compressed; it varies between builds), `scripts/mac-build.sh` takes **40–45 s** with the Node tarball cached (25–30 s when the dependencies are reused too).

Node is bundled rather than downloaded on first run: 114 MB on disk is the price of "open it and it works" with no network step and no version to get wrong. The bot's own files plus dependencies are 231 MB after the prune the sandbox image already uses (DSH's optional speech and office packages and SDKs the web profile never loads).

## How the window works

`mac/App.tsx` is a small NSH app (`nsh.json` declares `process.execute: ["/bin/sh"]`, `fs` on its own data directory, the clipboard). On launch it:

1. Finds its own bundle. NSH gives an app no path to its resources, and `process.execute` accepts only exact names or absolute paths (not `${dataDir}`, measured), so the one executable the window runs is `/bin/sh`; the shell's `$PPID` is the app process, and `ps -o comm=` on it is `…/Boop.app/Contents/MacOS/DeepSeekBot`, from which `Contents/Resources` follows.
2. Starts `Resources/bot/run.sh bot --port 3850` (`mac/src/supervisor.ts`): `run.sh` runs the bundled `node src/main.ts --home "~/Library/Application Support/DeepSeek Bot"`.
3. Reads the bot's stdout line by line; the line `tailpocket1:…` (src/main.ts `printPocketPairing`), or `http://<lan ip>:<port>/pair?code=<6 digits>` when the helper is missing (`printPairing`), makes the state *running*. The QR is drawn from the modules `run.sh qr <link>` prints (`mac/bot/qr.mjs`, the same encoder as the terminal QR).
4. If the port is taken (`EADDRINUSE` on stderr), tries the next one at once. If the bot dies after it was running, starts it again after 1 s; if it dies before pairing, waits 1, 2, 4, 8 s and after the fifth failure says it could not start.
5. The bot lives exactly as long as the window. Quit (the button, ⌘Q, the close button) makes NSH end the child's process group. An app that is killed or crashes leaves its children alive (measured: SIGTERM to the app, bot still up with parent 1), so `run.sh` watches its parent and stops the bot when the app is gone (`test/mac-run.test.ts`).

The window shows the status in plain words, the QR, Copy code and Quit. On the plain local network route it also shows the link and the six-digit code, with Copy link. Nothing else: no paths, no commands, no logs.

No "start at login" toggle: NSH 0.3.0 has no login-item API (nothing in `nsh/desktop`, nothing in the docs), and a packaged NSH app ends when its window closes, so the app cannot live in the menu bar either. Keep the window open; `scripts/install-service.sh` remains the way to run the bot after logout.

## Build

```sh
scripts/mac-build.sh
# → mac/.nsh/out/Boop.app  and  mac/.nsh/out/Boop.dmg
DEEPSEEK_BOT_MAC_BUILD=/Volumes/Some\ Disk/build scripts/mac-build.sh   # 1.3 GB of output on another disk
```

Needs `nsh` 0.3.0, Node 24 with npm, and the Xcode command line tools (`codesign`, `hdiutil`). Steps: `nsh package --target macos` (the window), `npm ci --omit=dev` into `<build>/stage` with the Dockerfile's prune list and broken `.bin` symlinks removed (codesign stops on them), Node from `https://nodejs.org/dist/v24.13.1/` checked against its `SHASUMS256.txt` (cached in `~/Library/Caches/deepseek-bot-mac`), copy into `Contents/Resources/bot`, `codesign --force --deep --sign -`, `hdiutil create` with an `Applications` link in the image.

Apple silicon only for now: the bundled Node matches the building Mac's architecture (`darwin-x64` on an Intel Mac); NSH's macOS runtime is arm64.

## Tests

```sh
cd mac && nsh test                 # supervisor (10) + window (7), headless
npm test                           # includes test/mac-qr.test.ts (qr.mjs) and test/mac-run.test.ts (run.sh follows the app)
cd mac && nsh check                # types
```

Headless `nsh test` has no `process` module, so the supervisor takes an injected `spawn` (`mac/supervisor.test.ts`) and the window is opened on a state put in storage (`mac/window.fixture.tsx`).

The real window, with the real supervisor and bot, is checked by `mac/window.local.sh` (gitignored, with `window.local.test.tsx`, `dev.local.tsx` and `clip.local.tsx`; it needs a built bundle and uses the real home and clipboard). It runs the test on the AppKit development host (`nsh test --target macos`) and, from the shell around it:

- Copy link: the link the window copied equals `pairing.txt`. `nsh test` keeps a clipboard of its own (measured: `null` at the start while the Mac's held text, the Mac's unchanged after Copy link), so a second step runs `Clipboard.writeText` under `nsh run` and reads it back with `pbpaste`.
- Quit: every bundle process seen while the window ran (bot, `dsh web`, the browser tool dsh starts) is gone 4 s after Quit, while the test still runs. Checked after the test ended, a Quit that did nothing also passed, because closing the test's app ends them too; with the check inside the test, that Quit fails (`still running after Quit`).

`App.tsx` only mounts `src/app.tsx` with the bundle's location, so `dev.local.tsx` can mount the same app with a built bundle's.

