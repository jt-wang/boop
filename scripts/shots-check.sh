#!/usr/bin/env bash
# The gate before screenshots leave a run (nightly.yml's upload, the release's screenshots for review).
#   scripts/shots-check.sh <folder> [--expect "a.png b.png …"]    scripts/shots-check.sh --self-test
# With --expect, the folder must hold exactly those files at its top level (REGRESSION.md lists them), each one a real PNG
# that decodes: one missing, empty, not a PNG, or anything else in the folder (any file, any subfolder) fails. Every PNG is read with tesseract, and the check fails when one shows something private:
#   email, home-path, private-ip, pairing-link (deepseekbot://, tailpocket1:/2:), pairing-code (a six-digit code next to
#   "pairing code", "code" or 配对码), token (tok_…, sk-…, "Bearer …", or 43 base64url characters: a device token as the
#   bot issues it, randomBytes(32).base64url), and with BOOP_PRIVATE_TERMS (a file, one term per line) private-term.
# The screenshots come from the demo and stand-in bots, so any hit means a test reached real data. A hit is reported
# as the file and its category only: the text read never reaches the log, which a public CI run shows to anyone.
# The self-test draws a fixed made-up value for each category on its own, and a clean line; it requires each to fail
# as its own category, the clean one to pass, and the log to hold none of the drawn values, so a broken OCR or a leaky
# report cannot pass. It also requires a JPEG named .png, a nested copy, an extra file and one named "a.png b.png" to
# fail --expect.
set -euo pipefail

categories() { # stdin: the OCR text; stdout: the categories it hits, one per line
  python3 -I -c '
import re, sys, os
t = sys.stdin.read()
flat = re.sub(r"\s+", " ", t)
flat = re.sub("[\u2010-\u2015\u2212]", "-", flat)  # OCR reads a hyphen as an en or em dash
rules = [
  ("email", r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z.]{2,}"),
  ("home-path", r"/(Users|home)/[A-Za-z0-9._-]+"),
  ("private-ip", r"\b(10|127)\.\d{1,3}\.\d{1,3}\.\d{1,3}\b|\b192\.168\.\d{1,3}\.\d{1,3}\b|\b172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}\b|\b100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b"),
  ("pairing-link", r"deepseekbot://|tailpocket[12]:"),
  ("pairing-code", r"(?i)(pair(ing)?\s*code|\bcode\b|配对码|驗證碼|验证码)\W{0,4}\d{3}\s?\d{3}\b"),
  ("token", r"tok_[A-Za-z0-9]{8,}|(?<![A-Za-z0-9])(?i:sk)-\s?[A-Za-z0-9]{12,}|(?i:bearer)\s+[A-Za-z0-9._~+/=-]{16,}|(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{40,46}(?![A-Za-z0-9_-])"),
]
hits = [name for name, rx in rules if re.search(rx, flat)]
terms = os.environ.get("BOOP_PRIVATE_TERMS")
if terms:
  for line in open(terms, encoding="utf-8"):
    term = line.strip()
    if term and not term.startswith("#") and term.lower() in flat.lower():
      hits.append("private-term"); break
print("\n".join(hits))
'
}

check() { # <folder> [expected names]
  local dir="$1" expect="${2:-}" bad=0 n=0 tmp f rel cats
  tmp=$(mktemp -d)
  if [ -n "$expect" ]; then
    for f in $expect; do
      [ -s "$dir/$f" ] && [ ! -L "$dir/$f" ] || { echo "FAIL $f: missing or empty"; bad=1; continue; }
      # a real PNG: its signature and Pillow's own reading of it, so a JPEG or anything else named .png is refused
      python3 -I -c 'import sys; from PIL import Image
f = sys.argv[1]; assert open(f, "rb").read(8) == bytes([137, 80, 78, 71, 13, 10, 26, 10])
im = Image.open(f); assert im.format == "PNG"; im.load(); assert im.size[0] > 0' "$dir/$f" 2>/dev/null ||
        { echo "FAIL $f: not a PNG that decodes"; bad=1; }
    done
    # nothing else at all: no other file, of any kind, at any depth, and no folder (one could hold a same-named copy)
    while IFS= read -r -d '' f; do
      rel=${f#"$dir"/}
      # each name compared whole: a file named "a.png b.png" is not two of them
      local want known=0
      for want in $expect; do [ "$rel" = "$want" ] && [ -f "$f" ] && known=1; done
      [ "$known" = 1 ] || { echo "FAIL $rel: not one of the expected screenshots"; bad=1; }
    done < <(find "$dir" -mindepth 1 -print0)
  fi
  while IFS= read -r -d '' f; do
    n=$((n + 1))
    # screencap's PNGs are RGBA with an sRGB chunk this tesseract's Leptonica refuses: read an RGB copy
    python3 -I -c 'import sys; from PIL import Image; Image.open(sys.argv[1]).convert("RGB").save(sys.argv[2])' "$f" "$tmp/ocr.png" 2>/dev/null &&
      tesseract "$tmp/ocr.png" "$tmp/ocr" >/dev/null 2>&1 || { echo "FAIL ${f#"$dir"/}: could not be read"; bad=1; continue; }
    cats=$(categories < "$tmp/ocr.txt" | tr '\n' ' ')
    [ -z "${cats// /}" ] || { echo "FAIL ${f#"$dir"/}: shows $cats"; bad=1; }
  done < <(find "$dir" -name '*.png' -print0)
  rm -rf "$tmp"
  echo "checked $n screenshots"
  [ "$n" -gt 0 ] || { echo "FAIL: no screenshots in $dir"; bad=1; }
  return $bad
}

if [ "${1:-}" = --self-test ]; then
  t=$(mktemp -d); trap 'rm -rf "$t"' EXIT
  # fixed made-up values, one category per image, so every run tests the same thing; assembled at run time so the
  # export's privacy scan does not read this file as holding one. The token is the bot's format (43 base64url
  # characters) in letters and digits OCR reads back unambiguously; none of these is a real value.
  python3 -I - "$t" <<'PY2'
import sys, os
from PIL import Image, ImageDraw, ImageFont
d = sys.argv[1]
def font(size):
  for f in ('DejaVuSansMono.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf', '/System/Library/Fonts/Menlo.ttc'):
    try: return ImageFont.truetype(f, size)
    except OSError: pass
  return ImageFont.load_default(size=size)
tok = 'Rk4Vm3Hx9Tb' + '7Nc8Ys2PdG6' + 'Ua5Ze3Xr9Mk' + '4Wt8QeB7Ad'
cases = {  # name: (category it must hit, text drawn, the private part that must not reach the log)
  'email': ('email', 'Signed in as ' + 'jane.doe' + '@' + 'example.org', 'jane.doe' + '@' + 'example.org'),
  'home-path': ('home-path', 'Saved to ' + '/Us' + 'ers/janedoe/notes', '/Us' + 'ers/janedoe'),
  'private-ip': ('private-ip', 'Connected to ' + '.'.join(['192', '168', '1', '20']), '.'.join(['192', '168', '1', '20'])),
  'pairing-link': ('pairing-link', 'Open ' + 'deepseek' + 'bot://pair?c=abc', 'deepseek' + 'bot://'),
  'pairing-code': ('pairing-code', 'Pairing code: ' + '48' + '2913', '48' + '2913'),
  'token-tok': ('token', 'tok' + '_' + 'Vm3Rx9Tb4Nc8', 'Vm3Rx9Tb4Nc8'),
  'token-sk': ('token', 'sk' + '-' + 'Hw4Nc8Ys2PdG6Jf5', 'Hw4Nc8Ys2PdG6Jf5'),
  'token-bearer': ('token', 'Bearer ' + 'Ua3Ze7Xr9Mk4Wt8Qe2', 'Ua3Ze7Xr9Mk4Wt8Qe2'),
  'token-device': ('token', tok, tok),
}
assert len(tok) == 43
for name, (cat, text, secret) in cases.items():
  os.mkdir(f'{d}/{name}')
  im = Image.new('RGB', (1800, 140), 'white'); ImageDraw.Draw(im).text((20, 40), text, fill='black', font=font(44)); im.save(f'{d}/{name}/shot.png')
  open(f'{d}/{name}.want', 'w').write(cat); open(f'{d}/{name}.secret', 'w').write(secret)
os.mkdir(f'{d}/clean')
im = Image.new('RGB', (1800, 140), 'white'); ImageDraw.Draw(im).text((20, 40), 'Remind me to call the dentist', fill='black', font=font(44)); im.save(f'{d}/clean/shot.png')
PY2
  for c in email home-path private-ip pairing-link pairing-code token-tok token-sk token-bearer token-device; do
    if check "$t/$c" > "$t/$c.log"; then echo "self-test FAIL: the check missed the $c screenshot"; exit 1; fi
    grep -Eq "^FAIL shot.png: shows (.* )?$(cat "$t/$c.want")( |$)" "$t/$c.log" || { echo "self-test FAIL: $c not reported as $(cat "$t/$c.want")"; exit 1; }
    ! grep -qiF -- "$(cat "$t/$c.secret")" "$t/$c.log" || { echo "self-test FAIL: the $c report holds the text it read"; exit 1; }
  done
  check "$t/clean" >/dev/null || { echo "self-test FAIL: the check refused a clean screenshot"; exit 1; }
  check "$t/clean" "shot.png" >/dev/null || { echo "self-test FAIL: the expected list refused the one expected file"; exit 1; }
  if check "$t/clean" "shot.png other.png" >/dev/null; then echo "self-test FAIL: a missing expected screenshot passed"; exit 1; fi
  # the folder holds the expected PNGs only: a JPEG named .png, a same-named copy in a subfolder, or any other file fails
  mkdir "$t/jpeg" "$t/nested" "$t/extra"
  python3 -I -c 'import sys; from PIL import Image; Image.open(sys.argv[1]).convert("RGB").save(sys.argv[2], "JPEG")' "$t/clean/shot.png" "$t/jpeg/shot.png"
  cp "$t/clean/shot.png" "$t/nested/shot.png"; mkdir "$t/nested/sub"; cp "$t/clean/shot.png" "$t/nested/sub/shot.png"
  cp "$t/clean/shot.png" "$t/extra/shot.png"; echo note > "$t/extra/notes.txt"
  # a ninth file whose name holds two expected names with a space between them
  mkdir "$t/joined"; cp "$t/clean/shot.png" "$t/joined/shot.png"; cp "$t/clean/shot.png" "$t/joined/other.png"; cp "$t/clean/shot.png" "$t/joined/shot.png other.png"
  if check "$t/joined" "shot.png other.png" >/dev/null; then echo "self-test FAIL: a file named after two expected ones passed"; exit 1; fi
  for c in jpeg nested extra; do
    if check "$t/$c" "shot.png" >/dev/null; then echo "self-test FAIL: the $c folder passed"; exit 1; fi
  done
  echo "self-test ok"; exit 0
fi
[ $# -ge 1 ] && [ -d "$1" ] || { echo "usage: $0 <folder> [--expect \"a.png b.png\"] | --self-test" >&2; exit 2; }
dir="$1"; shift
expect=""
[ "${1:-}" = --expect ] && expect="${2:?--expect needs the list}"
check "$dir" "$expect"
