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
need sed "Install sed first."
major="$(node -p 'process.versions.node.split(".")[0]')"
[ "$major" -ge 24 ] || { echo "Node.js $major found; Boop needs 24 or newer."; exit 1; }

case "$(uname -s)" in Darwin) OS=darwin ;; Linux) OS=linux ;; *) echo "Boop runs on macOS and Linux. On Windows, run this inside WSL."; exit 1 ;; esac
case "$(uname -m)" in arm64|aarch64) ARCH=arm64 ;; x86_64|amd64) ARCH=amd64 ;; *) echo "Boop has no build for $(uname -m)."; exit 1 ;; esac
FILE="boop-$OS-$ARCH.tgz"

not_boop() {
  echo "$DIR is not a Boop install, so it was left alone. Choose another folder with DEEPSEEK_BOT_DIR." >&2
  exit 1
}

case "$DIR" in /*) ;; *) DIR="./$DIR" ;; esac
NAME="$(basename "$DIR")"
case "$NAME" in /|.|..) not_boop ;; esac
PARENT="$(dirname "$DIR")"
mkdir -p "$PARENT"
PARENT="$(cd -P "$PARENT" && pwd -P)"
DIR="${PARENT%/}/$NAME"

if [ -e "$DIR" ] || [ -L "$DIR" ]; then
  if [ ! -d "$DIR" ] || [ -L "$DIR" ]; then not_boop; fi
  contents="$(ls -Aq "$DIR")"
  [ -z "$contents" ] || [ -f "$DIR/.boop-release" ] || not_boop
fi

TMP="$(mktemp -d "${PARENT%/}/.boop-install.XXXXXX")"
installed=false
move() { node -e 'require("node:fs").renameSync(process.argv[1], process.argv[2])' -- "$1" "$2"; }
cleanup() {
  if [ "$installed" = false ] && [ -d "$TMP/previous" ]; then
    if [ -e "$DIR" ] || [ -L "$DIR" ] || ! move "$TMP/previous" "$DIR"; then
      echo "Previous Boop install kept at $TMP/previous" >&2
      return
    fi
  fi
  rm -rf "$TMP"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

download() {
  curl -fsSL "$URL/$1" -o "$TMP/$1" || { echo "Could not download $URL/$1" >&2; exit 1; }
}
download "$FILE"
download SHA256SUMS
(cd "$TMP" && node --input-type=module - "$FILE" <<'JS'
import { createHash } from 'node:crypto'
import { createReadStream, readFileSync } from 'node:fs'

const file = process.argv[2]
const entries = readFileSync('SHA256SUMS', 'utf8').split(/\r?\n/)
  .map(line => /^(\S+) [ *](.+)$/.exec(line))
  .filter(entry => entry?.[2] === file)
if (entries.length !== 1 || !/^[a-f0-9]{64}$/i.test(entries[0][1])) {
  console.error(`SHA256SUMS has no unique valid checksum for ${file}`)
  process.exit(1)
}
const hash = createHash('sha256')
for await (const chunk of createReadStream(file)) hash.update(chunk)
if (hash.digest('hex') !== entries[0][1].toLowerCase()) {
  console.error(`SHA256 checksum mismatch for ${file}`)
  process.exit(1)
}
JS
)
tar xzf "$TMP/$FILE" -C "$TMP"
(cd "$TMP/boop" && npm ci --omit=dev --no-fund --no-audit)
START_DIR="$(printf '%s' "$DIR" | sed "s/'/'\\\\''/g")"

# Your assistant's memory and files live in ~/.deepseek-bot; this folder holds only code, so it can be replaced whole.
if [ -d "$DIR" ]; then move "$DIR" "$TMP/previous"; fi
move "$TMP/boop" "$DIR"
installed=true

cat <<EOF

Installed Boop to $DIR

Start it (the terminal prints a QR code; scan it in the Boop app on your phone):

  cd '$START_DIR' && DEEPSEEK_API_KEY=sk-… npm start

Other models:  npm start -- --model <provider>/<model> --base-url <https://…/v1> --api-key-env <ENV_VAR>
Keep it running after logout:  see SETUP.md (launchd / systemd)
EOF
