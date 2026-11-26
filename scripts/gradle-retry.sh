#!/usr/bin/env bash
# ./gradlew in a folder, once more with --refresh-dependencies --stacktrace (which says why: the HTTP status, TLS, a
# timeout) when it failed only because Gradle could not resolve a
# plugin or a dependency. A CI runner's lookup sometimes fails for an artifact that is there: 2026-11-26, Nightly's
# TailPocket build, "Plugin [id: 'org.jetbrains.kotlin.plugin.compose', version: '2.2.10'] was not found", the same
# pins that had built in the run before. Any other failure, a failed test or a compile error, fails at once.
# The second run is also --info, kept in a file: when it fails too, what Gradle logged about finding plugins and
# artifacts (each repository and URL it tried, and what each answered) is printed, then the end of the run; when it
# passes, only its end. One retry: a second failure fails, it is not tried a third time.
#   scripts/gradle-retry.sh <dir> <gradle args...>
#   scripts/gradle-retry.sh --self-test
set -uo pipefail
resolve='was not found in any of the following sources|Could not resolve |Could not GET |Could not HEAD |Could not download |Read timed out|Connection reset'
# --info lines about finding a plugin or an artifact
lookup='Resource missing|Resource not found|Failed to get resource|Performing HTTP|HTTP GET|HTTP HEAD|Response [0-9]{3}|Resolving plugin|[Pp]lugin marker|plugin request|Plugin \[id|Cached resource|repository|Could not|was not found|timed out|Connection reset|refused'

if [ "${1:-}" = --self-test ]; then
  t=$(mktemp -d); trap 'rm -rf "$t"' EXIT
  # a stand-in gradlew: says what $t/mode asks for, the first call only, and counts its calls
  cat > "$t/gradlew" <<'SH'
#!/usr/bin/env bash
d=$(dirname "$0"); n=$(( $(cat "$d/calls" 2>/dev/null || echo 0) + 1 )); echo $n > "$d/calls"; echo "$*" >> "$d/args"
case "$(cat "$d/mode"):$n" in
  resolve:1) echo "Plugin [id: 'x', version: '1'] was not found in any of the following sources:"; exit 1;;
  resolve-twice:*) echo "> Could not resolve all files for configuration ':app:debugRuntimeClasspath'."; echo "   > Could not resolve com.example:x:1."
    case "$*" in *--info*) echo "Resource missing. [HTTP GET: https://repo.example/x/x.gradle.plugin-1.pom]"; echo "Compiling with an unrelated line"; for i in $(seq 70); do echo "filler $i"; done;; esac; exit 1;;
  test:*) echo "> There were failing tests. See the report at: build/reports/tests/index.html"; exit 1;;
esac
exit 0
SH
  chmod +x "$t/gradlew"
  run() { echo "$1" > "$t/mode"; rm -f "$t/calls" "$t/args"; GRADLE_RETRY_WAIT=0 "$0" "$t" -q build > "$t/out" 2>&1; echo $?; }
  [ "$(run ok)" = 0 ] && [ "$(cat "$t/calls")" = 1 ] || { echo "self-test FAIL: a passing build did not pass in one run"; exit 1; }
  [ "$(run resolve)" = 0 ] && [ "$(cat "$t/calls")" = 2 ] || { echo "self-test FAIL: a failed plugin lookup was not run once more"; exit 1; }
  [ "$(sed -n 2p "$t/args")" = "-q build --refresh-dependencies --stacktrace --info" ] || { echo "self-test FAIL: the second run was not --refresh-dependencies --stacktrace --info"; exit 1; }
  [ "$(run resolve-twice)" != 0 ] && [ "$(cat "$t/calls")" = 2 ] || { echo "self-test FAIL: a lookup that failed twice did not fail after two runs"; exit 1; }
  grep -q 'Resource missing. \[HTTP GET: https://repo.example/x/x.gradle.plugin-1.pom\]' "$t/out" || { echo "self-test FAIL: a second failed lookup did not print what --info logged about it"; exit 1; }
  ! grep -q 'Compiling with an unrelated line' "$t/out" || { echo "self-test FAIL: a line about something else was printed from --info, not only the lookup lines"; exit 1; }
  grep -qx 'filler 70' "$t/out" || { echo "self-test FAIL: the end of the failed retry was not printed"; exit 1; }
  [ "$(run test)" != 0 ] && [ "$(cat "$t/calls")" = 1 ] || { echo "self-test FAIL: a failed test was run once more"; exit 1; }
  echo "self-test ok"; exit 0
fi

dir="${1:?dir}"; shift
log=$(mktemp); trap 'rm -f "$log"' EXIT
(cd "$dir" && ./gradlew "$@") 2>&1 | tee "$log"
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] && exit 0
grep -Eq "$resolve" "$log" || exit "$rc"
echo "::warning::Gradle could not resolve a plugin or dependency in $dir; once more with --refresh-dependencies --stacktrace"
sleep "${GRADLE_RETRY_WAIT:-30}"
info=$(mktemp); trap 'rm -f "$log" "$info"' EXIT
(cd "$dir" && ./gradlew "$@" --refresh-dependencies --stacktrace --info) > "$info" 2>&1
rc=$?
if [ "$rc" -ne 0 ]; then
  echo "::group::the retry failed too: what Gradle --info logged about finding plugins and artifacts"
  grep -E "$lookup" "$info" | head -400
  echo "::endgroup::"
fi
tail -n 60 "$info"
exit "$rc"
