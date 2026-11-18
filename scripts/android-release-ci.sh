#!/usr/bin/env bash
# The workflow supplies the existing release key only to this build step.
set -euo pipefail
: "${ANDROID_RELEASE_KEYSTORE:?missing release keystore}"
: "${ANDROID_RELEASE_PASSWORD:?missing release password}"
: "${ANDROID_RELEASE_KEY_ALIAS:?missing release alias}"
: "${RUNNER_TEMP:?RUNNER_TEMP}" "${ANDROID_HOME:?ANDROID_HOME}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
KEYSTORE="$RUNNER_TEMP/boop-release.jks"
umask 077
trap 'rm -f "$KEYSTORE"' EXIT
printf '%s' "$ANDROID_RELEASE_KEYSTORE" | base64 --decode > "$KEYSTORE"
export ORG_GRADLE_PROJECT_keystore="$KEYSTORE"
export ORG_GRADLE_PROJECT_keystorePassword="$ANDROID_RELEASE_PASSWORD"
export ORG_GRADLE_PROJECT_keyAlias="$ANDROID_RELEASE_KEY_ALIAS"
unset ANDROID_RELEASE_KEYSTORE ANDROID_RELEASE_PASSWORD ANDROID_RELEASE_KEY_ALIAS
"$ROOT/scripts/android-build.sh"
(cd "$ROOT/android" && ./gradlew --no-daemon --quiet testReleaseUnitTest)
APK="$ROOT/android/build/boop.apk"
OLD="$RUNNER_TEMP/boop-previous.apk"
curl --fail --location --silent --show-error https://github.com/jt-wang/boop/releases/download/v0.1.0/boop.apk -o "$OLD"
TOOLS="$ANDROID_HOME/build-tools/36.0.0"
"$TOOLS/apksigner" verify --verbose --print-certs "$OLD" > "$RUNNER_TEMP/boop-old-signature.txt"
"$TOOLS/apksigner" verify --verbose --print-certs "$APK" > "$RUNNER_TEMP/boop-new-signature.txt"
grep '^Signer #[0-9]* certificate SHA-256 digest:' "$RUNNER_TEMP/boop-old-signature.txt" > "$RUNNER_TEMP/boop-old-certs.txt"
grep '^Signer #[0-9]* certificate SHA-256 digest:' "$RUNNER_TEMP/boop-new-signature.txt" > "$RUNNER_TEMP/boop-new-certs.txt"
cmp "$RUNNER_TEMP/boop-old-certs.txt" "$RUNNER_TEMP/boop-new-certs.txt"
"$TOOLS/aapt" dump badging "$OLD" > "$RUNNER_TEMP/boop-old-manifest.txt"
"$TOOLS/aapt" dump badging "$APK" > "$RUNNER_TEMP/boop-new-manifest.txt"
python3 - "$ROOT" <<'PY'
import json, os, pathlib, re, sys
root = pathlib.Path(sys.argv[1])
temp = pathlib.Path(os.environ['RUNNER_TEMP'])
old = (temp / 'boop-old-manifest.txt').read_text().splitlines()[0]
new = (temp / 'boop-new-manifest.txt').read_text().splitlines()[0]
fields = lambda line: dict(re.findall(r"(name|versionCode|versionName)='([^']*)'", line))
before, after = fields(old), fields(new)
app = json.loads((root / 'mobile/nsh.json').read_text())
assert before['name'] == after['name'] == app['id'] == 'io.jingtao.boop', 'application ID differs'
assert after['versionName'] == app['version'], 'version name differs'
assert int(after['versionCode']) == app['build'] > int(before['versionCode']), 'version code must increase'
receipt = f"{after['name']} {after['versionName']} ({after['versionCode']})\nSame signing certificate as v0.1.0; APK signature verified; version code increased.\n"
(root / 'android/build/release-verification.txt').write_text(receipt)
print(receipt, end='')
PY
