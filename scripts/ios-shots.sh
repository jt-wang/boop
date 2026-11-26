#!/usr/bin/env bash
# The iOS screenshot baseline and layout probe (ScreenshotsTests), on a default iPhone and on an iPhone SE, one
# simulator at a time: each is booted, the app uninstalled (the demo opens from the welcome screen), the test run, and
# the simulator shut down again. The test runs once in light and once in dark, the simulator's appearance set by simctl
# between them: XCUIDevice.appearance is ignored under xcodebuild on the iOS 26 runtime the public CI has (every dark
# state came out light there). The 20 captures go to <shots-dir>; then scripts/shots-check.sh reads them.
#   scripts/ios-shots.sh <default-udid> <se-udid> <shots-dir>
# Needs NSH_HOME (scripts/ios-bundle.sh). Nightly runs it on the public CI's macOS runner; locally, check that no other
# simulator or emulator is running first.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEFAULT="${1:?default iPhone udid}" SMALL="${2:?iPhone SE udid}" SHOTS="${3:?shots dir}"
DERIVED="$ROOT/ios/build/derived"
BUNDLE=io.jingtao.boop
mkdir -p "$SHOTS"
rm -f "$SHOTS"/ios-chat-*.png

"$ROOT/scripts/ios-bundle.sh" >/dev/null
xcodebuild -project "$ROOT/ios/DeepSeekBot.xcodeproj" -scheme DeepSeekBot -configuration Debug \
  -destination 'generic/platform=iOS Simulator' -derivedDataPath "$DERIVED" ARCHS=arm64 ONLY_ACTIVE_ARCH=NO \
  build-for-testing | tail -2
RUN="$(ls "$DERIVED"/Build/Products/*.xctestrun | head -1)"

status=0
for pass in default small; do
  udid=$DEFAULT; small=0
  if [ $pass = small ]; then udid=$SMALL; small=1; fi
  xcrun simctl boot "$udid" 2>/dev/null || true
  xcrun simctl bootstatus "$udid" -b >/dev/null
  for theme in light dark; do
    xcrun simctl uninstall "$udid" "$BUNDLE" || true
    xcrun simctl ui "$udid" appearance $theme
    result="$ROOT/ios/build/shots-$pass-$theme.xcresult"; rm -rf "$result"
    rc=0
    TEST_RUNNER_SHOTS="$SHOTS" TEST_RUNNER_SHOTS_SMALL=$small TEST_RUNNER_SHOTS_THEME=$theme xcodebuild test-without-building -xctestrun "$RUN" \
      -destination "id=$udid" -only-testing:DeepSeekBotUITests/ScreenshotsTests -collect-test-diagnostics never -resultBundlePath "$result" \
      > "$ROOT/ios/build/shots-$pass-$theme.log" 2>&1 || rc=$?
    grep -E "error:|Test Case .* (passed|failed)" "$ROOT/ios/build/shots-$pass-$theme.log" || true
    [ $rc = 0 ] || status=1
  done
  xcrun simctl ui "$udid" appearance light
  xcrun simctl shutdown "$udid" || true
done
exit $status
