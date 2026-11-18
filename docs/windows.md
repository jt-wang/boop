# Boop for Windows

The "I have my own PC" path without a terminal: download the build, unpack it once,
open `Boop.exe`, scan the code with your phone. The app runs the assistant on this PC and
shows the pairing code; your phone reaches it through TailPocket, from any network
([connection.md](connection.md)). Everything the assistant remembers lives in
`%LOCALAPPDATA%\DeepSeek Bot` (derived from `%USERPROFILE%\AppData\Local`), so the next
launch is the same assistant.

Windows 10 1809 or later, or Windows 11. A web view needs the WebView2 Runtime (it
comes with Windows 11 and with Microsoft Edge on Windows 10); Boop's window uses none.
The `.exe` is not signed: Windows SmartScreen asks before it opens the first time
(More info → Run anyway).

## What is in the zip

```
Boop\
  Boop.exe                     the NSH runtime (the window), with the app's icon
  nsh\bundle.nshc              the window's bytecode, nsh.json's window options and theme
  nsh\assets\...
  bot\
    node.exe                   Node 24.13.1 from nodejs.org (win-x64)
    src\  app\  package.json   the bot and its web client, as in the repo
    node_modules\              npm ci --omit=dev, pruned as in the Dockerfile
    vendor\tailpocket\         the phone connection, with the Windows helper
    qr.mjs                     the QR encoder the window runs
```

The build prints the sizes. Measured on `windows-latest` (2026-11-18): `Boop\` is
**441.4 MB**, `bot\node.exe` 87.2 MB, `bot\node_modules` 256.7 MB, and
`Boop-windows.zip` **146.7 MB**; `scripts/windows-build.ps1` took 71 s after the
dependencies were downloaded. The Mac bundle's numbers are in
[mac.md](mac.md#what-is-in-the-bundle). Node is bundled rather than downloaded on
first run: open it and it works, with no network step and no version to get wrong.

## How the window works

`windows/App.tsx` is a small NSH app. Its `nsh.json` declares **no capabilities**:
an app without them may do everything (nsh.dev/docs/sandbox-and-capabilities), which
is needed to run `bot\node.exe` from a directory known only at run time. The window
UI, the QR decoder and the supervisor are shared with the Mac app (`mac/src`). On
launch it:

1. Finds its own directory. NSH has no documented API for the app's directory and
   `process.run` takes a name or an absolute path, so it runs PowerShell once:
   `Get-CimInstance Win32_Process` for its parent process (this process, `Boop.exe`)
   gives the executable's path. The bot's home comes from `%USERPROFILE%\AppData\Local\DeepSeek Bot`,
   because a child's environment is only `PATH`, `HOME`, `USERPROFILE`, `SystemRoot`,
   `TEMP`, `TMP`, `TMPDIR`, `LANG` and `LC_*` — **not** `LOCALAPPDATA`
   (`windows/.nsh/types/process.d.ts:57`). Using `$env:LOCALAPPDATA` there made the app
   fail immediately on real Windows (2026-11-18). The Mac app uses `ps` instead
   ([mac.md](mac.md#how-the-window-works)).
2. Starts `bot\node.exe bot\src\main.ts --home %USERPROFILE%\AppData\Local\DeepSeek Bot
   --port 3850 --supervised` (`mac/src/supervisor.ts`): no shell and no `run.sh`. Paths are
   absolute argv entries, so spaces and Japanese characters in the user's name need no
   quoting. `--supervised` stands in for `DEEPSEEK_BOT_SUPERVISED=1`, which a child's
   environment cannot carry (`process.spawn` has no `env` option), so a model change exits
   and the window starts the bot again.
3. Reads the bot's stdout line by line; the line `tailpocket1:…` (src/main.ts
   `printPocketPairing`), or `http://<lan ip>:<port>/pair?code=<6 digits>` when the
   helper is missing (`printPairing`), makes the state *running*. The QR is drawn
   from the modules `bot\node.exe bot\qr.mjs <link>` prints (the same encoder as the
   terminal QR).
4. If the port is taken (`EADDRINUSE` on stderr), tries the next one at once. If the
   bot dies after it was running, starts it again after 1 s; if it dies before
   pairing, waits 1, 2, 4, 8 s and after the fifth failure says it could not start.
5. Quit stops the bot (`supervisor.stop()`, which ends the child's process tree) and
   asks the host to close the window. Closing the window ends the app and its child.

The watch-the-parent loop of `mac/bot/run.sh` is not needed: there is no shell between
the window and node, and NSH ends the process tree with the app.

The window shows the status in plain words, the QR, Copy code and Quit. On the plain
local network route it also shows the link and the six-digit code, with Copy link.
Nothing else: no paths, no commands. When it fails it shows a short reason under the
status; the full, timestamped story goes to `%LOCALAPPDATA%\DeepSeek Bot\boop-start.log`
(or `process.dataDir\boop-start.log` when there is no home yet).

## Build

Build on Windows. `nsh package --target windows` builds the runner for the machine it
is built on, and only Windows can embed the icon (nsh.dev/docs/packaging); a package
made on macOS or Linux keeps NSH's default icon and does not run here as a Windows
build. The GitHub Actions workflow does this on `windows-latest`:

```powershell
# nsh 0.5.1 from https://nsh.dev/docs/installation, Node 24 + npm, Go for TailPocket's helper
git clone https://github.com/jt-wang/tailpocket.git ..\tailpocket
cd ..\tailpocket; CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -trimpath -ldflags="-s -w" -tags ts_omit_ssh -o ..\boop\vendor\tailpocket\bin\tailpocket-host-windows-amd64.exe .\cmd\tailpocket-host
cd ..\boop
powershell -ExecutionPolicy Bypass -File scripts/windows-build.ps1
# → windows\.nsh\out\Boop\  and  windows\.nsh\out\Boop-windows.zip
```

Steps: `nsh package --target windows` (the window), `npm ci --omit=dev` into
`<build>\stage` with the Dockerfile's prune list, Node from
`https://nodejs.org/dist/v24.13.1/` checked against its `SHASUMS256.txt`, copy into
`Boop\bot`, check the layout, and zip the directory (`Boop\Boop.exe`, `Boop\nsh\bundle.nshc`,
`Boop\bot\node.exe`).

Run the same build on a Windows machine with `DEEPSEEK_BOT_WINDOWS_BUILD` to keep the
~1 GB of output elsewhere (default: `windows\.nsh`, ignored by git).

`nsh package` also writes `windows\.nsh\out\Boop.iss` and, when Inno Setup 6 is
installed (`winget install JRSoftware.InnoSetup`), `Boop-setup.exe`: a per-user installer
(no administrator rights) with a Start menu shortcut and an Installed apps entry. The
zip is the build the workflow uploads; adding `-setup.exe` is optional and makes an
installer that upgrades in place.

### CI

`.github/workflows/windows-build.yml` runs on `windows-latest` for pushes to
`windows-build` and by hand (`gh workflow run windows-build.yml --ref windows-build`).
It downloads NSH 0.5.1, builds TailPocket's Windows helper, runs
`scripts/windows-build.ps1`, and uploads two artifacts for 7 days:

| Artifact | What a download contains | Extract times |
| --- | --- | --- |
| `Boop-windows` | GitHub's wrapper zip holding one `Boop\` folder (`Boop\Boop.exe`, `Boop\nsh\...`, `Boop\bot\...`) | once |
| `Boop-windows-zip` | GitHub's wrapper zip holding the distributable `Boop-windows.zip` (for release use) | twice: once for the wrapper, then the inner zip is ready to hand out |

**For normal use download `Boop-windows`, not `Boop-windows-zip`.** Uploading the inner
zip alone made GitHub wrap it, so a download had to be extracted twice (2026-11-18 user
report). `Boop-windows` uploads the unpacked folder instead.

## Tests

```sh
cd mac && nsh test                 # supervisor (12) + window (9), headless; the supervisor is shared
cd windows && nsh check            # types
npm test                           # the bot; includes test/mac-qr.test.ts (qr.mjs)
```

The Windows app has no headless test of its own: its two platform pieces are
`locate` (PowerShell) and `launch` (`bot\node.exe`), and both need a Windows host with
a packaged bundle. The supervisor's Windows command is covered by
`mac/supervisor.test.ts` with an injected `launch`; packaging and the layout are
checked by the workflow.

## Run

Download the `Boop-windows` artifact, extract it **once**, and open `Boop\Boop.exe`.
(If you use the release `Boop-windows.zip` instead, extract it once — it already holds
the `Boop\` folder: do not extract an inner `Boop\` again.) Keep the window open;
closing it stops the assistant.

## Troubleshooting

**「アシスタントを起動できませんでした。Boopを終了して、もう一度開いてください。」
(the failed state).** The window could not start the bot: either it could not find its
own bundle/derive the home, or `bot\node.exe` failed to launch, or the bot exited five
times before printing a pairing code. Quit and reopen once. If it happens again, send us
the log — a short reason is now also shown under the status line.

**Where the log is, and what to send:**

```
%LOCALAPPDATA%\DeepSeek Bot\boop-start.log
```

If that file is missing (for example `USERPROFILE` was empty and no home could be derived),
look in the app's NSH data directory for `boop-start.log`. The log is a plain text file,
rewritten on each event, with timestamped lines for: the env values used, locate errors,
the launch command (paths only), spawn errors, every stdout/stderr line from the bot,
child exit codes, and phase changes. It contains no secrets. Please attach the whole file;
also tell us your Windows version (10 or 11), whether the username/path has spaces or
Japanese characters, and the exact message you saw.

Old builds (before 2026-11-18) have no log: the failure was caused by reading
`$env:LOCALAPPDATA` from a PowerShell child, which NSH does not forward. Upgrade to a
build with `Boop-windows` and retest before sending a log.
