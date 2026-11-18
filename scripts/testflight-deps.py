#!/usr/bin/env python3
"""Prepare the pinned iOS dependencies on the hosted runner, without Apple credentials."""
import hashlib
import os
from pathlib import Path
import platform
import shutil
import subprocess
import tarfile
import urllib.request

# GitHub's release asset digests, read 2026-11-17; a different response must fail before extraction.
ASSETS = {
    "nsh-macos-arm64.tar.gz": "f63c3d57c31b28c9b34227aac81f099d1e0e61f1db552a6ec5127d114eaf59cb",
    "nsh-embed-ios.zip": "698404af02006ae9bf9e2b2c7cd2fd89e52f6d65ab2cb8273229bc31394640c7",
}


def download(url, destination, digest, opener=urllib.request.urlopen):
    with opener(url, timeout=120) as response, destination.open("wb") as output:
        shutil.copyfileobj(response, output, length=1024 * 1024)
    with destination.open("rb") as downloaded:
        actual = hashlib.file_digest(downloaded, "sha256").hexdigest()
    if actual != digest:
        destination.unlink()
        raise ValueError("dependency SHA-256 does not match the pinned release")


def main():
    if os.environ.get("GITHUB_ACTIONS") != "true" or platform.system() != "Darwin" or platform.machine() != "arm64":
        raise ValueError("dependency preparation requires a GitHub-hosted arm64 macOS runner")
    root = Path(__file__).resolve().parents[1]
    directory = Path(os.environ["RUNNER_TEMP"]) / "boop-deps"
    directory.mkdir()
    for name, digest in ASSETS.items():
        download("https://github.com/longbridge/nsh/releases/download/v0.4.0/" + name, directory / name, digest)
    distribution = directory / "distribution"
    distribution.mkdir()
    with tarfile.open(directory / "nsh-macos-arm64.tar.gz") as archive:
        archive.extractall(distribution, filter="data")
    binaries = list(distribution.rglob("bin/nsh"))
    if len(binaries) != 1:
        raise ValueError("unexpected NSH distribution layout: expected one bin/nsh")
    nsh = binaries[0]
    home = nsh.parent.parent
    frameworks = directory / "frameworks"
    subprocess.run(["ditto", "-xk", str(directory / "nsh-embed-ios.zip"), str(frameworks)], check=True)
    bundles = list(frameworks.rglob("NativeShell.xcframework"))
    if len(bundles) != 1:
        raise ValueError("unexpected iOS archive layout: expected one NativeShell.xcframework")
    target = home / "embed/ios/NativeShell.xcframework"
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists():
        shutil.rmtree(target)
    shutil.move(str(bundles[0]), target)
    version = subprocess.check_output([str(nsh), "--version"], text=True)
    if not version.startswith("nsh 0.4.0"):
        raise ValueError("downloaded NSH does not identify as 0.4.0")
    tailpocket = root.parent / "tailpocket"
    subprocess.run(["bash", "scripts/build-mobile.sh", "apple"], cwd=tailpocket, check=True)
    link = tailpocket / "sdk/apple/NSH/NativeShell.xcframework"
    if link.is_symlink():
        link.unlink()
    link.symlink_to(target, target_is_directory=True)
    with open(os.environ["GITHUB_ENV"], "a") as output:
        output.write(f"NSH_HOME={home}\nNSH_BIN={nsh}\n")


if __name__ == "__main__":
    main()
