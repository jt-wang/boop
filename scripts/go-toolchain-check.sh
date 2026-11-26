#!/usr/bin/env bash
# The Go on PATH is the one a go.mod asks for: its `toolchain` line, else its `go` line. setup-go v5 picked the `go` line
# (1.27.1) over `toolchain go1.27.4` and every workflow went on with it; this fails a run where that happens again.
#   scripts/go-toolchain-check.sh <go.mod>
set -euo pipefail
mod="${1:?go.mod}"
want=$(sed -n 's/^toolchain \(go[0-9][0-9.a-z]*\)[[:space:]]*$/\1/p' "$mod" | head -1)
[ -n "$want" ] || want=go$(sed -n 's/^go \([0-9][0-9.a-z]*\)[[:space:]]*$/\1/p' "$mod" | head -1)
[ "$want" != go ] || { echo "go-toolchain-check: no toolchain or go line in $mod" >&2; exit 1; }
got=$(go env GOVERSION)
if [ "$got" != "$want" ]; then
  echo "go-toolchain-check: Go on PATH is $got, $mod asks for $want" >&2
  exit 1
fi
echo "go-toolchain-check: $got, as $mod asks"
