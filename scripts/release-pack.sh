#!/bin/sh
# Makes the computer-side release files, one per platform, from an exported tree. Each is what the server runs plus
# TailPocket's helper for that platform, so installing needs no clone and no Go; install.sh downloads the right one.
#   scripts/release-pack.sh <tree> <out dir>
# TAILPOCKET_HELPERS: the folder with tailpocket-host-<os>-<arch> (default ../tailpocket/sdk/node/bin, from its scripts/build-host.sh).
set -eu
TREE="$(cd "$1" && pwd)"; mkdir -p "$2"; OUT="$(cd "$2" && pwd)"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HELPERS="${TAILPOCKET_HELPERS:-$ROOT/../tailpocket/sdk/node/bin}"
VERSION="$(node -p "require('$TREE/package.json').version")"
for p in darwin-arm64 darwin-amd64 linux-arm64 linux-amd64; do
  [ -f "$HELPERS/tailpocket-host-$p" ] || { echo "no helper for $p in $HELPERS" >&2; exit 1; }
  S="$(mktemp -d)"
  mkdir -p "$S/boop"
  for f in bin src app vendor scripts package.json package-lock.json README.md SETUP.md LICENSE; do cp -R "$TREE/$f" "$S/boop/"; done
  rm -rf "$S/boop/vendor/tailpocket/bin"
  mkdir -p "$S/boop/vendor/tailpocket/bin"
  cp "$HELPERS/tailpocket-host-$p" "$S/boop/vendor/tailpocket/bin/"
  chmod 755 "$S/boop/vendor/tailpocket/bin/tailpocket-host-$p"
  echo "$VERSION" > "$S/boop/.boop-release"
  COPYFILE_DISABLE=1 tar czf "$OUT/boop-$p.tgz" -C "$S" boop
  rm -rf "$S"
  echo "$OUT/boop-$p.tgz"
done
