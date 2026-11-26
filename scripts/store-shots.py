#!/usr/bin/env python3
"""Download the App Store screenshots of every Boop version into a folder, for scripts/shots-check.sh.

Read-only: GET requests to the App Store Connect API and to the image host, nothing else. Files are named 001.png,
002.png, ... so a hit names only a number; the log gets counts, never a URL, a locale's text or an image.
  scripts/store-shots.py <folder>      (ASC_ISSUER_ID, ASC_KEY_ID, ASC_PRIVATE_KEY_P8, as scripts/testflight-status.py)
TestFlight has no screenshots of its own to read: its only images are testers' feedback, which nobody publishes.
"""
import json
import os
from pathlib import Path
import sys
import time
import urllib.parse
import urllib.request

API = "https://api.appstoreconnect.apple.com"


def screenshot_urls(get):
    """Every screenshot of every version and locale, as a PNG URL; and the counts along the way."""
    apps = get("/v1/apps?" + urllib.parse.urlencode({"filter[bundleId]": "io.jingtao.boop"}))["data"]
    if len(apps) != 1:
        raise SystemExit(f"expected one app for io.jingtao.boop, found {len(apps)}")
    counts = {"versions": 0, "localizations": 0, "sets": 0, "screenshots": 0}
    urls = []
    for version in pages(get, f"/v1/apps/{apps[0]['id']}/appStoreVersions?limit=200"):
        counts["versions"] += 1
        for loc in pages(get, f"/v1/appStoreVersions/{version['id']}/appStoreVersionLocalizations?limit=200"):
            counts["localizations"] += 1
            for shot_set in pages(get, f"/v1/appStoreVersionLocalizations/{loc['id']}/appScreenshotSets?limit=200"):
                counts["sets"] += 1
                for shot in pages(get, f"/v1/appScreenshotSets/{shot_set['id']}/appScreenshots?limit=200"):
                    counts["screenshots"] += 1
                    asset = shot["attributes"].get("imageAsset") or {}
                    if not asset.get("templateUrl"):
                        continue  # still uploading or failed: nothing published to read
                    urls.append(asset["templateUrl"].replace("{w}", str(asset["width"])).replace("{h}", str(asset["height"])).replace("{f}", "png"))
    return urls, counts


def pages(get, path):
    while path:
        body = get(path)
        yield from body["data"]
        path = body.get("links", {}).get("next")


def main():
    import jwt
    out = Path(sys.argv[1]); out.mkdir(parents=True, exist_ok=False)

    def get(path):
        now = int(time.time())
        token = jwt.encode({"iss": os.environ["ASC_ISSUER_ID"], "iat": now, "exp": now + 1200, "aud": "appstoreconnect-v1"},
                           os.environ["ASC_PRIVATE_KEY_P8"], algorithm="ES256", headers={"kid": os.environ["ASC_KEY_ID"], "typ": "JWT"})
        url = urllib.parse.urljoin(API, path)
        if urllib.parse.urlsplit(url).netloc != "api.appstoreconnect.apple.com":
            raise ValueError("unexpected Apple pagination host")
        with urllib.request.urlopen(urllib.request.Request(url, headers={"Authorization": "Bearer " + token}), timeout=60) as r:
            return json.load(r)

    urls, counts = screenshot_urls(get)
    for i, url in enumerate(urls, 1):
        if urllib.parse.urlsplit(url).scheme != "https":
            raise ValueError("unexpected screenshot URL scheme")
        with urllib.request.urlopen(url, timeout=60) as r:  # the image host: no credentials sent
            (out / f"{i:03}.png").write_bytes(r.read())
    print(" ".join(f"{k}={v}" for k, v in counts.items()), f"downloaded={len(urls)}")


if __name__ == "__main__":
    main()
