#!/bin/sh
# Keep deepseek-bot running after logout and reboot.
#   macOS: a LaunchAgent in ~/Library/LaunchAgents
#   Linux: a systemd --user unit
# Usage: scripts/install-service.sh [extra args for `node src/main.ts`]
# Model keys are read from the environment at install time and stored in the service definition
# (DEEPSEEK_API_KEY, DEEPSEEK_BOT_MODEL_KEY). Re-run after changing them.
set -eu
DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node)"
ARGS="$*"
mkdir -p "$HOME/.deepseek-bot"

case "$(uname -s)" in
  Darwin)
    PLIST="$HOME/Library/LaunchAgents/com.deepseek-bot.plist"
    launchctl unload "$PLIST" 2>/dev/null || true
    cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.deepseek-bot</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>$DIR/src/main.ts</string>$(for a in $ARGS; do printf '<string>%s</string>' "$a"; done)</array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>$(dirname "$NODE"):/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
    <key>DEEPSEEK_API_KEY</key><string>${DEEPSEEK_API_KEY:-}</string>
    <key>DEEPSEEK_BOT_MODEL_KEY</key><string>${DEEPSEEK_BOT_MODEL_KEY:-}</string>
    <key>DEEPSEEK_BOT_SUPERVISED</key><string>1</string>
  </dict>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$HOME/.deepseek-bot/bot.log</string>
  <key>StandardErrorPath</key><string>$HOME/.deepseek-bot/bot.log</string>
</dict></plist>
EOF
    chmod 600 "$PLIST"
    launchctl load "$PLIST"
    echo "Installed. Logs: ~/.deepseek-bot/bot.log  Pairing link: ~/.deepseek-bot/pairing.txt"
    echo "Remove with: launchctl unload $PLIST && rm $PLIST"
    ;;
  Linux)
    UNIT_DIR="$HOME/.config/systemd/user"; mkdir -p "$UNIT_DIR"
    cat > "$UNIT_DIR/deepseek-bot.service" <<EOF
[Unit]
Description=deepseek-bot
After=network-online.target

[Service]
WorkingDirectory=$DIR
ExecStart=$NODE $DIR/src/main.ts $ARGS
Restart=always
RestartSec=3
Environment=DEEPSEEK_API_KEY=${DEEPSEEK_API_KEY:-}
Environment=DEEPSEEK_BOT_MODEL_KEY=${DEEPSEEK_BOT_MODEL_KEY:-}
Environment=DEEPSEEK_BOT_SUPERVISED=1

[Install]
WantedBy=default.target
EOF
    chmod 600 "$UNIT_DIR/deepseek-bot.service"
    systemctl --user daemon-reload && systemctl --user enable --now deepseek-bot
    echo "Installed. Logs: journalctl --user -u deepseek-bot -f   Pairing link: ~/.deepseek-bot/pairing.txt"
    echo "Linger so it runs without a login session: sudo loginctl enable-linger $USER"
    ;;
  *) echo "No service installer for $(uname -s); run 'npm start' under your process manager."; exit 1 ;;
esac
