#!/bin/sh
# The bot inside "Boop.app" (Contents/Resources/bot/run.sh, put there by
# scripts/mac-build.sh next to node, src/, app/ and node_modules/). The window
# (mac/App.tsx) runs it through /bin/sh, the one executable the app declares.
#   run.sh bot [--port N]   start the bot; its home is ~/Library/Application Support/DeepSeek Bot
#   run.sh qr <link>        print the QR modules of <link>, one line of 0/1 per row
set -eu
BOT="$(cd "$(dirname "$0")" && pwd)"
BOT_HOME="$HOME/Library/Application Support/DeepSeek Bot"
cmd="${1:-bot}"
shift || true
case "$cmd" in
  bot)
    mkdir -p "$BOT_HOME"
    # The window starts the bot again when it exits, so a model change may exit instead of asking for a restart.
    export DEEPSEEK_BOT_SUPERVISED=1
    cd "$BOT"
    "$BOT/node" "$BOT/src/main.ts" --home "$BOT_HOME" "$@" &
    NODE=$!
    trap 'kill "$NODE" 2>/dev/null' TERM INT
    # The bot lives as long as the window: NSH ends the process group on Quit, but an app that
    # is killed or crashes leaves its children running (measured 2026-10-27: SIGTERM to the app,
    # bot still up with parent 1). So this script watches its parent, the app, and stops the bot
    # when it is gone (test/mac-run.test.ts).
    APP=$PPID
    while kill -0 "$APP" 2>/dev/null && kill -0 "$NODE" 2>/dev/null; do sleep 1; done
    kill "$NODE" 2>/dev/null
    wait "$NODE"
    ;;
  qr)
    exec "$BOT/node" "$BOT/qr.mjs" "$1"
    ;;
  *)
    echo "run.sh: unknown command $cmd" >&2
    exit 2
    ;;
esac
