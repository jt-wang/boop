#!/bin/sh
# Builds the phone app for the browser (the same NSH app the iOS shell runs) into app/,
# which the bot serves at /. Needs the nsh CLI (https://nsh.dev); the output is committed,
# so people who install from git or npm do not need nsh.
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
. "$ROOT/scripts/nsh-require.sh"
cd "$ROOT/mobile"
out="$(mktemp -d)"
"$NSH_BIN" package --target web -o "$out" "$PWD/App.tsx"   # absolute: nsh resolves the app directory from the entry path
dir="$(find "$out" -mindepth 1 -maxdepth 1 -type d | head -1)"
rm -rf ../app
cp -R "$dir" ../app
cp web/sw.js ../app/sw.js          # Web Push (web/host.js registers it)
node ../scripts/app-source-hash.ts > ../app/source.sha256   # what it was built from (test/app-fresh.test.ts fails when mobile/ moves on)
rm -rf "$out"
ls -la ../app
