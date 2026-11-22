#!/usr/bin/env python3
"""Put one processed Boop build in the public TestFlight group and submit it for Beta App Review.

Never submits for App Store review and never changes another build. Creates the external group "Public" with a public
link if it does not exist. With --copy-review-info-from, Boop's missing beta review contact and feedback
email are copied as they are from another app of the same account, and --description fills a missing beta app
description; the copied values are never printed. Otherwise it stops before submitting, changing nothing, when any of
them is missing. A build that already has a beta review is only read back, so a repeat run changes nothing.
Prints and writes a JSON receipt; never prints credentials or tester emails.
"""
import argparse
import json
import os
from pathlib import Path
import time
import urllib.error
import urllib.parse
import urllib.request

API = "https://api.appstoreconnect.apple.com"
BUNDLE = "io.jingtao.boop"
GROUP = "Public"
CONTACT = ("contactFirstName", "contactLastName", "contactPhone", "contactEmail")


class Stop(Exception):
    pass


def review_info_missing(call, app):
    detail = call("GET", f"/v1/apps/{app}/betaAppReviewDetail")["data"]["attributes"]
    missing = [k for k in CONTACT if not detail.get(k)]
    if detail.get("demoAccountRequired") and not (detail.get("demoAccountName") and detail.get("demoAccountPassword")):
        missing.append("demoAccount")
    locs = call("GET", f"/v1/apps/{app}/betaAppLocalizations")["data"]
    if not any(l["attributes"].get("description") for l in locs):
        missing.append("betaAppDescription")
    if not any(l["attributes"].get("feedbackEmail") for l in locs):
        missing.append("feedbackEmail")
    return missing


def copy_review_info(call, app, source_bundle, description, missing):
    """Fill Boop's missing beta review contact and feedback email from another app of the same account, as they are
    there, and the description from --description. Returns the source app's name; never returns or prints the values."""
    apps = call("GET", "/v1/apps?" + urllib.parse.urlencode({"filter[bundleId]": source_bundle}))["data"]
    if len(apps) != 1:
        raise Stop("no app " + source_bundle + " to copy the review details from")
    src = apps[0]["id"]
    name = apps[0]["attributes"].get("name") or source_bundle
    if any(k in missing for k in CONTACT):
        sd = call("GET", f"/v1/apps/{src}/betaAppReviewDetail")["data"]["attributes"]
        if not all(sd.get(k) for k in CONTACT):
            raise Stop(name + " has no complete beta review contact to copy")
        mine = call("GET", f"/v1/apps/{app}/betaAppReviewDetail")["data"]
        call("PATCH", f"/v1/betaAppReviewDetails/{mine['id']}", {"data": {"type": "betaAppReviewDetails",
             "id": mine["id"], "attributes": {k: sd[k] for k in CONTACT}}})
    attrs = {}
    if "feedbackEmail" in missing:
        sl = [l["attributes"] for l in call("GET", f"/v1/apps/{src}/betaAppLocalizations")["data"]
              if l["attributes"].get("feedbackEmail")]
        sl.sort(key=lambda a: a.get("locale") != "en-US")
        if not sl:
            raise Stop(name + " has no feedback email to copy")
        attrs["feedbackEmail"] = sl[0]["feedbackEmail"]
    if "betaAppDescription" in missing:
        if not description:
            raise Stop("no beta app description given")
        attrs["description"] = description
    if attrs:
        en = [l for l in call("GET", f"/v1/apps/{app}/betaAppLocalizations")["data"] if l["attributes"]["locale"] == "en-US"]
        if en:
            call("PATCH", f"/v1/betaAppLocalizations/{en[0]['id']}", {"data": {"type": "betaAppLocalizations",
                 "id": en[0]["id"], "attributes": attrs}})
        else:
            call("POST", "/v1/betaAppLocalizations", {"data": {"type": "betaAppLocalizations",
                 "attributes": {"locale": "en-US", **attrs}, "relationships": {"app": {"data": {"type": "apps", "id": app}}}}})
    print("已从 " + name + " 复制")
    return name


def submit(call, version, build, what_to_test, copy_from=None, description=None):
    r = {"version": version, "build": build, "group": GROUP, "created_group": False, "added_to_group": False,
         "what_to_test_set": False, "submitted": False}
    apps = call("GET", "/v1/apps?" + urllib.parse.urlencode({"filter[bundleId]": BUNDLE}))["data"]
    if len(apps) != 1:
        raise Stop("expected the Boop app record")
    app = apps[0]["id"]
    q = urllib.parse.urlencode({"filter[app]": app, "filter[version]": build,
                                "filter[preReleaseVersion.version]": version, "include": "buildBetaDetail"})
    page = call("GET", "/v1/builds?" + q)
    if len(page["data"]) != 1:
        raise Stop(f"expected exactly one build {version} ({build})")
    b = page["data"][0]
    r["build_id"] = b["id"]
    if b["attributes"].get("processingState") != "VALID":
        raise Stop("build is " + str(b["attributes"].get("processingState")) + ", not VALID; nothing changed")

    review = call("GET", f"/v1/builds/{b['id']}/betaAppReviewSubmission")["data"]
    missing = review_info_missing(call, app)
    if review is None and missing and copy_from:
        r["review_info_copied_from"] = copy_review_info(call, app, copy_from, description, missing)
        missing = review_info_missing(call, app)
    r["missing_review_info"] = missing
    if review is None and missing:
        raise Stop("Beta App Review needs: " + ", ".join(missing) + "; nothing changed")

    groups = call("GET", f"/v1/apps/{app}/betaGroups?limit=200")["data"]
    public = [g for g in groups if g["attributes"]["name"] == GROUP and not g["attributes"]["isInternalGroup"]]
    if len(public) > 1:
        raise Stop("more than one external group named " + GROUP)
    if not public:
        public = [call("POST", "/v1/betaGroups", {"data": {"type": "betaGroups", "attributes": {
            "name": GROUP, "publicLinkEnabled": True, "publicLinkLimitEnabled": False, "feedbackEnabled": True},
            "relationships": {"app": {"data": {"type": "apps", "id": app}}}}})["data"]]
        r["created_group"] = True
    g = public[0]
    ref = {"type": "builds", "id": b["id"]}
    in_group = {x["id"] for x in call("GET", f"/v1/betaGroups/{g['id']}/relationships/builds?limit=200")["data"]}
    if b["id"] not in in_group:
        call("POST", f"/v1/betaGroups/{g['id']}/relationships/builds", {"data": [ref]})
        r["added_to_group"] = True

    if review is None:
        loc = [l for l in call("GET", f"/v1/builds/{b['id']}/betaBuildLocalizations")["data"]
               if l["attributes"]["locale"] == "en-US"]
        if loc:
            call("PATCH", f"/v1/betaBuildLocalizations/{loc[0]['id']}", {"data": {
                "type": "betaBuildLocalizations", "id": loc[0]["id"], "attributes": {"whatsNew": what_to_test}}})
        else:
            call("POST", "/v1/betaBuildLocalizations", {"data": {"type": "betaBuildLocalizations",
                 "attributes": {"locale": "en-US", "whatsNew": what_to_test},
                 "relationships": {"build": {"data": ref}}}})
        r["what_to_test_set"] = True
        call("POST", "/v1/betaAppReviewSubmissions",
             {"data": {"type": "betaAppReviewSubmissions", "relationships": {"build": {"data": ref}}}})
        r["submitted"] = True

    if not g["attributes"].get("publicLinkEnabled"):
        try:
            call("PATCH", f"/v1/betaGroups/{g['id']}", {"data": {"type": "betaGroups", "id": g["id"],
                 "attributes": {"publicLinkEnabled": True, "publicLinkLimitEnabled": False}}})
        except Stop as e:  # Apple may only allow the link once a build passed review; report it, rerun later.
            r["public_link_error"] = str(e)

    # Read back what App Store Connect now reports.
    g = call("GET", f"/v1/betaGroups/{g['id']}")["data"]["attributes"]
    r["public_link_enabled"], r["public_link"] = g.get("publicLinkEnabled"), g.get("publicLink")
    sub = call("GET", f"/v1/builds/{b['id']}/betaAppReviewSubmission")["data"]
    r["beta_review_state"] = sub["attributes"].get("betaReviewState") if sub else None
    bd = call("GET", f"/v1/builds/{b['id']}/buildBetaDetail")["data"]["attributes"]
    r["external_build_state"], r["internal_build_state"] = bd.get("externalBuildState"), bd.get("internalBuildState")
    return r


def client(env):
    import jwt

    def call(method, path, body=None):
        now = int(time.time())
        token = jwt.encode({"iss": env["ASC_ISSUER_ID"], "iat": now, "exp": now + 1200, "aud": "appstoreconnect-v1"},
                           env["ASC_PRIVATE_KEY_P8"], algorithm="ES256", headers={"kid": env["ASC_KEY_ID"], "typ": "JWT"})
        url = urllib.parse.urljoin(API, path)
        if urllib.parse.urlsplit(url).netloc != "api.appstoreconnect.apple.com":
            raise Stop("unexpected Apple host")
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(url, data=data, method=method, headers={
            "Authorization": "Bearer " + token, "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                text = resp.read()
        except urllib.error.HTTPError as e:
            try:
                errs = json.loads(e.read()).get("errors", [])
                why = "; ".join(f"{x.get('code')}: {x.get('detail')}" for x in errs)
            except ValueError:
                why = ""
            raise Stop(f"{method} {urllib.parse.urlsplit(url).path} -> {e.code} {why}".strip()) from None
        return json.loads(text) if text else {}
    return call


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--version", required=True)
    p.add_argument("--build", required=True)
    p.add_argument("--what-to-test", required=True)
    p.add_argument("--output", required=True)
    p.add_argument("--copy-review-info-from", help="bundle ID of an app in the same account whose beta review contact "
                   "and feedback email fill Boop's missing ones")
    p.add_argument("--description", help="beta app description, used when Boop has none")
    a = p.parse_args()
    missing = [k for k in ("ASC_KEY_ID", "ASC_ISSUER_ID", "ASC_PRIVATE_KEY_P8") if not os.environ.get(k)]
    try:
        if missing:
            raise Stop("missing ASC configuration: " + ", ".join(missing))
        receipt = submit(client(os.environ), a.version, a.build, a.what_to_test, a.copy_review_info_from, a.description)
    except Stop as e:
        receipt = {"version": a.version, "build": a.build, "error": str(e)}
    Path(a.output).write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps(receipt, indent=2))
    return 1 if "error" in receipt else 0


if __name__ == "__main__":
    raise SystemExit(main())
