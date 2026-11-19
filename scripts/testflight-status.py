#!/usr/bin/env python3
"""Read Apple build numbers and tester availability without exporting credentials."""
import datetime
import json
import os
from pathlib import Path
import time
import urllib.parse
import urllib.request

API = "https://api.appstoreconnect.apple.com"


def read_status(get):
    apps = get("/v1/apps?" + urllib.parse.urlencode({"filter[bundleId]": "io.jingtao.boop"}))["data"]
    if len(apps) != 1:
        raise ValueError("expected the Boop app record")
    app = apps[0]
    builds, included = [], {}
    url = "/v1/builds?" + urllib.parse.urlencode({
        "filter[app]": app["id"], "include": "preReleaseVersion,buildBetaDetail",
        "sort": "-uploadedDate", "limit": 200,
    })
    while url:
        page = get(url)
        builds.extend(page["data"])
        included.update({item["id"]: item for item in page.get("included", [])})
        url = page.get("links", {}).get("next")
    groups = get(f"/v1/apps/{app['id']}/betaGroups?limit=200")["data"]
    summary = []
    for build in builds:
        relations = build.get("relationships", {})
        def related(name):
            ref = relations.get(name, {}).get("data")
            return included.get(ref["id"], {}).get("attributes", {}) if ref else {}
        summary.append({
            "id": build["id"], "build": build["attributes"]["version"],
            "version": related("preReleaseVersion").get("version"),
            **{k: build["attributes"].get(k) for k in ("processingState", "uploadedDate", "expired", "usesNonExemptEncryption")},
            "beta": related("buildBetaDetail"),
        })
    next_build = max([int(b["build"]) for b in summary if b["build"].isdigit()] + [0]) + 1
    return {"appID": app["id"], "bundleId": "io.jingtao.boop", "nextBuild": next_build,
            "checkedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(), "builds": summary,
            "groups": [{"id": g["id"], **{k: g["attributes"].get(k) for k in
                ("name", "isInternalGroup", "hasAccessToAllBuilds", "publicLinkEnabled", "publicLink")}} for g in groups]}


def main():
    import jwt
    def get(path):
        now = int(time.time())
        token = jwt.encode({"iss": os.environ["ASC_ISSUER_ID"], "iat": now, "exp": now + 1200,
                            "aud": "appstoreconnect-v1"}, os.environ["ASC_PRIVATE_KEY_P8"],
                           algorithm="ES256", headers={"kid": os.environ["ASC_KEY_ID"], "typ": "JWT"})
        url = urllib.parse.urljoin(API, path)
        if urllib.parse.urlsplit(url).netloc != "api.appstoreconnect.apple.com":
            raise ValueError("unexpected Apple pagination host")
        request = urllib.request.Request(url, headers={"Authorization": "Bearer " + token})
        with urllib.request.urlopen(request, timeout=60) as response:
            return json.load(response)
    result = read_status(get)
    Path(os.environ["RUNNER_TEMP"], "boop-testflight-status.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
