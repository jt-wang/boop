"""scripts/testflight-beta.py against a fake App Store Connect: what it changes, and what it never does."""
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("beta", Path(__file__).parents[1] / "scripts" / "testflight-beta.py")
beta = importlib.util.module_from_spec(spec)
spec.loader.exec_module(beta)

CONTACT = {"contactFirstName": "Sam", "contactLastName": "Example", "contactPhone": "+1 555 0100",
           "contactEmail": "sam@example.com", "demoAccountRequired": False}


class FakeASC:
    def __init__(self, contact=CONTACT, groups=(), review=None, state="VALID"):
        self.contact, self.groups, self.review, self.state = dict(contact), list(groups), review, state
        self.group_builds, self.calls, self.whats_new = {}, [], None

    def __call__(self, method, path, body=None):
        self.calls.append((method, path.split("?")[0]))
        p = path.split("?")[0]
        if p == "/v1/apps":
            return {"data": [{"id": "app1"}]}
        if p == "/v1/builds":
            return {"data": [{"id": "b10", "attributes": {"processingState": self.state}}]}
        if p == "/v1/apps/app1/betaAppReviewDetail":
            return {"data": {"attributes": self.contact}}
        if p == "/v1/apps/app1/betaAppLocalizations":
            return {"data": [{"attributes": {"description": "Boop", "feedbackEmail": "f@example.com"}}]}
        if p == "/v1/builds/b10/betaAppReviewSubmission":
            return {"data": self.review}
        if p == "/v1/apps/app1/betaGroups":
            return {"data": self.groups}
        if p == "/v1/betaGroups" and method == "POST":
            g = {"id": "g2", "attributes": {"name": body["data"]["attributes"]["name"], "isInternalGroup": False,
                                            "publicLinkEnabled": True, "publicLink": "https://testflight.apple.com/join/X"}}
            self.groups.append(g)
            return {"data": g}
        if p.endswith("/relationships/builds"):
            gid = p.split("/")[3]
            if method == "POST":
                self.group_builds.setdefault(gid, set()).update(x["id"] for x in body["data"])
                return {}
            return {"data": [{"id": i} for i in self.group_builds.get(gid, ())]}
        if p == "/v1/builds/b10/betaBuildLocalizations":
            return {"data": []}
        if p == "/v1/betaBuildLocalizations":
            self.whats_new = body["data"]["attributes"]["whatsNew"]
            return {}
        if p == "/v1/betaAppReviewSubmissions":
            self.review = {"attributes": {"betaReviewState": "WAITING_FOR_REVIEW"}}
            return {}
        if p.startswith("/v1/betaGroups/") and method == "GET":
            return {"data": [g for g in self.groups if g["id"] == p.split("/")[3]][0]}
        if p == "/v1/builds/b10/buildBetaDetail":
            return {"data": {"attributes": {"externalBuildState": "WAITING_FOR_BETA_REVIEW" if self.review else
                                            "READY_FOR_BETA_SUBMISSION", "internalBuildState": "IN_BETA_TESTING"}}}
        raise AssertionError("unexpected call " + method + " " + p)

    def writes(self):
        return [c for c in self.calls if c[0] != "GET"]


INTERNAL = {"id": "g1", "attributes": {"name": "Internal Testing", "isInternalGroup": True}}


class BetaTest(unittest.TestCase):
    def test_first_run_creates_the_public_group_adds_the_build_and_submits(self):
        asc = FakeASC(groups=[INTERNAL])
        r = beta.submit(asc, "0.1.10", "10", "Try the offline reasons.")
        self.assertTrue(r["created_group"] and r["added_to_group"] and r["submitted"])
        self.assertEqual(asc.group_builds, {"g2": {"b10"}})  # never the internal group
        self.assertEqual(asc.whats_new, "Try the offline reasons.")
        self.assertEqual(r["beta_review_state"], "WAITING_FOR_REVIEW")
        self.assertEqual(r["public_link"], "https://testflight.apple.com/join/X")
        self.assertFalse(any("appStoreVersionSubmissions" in p or "reviewSubmissions" == p.split("/")[-1]
                             for _, p in asc.calls))

    def test_a_build_already_in_review_is_only_read_back(self):
        pub = {"id": "g2", "attributes": {"name": "Public", "isInternalGroup": False, "publicLinkEnabled": True,
                                          "publicLink": "https://testflight.apple.com/join/X"}}
        asc = FakeASC(groups=[INTERNAL, pub], review={"attributes": {"betaReviewState": "IN_REVIEW"}})
        asc.group_builds = {"g2": {"b10"}}
        r = beta.submit(asc, "0.1.10", "10", "x")
        self.assertEqual(asc.writes(), [])
        self.assertEqual(r["beta_review_state"], "IN_REVIEW")

    def test_missing_contact_details_stop_before_any_change_and_name_the_fields(self):
        asc = FakeASC(contact={**CONTACT, "contactPhone": None, "contactEmail": ""}, groups=[INTERNAL])
        with self.assertRaisesRegex(beta.Stop, "contactPhone, contactEmail"):
            beta.submit(asc, "0.1.10", "10", "x")
        self.assertEqual(asc.writes(), [])

    def test_a_build_still_processing_changes_nothing(self):
        asc = FakeASC(groups=[INTERNAL], state="PROCESSING")
        with self.assertRaisesRegex(beta.Stop, "not VALID"):
            beta.submit(asc, "0.1.10", "10", "x")
        self.assertEqual(asc.writes(), [])


if __name__ == "__main__":
    unittest.main()
