#!/bin/sh
# Overwrites a home folder, and an NSH checkout on another disk, inside a built file, in place and at the same length
# (test/android-scrub.test.ts).
#   scripts/android-scrub-home.sh <home> <file>...
set -eu
HOME_PATH="${1:-}"
[ "${#HOME_PATH}" -ge 2 ] && [ "${HOME_PATH#/}" != "$HOME_PATH" ] || { echo "android-scrub-home: not a home folder: '$HOME_PATH'" >&2; exit 2; }
shift
SCRUB_HOME="$HOME_PATH" perl -0777 -pi -e 'BEGIN { binmode(STDIN); binmode(STDOUT); $h = $ENV{SCRUB_HOME}; $r = "/" . ("x" x (length($h) - 1)) } s/\Q$h\E/$r/g; s{/Volumes/[ -~]*?(?=/nsh/)}{"/" . ("x" x (length($&) - 1))}ge' "$@"
