#!/usr/bin/env bash
# An Android emulator on a GitHub Linux runner for the nightly device tests (.github/workflows/nightly.yml): API 35,
# Google APIs, x86_64, a Pixel 6 screen (1080x2400 at 420 dpi), the same phone Herdr Anywhere's device CI uses.
# Animations off, light, font scale 1, read back before any test runs.
# Usage: scripts/ci-android-up.sh    then ANDROID_SERIAL=emulator-5554
set -euo pipefail
: "${ANDROID_HOME:?}" "${RUNNER_TEMP:?}"
echo 'KERNEL=="kvm", GROUP="kvm", MODE="0666", OPTIONS+="static_node=kvm"' | sudo tee /etc/udev/rules.d/99-kvm4all.rules >/dev/null
sudo udevadm control --reload-rules
sudo udevadm trigger --name-match=kvm
image="system-images;android-35;google_apis;x86_64"
bin="$ANDROID_HOME/cmdline-tools/latest/bin"
{ yes || true; } | "$bin/sdkmanager" --licenses >/dev/null
"$bin/sdkmanager" --install platform-tools emulator "$image" >/dev/null
export ANDROID_AVD_HOME="$HOME/.android/avd"
mkdir -p "$ANDROID_AVD_HOME"
echo no | "$bin/avdmanager" create avd --force -n boop -k "$image" -d pixel_6 -p "$ANDROID_AVD_HOME/boop.avd" >/dev/null
nohup "$ANDROID_HOME/emulator/emulator" -avd boop -no-window -gpu swangle -noaudio -no-boot-anim -no-snapshot \
  >"$RUNNER_TEMP/emulator.log" 2>&1 &
adb="$ANDROID_HOME/platform-tools/adb"
end=$(($(date +%s) + 900))
until [ "$("$adb" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = 1 ]; do
  [ "$(date +%s)" -lt "$end" ] || { echo "FAIL: the emulator did not boot in 900 s"; tail -40 "$RUNNER_TEMP/emulator.log"; exit 1; }
  sleep 5
done
sleep 60
for s in window_animation_scale transition_animation_scale animator_duration_scale; do "$adb" shell settings put global $s 0; done
"$adb" shell settings put global hide_error_dialogs 1
"$adb" shell cmd uimode night no >/dev/null
"$adb" shell settings put system font_scale 1.0
size=$("$adb" shell wm size | tr -d '\r' | tail -1); dpi=$("$adb" shell wm density | tr -d '\r' | tail -1)
echo "booted: Android $("$adb" shell getprop ro.build.version.release | tr -d '\r'); $size, $dpi"
[ "$size" = "Physical size: 1080x2400" ] && [ "$dpi" = "Physical density: 420" ] || { echo "FAIL: not 1080x2400 at 420 dpi"; exit 1; }
