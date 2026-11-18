#!/usr/bin/env bash
# Puts what the Xcode project needs next to it:
#   ios/DeepSeekBot/nsh/            the app from mobile/ (`nsh build --release`)
#   ios/Frameworks/NativeShell.xcframework → the NSH runtime's iOS framework
# Run before any xcodebuild; scripts/ios-build.sh calls it.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
. "$ROOT/scripts/nsh-require.sh"
FRAMEWORK="${NSH_FRAMEWORK:-$NSH_HOME/embed/ios/NativeShell.xcframework}"

[ -d "$FRAMEWORK" ] || { echo "NativeShell.xcframework not found at $FRAMEWORK (set NSH_FRAMEWORK)" >&2; exit 1; }

echo "nsh build mobile → ios/DeepSeekBot/nsh"
rm -rf "$ROOT/ios/DeepSeekBot/nsh"
"$NSH_BIN" build "$ROOT/mobile" --release --out "$ROOT/ios/DeepSeekBot/nsh"
# Only what the app loads: bytecode, capabilities, assets, app.json. The JS and its map stay out of the .ipa.
rm -f "$ROOT/ios/DeepSeekBot/nsh/bundle.js" "$ROOT/ios/DeepSeekBot/nsh/bundle.js.map"

mkdir -p "$ROOT/ios/Frameworks"
ln -sfn "$FRAMEWORK" "$ROOT/ios/Frameworks/NativeShell.xcframework"
echo "framework → $(readlink "$ROOT/ios/Frameworks/NativeShell.xcframework")"
ls "$ROOT/ios/DeepSeekBot/nsh"
