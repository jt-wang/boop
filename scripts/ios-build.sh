#!/usr/bin/env bash
# Builds the iOS app.
#   scripts/ios-build.sh simulator   build for the simulator → ios/build/sim/DeepSeekBot.app
#   scripts/ios-build.sh device [id] build for an iPhone with your own Apple account; with a device id, install on it
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

if [ "$MODE" = device ] && ! sed -n 's/^DEVELOPMENT_TEAM *= *//p' "$ROOT/ios/Config/Signing.local.xcconfig" 2>/dev/null | grep -q .; then
  echo "set DEVELOPMENT_TEAM in ios/Config/Signing.local.xcconfig: copy Signing.local.xcconfig.example and fill it in (docs/ios.md)" >&2
  exit 2
fi

"$ROOT/scripts/ios-bundle.sh"

AUTH=()
SIGNING=()
if [ "$MODE" = archive ] && [ "${IOS_SIGNING_STYLE:-}" = Manual ]; then
  : "${IOS_TEAM_ID:?IOS_TEAM_ID}" "${IOS_PROFILE_UUID:?IOS_PROFILE_UUID}" "${IOS_SIGNING_IDENTITY:?IOS_SIGNING_IDENTITY}"
  : "${IOS_KEYCHAIN_PATH:?IOS_KEYCHAIN_PATH}" "${IOS_VERSION:?IOS_VERSION}" "${IOS_BUILD:?IOS_BUILD}" "${IOS_EXPORT_OPTIONS:?IOS_EXPORT_OPTIONS}"
  SIGNING=(CODE_SIGN_STYLE=Manual "DEVELOPMENT_TEAM=$IOS_TEAM_ID" "BOOP_BUNDLE_ID=io.jingtao.boop"
    "CODE_SIGN_IDENTITY=$IOS_SIGNING_IDENTITY" "PROVISIONING_PROFILE_SPECIFIER=$IOS_PROFILE_UUID"
    "OTHER_CODE_SIGN_FLAGS=--keychain \"$IOS_KEYCHAIN_PATH\"" "MARKETING_VERSION=$IOS_VERSION" "CURRENT_PROJECT_VERSION=$IOS_BUILD")
elif [ -n "${ASC_KEY_ID:-}" ]; then
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
  device)
    DEVICE="${2:-}"
    xcodebuild -project "$PROJECT" -scheme DeepSeekBot -configuration Debug \
      -destination "$( [ -n "$DEVICE" ] && echo "id=$DEVICE" || echo 'generic/platform=iOS' )" -derivedDataPath "$BUILD/derived" ${AUTH[@]+"${AUTH[@]}"} build | tail -5
    APP="$BUILD/derived/Build/Products/Debug-iphoneos/DeepSeekBot.app"
    if [ -n "$DEVICE" ]; then xcrun devicectl device install app --device "$DEVICE" "$APP"; else echo "→ $APP"; fi
    ;;
  archive)
    # Derived data and package caches stay in ios/build, on the checkout's disk, instead of ~/Library.
    ARCHIVE="$BUILD/DeepSeekBot.xcarchive"
    rm -rf "$ARCHIVE" "$BUILD/export"
    xcodebuild -project "$PROJECT" -scheme DeepSeekBot -configuration Release \
      -destination 'generic/platform=iOS' -archivePath "$ARCHIVE" -derivedDataPath "$BUILD/derived" \
      -clonedSourcePackagesDirPath "$BUILD/packages" -packageCachePath "$BUILD/package-cache" ${AUTH[@]+"${AUTH[@]}"} ${SIGNING[@]+"${SIGNING[@]}"} archive | tail -5
    # Whatever was compiled on this Mac must not carry its home folder to testers. The export signs the binary again.
    "$ROOT/scripts/android-scrub-home.sh" "$HOME" "$ARCHIVE/Products/Applications/DeepSeekBot.app/DeepSeekBot"
    xcodebuild -exportArchive -archivePath "$ARCHIVE" -exportOptionsPlist "${IOS_EXPORT_OPTIONS:-$ROOT/ios/ExportOptions.plist}" \
      -exportPath "$BUILD/export" ${AUTH[@]+"${AUTH[@]}"} | tail -5
    echo "→ $BUILD/export/DeepSeekBot.ipa"
    echo "upload: scripts/ios-upload.sh"
    ;;
  *) echo "usage: $0 [simulator|device [id]|archive]" >&2; exit 2 ;;
esac
