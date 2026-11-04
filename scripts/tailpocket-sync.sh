#!/bin/sh
# Boop's local connection (docs/connection.md) needs TailPocket's built pieces. Until TailPocket publishes a release they
# come from a checkout: this copies the computer's helper for this machine into vendor/tailpocket/bin, and with
# `android` or `ios` builds and copies what that phone shell links. `helper` copies the computer's helper and nothing else,
# which is all an install needs (install.sh). TAILPOCKET_DIR says where the checkout is.
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
T="${TAILPOCKET_DIR:-$ROOT/../tailpocket}"
[ -d "$T/sdk/node" ] || { echo "no TailPocket checkout at $T: set TAILPOCKET_DIR" >&2; exit 1; }
case "$(uname -s)" in Darwin) OS=darwin ;; Linux) OS=linux ;; *) echo "unsupported system" >&2; exit 1 ;; esac
case "$(uname -m)" in arm64|aarch64) ARCH=arm64 ;; x86_64) ARCH=amd64 ;; *) echo "unsupported machine" >&2; exit 1 ;; esac
HELPER="tailpocket-host-$OS-$ARCH"
[ -x "$T/sdk/node/bin/$HELPER" ] || (cd "$T" && ./scripts/build-host.sh)
mkdir -p "$ROOT/vendor/tailpocket/bin"
cp "$T/sdk/node/bin/$HELPER" "$ROOT/vendor/tailpocket/bin/$HELPER"
if [ "${1:-}" = helper ]; then echo "helper: vendor/tailpocket/bin/$HELPER"; exit 0; fi
cp "$T/sdk/node/index.js" "$T/sdk/node/index.d.ts" "$T/sdk/node/package.json" "$T/LICENSE" "$T/NOTICE" "$ROOT/vendor/tailpocket/"
echo "helper: vendor/tailpocket/bin/$HELPER"
mkdir -p "$ROOT/mobile/src/tailpocket"
cp "$T/sdk/js/client.ts" "$T/sdk/js/nsh.ts" "$ROOT/mobile/src/tailpocket/"

for target in "$@"; do
  case "$target" in
    android)
      export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
      export JAVA_HOME="${JAVA_HOME:-/Applications/Android Studio.app/Contents/jbr/Contents/Home}"
      [ -f "$T/build/android/tailpocket-mobile.aar" ] || (cd "$T" && ./scripts/build-mobile.sh android)
      (cd "$T/sdk/android" && ./gradlew -q publish :tailpocket-nsh:assembleRelease)
      mkdir -p "$ROOT/android/app/libs" "$ROOT/android/tailpocket-m2/io/jingtao"
      cp "$T/sdk/android/tailpocket-nsh/build/outputs/aar/tailpocket-nsh-release.aar" "$ROOT/android/app/libs/tailpocket-nsh.aar"
      cp -R "$T/build/android/m2/io/jingtao/tailpocket" "$ROOT/android/tailpocket-m2/io/jingtao/"
      echo "android: android/app/libs/tailpocket-nsh.aar, android/tailpocket-m2"
      ;;
    ios)
      [ -d "$T/build/apple/TailPocketMobile.xcframework" ] || (cd "$T" && ./scripts/build-mobile.sh apple)
      [ -e "$T/sdk/apple/NSH/NativeShell.xcframework" ] || ln -s "${NSH_IOS_XCFRAMEWORK:-$HOME/.nsh/embed/ios/NativeShell.xcframework}" "$T/sdk/apple/NSH/NativeShell.xcframework"
      echo "ios: the project links $T/sdk/apple/NSH"
      ;;
    *) echo "unknown target $target" >&2; exit 1 ;;
  esac
done
