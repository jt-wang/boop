#!/usr/bin/env bash
# The Android shell's tests: JVM unit tests, then the instrumented ones on a device or emulator.
#   scripts/android-test.sh [serial]     (default: the only device adb sees; ANDROID_SERIAL works too)
# Installs the debug build and its test APK on that device (it replaces an installed io.jingtao.boop).
# ModuleOpenTest needs signed packages: the tip calculator in android/app/src/androidTest/module, signed once with
# a release key certified by root A (the bot's) and once by root B (another bot's), as src/ui.ts signs modules.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
[ $# -gt 0 ] && export ANDROID_SERIAL="$1"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
export JAVA_HOME="${JAVA_HOME:-/Applications/Android Studio.app/Contents/jbr/Contents/Home}"
NSH_BIN="${NSH_BIN:-$(command -v nsh || echo "$HOME/.local/bin/nsh")}"

"$ROOT/scripts/android-build.sh" --debug

OUT="$ROOT/android/app/build/generated/uiFixtures"
KEYS="$(mktemp -d)"
trap 'rm -rf "$KEYS"' EXIT
rm -rf "$OUT"; mkdir -p "$OUT/ui"
for who in a b; do
  "$NSH_BIN" keygen "$KEYS/root-$who" >/dev/null
  "$NSH_BIN" keygen "$KEYS/release-$who" >/dev/null
  "$NSH_BIN" certify --root "$KEYS/root-$who.secret" --key "$KEYS/release-$who.pub" --apps 'dev.deepseekbot.ui.*' --days 1 -o "$KEYS/release-$who.cert" >/dev/null
done
MOD="$ROOT/android/app/src/androidTest/module"
"$NSH_BIN" publish "$MOD" --key "$KEYS/release-a.secret" --cert "$KEYS/release-a.cert" -o "$OUT/ui/signed.nshpkg" --source-map none >/dev/null
"$NSH_BIN" publish "$MOD" --key "$KEYS/release-b.secret" --cert "$KEYS/release-b.cert" -o "$OUT/ui/foreign.nshpkg" --source-map none >/dev/null
cp "$KEYS/root-a.pub" "$OUT/ui/root.pub"
rm -rf "$MOD/.nsh"
ls -l "$OUT/ui"

cd "$ROOT/android"
./gradlew --quiet testDebugUnitTest
./gradlew --quiet connectedDebugAndroidTest
echo "results: android/app/build/reports/androidTests/connected/debug/index.html"
