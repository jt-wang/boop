#!/usr/bin/env bash
# After a failed device-test run: what the Boop process logged, and the crash buffer's entries for it, into one file.
#   scripts/android-logcat.sh <out.txt> [<raw.txt> <system_server pid>]   (the device: ANDROID_SERIAL, as
#     scripts/android-test.sh; with raw.txt, a saved `logcat -v threadtime` and that device's system_server pid)
#   scripts/android-logcat.sh --self-test
# Only Boop's lines: the main and system buffers' lines of a pid while it is Boop's, from system_server's
# ActivityManager "Start proc <pid>:io.jingtao.boop/…" or AndroidRuntime's "Process: io.jingtao.boop, PID: <pid>" from
# that pid, until system_server says it died or hands the pid to another process (the same text in any other line
# changes nothing). Boop is exactly io.jingtao.boop or its io.jingtao.boop:<name> processes, not
# io.jingtao.boop.test. A pid the log names no owner for is left out. A native crash's backtrace is logged by Android's
# crash reporter under its own pid: each of its tombstones (from "*** *** ***" on) is kept when the process names in
# its header ("Cmdline: …", ">>> … <<<") are Boop's, or, with no name, when its "pid:" was Boop's then. A
# backtrace's "BuildId: <40 hex>" keeps its first 12 characters, which still name the build: 40 hex characters read
# as a token to the privacy check. Nothing of other apps. Three tags of the test process are left out: FrameTracker
# (window names that read as an email), ImeTracker and TestRunner (long test names that read as a token); none says
# what the app did. The caller reads the file with scripts/shots-check.sh --text before it leaves the run.
set -euo pipefail

filter() {  # <raw> <out> <system_server pid>
python3 -I - "$1" "$2" "$3" <<'PY'
import re, sys
lines = open(sys.argv[1], encoding="utf-8", errors="replace").read().splitlines()
# threadtime: "MM-DD HH:MM:SS.mmm  PID  TID L TAG: text"
row = re.compile(r"^\d\d-\d\d \d\d:\d\d:\d\d\.\d+\s+(\d+)\s+\d+ [VDIWEFA] (.*?)\s*:( |$)(.*)")
dropped = {"FrameTracker", "ImeTracker", "TestRunner"}
def is_boop(name): return name == "io.jingtao.boop" or name.startswith("io.jingtao.boop:")
# A pid is Boop's from a trusted event that names it until one ends it. Trusted: a whole ActivityManager line from
# system_server's own pid (its "Start proc <pid>:<process>/<uid> for …", "Process <process> (pid <pid>) has died…" or
# "Killing <pid>:<process>/…"), and an AndroidRuntime line "Process: <process>, PID: <pid>" from that same pid. The
# same text quoted in any other line, tag or pid changes nothing. A pid Android hands to another process afterwards is
# not Boop's; a line of a pid whose owner the log does not say is left out.
system_pid = sys.argv[3]
start = re.compile(r"Start proc (\d+):([^/\s]+)/\S+ for .*")
died = re.compile(r"Process (\S+) \(pid (\d+)\) has died(: .*)?|Killing (\d+):[^/\s]+/\S+ .*")
header = re.compile(r"Process: ([^,\s]+), PID: (\d+)")
live, ever, keep = set(), set(), set()
# the crash reporter's tombstones, per reporter pid (from "*** *** ***" on): its lines, the process names its header
# gives ("Cmdline: …", ">>> … <<<"), and whether its "pid: …" was Boop's then; a header that names a process decides,
# the pid only when none does
blocks, open_block = [], {}
for i, l in enumerate(lines):
  m = row.match(l)
  if not m: continue
  pid, tag, text = m.group(1), m.group(2), m.group(4)
  system = pid == system_pid and tag == "ActivityManager"
  if system and (s := start.fullmatch(text)):
    (live.add if is_boop(s.group(2)) else live.discard)(s.group(1))
    if is_boop(s.group(2)): ever.add(s.group(1))
  if system and (d := died.fullmatch(text)):
    live.discard(d.group(2) or d.group(4))
  if tag == "AndroidRuntime" and (h := header.fullmatch(text)) and h.group(2) == pid:
    if is_boop(h.group(1)):
      if pid not in live and i > 0 and (pm := row.match(lines[i - 1])) and pm.group(1) == pid and "FATAL EXCEPTION" in pm.group(4):
        keep.add(i - 1)
      live.add(pid); ever.add(pid)
    else:
      live.discard(pid)
  if pid in live:
    if tag not in dropped: keep.add(i)
    continue
  if tag != "DEBUG": continue
  if text.startswith("*** *** ***"):
    open_block[pid] = {"lines": [], "names": set(), "pid_boop": False}
    blocks.append(open_block[pid])
  if pid not in open_block: continue
  blk = open_block[pid]
  blk["lines"].append(i)
  for n in re.findall(r"^Cmdline: (\S+)|>>> (\S+) <<<", text.strip()):
    blk["names"].add(n[0] or n[1])
  if (pl := re.match(r"pid: (\d+),", text.strip())) and pl.group(1) in live:
    blk["pid_boop"] = True
for blk in blocks:
  if (all(is_boop(n) for n in blk["names"]) if blk["names"] else blk["pid_boop"]):
    keep.update(blk["lines"])
kept = [re.sub(r"(BuildId: [0-9a-f]{12})[0-9a-f]+", r"\1", lines[i]) for i in sorted(keep)]
with open(sys.argv[2], "w", encoding="utf-8") as f:
  f.write(f"# io.jingtao.boop pids: {' '.join(sorted(ever, key=int)) or 'none found'}\n")
  f.write("\n".join(kept) + "\n")
print(f"{len(kept)} lines of {len(ever)} Boop process(es) to {sys.argv[2]}")
PY
}

if [ "${1:-}" = --self-test ]; then
  t=$(mktemp -d); trap 'rm -rf "$t"' EXIT
  # made-up log: Boop (3260) and another app (4100) both crash in native code; their reporters (3360, 4200) write
  # interleaved tombstones. Boop's backtrace stays, with its BuildId shortened; the other app's does not.
  hex=$(printf '%s' 3f2a9c1e7b4d 8a6f0e2c5b9d 1a7e4c3b8f6a 2d5c)
  python3 -I - "$t/raw.txt" "$hex" <<'PY'
import sys
hexid = sys.argv[2]
def r(pid, tag, text, lvl="F"): return f"11-26 17:40:01.234  {pid}  {pid} {lvl} {tag:<8}: {text}"
lines = [
  r(600, "ActivityManager", "Start proc 3260:io.jingtao.boop/u0a190 for top-activity", "I"),
  r(600, "ActivityManager", "Start proc 4100:com.example.other/u0a191 for service", "I"),
  r(3260, "ReactNativeJS", "the chat opened", "I"),
  r(3260, "libc", "Fatal signal 11 (SIGSEGV), code 1 (SEGV_MAPERR), fault addr 0x0 in tid 3301 (mqt_js), pid 3260 (io.jingtao.boop)"),
  r(4100, "libc", "Fatal signal 6 (SIGABRT) in tid 4100 (other), pid 4100 (com.example.other)"),
  r(3360, "DEBUG", "*** *** *** *** *** *** *** *** *** *** *** *** *** *** *** ***"),
  r(4200, "DEBUG", "*** *** *** *** *** *** *** *** *** *** *** *** *** *** *** ***"),
  r(3360, "DEBUG", "ABI: 'x86_64'"),
  r(4200, "DEBUG", "Cmdline: com.example.other"),
  r(3360, "DEBUG", "Cmdline: io.jingtao.boop"),
  r(4200, "DEBUG", "pid: 4100, tid: 4100, name: other  >>> com.example.other <<<"),
  r(3360, "DEBUG", "pid: 3260, tid: 3301, name: mqt_js  >>> io.jingtao.boop <<<"),
  r(4200, "DEBUG", "      #00 pc 0000000000012345  /system/lib64/libother.so (OTHER_FRAME)"),
  r(3360, "DEBUG", f"      #00 pc 000000000004a1b2  /data/app/~~Qx3Lw9Tz/io.jingtao.boop-Rm2Kd8Vs/lib/x86_64/libhermes.so (BOOP_FRAME) (BuildId: {hexid})"),
  # a package whose name starts with Boop's, its tombstone giving Boop's live pid: the name decides, so it is left out
  r(4300, "DEBUG", "*** *** *** *** *** *** *** *** *** *** *** *** *** *** *** ***"),
  r(4300, "DEBUG", "Cmdline: io.jingtao.boop.test"),
  r(4300, "DEBUG", "pid: 3260, tid: 3260, name: test  >>> io.jingtao.boop.test <<<"),
  r(4300, "DEBUG", "      #00 pc 0000000000054321  /system/lib64/libtest.so (PREFIX_FRAME)"),
  # the same event texts quoted elsewhere change nothing: in Boop's own log (3260 stays Boop's), under another tag of
  # system_server, under ActivityManager from an app's pid, and a crash header not from AndroidRuntime
  r(3260, "ReactNativeJS", "quoted: Process io.jingtao.boop (pid 3260) has died: fg TOP", "I"),
  r(600, "ActivityManager", "note: Process io.jingtao.boop (pid 3260) has died earlier", "I"),
  r(3260, "ReactNativeJS", "AFTER_QUOTE_LINE", "I"),
  r(600, "ActivityManager", "note: Start proc 5500:io.jingtao.boop/u0a190 for quoted", "I"),
  r(5500, "Quoted", "QUOTED_IN_SYSTEM_LINE", "I"),
  r(600, "PackageManager", "Start proc 5200:io.jingtao.boop/u0a190 for quoted", "I"),
  r(5200, "Quoted", "QUOTED_TAG_LINE", "I"),
  r(5100, "ActivityManager", "Start proc 5100:io.jingtao.boop/u0a190 for spoof", "I"),
  r(5100, "Spoof", "SPOOF_PID_LINE", "I"),
  r(5300, "Spoof", "Process: io.jingtao.boop, PID: 5300", "E"),
  r(5300, "Spoof", "HEADER_SPOOF_LINE", "I"),
  r(5400, "AndroidRuntime", "Process: io.jingtao.boop, PID: 5401", "E"),
  r(5400, "Spoof", "HEADER_OTHER_PID_LINE", "I"),
  # Boop's pid 3260 dies: its later lines, with no new start, are not Boop's
  r(600, "ActivityManager", "Process io.jingtao.boop (pid 3260) has died: fg TOP", "I"),
  r(3260, "Reused", "AFTER_DEATH_LINE", "I"),
  # Boop's pid 3270 goes to another app with no death line in between: from then on not Boop's
  r(600, "ActivityManager", "Start proc 3270:io.jingtao.boop/u0a190 for service", "I"),
  r(3270, "ReactNativeJS", "BOOP_3270_LINE", "I"),
  r(600, "ActivityManager", "Start proc 3270:com.example.reused/u0a192 for service", "I"),
  r(3270, "Reused", "REUSED_LINE", "I"),
  # a Java crash: AndroidRuntime's header from Boop's own pid, after the system lost track of it
  r(3280, "AndroidRuntime", "FATAL EXCEPTION: main", "E"),
  r(3280, "AndroidRuntime", "Process: io.jingtao.boop, PID: 3280", "E"),
  r(3280, "AndroidRuntime", "JAVA_CRASH_LINE", "E"),
  # a pid no event names: left out
  r(5000, "Unknown", "UNOWNED_LINE", "I"),
]
open(sys.argv[1], "w").write("\n".join(lines) + "\n")
PY
  filter "$t/raw.txt" "$t/out.txt" 600 >/dev/null
  grep -q 'Fatal signal 11' "$t/out.txt" || { echo "self-test FAIL: Boop's fatal signal left out"; exit 1; }
  grep -q 'BOOP_FRAME' "$t/out.txt" || { echo "self-test FAIL: Boop's native backtrace left out"; exit 1; }
  grep -q "BuildId: ${hex:0:12})" "$t/out.txt" || { echo "self-test FAIL: Boop's BuildId not shortened to 12 characters"; exit 1; }
  grep -q 'ABI:' "$t/out.txt" || { echo "self-test FAIL: the tombstone's lines before its Cmdline left out"; exit 1; }
  ! grep -q 'other' "$t/out.txt" || { echo "self-test FAIL: the other app's crash kept"; exit 1; }
  ! grep -q 'PREFIX_FRAME\|boop\.test' "$t/out.txt" || { echo "self-test FAIL: a package named like Boop's was kept"; exit 1; }
  grep -q 'AFTER_QUOTE_LINE' "$t/out.txt" || { echo "self-test FAIL: a death quoted in Boop's own log ended its pid"; exit 1; }
  grep -q 'BOOP_3270_LINE' "$t/out.txt" || { echo "self-test FAIL: Boop's second process left out"; exit 1; }
  grep -q 'FATAL EXCEPTION' "$t/out.txt" && grep -q 'JAVA_CRASH_LINE' "$t/out.txt" || { echo "self-test FAIL: Boop's Java crash left out"; exit 1; }
  ! grep -q 'QUOTED_TAG_LINE' "$t/out.txt" || { echo "self-test FAIL: a start quoted under another system tag made a pid Boop's"; exit 1; }
  ! grep -q 'QUOTED_IN_SYSTEM_LINE' "$t/out.txt" || { echo "self-test FAIL: a start quoted inside a system record made a pid Boop's"; exit 1; }
  ! grep -q 'SPOOF_PID_LINE' "$t/out.txt" || { echo "self-test FAIL: an app's ActivityManager line made a pid Boop's"; exit 1; }
  ! grep -q 'HEADER_SPOOF_LINE' "$t/out.txt" || { echo "self-test FAIL: a crash header not from AndroidRuntime made a pid Boop's"; exit 1; }
  ! grep -q 'HEADER_OTHER_PID_LINE' "$t/out.txt" || { echo "self-test FAIL: a crash header naming another pid made it Boop's"; exit 1; }
  ! grep -q 'AFTER_DEATH_LINE' "$t/out.txt" || { echo "self-test FAIL: a dead pid's later lines were kept as Boop's"; exit 1; }
  ! grep -q 'REUSED_LINE' "$t/out.txt" || { echo "self-test FAIL: a pid started as another app was kept as Boop's"; exit 1; }
  ! grep -q 'UNOWNED_LINE' "$t/out.txt" || { echo "self-test FAIL: a line of a pid of unknown owner was kept"; exit 1; }
  "$(dirname "$0")/shots-check.sh" --text "$t/out.txt" >/dev/null || { echo "self-test FAIL: the privacy check refused Boop's native crash"; exit 1; }
  # from a device: a stand-in adb whose logcat is the log above and whose pidof answers as $t/pidof says; without one
  # system_server pid the run fails and writes no log
  mkdir -p "$t/sdk/platform-tools"
  cat > "$t/sdk/platform-tools/adb" <<'SH'
#!/usr/bin/env bash
d=$(dirname "$0")/../..
case "$*" in
  *logcat*) cat "$d/raw.txt";;
  *pidof*) m=$(cat "$d/pidof"); [ "$m" = fail ] && exit 1; printf '%s\r\n' "$m";;
esac
SH
  chmod +x "$t/sdk/platform-tools/adb"
  for m in 600 fail "" "600 601" "60a"; do
    printf '%s' "$m" > "$t/pidof"; rm -f "$t/dev.txt"
    rc=0; ANDROID_HOME="$t/sdk" "$0" "$t/dev.txt" >/dev/null 2>&1 || rc=$?
    if [ "$m" = 600 ]; then
      [ $rc = 0 ] && grep -q BOOP_FRAME "$t/dev.txt" || { echo "self-test FAIL: the device run with one system_server pid did not keep Boop's lines"; exit 1; }
    else
      [ $rc != 0 ] && [ ! -e "$t/dev.txt" ] || { echo "self-test FAIL: the device run passed with pidof answering \"$m\""; exit 1; }
    fi
  done
  echo "self-test ok"; exit 0
fi

OUT="${1:?out.txt}"
if [ -n "${2:-}" ]; then filter "$2" "$OUT" "${3:?system_server pid}"; exit; fi
ADB="${ANDROID_HOME:-$HOME/Library/Android/sdk}/platform-tools/adb"
raw="$(mktemp)"; trap 'rm -f "$raw"' EXIT
"$ADB" logcat -d -b main,system,crash -v threadtime > "$raw"
sys_pid=$("$ADB" shell pidof system_server | tr -d '\r') || { echo "adb shell pidof system_server failed" >&2; exit 1; }
[[ "$sys_pid" =~ ^[0-9]+$ ]] || { echo "system_server pid not one number: '$sys_pid'" >&2; exit 1; }
filter "$raw" "$OUT" "$sys_pid"
