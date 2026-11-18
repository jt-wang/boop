"""CI boundaries only: no Xcode, signing identity, network or Apple account used."""
import importlib.util
import io
import base64
import datetime
import hashlib
import json
import os
import plistlib
from pathlib import Path
import tempfile
import shutil
import subprocess
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import zipfile

ROOT = Path(__file__).resolve().parents[1]


def load_ci():
    spec = importlib.util.spec_from_file_location("testflight_ci", ROOT / "scripts/testflight-ci.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def context():
    return dict(GITHUB_EVENT_NAME="workflow_dispatch", GITHUB_REPOSITORY="jt-wang/boop",
                GITHUB_REF="refs/heads/main", GITHUB_SHA="a" * 40, DEFAULT_BRANCH="main",
                GITHUB_WORKFLOW_SHA="a" * 40,
                GITHUB_WORKFLOW_REF="jt-wang/boop/.github/workflows/testflight.yml@refs/heads/main",
                TF_SOURCE_SHA="a" * 40, TF_VERSION=json.loads((ROOT / "mobile/nsh.json").read_text())["version"],
                TF_BUILD="4", TF_UPLOAD="false")


class PreflightTests(unittest.TestCase):
    def test_missing_secrets_fails_before_external_commands(self):
        ci = load_ci()
        calls = []
        with self.assertRaisesRegex(ValueError, "APPLE_TEAM_ID"):
            ci.release(ROOT, context(), lambda *a, **k: calls.append(a))
        self.assertEqual(calls, [])

    def test_only_default_branch_exact_sha_and_manual_dispatch_are_accepted(self):
        ci = load_ci()
        self.assertFalse(ci.preflight(ROOT, context()))
        for key, value in [("GITHUB_EVENT_NAME", "push"), ("GITHUB_REF", "refs/heads/topic"),
                           ("GITHUB_REPOSITORY", "example/fork"), ("TF_SOURCE_SHA", "b" * 40),
                           ("GITHUB_WORKFLOW_SHA", "b" * 40),
                           ("GITHUB_WORKFLOW_REF", "jt-wang/boop/.github/workflows/testflight.yml@refs/heads/topic"),
                           ("TF_SOURCE_SHA", "main"), ("TF_UPLOAD", "yes"),
                           ("TF_VERSION", "9.9.9"), ("TF_BUILD", "0"), ("TF_BUILD", "4; exit 0")]:
            with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                ci.preflight(ROOT, dict(context(), **{key: value}))
        self.assertTrue(ci.preflight(ROOT, dict(context(), TF_UPLOAD="true")))
        default = context()
        del default["TF_UPLOAD"]
        self.assertFalse(ci.preflight(ROOT, default))


class SigningTests(unittest.TestCase):
    def scenario(self, upload="false", fail=None, bad_profile=False):
        ci = load_ci()
        with tempfile.TemporaryDirectory(prefix="boop-ci-test-") as folder:
            folder = Path(folder)
            repo = folder / "repo"
            (repo / "mobile").mkdir(parents=True)
            (repo / "mobile/nsh.json").write_text('{"version":"0.1.3"}')
            home = folder / "home"
            home.mkdir()
            cert = b"synthetic distribution certificate"
            fingerprint = hashlib.sha1(cert).hexdigest().upper()
            profile = dict(UUID="11111111-2222-4333-8444-555555555555",
                           TeamIdentifier=["ABCDE12345"], DeveloperCertificates=[cert],
                           ExpirationDate=datetime.datetime(2099, 1, 1),
                           Entitlements={"application-identifier": "ABCDE12345.io.jingtao.boop",
                                         "get-task-allow": False, "aps-environment": "production"})
            if bad_profile:
                profile["ProvisionedDevices"] = ["synthetic-device"]
            env = dict(context(), HOME=str(home), RUNNER_TEMP=str(folder), TF_UPLOAD=upload, TF_VERSION="0.1.3",
                       ASC_KEY_ID="KEY1234567", ASC_ISSUER_ID="11111111-2222-4333-8444-555555555555",
                       ASC_PRIVATE_KEY_P8="synthetic API key contents",
                       APPLE_TEAM_ID="ABCDE12345", IOS_DISTRIBUTION_P12_PASSWORD="synthetic password",
                       IOS_DISTRIBUTION_P12_BASE64=base64.b64encode(b"synthetic p12").decode(),
                       IOS_PROVISION_PROFILE_BASE64=base64.b64encode(b"synthetic CMS").decode())
            if upload == "false":
                for name in ("ASC_KEY_ID", "ASC_ISSUER_ID", "ASC_PRIVATE_KEY_P8"):
                    del env[name]
            calls = []
            def execute(args, **kwargs):
                args = [str(x) for x in args]
                calls.append(args)
                for name in ci.SECRETS:
                    if any(x.endswith("ios-upload.sh") for x in args) and name in ("ASC_KEY_ID", "ASC_ISSUER_ID"):
                        continue
                    self.assertNotIn(name, kwargs.get("env", {}), "raw secrets escaped to child environment")
                if fail and fail in " ".join(args):
                    raise RuntimeError("synthetic child failure")
                if args[:3] == ["security", "cms", "-D"]:
                    return SimpleNamespace(stdout=plistlib.dumps(profile), returncode=0)
                if args[:2] == ["security", "list-keychains"]:
                    return SimpleNamespace(stdout=b'"login.keychain-db"\n', returncode=0)
                if args[:2] == ["security", "find-identity"]:
                    return SimpleNamespace(stdout=f' 1) {fingerprint} "Apple Distribution: Synthetic"\n'.encode(), returncode=0)
                if args[-1:] == ["archive"]:
                    ipa = repo / "ios/build/export/DeepSeekBot.ipa"
                    ipa.parent.mkdir(parents=True)
                    with zipfile.ZipFile(ipa, "w") as package:
                        package.writestr("Payload/DeepSeekBot.app/Info.plist", plistlib.dumps(dict(
                            CFBundleIdentifier="io.jingtao.boop", CFBundleShortVersionString="0.1.3", CFBundleVersion="4")))
                return SimpleNamespace(stdout=b"", returncode=0)
            error = None
            try:
                ci.release(repo, env, execute)
            except (ValueError, RuntimeError) as exc:
                error = exc
            leftovers = list(home.rglob("*.mobileprovision")) + list(folder.glob("boop-signing-*"))
            if fail == "list-keychains -d user -s login.keychain-db":
                # The cleanup retry needs only state, not p8/p12/profile contents.
                for pending in folder.glob("boop-signing-*"):
                    self.assertEqual([p.name for p in pending.iterdir()], ["state.json"])
            else:
                self.assertEqual(leftovers, [], "temporary signing material was left behind")
            return calls, error

    def test_default_build_checks_package_without_asc_and_cleans_signing_material(self):
        calls, error = self.scenario()
        self.assertIsNone(error)
        upload = [c for c in calls if any(x.endswith("ios-upload.sh") for x in c)]
        self.assertEqual(upload, [])
        self.assertTrue(any(c[:2] == ["codesign", "--verify"] for c in calls))
        self.assertTrue(any(c[:2] == ["security", "delete-keychain"] for c in calls))

    def test_upload_requires_explicit_true(self):
        calls, error = self.scenario(upload="true")
        self.assertIsNone(error)
        self.assertTrue(any("--upload" in c for c in calls))

    def test_failed_build_does_not_validate_or_upload_and_still_cleans(self):
        calls, error = self.scenario(fail="ios-build.sh")
        self.assertIsInstance(error, RuntimeError)
        self.assertFalse(any(any(x.endswith("ios-upload.sh") for x in c) for c in calls))
        self.assertTrue(any(c[:2] == ["security", "delete-keychain"] for c in calls))

    def test_development_profile_is_rejected_before_build(self):
        calls, error = self.scenario(bad_profile=True)
        self.assertIsInstance(error, ValueError)
        self.assertFalse(any(any(x.endswith("ios-build.sh") for x in c) for c in calls))

    def test_failed_keychain_restore_still_deletes_keychain_and_fails(self):
        calls, error = self.scenario(fail="list-keychains -d user -s login.keychain-db")
        self.assertIsInstance(error, RuntimeError)
        self.assertTrue(any(c[:2] == ["security", "delete-keychain"] for c in calls))

    def test_one_profile_unlink_failure_does_not_skip_other_cleanup_and_can_retry(self):
        ci = load_ci()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            folder = root / "boop-signing-fixture"
            folder.mkdir()
            first, second = root / "one.mobileprovision", root / "two.mobileprovision"
            first.write_bytes(b"synthetic profile")
            second.write_bytes(b"synthetic profile")
            (folder / "distribution.p12").write_bytes(b"synthetic certificate")
            (folder / "state.json").write_text(json.dumps({"profiles": [str(first), str(second)], "old_keychains": []}))
            unlink = Path.unlink
            def fail_first(path, *args, **kwargs):
                if path == first:
                    raise OSError("synthetic unlink failure")
                return unlink(path, *args, **kwargs)
            with patch.object(Path, "unlink", fail_first):
                with self.assertRaises(RuntimeError):
                    ci.cleanup(folder, lambda *a, **k: None, {})
            self.assertFalse(second.exists())
            self.assertFalse((folder / "distribution.p12").exists())
            self.assertTrue((folder / "state.json").exists())
            ci.cleanup(folder, lambda *a, **k: None, {})
            self.assertFalse(first.exists())
            self.assertFalse(folder.exists())


class ShellBoundaryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tools = tempfile.TemporaryDirectory(prefix="boop-ci-tools-")
        cls.binary = Path(cls.tools.name) / "tool"
        subprocess.run(["go", "build", "-o", str(cls.binary), str(ROOT / "test/fixtures/ios-ci-tool/main.go")],
                       check=True, env=dict(os.environ, GOMAXPROCS="1", GOMEMLIMIT="256MiB"), capture_output=True)

    @classmethod
    def tearDownClass(cls):
        cls.tools.cleanup()

    def invoke(self, script, args, fail="", manual=False):
        with tempfile.TemporaryDirectory(prefix="boop-script-test-") as folder:
            folder = Path(folder)
            (folder / "scripts").mkdir()
            (folder / "bin").mkdir()
            (folder / "home").mkdir()
            for name in (script, "scrub-home.sh"):
                shutil.copy(ROOT / "scripts" / name, folder / "scripts" / name)
            for tool in ("xcrun", "xcodebuild"):
                shutil.copy(self.binary, folder / "bin" / tool)
            # The bundler is another compiled no-op boundary, not a shell imitation.
            shutil.copy(self.binary, folder / "scripts/ios-bundle.sh")
            key = folder / "original.p8"
            key.write_text("synthetic API material")
            ipa = folder / "app.ipa"
            ipa.write_bytes(b"synthetic upload input")
            env = dict(os.environ, PATH=str(folder / "bin") + os.pathsep + os.environ["PATH"],
                       HOME=str(folder / "home"), TMPDIR=str(folder), FAKE_LOG=str(folder / "calls"),
                       FAKE_FAIL=fail, ASC_KEY_ID="KEY1234567", ASC_ISSUER_ID="synthetic-issuer", ASC_KEY_PATH=str(key))
            if manual:
                env.update(IOS_SIGNING_STYLE="Manual", IOS_TEAM_ID="ABCDE12345", IOS_PROFILE_UUID="synthetic-profile",
                           IOS_SIGNING_IDENTITY="synthetic-identity", IOS_KEYCHAIN_PATH=str(folder / "keychain"),
                           IOS_VERSION="0.1.3", IOS_BUILD="4", IOS_EXPORT_OPTIONS=str(folder / "options.plist"))
            result = subprocess.run(["bash", str(folder / "scripts" / script), *[str(ipa) if a == "IPA" else a for a in args]], env=env, capture_output=True)
            calls = [json.loads(line) for line in (folder / "calls").read_text().splitlines()] if (folder / "calls").exists() else []
            self.assertFalse(list((folder / "home").rglob("*.p8")), "uploader copied a key into HOME")
            self.assertEqual(list(folder.glob("boop-upload-*")), [], "uploader leaked its temporary key")
            self.assertTrue(key.exists(), "uploader deleted the caller's key")
            return result, calls

    def test_standalone_uploader_keeps_its_existing_upload_default(self):
        result, calls = self.invoke("ios-upload.sh", ["IPA"])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual([c[1] for c in calls], ["--validate-app", "--upload-app"])
        result, calls = self.invoke("ios-upload.sh", ["--upload", "IPA"])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual([c[1] for c in calls], ["--validate-app", "--upload-app"])

    def test_uploader_stops_on_validation_failure_and_cleans_key(self):
        result, calls = self.invoke("ios-upload.sh", ["--upload", "IPA"], fail="--validate-app")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual([c[1] for c in calls], ["--validate-app"])

    def test_manual_archive_uses_requested_signing_version_and_export_options(self):
        result, calls = self.invoke("ios-build.sh", ["archive"], manual=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        archive = next(c for c in calls if "archive" in c)
        self.assertIn("CODE_SIGN_STYLE=Manual", archive)
        self.assertIn("MARKETING_VERSION=0.1.3", archive)
        self.assertIn("CURRENT_PROJECT_VERSION=4", archive)
        self.assertIn("PROVISIONING_PROFILE_SPECIFIER=synthetic-profile", archive)
        self.assertNotIn("-allowProvisioningUpdates", archive)
        export = next(c for c in calls if "-exportArchive" in c)
        self.assertTrue(export[export.index("-exportOptionsPlist") + 1].endswith("options.plist"))


class DependencyTests(unittest.TestCase):
    def test_download_keeps_only_the_exact_pinned_bytes(self):
        spec = importlib.util.spec_from_file_location("testflight_deps", ROOT / "scripts/testflight-deps.py")
        deps = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(deps)
        data = b"synthetic dependency archive"
        digest = hashlib.sha256(data).hexdigest()
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "archive"
            deps.download("https://example.com/archive", destination, digest, lambda *a, **k: io.BytesIO(data))
            self.assertEqual(destination.read_bytes(), data)
            with self.assertRaises(ValueError):
                deps.download("https://example.com/archive", destination, digest, lambda *a, **k: io.BytesIO(data + b"changed"))
            self.assertFalse(destination.exists())


if __name__ == "__main__":
    unittest.main()
