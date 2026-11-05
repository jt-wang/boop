# SETUP.md — install Boop for someone

This uses the release files only: no clone and no build. It runs on macOS (Apple silicon or Intel), Linux, and Windows inside WSL. On a Mac with Apple silicon the person can instead download the Mac app, https://github.com/jt-wang/boop/releases/latest/download/Boop.dmg, which needs nothing else; it does not run on Intel Macs. Follow top to bottom. Stop and tell the person when a step says so.

## 1. Check the machine

On Windows, run every step inside WSL (Ubuntu); if it is not installed, the person runs `wsl --install` in an administrator PowerShell and restarts.

```sh
node -v        # must print v24 or higher
npm -v
```

If Node.js is older than 24, install it from https://nodejs.org (LTS) or with the person's package manager, then re-run the check.

## 2. Install it

```sh
curl -fsSL https://raw.githubusercontent.com/jt-wang/boop/main/install.sh | sh
cd ~/boop
```

This downloads the release file for this computer, TailPocket's helper included, and fetches the few packages the bot needs with `npm`. It takes a minute. With the helper the phone pairs once and reaches this computer from any network.

## 3. Choose a model

Ask the person which of these they have. Do not ask them to paste a key into the chat; have them export it in their shell.

- **DeepSeek official key** → they run `export DEEPSEEK_API_KEY=…` in the terminal that will start the bot. Nothing else to configure.
- **Any OpenAI-compatible endpoint** (a proxy, OpenRouter, Ollama, a local gateway) → note its base URL, a model id it serves, and the name of the environment variable holding its key. Start the bot once with:

  ```sh
  npm start -- --model <provider>/<model-id> --base-url <https://…/v1> --api-key-env <ENV_VAR_NAME>
  ```

  The choice is saved to `~/.deepseek-bot/config.json`; later starts need only `npm start`.

## 4. Start it

```sh
npm start
```

Expected output within ~20 seconds:

```
[bot] dsh web on http://127.0.0.1:NNNNN (loopback only)
[bot] listening to the assistant
<QR code>
  tailpocket1:…
```

If it prints `dsh web exited` or no pairing code, read the lines above it. The usual causes: Node.js below 24, or port 3850 taken (`npm start -- --port 3851`).

Check it is alive:

```sh
curl -s http://127.0.0.1:3850/health      # → {"ok":true,"dsh":true}
```

## 5. Hand over

Show the person the QR (the same text is saved in `~/.deepseek-bot/pairing.txt`). Tell them:

1. Open the Boop app on the phone and tap Scan the code.
2. Name the assistant.

They pair once; after that it works from any network. A code lasts 15 minutes, and a new one follows while no phone is paired. For another one sooner, press `p` then Enter in the terminal.

To use a phone's browser instead of the app, start with `npm start -- --host 0.0.0.0`. It prints a pairing URL to open on the same Wi-Fi, valid for 12 hours, over plain HTTP (`docs/connection.md`). Then Share → Add to Home Screen.

## 6. Keep it running (optional)

`scripts/install-service.sh` installs a launchd agent (macOS) or a systemd user unit (Linux) that keeps the bot up and restarts it; it reads `DEEPSEEK_API_KEY` / `DEEPSEEK_BOT_MODEL_KEY` from the environment at install time. Pass the same `--model …` flags you used for `npm start` as arguments. Or, by hand on macOS:

```sh
cat > ~/Library/LaunchAgents/com.deepseek-bot.plist <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.deepseek-bot</string>
  <key>ProgramArguments</key><array><string>$(which node)</string><string>$(pwd)/src/main.ts</string></array>
  <key>WorkingDirectory</key><string>$(pwd)</string>
  <key>EnvironmentVariables</key><dict><key>DEEPSEEK_API_KEY</key><string>${DEEPSEEK_API_KEY}</string></dict>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$HOME/.deepseek-bot/bot.log</string>
  <key>StandardErrorPath</key><string>$HOME/.deepseek-bot/bot.log</string>
</dict></plist>
EOF
launchctl load ~/Library/LaunchAgents/com.deepseek-bot.plist
tail -f ~/.deepseek-bot/bot.log     # the pairing URL appears here
```

Linux: a `systemd --user` unit with the same `ExecStart` and environment.

## 7. Notifications (optional)

Web Push needs HTTPS. Either start with `npm start -- --tunnel` (needs `cloudflared` on PATH; prints an `https://…trycloudflare.com` URL to pair with instead), or put the bot behind a reverse proxy with a certificate and pair through that address. Then the person turns on Notifications in the app's Settings.

## 8. Connectors (optional)

The assistant can use MCP servers the person adds from the app (Settings → Connectors): GitHub, Notion, Google Calendar, a folder on disk, or any custom server. Each preset names the environment variables it needs (for example `GITHUB_TOKEN`). Set them in the shell or service that runs the bot, restart the bot, and the connector comes up. Keys never go through the app or into files.

## 9. The assistant's browser

A headless Chrome with a persistent profile under `~/.deepseek-bot/browser-profile` is mounted automatically (`browser: true` in `config.json`). It needs Google Chrome installed on the computer (`channel: chrome`). Logins the assistant makes persist between sessions.

## 10. Build it yourself

A server behind HTTPS with Docker, Fly.io, the iPhone app and changes to the code all start from a clone: [docs/BUILD.md](docs/BUILD.md).
