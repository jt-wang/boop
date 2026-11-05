#!/bin/sh
# Build "Boop.app" and "Boop.dmg": the NSH window (mac/), the bot
# (src/, app/, package.json, production node_modules) and a Node runtime, all
# inside the bundle. Output: mac/.nsh/out/. See docs/mac.md.
#
#   scripts/mac-build.sh            ad hoc signed: runs on this Mac (and on Macs that allow it in System Settings)
#   MAC_SIGN_IDENTITY="Developer ID Application: …" MAC_NOTARY_PROFILE=<notarytool keychain profile> scripts/mac-build.sh
#                                   signed + notarized, for download by anyone (needs the owner's Apple Developer account; untested here)
#
# Needs: nsh 0.3.0 (https://nsh.dev/docs/installation), Node 24 + npm (to install the bot's
# dependencies; the bundle gets its own Node), Xcode command line tools (codesign, hdiutil).
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# About 1.3 GB of build output; DEEPSEEK_BOT_MAC_BUILD puts it on another disk (default: mac/.nsh, ignored by git).
BUILD="${DEEPSEEK_BOT_MAC_BUILD:-$ROOT/mac/.nsh}"
OUT="$BUILD/out"
STAGE="$BUILD/stage"
CACHE="${DEEPSEEK_BOT_MAC_CACHE:-$HOME/Library/Caches/deepseek-bot-mac}"
NODE_VERSION="${NODE_VERSION:-24.13.1}"
case "$(uname -m)" in
  arm64) NODE_ARCH=darwin-arm64 ;;
  x86_64) NODE_ARCH=darwin-x64 ;;
  *) echo "unsupported architecture $(uname -m)" >&2; exit 1 ;;
esac
NODE_TGZ="node-v$NODE_VERSION-$NODE_ARCH.tar.gz"
APP="$OUT/Boop.app"
RES="$APP/Contents/Resources/bot"
DMG="$OUT/Boop.dmg"
T0=$(date +%s)

say() { printf '\n== %s\n' "$*"; }

say "1/6 the window (nsh package --target macos)"
rm -rf "$APP" "$DMG"
mkdir -p "$OUT"
( cd "$ROOT/mac" && nsh package --target macos --out "$OUT" )
test -d "$APP" || { echo "nsh package did not produce $APP" >&2; exit 1; }

say "2/6 the bot's dependencies (npm ci --omit=dev, pruned as in the Dockerfile)"
mkdir -p "$STAGE"
if [ -f "$STAGE/package-lock.json" ] && cmp -s "$ROOT/package-lock.json" "$STAGE/package-lock.json" && [ -d "$STAGE/node_modules" ]; then
  echo "reusing $STAGE/node_modules (package-lock.json unchanged)"
else
  rm -rf "$STAGE/node_modules"
  cp "$ROOT/package.json" "$ROOT/package-lock.json" "$STAGE/"
  ( cd "$STAGE" && npm ci --omit=dev --no-audit --no-fund )
  # Same list as the Dockerfile: DSH's optional speech/office packages and SDKs the web profile never loads.
  ( cd "$STAGE/node_modules" && rm -rf @deepseek-ai/libreoffice-kit-wasm @deepseek-ai/libreoffice-kit-*-* sherpa-onnx-* @img/sharp-wasm32 \
      @aws-sdk @smithy @octokit @google @anthropic-ai openai @opentelemetry @img )
  # codesign stops at a symlink whose target is gone (.bin/anthropic-ai-sdk after the prune, measured 2026-10-27).
  find "$STAGE/node_modules" -type l ! -exec test -e {} \; -delete
fi

say "3/6 Node $NODE_VERSION ($NODE_ARCH) from nodejs.org, checksum verified"
mkdir -p "$CACHE"
if [ ! -f "$CACHE/$NODE_TGZ" ]; then
  curl -fsSL -o "$CACHE/SHASUMS256.txt" "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt"
  curl -fsSL -o "$CACHE/$NODE_TGZ.part" "https://nodejs.org/dist/v$NODE_VERSION/$NODE_TGZ"
  ( cd "$CACHE" && grep " $NODE_TGZ\$" SHASUMS256.txt | sed "s/$NODE_TGZ/$NODE_TGZ.part/" | shasum -a 256 -c - )
  mv "$CACHE/$NODE_TGZ.part" "$CACHE/$NODE_TGZ"
fi
rm -rf "$STAGE/node" && mkdir -p "$STAGE/node"
tar -xzf "$CACHE/$NODE_TGZ" -C "$STAGE/node" --strip-components=1 "node-v$NODE_VERSION-$NODE_ARCH/bin/node" "node-v$NODE_VERSION-$NODE_ARCH/LICENSE"

say "4/6 the bot into the bundle"
mkdir -p "$RES"
cp -R "$ROOT/src" "$ROOT/app" "$RES/"
# TailPocket's helper for this Mac: how a phone reaches the assistant (docs/connection.md). Comes from scripts/tailpocket-sync.sh.
ls "$ROOT"/vendor/tailpocket/bin/tailpocket-host-darwin-* >/dev/null || "$ROOT/scripts/tailpocket-sync.sh"
cp -R "$ROOT/vendor" "$RES/"
cp "$ROOT/package.json" "$RES/"
cp -R "$STAGE/node_modules" "$RES/node_modules"
cp "$STAGE/node/bin/node" "$RES/node"
cp "$STAGE/node/LICENSE" "$RES/LICENSE-node"
cp "$ROOT/mac/bot/run.sh" "$ROOT/mac/bot/qr.mjs" "$RES/"
chmod +x "$RES/run.sh" "$RES/node"

say "5/6 signing"
if [ -n "${MAC_SIGN_IDENTITY:-}" ]; then
  # Developer ID + hardened runtime (Gatekeeper lets a download open after notarization). Untested without an account.
  codesign --force --deep --options runtime --timestamp --entitlements "$ROOT/mac/entitlements.plist" --sign "$MAC_SIGN_IDENTITY" "$APP"
else
  # Ad hoc: the seal covers the files added after `nsh package`; macOS opens it on this Mac, and
  # elsewhere after the person allows it (System Settings › Privacy & Security).
  codesign --force --deep --sign - "$APP"
fi
codesign --verify --deep --strict "$APP"

say "6/6 the disk image"
DMGROOT="$STAGE/dmg"
rm -rf "$DMGROOT" && mkdir -p "$DMGROOT"
cp -R "$APP" "$DMGROOT/"
ln -s /Applications "$DMGROOT/Applications"
hdiutil create -quiet -volname "Boop" -srcfolder "$DMGROOT" -ov -format UDZO "$DMG"
rm -rf "$DMGROOT"   # a second 389 MB copy of the app; not worth keeping (the build Mac's disk filled up once)
if [ -n "${MAC_SIGN_IDENTITY:-}" ] && [ -n "${MAC_NOTARY_PROFILE:-}" ]; then
  xcrun notarytool submit "$DMG" --keychain-profile "$MAC_NOTARY_PROFILE" --wait
  xcrun stapler staple "$DMG"
fi

say "done in $(( $(date +%s) - T0 )) s"
du -sh "$APP" "$RES/node" "$RES/node_modules" "$DMG"
echo "$APP"
echo "$DMG"
