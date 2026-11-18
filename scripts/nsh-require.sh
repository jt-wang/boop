# Sourced by the scripts that build Boop's apps. Boop is written against one NSH release, and the CLI and the framework
# have to come from the same install: with a framework from another version the typed email and access code never
# reached the sign-in fields (docs/ios.md). NSH_BIN and NSH_HOME override where that install is.
NSH_REQUIRED=0.4
NSH_BIN="${NSH_BIN:-$(command -v nsh || echo "$HOME/.local/bin/nsh")}"
[ -x "$NSH_BIN" ] || { echo "nsh not found; install NSH $NSH_REQUIRED: https://nsh.dev/docs/installation" >&2; exit 1; }
case "$("$NSH_BIN" --version 2>/dev/null)" in
  "nsh $NSH_REQUIRED."*) ;;
  *) echo "Boop needs NSH $NSH_REQUIRED and $NSH_BIN is $("$NSH_BIN" --version 2>&1). Install it: https://nsh.dev/docs/installation" >&2; exit 1 ;;
esac
NSH_HOME="${NSH_HOME:-$(cd "$(dirname "$(readlink -f "$NSH_BIN")")/.." && pwd)}"
