#!/usr/bin/env bash
# Uploads ios/build/export/DeepSeekBot.ipa to App Store Connect (TestFlight).
# Needs an App Store Connect API key (App Store Connect → Users and Access →
# Integrations → App Store Connect API → Team Keys; role App Manager or Admin):
#   ASC_KEY_ID=ABC123DEFG ASC_ISSUER_ID=xxxxxxxx-… ASC_KEY_PATH=/path/AuthKey_ABC123DEFG.p8 scripts/ios-upload.sh
# Or an Apple ID with an app-specific password (appleid.apple.com → Sign-In and Security):
#   ASC_APPLE_ID=you@example.com ASC_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx scripts/ios-upload.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# Keep the standalone command's upload default. CI invokes this script only for upload=true.
[ "${1:-}" != --upload ] || shift
IPA="${1:-$ROOT/ios/build/export/DeepSeekBot.ipa}"
[ -f "$IPA" ] || { echo "no .ipa at $IPA; run scripts/ios-build.sh archive first" >&2; exit 1; }
IPA="$(cd "$(dirname "$IPA")" && pwd)/$(basename "$IPA")"
KEY_DIR=""
cleanup() { [ -z "$KEY_DIR" ] || rm -rf "$KEY_DIR"; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [ -n "${ASC_KEY_ID:-}" ]; then
  : "${ASC_ISSUER_ID:?ASC_ISSUER_ID}" "${ASC_KEY_PATH:?ASC_KEY_PATH}"
  [[ "$ASC_KEY_ID" =~ ^[A-Za-z0-9]+$ ]] || { echo 'invalid ASC_KEY_ID' >&2; exit 2; }
  KEY_SOURCE="$(cd "$(dirname "$ASC_KEY_PATH")" && pwd)/$(basename "$ASC_KEY_PATH")"
  umask 077
  KEY_DIR="$(mktemp -d "${TMPDIR:-/tmp}/boop-upload-XXXXXX")"
  mkdir "$KEY_DIR/private_keys"
  cp "$KEY_SOURCE" "$KEY_DIR/private_keys/AuthKey_$ASC_KEY_ID.p8"
  export API_PRIVATE_KEYS_DIR="$KEY_DIR/private_keys"
  cd "$KEY_DIR"  # ./private_keys takes precedence over any old key in HOME.
  xcrun altool --validate-app "$IPA" --api-key "$ASC_KEY_ID" --api-issuer "$ASC_ISSUER_ID"
  xcrun altool --upload-app -f "$IPA" --api-key "$ASC_KEY_ID" --api-issuer "$ASC_ISSUER_ID"
elif [ -n "${ASC_APPLE_ID:-}" ]; then
  : "${ASC_APP_PASSWORD:?ASC_APP_PASSWORD}"
  xcrun altool --validate-app -f "$IPA" -t ios -u "$ASC_APPLE_ID" -p "$ASC_APP_PASSWORD"
  xcrun altool --upload-app -f "$IPA" -t ios -u "$ASC_APPLE_ID" -p "$ASC_APP_PASSWORD"
else
  echo "set ASC_KEY_ID/ASC_ISSUER_ID/ASC_KEY_PATH (API key) or ASC_APPLE_ID/ASC_APP_PASSWORD; see docs/ios.md" >&2
  exit 2
fi
echo "uploaded; it appears in App Store Connect → TestFlight after processing (usually 5–15 minutes)"
