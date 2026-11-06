"""Find code that a diff moves from a deleted file into an added file.

A refactor that splits a file shows in git as one deleted file and several added files, so every
moved line reads as new. This module matches each added file against the deleted files. For each
added file it builds the code that file came from, in the added file's order. For each deleted
file it builds the part that some added file took. A diff against those built files shows only
what the move changed: edits inside moved code, new code, and code that was removed.
"""

import os
import shutil
import subprocess
from dataclasses import dataclass, field

# A run of equal lines counts as moved only above both bounds, so braces and blank lines alone
# never match.
MIN_RUN_LINES = 3
MIN_RUN_CHARS = 30
MIN_ANCHOR_CHARS = 4

# Two runs from one source join into one segment across an edit of up to this many lines. The
# lines between them then show as a change inside the moved code, not as new code.
MAX_SEGMENT_GAP = 40

# An added file counts as moved only when this share of its lines matched, or this many lines did.
# A shared import block alone then leaves a new file as new.
MIN_MOVED_SHARE = 0.1
MIN_MOVED_LINES = 20


@dataclass
class Run:
    target_start: int
    source: str
    source_start: int
    length: int


@dataclass
class Segment:
    source: str
    source_start: int
    source_end: int
    target_start: int
    target_end: int
    matched: int


@dataclass
class MovedTarget:
    file: str
    base_path: str
    head_path: str
    segments: list
    base_offsets: list = field(default_factory=list)

    def origin(self, base_line):
        """The source file and line of a 1-based line in the built base, as `file:line`."""
        for offset, segment in zip(self.base_offsets, self.segments):
            length = segment.source_end - segment.source_start
            if offset < base_line <= offset + length:
                return f"{segment.source}:{segment.source_start + base_line - offset}"

        return ""


@dataclass
class MovedSource:
    file: str
    base_path: str
    kept_path: str
    kept_lines: int
    targets: dict


def file_lines(rev, path, root):
    if rev is None:
        with open(os.path.join(root, path), encoding="utf-8", errors="replace") as file:
            return file.read().splitlines(keepends=True)

    show = subprocess.run(["git", "show", f"{rev}:{path}"], capture_output=True, check=True)
    return show.stdout.decode("utf-8", errors="replace").splitlines(keepends=True)


def run_length(target, t, source, s):
    n = 0
    while t + n < len(target) and s + n < len(source) and target[t + n].strip() == source[s + n].strip():
        n += 1

    return n


def qualifies(lines):
    return len(lines) >= MIN_RUN_LINES and sum(len(line.strip()) for line in lines) >= MIN_RUN_CHARS


def find_runs(target, sources, index):
    """Longest runs of target lines equal to source lines, taken left to right.

    A tie goes to the run that continues the previous one, so a moved function stays one segment.
    """
    taken = [False] * len(target)
    runs = []
    t = 0
    while t < len(target):
        key = target[t].strip()
        best = None
        if len(key) >= MIN_ANCHOR_CHARS:
            previous = runs[-1] if runs else None
            for source, s in index.get(key, ()):
                n = run_length(target, t, sources[source], s)
                continues = previous is not None and previous.source == source and s >= previous.source_start + previous.length
                score = (n, continues)
                if best is None or score > best[0]:
                    best = (score, source, s, n)

        if best is None or not qualifies(target[t:t + best[3]]):
            t += 1
            continue

        _, source, s, n = best
        back = 0
        while t - back > 0 and s - back > 0 and not taken[t - back - 1] \
                and target[t - back - 1].strip() == sources[source][s - back - 1].strip():
            back += 1

        runs.append(Run(t - back, source, s - back, n + back))
        for i in range(t - back, t + n):
            taken[i] = True

        t += n

    return runs


def join_segments(runs):
    segments = []
    for run in sorted(runs, key=lambda r: r.target_start):
        last = segments[-1] if segments else None
        source_gap = run.source_start - last.source_end if last else -1
        target_gap = run.target_start - last.target_end if last else -1
        if last and last.source == run.source and 0 <= source_gap <= MAX_SEGMENT_GAP and 0 <= target_gap <= MAX_SEGMENT_GAP:
            last.source_end = run.source_start + run.length
            last.target_end = run.target_start + run.length
            last.matched += run.length
            continue

        segments.append(Segment(run.source, run.source_start, run.source_start + run.length,
                                run.target_start, run.target_start + run.length, run.length))

    return segments


def write(path, lines):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as file:
        file.writelines(lines)


def find_moves(base, head, statuses, root, out_dir):
    """Moved targets and sources by file. Files with no moved code are absent."""
    sources = {f: file_lines(base, f, root) for f, status in statuses.items() if status == "D"}
    targets = {f: file_lines(head, f, root) for f, status in statuses.items() if status == "A"}
    if not sources or not targets:
        return {}, {}

    index = {}
    for source, lines in sources.items():
        for i, line in enumerate(lines):
            key = line.strip()
            if len(key) >= MIN_ANCHOR_CHARS:
                index.setdefault(key, []).append((source, i))

    shutil.rmtree(out_dir, ignore_errors=True)
    kept = {source: [False] * len(lines) for source, lines in sources.items()}
    moved_targets = {}
    for file, lines in targets.items():
        segments = join_segments(find_runs(lines, sources, index))
        matched = sum(segment.matched for segment in segments)
        if matched < MIN_MOVED_LINES and matched < MIN_MOVED_SHARE * len(lines):
            continue

        move = MovedTarget(file, os.path.join(out_dir, "from", file), os.path.join(out_dir, "head", file), segments)
        base_lines = []
        for segment in segments:
            move.base_offsets.append(len(base_lines))
            base_lines.extend(sources[segment.source][segment.source_start:segment.source_end])
            kept[segment.source][segment.source_start:segment.source_end] = [True] * (segment.source_end - segment.source_start)

        write(move.base_path, base_lines)
        write(move.head_path, lines)
        moved_targets[file] = move

    moved_sources = {}
    for source, flags in kept.items():
        if not any(flags):
            continue

        targets_of = {}
        for move in moved_targets.values():
            lines = sum(s.matched for s in move.segments if s.source == source)
            if lines:
                targets_of[move.file] = lines

        moved = MovedSource(source, os.path.join(out_dir, "base", source), os.path.join(out_dir, "kept", source),
                            sum(flags), targets_of)
        write(moved.base_path, sources[source])
        write(moved.kept_path, [line for line, keep in zip(sources[source], flags) if keep])
        moved_sources[source] = moved

    return moved_targets, moved_sources
