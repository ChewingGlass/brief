#!/usr/bin/env python3
"""Index the hunks of a diff, and resolve a plan that orders them into a brief.

  brief.py hunks --base <sha> [--head <rev>] [-U <n>]                 > hunks.json
  brief.py model --base <sha> [--head <rev>] [-U <n>] --plan plan.json > <name>.brief.json

Both commands diff <base> against <head>. <head> defaults to the working tree. Hunk ids are stable
for one diff, so both commands must use the same arguments. Every hunk the plan does not place goes
to the rest of the diff, so the brief always holds the whole change.
"""

import argparse
import datetime
import fnmatch
import json
import re
import subprocess
import sys
from dataclasses import dataclass, asdict

HUNK_HEADER = re.compile(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$")


@dataclass
class Hunk:
    id: str
    file: str
    old_start: int
    new_start: int
    new_len: int
    first_changed_line: int
    added: int
    deleted: int
    enclosing: str
    text: str


def git_diff(base, head, context):
    cmd = ["git", "diff", f"-U{context}", "--no-color", "--no-ext-diff", base]
    if head:
        cmd.append(head)
    return subprocess.run(cmd, check=True, capture_output=True, text=True).stdout


def parse_hunks(diff):
    hunks = []
    file = None
    current = None

    def close():
        if current:
            hunks.append(finish(current))

    for line in diff.splitlines():
        if line.startswith("diff --git "):
            close()
            current = None
            file = line.split(" b/", 1)[1]
            continue

        if line.startswith("+++ "):
            if line != "+++ /dev/null":
                file = line[6:] if line.startswith("+++ b/") else line[4:]
            continue

        match = HUNK_HEADER.match(line)
        if match:
            close()
            current = {
                "file": file,
                "old_start": int(match.group(1)),
                "new_start": int(match.group(3)),
                "new_len": int(match.group(4) or 1),
                "enclosing": match.group(5).strip(),
                "lines": [line],
            }
            continue

        if current and line[:1] in (" ", "+", "-", "\\"):
            current["lines"].append(line)

    close()

    for index, hunk in enumerate(hunks):
        hunk.id = f"h{index + 1}"

    return hunks


def finish(raw):
    new_line = raw["new_start"]
    first_changed = None
    added = deleted = 0

    for line in raw["lines"][1:]:
        if line.startswith("+"):
            added += 1
            first_changed = first_changed or new_line
            new_line += 1
        elif line.startswith("-"):
            deleted += 1
            first_changed = first_changed or max(new_line, 1)
        elif line.startswith(" "):
            new_line += 1

    return Hunk(
        id="",
        file=raw["file"],
        old_start=raw["old_start"],
        new_start=raw["new_start"],
        new_len=raw["new_len"],
        first_changed_line=first_changed or raw["new_start"],
        added=added,
        deleted=deleted,
        enclosing=raw["enclosing"],
        text="\n".join(raw["lines"]),
    )


class Placer:
    """Hands out hunks to plan steps, and refuses a hunk that is unknown or placed twice."""

    def __init__(self, hunks):
        self.by_id = {hunk.id: hunk for hunk in hunks}
        self.placed = {}

    def take(self, ids, owner):
        taken = []
        for hunk_id in ids:
            if hunk_id not in self.by_id:
                sys.exit(f"plan names unknown hunk {hunk_id}")

            if hunk_id in self.placed:
                sys.exit(f"hunk {hunk_id} is placed twice: {self.placed[hunk_id]} and {owner}")

            self.placed[hunk_id] = owner
            taken.append(self.by_id[hunk_id])

        return taken


def file_statuses(base, head):
    cmd = ["git", "diff", "--name-status", "--no-renames", base] + ([head] if head else [])
    lines = subprocess.run(cmd, check=True, capture_output=True, text=True).stdout.splitlines()
    return {line.split("\t", 1)[1]: line[0] for line in lines if "\t" in line}


def hunk_entry(hunk):
    old_len = int(HUNK_HEADER.match(hunk.text.split("\n", 1)[0]).group(2) or 1)
    return {"id": hunk.id, "file": hunk.file, "line": hunk.first_changed_line,
            "new_start": hunk.new_start, "new_len": hunk.new_len,
            "old_start": hunk.old_start, "old_len": old_len,
            "added": hunk.added, "deleted": hunk.deleted, "enclosing": hunk.enclosing}


def build_model(hunks, plan, ctx):
    """The plan resolved against the hunks, for the VS Code extension to show."""
    placer = Placer(hunks)
    paths = []
    for section in plan.get("paths", []):
        steps = []
        for step in section["steps"]:
            entry = {"fn": step["fn"], "via": step.get("via"), "note": step.get("note"),
                     "same_as": step.get("same_as"), "caller": step.get("caller")}
            taken = [] if step.get("same_as") else placer.take(step.get("hunks", []), step["fn"])
            if taken:
                entry["hunks"] = [hunk_entry(h) for h in sorted(taken, key=lambda h: (h.file, h.new_start))]
            elif not step.get("same_as"):
                entry["file"], entry["line"] = step["file"], step["line"]

            steps.append(entry)

        paths.append({"heading": section["heading"], "steps": steps})

    remaining = [hunk for hunk in hunks if hunk.id not in placer.placed]
    files = list(dict.fromkeys(hunk.file for hunk in remaining))
    order = plan.get("rest_order", [])
    files.sort(key=lambda f: next((i for i, glob in enumerate(order) if fnmatch.fnmatch(f, glob)), len(order)))
    fold, omit = plan.get("fold", []), plan.get("omit", [])

    def kind(file):
        if any(fnmatch.fnmatch(file, g) for g in omit):
            return "omitted"

        return "folded" if any(fnmatch.fnmatch(file, g) for g in fold) else "shown"

    rank = {"shown": 0, "folded": 1, "omitted": 2}
    files.sort(key=lambda f: rank[kind(f)])
    rest = [{"file": f, "kind": kind(f), "hunks": [hunk_entry(h) for h in remaining if h.file == f]} for f in files]

    return {
        "title": plan["title"], "url": plan["url"], "brief": plan["brief"],
        "root": ctx["root"], "base": ctx["base"], "head": ctx.get("head"),
        "generated": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "added": sum(h.added for h in hunks), "deleted": sum(h.deleted for h in hunks),
        "statuses": ctx["statuses"], "paths": paths, "rest": rest,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["hunks", "model"])
    parser.add_argument("--base", required=True)
    parser.add_argument("--head")
    parser.add_argument("-U", dest="context", type=int, default=3)
    parser.add_argument("--plan")
    args = parser.parse_args()

    hunks = parse_hunks(git_diff(args.base, args.head, args.context))

    if args.command == "hunks":
        index = [{k: v for k, v in asdict(h).items() if k != "text"} for h in hunks]
        json.dump(index, sys.stdout, indent=1)
        return

    with open(args.plan) as plan_file:
        plan = json.load(plan_file)

    root = subprocess.run(["git", "rev-parse", "--show-toplevel"], capture_output=True, text=True, check=True).stdout.strip()
    ctx = {"root": root, "base": args.base, "head": args.head, "statuses": file_statuses(args.base, args.head)}
    json.dump(build_model(hunks, plan, ctx), sys.stdout, indent=1)


if __name__ == "__main__":
    main()
