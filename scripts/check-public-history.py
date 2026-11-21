#!/usr/bin/env python3
"""Fails when a public commit or tag breaks the publishing rules.

Every commit on a branch or tag (and the pull request head, if given) must be authored and committed by
AUTHOR at 12:00:00 +0000 and carry exactly one trailer, Source-Rev, the mark of a source-export commit.
Commits whose author and committer are both listed with --upstream are kept as they are. Every tag must be
annotated, by AUTHOR, at 12:00:00 +0000. The output names commits and rules, never the identity found.

usage: check-public-history.py --author "Name <email>" [--upstream EMAIL ...] [REV ...]
"""
import argparse
import re
import subprocess
import sys

IDENTITY_LINE = re.compile(r"(?im)^[ \t]*(?:[A-Za-z0-9-]*-by|[A-Za-z0-9-]*Thread(?:-ID)?|Change-Id|Session(?:-ID)?)"
                           r"[ \t]*:")

EMAIL = re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+")


def git(*a):
    return subprocess.run(["git", *a], capture_output=True, text=True, check=True).stdout


def bad_time(raw):
    epoch, _, zone = raw.partition(" ")
    return zone != "+0000" or int(epoch) % 86400 != 43200


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--author", required=True)
    p.add_argument("--upstream", action="append", default=[])
    p.add_argument("revs", nargs="*")
    a = p.parse_args()
    name, email = re.fullmatch(r"(.+) <(.+)>", a.author).groups()
    refs = git("for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes", "refs/tags").split()
    refs = [r for r in refs if not r.endswith("/HEAD")]
    problems = []
    fmt = "%h%x00%an%x00%ae%x00%ad%x00%cn%x00%ce%x00%cd%x00%(trailers:only,unfold)%x00%B%x1e"
    out = git("log", "--date=raw", f"--format={fmt}", *refs, *a.revs, "--")
    count = 0
    for rec in filter(None, (r.strip("\n") for r in out.split("\x1e"))):
        count += 1
        sha, an, ae, ad, cn, ce, cd, trailers, body = rec.split("\0")
        if ae in a.upstream and ce in a.upstream:
            continue
        for role, n, e, when in (("author", an, ae, ad), ("committer", cn, ce, cd)):
            if (n, e) != (name, email):
                problems.append(f"commit {sha}: {role} is not {name}'s public identity")
            elif bad_time(when):
                problems.append(f"commit {sha}: {role} date is not 12:00:00 +0000")
        keys = [t.split(":", 1)[0].strip() for t in trailers.splitlines() if t.strip()]
        problems += [f"commit {sha}: trailer {k} is not allowed" for k in keys if k != "Source-Rev"]
        if keys.count("Source-Rev") != 1:
            problems.append(f"commit {sha}: needs exactly one Source-Rev trailer; publish with source-export")
        if IDENTITY_LINE.search(body):
            problems.append(f"commit {sha}: the message names a person or an internal session")
        if "ampcode.com/threads" in body:
            problems.append(f"commit {sha}: the message links an agent thread")
        if any(not e.endswith("@users.noreply.github.com") for e in EMAIL.findall(body)):
            problems.append(f"commit {sha}: the message has an email that is not a GitHub noreply one")
    tags = git("for-each-ref", "refs/tags",
               "--format=%(refname:strip=2)%00%(objecttype)%00%(taggername)%00%(taggeremail:trim)%00%(taggerdate:raw)")
    for line in filter(None, tags.splitlines()):
        tag, kind, tn, te, when = line.split("\0")
        if kind != "tag":
            problems.append(f"tag {tag}: lightweight, has no tagger")
        elif (tn, te) != (name, email):
            problems.append(f"tag {tag}: tagger is not {name}'s public identity")
        elif bad_time(when):
            problems.append(f"tag {tag}: tagger date is not 12:00:00 +0000")
    for problem in problems:
        print(problem)
    print(f"checked {count} commits and {len(tags.splitlines())} tags: {len(problems)} problem(s)")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
