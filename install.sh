#!/bin/sh
# Installs Boop on macOS or Linux (on Windows, inside WSL) from the latest release's files. Usage:
#   curl -fsSL https://raw.githubusercontent.com/jt-wang/boop/main/install.sh | sh
# Options (env): DEEPSEEK_BOT_DIR (default ~/boop), DEEPSEEK_BOT_RELEASE_URL.
set -eu

DIR="${DEEPSEEK_BOT_DIR:-$HOME/boop}"
URL="${DEEPSEEK_BOT_RELEASE_URL:-https://github.com/jt-wang/boop/releases/latest/download}"

need() { command -v "$1" >/dev/null 2>&1 || { echo "Boop needs $1. $2"; exit 1; }; }
need node "Install Node.js 24 or newer from https://nodejs.org"
need npm "It comes with Node.js: https://nodejs.org"
need curl "Install curl first."
need tar "Install tar first."
major="$(node -p 'process.versions.node.split(".")[0]')"
[ "$major" -ge 24 ] || { echo "Node.js $major found; Boop needs 24 or newer."; exit 1; }

case "$(uname -s)" in Darwin) OS=darwin ;; Linux) OS=linux ;; *) echo "Boop runs on macOS and Linux. On Windows, run this inside WSL."; exit 1 ;; esac
case "$(uname -m)" in arm64|aarch64) ARCH=arm64 ;; x86_64|amd64) ARCH=amd64 ;; *) echo "Boop has no build for $(uname -m)."; exit 1 ;; esac
FILE="boop-$OS-$ARCH.tgz"

if [ -e "$DIR" ] && [ -n "$(ls -A "$DIR" 2>/dev/null)" ] && [ ! -f "$DIR/.boop-release" ]; then
  echo "$DIR is not a Boop install, so it was left alone. Choose another folder with DEEPSEEK_BOT_DIR."; exit 1
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
curl -fsSL "$URL/$FILE" -o "$TMP/$FILE" || { echo "Could not download $URL/$FILE"; exit 1; }
tar xzf "$TMP/$FILE" -C "$TMP"

# Your assistant's memory and files live in ~/.deepseek-bot; this folder holds only code, so it can be replaced whole.
rm -rf "$DIR"
mkdir -p "$(dirname "$DIR")"
mv "$TMP/boop" "$DIR"
cd "$DIR"
npm ci --omit=dev --no-fund --no-audit

cat <<EOF

Installed Boop to $DIR

Start it (the terminal prints a QR code; scan it in the Boop app on your phone):

  cd $DIR && DEEPSEEK_API_KEY=sk-… npm start

Other models:  npm start -- --model <provider>/<model> --base-url <https://…/v1> --api-key-env <ENV_VAR>
Keep it running after logout:  see SETUP.md (launchd / systemd)
EOF
