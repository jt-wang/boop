#!/usr/bin/env bash
# Builds the Android app: the shell in android/ (Gradle) around the app from mobile/.
#   scripts/android-build.sh [--host https://your-host] [--debug] → android/build/boop.apk
#   --host   the host "Start" signs in to; the shell passes it to the app as host.params.hostUrl.
#   --debug  a debuggable build (what the instrumented tests run against) instead of the release one.
# A release signs with the debug key unless given a keystore. Through the environment, so no password reaches a command line:
#   ORG_GRADLE_PROJECT_keystore=… ORG_GRADLE_PROJECT_keyAlias=… ORG_GRADLE_PROJECT_keystorePassword=… scripts/android-build.sh
# Puts in place (both gitignored):
#   android/app/src/main/assets/nsh/  the app (`nsh build mobile --release`): bytecode, capabilities, assets, app.json
#   android/app/libs/nsh.aar          ~/.nsh/embed/android/nsh.aar with each ABI's libnsh.so taken from the runtime
#                                     `nsh package` uses (~/.nsh/runtime/android/release/lib), where the wss fix lives
#                                     (docs/android.md). NSH_RUNTIME_LIBS overrides that directory.
# Needs ANDROID_HOME (default ~/Library/Android/sdk) with platforms;android-36, and a JDK 17+ (Android Studio's is
# used when JAVA_HOME is unset). Gradle 8.14.3 comes through the wrapper.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOST=""
VARIANT=release
while [ $# -gt 0 ]; do case "$1" in --host) HOST="$2"; shift 2;; --debug) VARIANT=debug; shift;; *) echo "unknown option $1" >&2; exit 2;; esac; done
if [ -n "$HOST" ]; then
  case "$HOST" in https://*) ;; *) echo "--host must be an https:// URL" >&2; exit 2;; esac
fi
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
export JAVA_HOME="${JAVA_HOME:-/Applications/Android Studio.app/Contents/jbr/Contents/Home}"
NSH_HOME="${NSH_HOME:-$HOME/.nsh}"
NSH_BIN="${NSH_BIN:-$(command -v nsh || echo "$HOME/.local/bin/nsh")}"
AAR="${NSH_AAR:-$NSH_HOME/embed/android/nsh.aar}"
LIBS="${NSH_RUNTIME_LIBS:-$NSH_HOME/runtime/android/release/lib}"
APP="$ROOT/android/app"

[ -x "$NSH_BIN" ] || { echo "nsh not found; install it from https://nsh.dev/docs/installation" >&2; exit 1; }
[ -f "$AAR" ] || { echo "nsh.aar not found at $AAR (set NSH_AAR)" >&2; exit 1; }

echo "nsh build mobile → android/app/src/main/assets/nsh"
rm -rf "$APP/src/main/assets/nsh"
"$NSH_BIN" build "$ROOT/mobile" --release --out "$APP/src/main/assets/nsh"
rm -f "$APP/src/main/assets/nsh/bundle.js" "$APP/src/main/assets/nsh/bundle.js.map"

echo "nsh.aar + libnsh.so from $LIBS → android/app/libs/nsh.aar"
mkdir -p "$APP/libs"
cp "$AAR" "$APP/libs/nsh.aar"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
for so in "$LIBS"/*/libnsh.so; do
  abi="$(basename "$(dirname "$so")")"
  mkdir -p "$WORK/jni/$abi"
  cp "$so" "$WORK/jni/$abi/libnsh.so"
  # The patched runtime was built on this Mac and holds its home folder and NSH checkout (test/android-scrub.test.ts).
  "$ROOT/scripts/android-scrub-home.sh" "$HOME" "$WORK/jni/$abi/libnsh.so"
  (cd "$WORK" && zip -q -0 "$APP/libs/nsh.aar" "jni/$abi/libnsh.so")
  echo "  $abi $(shasum -a 256 "$so" | cut -c1-12)"
done
# The stock AAR's arm64 library has no TLS provider: wss:// never opens (docs/android.md). Say so if that is what we got.
if unzip -p "$AAR" jni/arm64-v8a/libnsh.so | cmp -s - "$LIBS/arm64-v8a/libnsh.so"; then
  echo "warning: $LIBS/arm64-v8a/libnsh.so is the stock one, without the wss fix (docs/android.md)" >&2
fi

GRADLE_TASK="assemble$(tr '[:lower:]' '[:upper:]' <<< "${VARIANT:0:1}")${VARIANT:1}"
(cd "$ROOT/android" && ./gradlew --quiet "$GRADLE_TASK" -PhostUrl="${HOST%/}")
OUT="$ROOT/android/build/boop.apk"
mkdir -p "$ROOT/android/build"
cp "$APP/build/outputs/apk/$VARIANT/app-$VARIANT.apk" "$OUT"
echo "→ $OUT ($(du -h "$OUT" | cut -f1 | tr -d ' '))${HOST:+ (Start → $HOST)}"
