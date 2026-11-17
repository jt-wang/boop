#!/usr/bin/env python3
"""Build and validate a trusted manual TestFlight run; uploading is opt-in."""
import json
import re
import base64
import datetime
import hashlib
import os
from pathlib import Path
import plistlib
import secrets
import shlex
import shutil
import subprocess
import sys
import tempfile
import uuid
import zipfile

SIGNING_SECRETS = (
    "APPLE_TEAM_ID",
    "IOS_DISTRIBUTION_P12_BASE64", "IOS_DISTRIBUTION_P12_PASSWORD",
    "IOS_PROVISION_PROFILE_BASE64",
)
ASC_SECRETS = ("ASC_KEY_ID", "ASC_ISSUER_ID", "ASC_PRIVATE_KEY_P8")
SECRETS = SIGNING_SECRETS + ASC_SECRETS
BUNDLE_ID = "io.jingtao.boop"


def preflight(root, env):
    if (env.get("GITHUB_EVENT_NAME") != "workflow_dispatch"
            or env.get("GITHUB_REPOSITORY") != "jt-wang/boop"
            or not env.get("DEFAULT_BRANCH")
            or env.get("GITHUB_REF") != "refs/heads/" + env["DEFAULT_BRANCH"]):
        raise ValueError("only a manual run on the repository default branch is trusted")
    sha = env.get("TF_SOURCE_SHA", "")
    if not re.fullmatch(r"[0-9a-f]{40}", sha) or sha != env.get("GITHUB_SHA"):
        raise ValueError("source SHA must equal this workflow's github.sha")
    if (env.get("GITHUB_WORKFLOW_SHA") != sha
            or env.get("GITHUB_WORKFLOW_REF") != "jt-wang/boop/.github/workflows/testflight.yml@" + env["GITHUB_REF"]):
        raise ValueError("workflow ref and SHA must identify this exact trusted source")
    version = env.get("TF_VERSION", "")
    if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", version):
        raise ValueError("version must be major.minor.patch")
    if version != json.loads((root / "mobile/nsh.json").read_text())["version"]:
        raise ValueError("version must match mobile/nsh.json; review version changes first")
    if not re.fullmatch(r"[1-9][0-9]{0,3}", env.get("TF_BUILD", "")):
        raise ValueError("build must be an integer from 1 to 9999")
    if env.get("TF_UPLOAD", "false") not in ("false", "true"):
        raise ValueError("upload must be false or true")
    return env.get("TF_UPLOAD", "false") == "true"


def configured(env, upload):
    for name in SIGNING_SECRETS + (ASC_SECRETS if upload else ()):
        if not env.get(name):
            print(f"missing configuration: {name}", file=sys.stderr)
            raise ValueError(f"missing configuration: {name}")
    if not re.fullmatch(r"[A-Z0-9]{10}", env["APPLE_TEAM_ID"]):
        raise ValueError("invalid APPLE_TEAM_ID")
    if upload:
        if not re.fullmatch(r"[A-Z0-9]{10}", env["ASC_KEY_ID"]):
            raise ValueError("invalid ASC_KEY_ID")
        uuid.UUID(env["ASC_ISSUER_ID"])


def command(args, **kwargs):
    # Never echo a security command or a child exception containing password arguments.
    result = subprocess.run(args, capture_output=True, **kwargs)
    if result.returncode:
        print(f"{Path(args[0]).name} failed (exit {result.returncode})", file=sys.stderr)
        raise RuntimeError(f"{Path(args[0]).name} failed (exit {result.returncode})")
    return result


def cleanup(folder, execute, env):
    state_path = folder / "state.json"
    if not state_path.exists():
        shutil.rmtree(folder)
        return
    state = json.loads(state_path.read_text())
    errors = []
    try:
        if state.get("keychain"):
            try:
                if not state.get("restored"):
                    execute(["security", "list-keychains", "-d", "user", "-s", *state["old_keychains"]], env=env)
                    state["restored"] = True
            except Exception:
                errors.append("keychain search-list restore failed")
            try:
                if not state.get("deleted"):
                    execute(["security", "delete-keychain", state["keychain"]], env=env)
                    state["deleted"] = True
            except Exception:
                errors.append("temporary keychain deletion failed")
    finally:
        for path in state["profiles"]:
            try:
                Path(path).unlink(missing_ok=True)
            except OSError:
                errors.append("provisioning profile removal failed")
        # Retain only retry state and a keychain that could not yet be deleted.
        for item in folder.iterdir():
            if item == state_path or item.name.startswith("signing.keychain") and not state.get("deleted"):
                continue
            try:
                if item.is_dir():
                    shutil.rmtree(item)
                else:
                    item.unlink()
            except OSError:
                errors.append("temporary signing file removal failed")
        if errors:
            state_path.write_text(json.dumps(state))
        else:
            shutil.rmtree(folder)
    if errors:
        raise RuntimeError(errors[0])


def release(root, env, execute=command):
    upload = preflight(root, env)
    configured(env, upload)
    # Only disposable GitHub runners may receive this material; tests use an isolated directory.
    work_env = {k: v for k, v in env.items() if k not in SECRETS}
    folder = Path(tempfile.mkdtemp(prefix="boop-signing-", dir=env["RUNNER_TEMP"]))
    state = {"profiles": [], "old_keychains": []}
    state_path = folder / "state.json"
    def remember():
        state_path.write_text(json.dumps(state))
    remember()
    try:
        p12 = folder / "distribution.p12"
        cms = folder / "profile.mobileprovision"
        p12.write_bytes(base64.b64decode(env["IOS_DISTRIBUTION_P12_BASE64"], validate=True))
        cms.write_bytes(base64.b64decode(env["IOS_PROVISION_PROFILE_BASE64"], validate=True))
        p12.chmod(0o600)
        cms.chmod(0o600)
        profile = plistlib.loads(execute(["security", "cms", "-D", "-i", str(cms)], env=work_env).stdout)
        uuid.UUID(profile["UUID"])
        profile_id = profile["UUID"]
        entitlements = profile.get("Entitlements", {})
        if (profile.get("TeamIdentifier") != [env["APPLE_TEAM_ID"]]
                or entitlements.get("application-identifier") != env["APPLE_TEAM_ID"] + "." + BUNDLE_ID
                or entitlements.get("get-task-allow") is not False
                or entitlements.get("aps-environment") != "production"
                or "ProvisionedDevices" in profile or profile.get("ProvisionsAllDevices")
                or profile["ExpirationDate"].replace(tzinfo=datetime.timezone.utc) <= datetime.datetime.now(datetime.timezone.utc)):
            raise ValueError("profile must be unexpired App Store distribution for this team and bundle with production push")
        state["old_keychains"] = shlex.split(execute(["security", "list-keychains", "-d", "user"], env=work_env).stdout.decode())
        keychain = str(folder / "signing.keychain-db")
        password = secrets.token_urlsafe(32)
        execute(["security", "create-keychain", "-p", password, keychain], env=work_env)
        state["keychain"] = keychain
        remember()
        execute(["security", "set-keychain-settings", "-lut", "21600", keychain], env=work_env)
        execute(["security", "unlock-keychain", "-p", password, keychain], env=work_env)
        execute(["security", "import", str(p12), "-k", keychain, "-P", env["IOS_DISTRIBUTION_P12_PASSWORD"],
                 "-T", "/usr/bin/codesign", "-T", "/usr/bin/security"], env=work_env)
        execute(["security", "set-key-partition-list", "-S", "apple-tool:,apple:,codesign:", "-s", "-k", password, keychain], env=work_env)
        execute(["security", "list-keychains", "-d", "user", "-s", keychain, *state["old_keychains"]], env=work_env)
        identities = execute(["security", "find-identity", "-v", "-p", "codesigning", keychain], env=work_env).stdout.decode()
        valid = set(re.findall(r'([A-F0-9]{40}) "Apple Distribution[^"\n]*"', identities))
        matching = valid & {hashlib.sha1(cert).hexdigest().upper() for cert in profile.get("DeveloperCertificates", [])}
        if not matching:
            raise ValueError("p12 has no valid Apple Distribution identity matching the profile")
        identity = sorted(matching)[0]
        for directory in ("Library/MobileDevice/Provisioning Profiles", "Library/Developer/Xcode/UserData/Provisioning Profiles"):
            destination = Path(env["HOME"]) / directory / (profile_id + ".mobileprovision")
            destination.parent.mkdir(parents=True, exist_ok=True)
            if destination.exists():
                raise ValueError("refusing to replace a pre-existing provisioning profile")
            state["profiles"].append(str(destination))
            remember()
            shutil.copyfile(cms, destination)
            destination.chmod(0o600)
        options = folder / "ExportOptions.plist"
        options.write_bytes(plistlib.dumps(dict(method="app-store-connect", destination="export", signingStyle="manual",
            teamID=env["APPLE_TEAM_ID"], signingCertificate=identity, provisioningProfiles={BUNDLE_ID: profile_id},
            uploadSymbols=False, manageAppVersionAndBuildNumber=False)))
        build_env = dict(work_env, IOS_SIGNING_STYLE="Manual", IOS_TEAM_ID=env["APPLE_TEAM_ID"],
            IOS_PROFILE_UUID=profile_id, IOS_SIGNING_IDENTITY=identity, IOS_KEYCHAIN_PATH=keychain,
            IOS_VERSION=env["TF_VERSION"], IOS_BUILD=env["TF_BUILD"], IOS_EXPORT_OPTIONS=str(options))
        print("Building signed archive", flush=True)
        execute(["bash", str(root / "scripts/ios-build.sh"), "archive"], cwd=root, env=build_env)
        ipa = root / "ios/build/export/DeepSeekBot.ipa"
        with zipfile.ZipFile(ipa) as package:
            if package.testzip() is not None:
                raise ValueError("IPA has a corrupt entry")
            info = plistlib.loads(package.read("Payload/DeepSeekBot.app/Info.plist"))
            if (info.get("CFBundleIdentifier"), info.get("CFBundleShortVersionString"), info.get("CFBundleVersion")) != (BUNDLE_ID, env["TF_VERSION"], env["TF_BUILD"]):
                raise ValueError("exported IPA bundle/version/build does not match the request")
            package.extractall(folder / "ipa")
        execute(["codesign", "--verify", "--deep", "--strict", str(folder / "ipa/Payload/DeepSeekBot.app")], env=work_env)
        if upload:
            key = folder / ("AuthKey_" + env["ASC_KEY_ID"] + ".p8")
            key.write_text(env["ASC_PRIVATE_KEY_P8"])
            key.chmod(0o600)
            upload_env = dict(work_env, ASC_KEY_ID=env["ASC_KEY_ID"], ASC_ISSUER_ID=env["ASC_ISSUER_ID"], ASC_KEY_PATH=str(key))
            # The uploader receives identifiers and a temporary key path, never the raw p8.
            execute(["bash", str(root / "scripts/ios-upload.sh"), "--upload", str(ipa)], cwd=root, env=upload_env)
        print("Uploaded to ASC; processing is separate" if upload else "Signed IPA passed local checks; ASC was not contacted", flush=True)
    finally:
        cleanup(folder, execute, work_env)


if __name__ == "__main__":
    root = Path(__file__).resolve().parents[1]
    try:
        if sys.argv[1:] == ["--preflight"]:
            preflight(root, os.environ)
        elif sys.argv[1:] == ["--check-config"]:
            configured(os.environ, preflight(root, os.environ))
        elif sys.argv[1:] == ["--cleanup"]:
            for folder in Path(os.environ["RUNNER_TEMP"]).glob("boop-signing-*"):
                cleanup(folder, command, {k: v for k, v in os.environ.items() if k not in SECRETS})
        elif not sys.argv[1:]:
            release(root, os.environ)
        else:
            raise ValueError("usage: testflight-ci.py [--preflight|--check-config|--cleanup]")
    except Exception as exc:
        # Subprocess exceptions never expose their argv or a secret value.
        print(f"TestFlight CI failed ({type(exc).__name__}); no success receipt was produced", file=sys.stderr)
        sys.exit(1)
