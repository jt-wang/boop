#!/usr/bin/env bash
# Uploads ios/build/export/DeepSeekBot.ipa to App Store Connect (TestFlight).
# Needs an App Store Connect API key (App Store Connect → Users and Access →
# Integrations → App Store Connect API → Team Keys; role App Manager or Admin):
#   ASC_KEY_ID=ABC123DEFG ASC_ISSUER_ID=xxxxxxxx-… ASC_KEY_PATH=/path/AuthKey_ABC123DEFG.p8 scripts/ios-upload.sh
# Or an Apple ID with an app-specific password (appleid.apple.com → Sign-In and Security):
#   ASC_APPLE_ID=you@example.com ASC_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx scripts/ios-upload.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IPA="${1:-$ROOT/ios/build/export/DeepSeekBot.ipa}"
[ -f "$IPA" ] || { echo "no .ipa at $IPA; run scripts/ios-build.sh archive first" >&2; exit 1; }

if [ -n "${ASC_KEY_ID:-}" ]; then
  : "${ASC_ISSUER_ID:?ASC_ISSUER_ID}" "${ASC_KEY_PATH:?ASC_KEY_PATH}"
  # altool looks for AuthKey_<id>.p8 in ./private_keys, ~/private_keys, ~/.private_keys or ~/.appstoreconnect/private_keys.
  mkdir -p "$HOME/.appstoreconnect/private_keys"
  [ -f "$HOME/.appstoreconnect/private_keys/AuthKey_$ASC_KEY_ID.p8" ] || cp "$ASC_KEY_PATH" "$HOME/.appstoreconnect/private_keys/AuthKey_$ASC_KEY_ID.p8"
  xcrun altool --validate-app -f "$IPA" -t ios --apiKey "$ASC_KEY_ID" --apiIssuer "$ASC_ISSUER_ID"
  xcrun altool --upload-app -f "$IPA" -t ios --apiKey "$ASC_KEY_ID" --apiIssuer "$ASC_ISSUER_ID"
elif [ -n "${ASC_APPLE_ID:-}" ]; then
  : "${ASC_APP_PASSWORD:?ASC_APP_PASSWORD}"
  xcrun altool --validate-app -f "$IPA" -t ios -u "$ASC_APPLE_ID" -p "$ASC_APP_PASSWORD"
  xcrun altool --upload-app -f "$IPA" -t ios -u "$ASC_APPLE_ID" -p "$ASC_APP_PASSWORD"
else
  echo "set ASC_KEY_ID/ASC_ISSUER_ID/ASC_KEY_PATH (API key) or ASC_APPLE_ID/ASC_APP_PASSWORD; see docs/ios.md" >&2
  exit 2
fi
echo "uploaded; it appears in App Store Connect → TestFlight after processing (usually 5–15 minutes)"
