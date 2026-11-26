#!/usr/bin/env bash
# The Android shell's tests: JVM unit tests, then the instrumented ones on a device or emulator.
#   scripts/android-test.sh [serial]     (default: the only device adb sees; ANDROID_SERIAL works too)
# Uninstalls io.jingtao.boop from that device first, with its data, then installs the debug build and its test APK.
# ModuleOpenTest needs signed packages: the tip calculator in android/app/src/androidTest/module, signed once with
# a release key certified by root A (the bot's) and once by root B (another bot's), as src/ui.ts signs modules.
#   scripts/android-test.sh --self-test   (the isolated test's verdict on recorded results; no device, no build)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# The isolated test's verdict from the instrumentation results its own run just wrote (<dir>/*.xml) and Gradle's exit
# code: 0 it ran and passed; 10 it ran and a case of its own failed (reported, not fatal); any other code fails the run
# as any other test would, among them 2 for: a results file that does not parse, an error of the run beside the cases
# (a suite's system-err), no results (an install, the runner or the device failed), other tests in them, no
# case of it, every case skipped, or Gradle failing while every case of it passed.
isolated_verdict() {  # <gradle rc> <results dir> <class>
  python3 -I - "$@" <<'PY'
import glob, sys, xml.etree.ElementTree as E
rc, d, cls = int(sys.argv[1]), sys.argv[2], sys.argv[3]
def stop(why): print(f"isolated test {cls}: {why}", file=sys.stderr); sys.exit(2)
files = glob.glob(f"{d}/*.xml")
if not files: stop(f"no test results (Gradle exit {rc}): it did not run")
try:
    roots = [E.parse(f).getroot() for f in files]
except (E.ParseError, OSError) as exc:
    stop(f"cannot read its test results: {exc}")
# an error of the run itself (the device, the runner) is written beside the cases, in a suite's own system-err
for root in roots:
    for suite in [root] if root.tag == "testsuite" else root.iter("testsuite"):
        for err in suite.findall("system-err"):
            if (err.text or "").strip(): stop("the run reported an error outside its cases: " + err.text.strip().splitlines()[0][:200])
cases = [tc for root in roots for tc in root.iter("testcase")]
others = sorted({tc.get("classname") for tc in cases} - {cls})
if others: stop(f"the results hold other tests: {', '.join(others)}")
ran = [tc for tc in cases if tc.find("skipped") is None]
if not ran: stop("the results hold no case of it that ran")
failed = [tc for tc in ran if tc.find("failure") is not None or tc.find("error") is not None]
if rc != 0 and not failed: stop(f"Gradle exit {rc} while every case of it passed: an install, the runner or the device failed")
sys.exit(10 if failed else 0)
PY
}

if [ "${1:-}" = --self-test ]; then
  t=$(mktemp -d); trap 'rm -rf "$t"' EXIT
  C=dev.deepseekbot.app.ListFlashTest
  case_() { echo "<testcase name=\"t$1\" classname=\"$2\" time=\"1\">$3</testcase>"; }
  check() {  # <name> <rc> <expected verdict> <case...>
    local n=$1 rc=$2 want=$3; shift 3; rm -rf "$t/r"; mkdir -p "$t/r"
    if [ $# -gt 0 ]; then { echo "<?xml version='1.0' encoding='UTF-8' ?><testsuite>"; printf '%s\n' "$@"; echo "</testsuite>"; } > "$t/r/TEST-x.xml"; fi
    set +e; isolated_verdict "$rc" "$t/r" "$C" 2>/dev/null; local got=$?; set -e
    case "$want:$got" in 0:0|10:10) ;; fatal:0|fatal:10) echo "self-test FAIL: $n: verdict $got, want one that fails the run"; exit 1;; fatal:*) ;;
      *) echo "self-test FAIL: $n: verdict $got, want $want"; exit 1;; esac
  }
  check "passed" 0 0 "$(case_ 1 $C '')"
  check "its own case failed" 1 10 "$(case_ 1 $C '<failure>AssertionError: x</failure>')"
  check "no results (install failed)" 1 fatal
  check "no results, Gradle passed" 0 fatal
  check "Gradle failed, every case passed" 1 fatal "$(case_ 1 $C '')"
  check "another test in the results" 1 fatal "$(case_ 1 $C '<failure>x</failure>')" "$(case_ 2 dev.deepseekbot.app.MainFlowTest '<failure>y</failure>')"
  check "every case skipped" 0 fatal "$(case_ 1 $C '<skipped/>')"
  check "results without a case" 1 fatal ""
  check "its own case failed and the run reported a device error" 1 fatal "$(case_ 1 $C '<failure>x</failure>')" "<system-err>Test run failed to complete. Instrumentation run failed due to Process crashed.</system-err>"
  check "its own case failed, an empty system-err" 1 10 "$(case_ 1 $C '<failure>x</failure>')" "<system-err/>"
  # a results file cut off mid-write, as when the runner dies: it does not parse, and that is no verdict on the test
  rm -rf "$t/r"; mkdir -p "$t/r"; printf '%s' "<?xml version='1.0' encoding='UTF-8' ?><testsuite><testcase name=\"t1\" classname=\"$C\"><failure>x" > "$t/r/TEST-x.xml"
  set +e; isolated_verdict 1 "$t/r" "$C" 2>/dev/null; got=$?; set -e
  case $got in 0|10) echo "self-test FAIL: a truncated results file: verdict $got, want one that fails the run"; exit 1;; esac
  echo "self-test ok"; exit 0
fi
[ $# -gt 0 ] && export ANDROID_SERIAL="$1"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
export JAVA_HOME="${JAVA_HOME:-/Applications/Android Studio.app/Contents/jbr/Contents/Home}"
. "$ROOT/scripts/nsh-require.sh"

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
# what the test runs below compile against, resolved first with scripts/gradle-retry.sh's one retry for a failed
# lookup; the test runs themselves are not retried, so a failing test fails once
"$ROOT/scripts/gradle-retry.sh" "$ROOT/android" --quiet assembleDebugAndroidTest compileDebugUnitTestSources
./gradlew --quiet testDebugUnitTest
# PushNotificationTest revokes the notification permission. If an earlier install already holds it, Android kills the
# app for the revoke, and the tests run inside that process (measured 2026-11-05: "Killing … permissions revoked").
# Gradle uninstalls the app after the run anyway, so nothing more is lost by doing it first.
"$ANDROID_HOME/platform-tools/adb" uninstall io.jingtao.boop >/dev/null 2>&1 || true
# Isolated tests run after the others and report, but their failure does not fail this script. Why each one is isolated
# and when that ends: .dev/RELEASING.md, "Isolated tests". Everything else fails the script as before.
ISOLATED=dev.deepseekbot.app.ListFlashTest
REPORTS="$ROOT/android/app/build/reports/androidTests"
RESULTS="$ROOT/android/app/build/outputs/androidTest-results"
rm -rf "$REPORTS/main" "$REPORTS/isolated" "$RESULTS/main" "$RESULTS/isolated"
./gradlew --quiet connectedDebugAndroidTest "-Pandroid.testInstrumentationRunnerArguments.notClass=$ISOLATED"
mv "$REPORTS/connected" "$REPORTS/main"
mv "$RESULTS/connected" "$RESULTS/main"
set +e
./gradlew --quiet connectedDebugAndroidTest "-Pandroid.testInstrumentationRunnerArguments.class=$ISOLATED"
rc=$?
isolated_verdict "$rc" "$RESULTS/connected/debug" "$ISOLATED"
verdict=$?
set -e
[ ! -d "$REPORTS/connected" ] || mv "$REPORTS/connected" "$REPORTS/isolated"
[ ! -d "$RESULTS/connected" ] || mv "$RESULTS/connected" "$RESULTS/isolated"
case $verdict in
  0) echo "isolated test passed: $ISOLATED" ;;
  10) msg="isolated test failed: $ISOLATED (does not fail the run; .dev/RELEASING.md, \"Isolated tests\")"
     if [ -n "${GITHUB_ACTIONS:-}" ]; then echo "::warning::$msg"; else echo "$msg" >&2; fi ;;
  *) echo "the isolated run of $ISOLATED did not give its own result (verdict $verdict); this fails the run" >&2; exit 1 ;;
esac
echo "results: android/app/build/reports/androidTests/main/debug/index.html, isolated/debug/index.html"
