#!/usr/bin/env bash
# Puts what the Xcode project needs next to it:
#   ios/DeepSeekBot/nsh/            the app from mobile/ (`nsh build --release`)
#   ios/Frameworks/NativeShell.xcframework → the NSH runtime's iOS framework
# Run before any xcodebuild; scripts/ios-build.sh calls it.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NSH_HOME="${NSH_HOME:-$HOME/.nsh}"
NSH_BIN="${NSH_BIN:-$(command -v nsh || echo "$HOME/.local/bin/nsh")}"
FRAMEWORK="${NSH_FRAMEWORK:-$NSH_HOME/embed/ios/NativeShell.xcframework}"

[ -x "$NSH_BIN" ] || { echo "nsh not found; install it from https://nsh.dev/docs/installation" >&2; exit 1; }
[ -d "$FRAMEWORK" ] || { echo "NativeShell.xcframework not found at $FRAMEWORK (set NSH_FRAMEWORK)" >&2; exit 1; }

echo "nsh build mobile → ios/DeepSeekBot/nsh"
rm -rf "$ROOT/ios/DeepSeekBot/nsh"
"$NSH_BIN" build "$ROOT/mobile" --release --out "$ROOT/ios/DeepSeekBot/nsh"
# Only what the app loads: bytecode, capabilities, assets, app.json. The JS and its map stay out of the .ipa.
rm -f "$ROOT/ios/DeepSeekBot/nsh/bundle.js" "$ROOT/ios/DeepSeekBot/nsh/bundle.js.map"

# NSH 0.3.0's framework has no TLS provider: the app never opens wss:// to a hosted computer (docs/ios.md). Its
# runtime has no ring symbols; one built from NSH main (longbridge/nsh#530) has them.
# (grep -c, not -q: under pipefail an early grep exit fails nm with SIGPIPE.)
if [ "$(nm "$FRAMEWORK/ios-arm64-simulator/NativeShell.framework/NativeShell" 2>/dev/null | grep -c ring_core || true)" = 0 ]; then
  echo "warning: $FRAMEWORK is the stock one, without the wss fix (docs/ios.md)" >&2
fi

mkdir -p "$ROOT/ios/Frameworks"
ln -sfn "$FRAMEWORK" "$ROOT/ios/Frameworks/NativeShell.xcframework"
echo "framework → $(readlink "$ROOT/ios/Frameworks/NativeShell.xcframework")"
ls "$ROOT/ios/DeepSeekBot/nsh"
