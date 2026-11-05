#!/usr/bin/env bash
# Builds the iOS app.
#   scripts/ios-build.sh simulator   build for the simulator → ios/build/sim/DeepSeekBot.app
#   scripts/ios-build.sh archive     archive + export an App Store .ipa → ios/build/export/DeepSeekBot.ipa
# Signing is automatic for the team in ios/Config/Signing.local.xcconfig (docs/ios.md). Without an Apple ID signed in to
# Xcode, give xcodebuild an App Store Connect API key so it can make the
# provisioning profile itself:
#   ASC_KEY_ID=…  ASC_ISSUER_ID=…  ASC_KEY_PATH=/path/AuthKey_….p8  scripts/ios-build.sh archive
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MODE="${1:-simulator}"
PROJECT="$ROOT/ios/DeepSeekBot.xcodeproj"
BUILD="$ROOT/ios/build"

"$ROOT/scripts/ios-bundle.sh"

AUTH=()
if [ -n "${ASC_KEY_ID:-}" ]; then
  AUTH=(-allowProvisioningUpdates -authenticationKeyID "$ASC_KEY_ID" -authenticationKeyIssuerID "${ASC_ISSUER_ID:?ASC_ISSUER_ID}" -authenticationKeyPath "${ASC_KEY_PATH:?ASC_KEY_PATH}")
else
  AUTH=(-allowProvisioningUpdates)
fi

case "$MODE" in
  simulator)
    # Ad hoc signed (no account needed). Not CODE_SIGNING_ALLOWED=NO: without the
    # aps-environment entitlement the simulator refuses to register for push (measured 2026-10-27).
    # arm64 only: ~/.nsh/embed/ios/NativeShell.xcframework has no x86_64 simulator slice (nsh 0.3.0, measured
    # 2026-10-27: a generic simulator build fails with "Unable to resolve module dependency: 'NativeShell'").
    xcodebuild -project "$PROJECT" -scheme DeepSeekBot -configuration Debug \
      -destination 'generic/platform=iOS Simulator' -derivedDataPath "$BUILD/derived" ARCHS=arm64 ONLY_ACTIVE_ARCH=NO build | tail -3
    mkdir -p "$BUILD/sim"
    rm -rf "$BUILD/sim/DeepSeekBot.app"
    cp -R "$BUILD/derived/Build/Products/Debug-iphonesimulator/DeepSeekBot.app" "$BUILD/sim/"
    echo "→ $BUILD/sim/DeepSeekBot.app"
    echo "install: xcrun simctl install booted $BUILD/sim/DeepSeekBot.app && xcrun simctl launch booted io.jingtao.boop"
    ;;
  archive)
    ARCHIVE="$BUILD/DeepSeekBot.xcarchive"
    rm -rf "$ARCHIVE" "$BUILD/export"
    xcodebuild -project "$PROJECT" -scheme DeepSeekBot -configuration Release \
      -destination 'generic/platform=iOS' -archivePath "$ARCHIVE" "${AUTH[@]}" archive | tail -5
    xcodebuild -exportArchive -archivePath "$ARCHIVE" -exportOptionsPlist "$ROOT/ios/ExportOptions.plist" \
      -exportPath "$BUILD/export" "${AUTH[@]}" | tail -5
    echo "→ $BUILD/export/DeepSeekBot.ipa"
    echo "upload: scripts/ios-upload.sh"
    ;;
  *) echo "usage: $0 [simulator|archive]" >&2; exit 2 ;;
esac
