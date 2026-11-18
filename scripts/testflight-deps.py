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

# GitHub's release asset digests (nsh v0.5.1, read 2026-11-18); a different response must fail before extraction.
ASSETS = {
    "nsh-macos-arm64.tar.gz": "2710affd59e6345b6f87dfa1f579c36b9a9d7a58992b8399d14f39290da048a3",
    "nsh-embed-ios.zip": "0a11159c9d368f7558f9b48b62ffcb956a2643ab7ddc21925404ab52dfa563a3",
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
        download("https://github.com/longbridge/nsh/releases/download/v0.5.1/" + name, directory / name, digest)
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
    if not version.startswith("nsh 0.5.1"):
        raise ValueError("downloaded NSH does not identify as 0.5.1")
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
