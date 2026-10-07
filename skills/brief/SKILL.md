---
name: brief
description: Review a PR, or the current branch, as its diff reordered along the call path, in VS Code. Checks the PR out into a worktree (or uses the current checkout against the default branch when no target is given), writes a brief that a bundled VS Code extension shows as a tree of call paths beside one multi-file diff in call order, riskiest path first, and runs /code-review in the background. When the human is done, merges their findings with the review's and writes a recommended action (fix, comment or drop) under each one in the findings file. The human edits the actions and says "go", and the skill carries out all of them. Use for "/brief 371", "/brief" on the current branch, "brief me on PR N", "open PR N for review".
---

# Brief

The human reviews architecture and smell. The bot reviews lines. This skill gives the human the
diff in the order the code runs, inside the editor where go-to-definition works. The bot's
findings land in the same file when they are ready.

## Arguments

`/brief [<target>] [--effort=<low|medium|high|max>] [--no-review]`

- `target` is a PR number, a PR URL, or a branch name. A branch with no PR still works, but the
  comment option in Phase 6 is then unavailable.
- No `target` means local mode: the current checkout, compared from its merge base with the
  remote default branch, such as `origin/main`, to the working tree. Uncommitted edits count. See "Local mode" in Phase 1.
- `--effort` goes to `/code-review`. The default is `high`.
- `--no-review` skips the background review. Phases 2 and 5 do not run, and Phase 6 works from
  the human's findings alone. Words like "no review" or "without Claude" in the request mean the
  same.

## Rules

1. **Risk sets the order, and nothing else.** The riskiest path comes first. Code that moves
   money, changes stored data layout, or checks authority comes before library code, and library
   code comes before tooling. Bigger changes come before smaller ones in the same tier. Never
   print a risk label.
2. **The brief is at most 3 sentences.** It says what problem the change solves and the approach
   it takes. No walkthrough, no risk list, no verdicts.
3. **Every code reference is a link** to the changed line, not to the top of the function.
4. **Do not ask questions while the human reads.** Answer the questions they ask. Otherwise stay
   quiet until they say they are done.
5. **Nothing leaves the machine without approval.** A push, a PR comment and a PR review each need
   an explicit yes.

`<name>` below is `PR-<n>` for a PR and the branch name with `/` replaced by `-` in local mode.

Keep a state file at `<scratchpad>/brief-<name>.md` with the worktree path, the PR metadata, the
review agent's id, and the findings. A context compaction then loses nothing.

## Phase 1: Check out the PR

```bash
gh pr view <target> --json number,title,url,headRefName,baseRefName,headRepositoryOwner,isCrossRepository,additions,deletions,changedFiles
git worktree list --porcelain
```

If a worktree already has the head branch checked out, reuse it, including the main tree.
Otherwise create a sibling worktree, so the repo's tooling does not resolve it as nested:

```bash
WT="$(dirname <repo-root>)/<repo-name>-review/pr-<n>"
git worktree add --detach "$WT" origin/<baseRefName>
cd "$WT" && gh pr checkout <n>          # handles fork PRs and sets the upstream
git rev-parse --abbrev-ref --symbolic-full-name '@{upstream}'
```

The upstream must be the same-named branch on the PR's remote. If it is not, run
`git branch --set-upstream-to=<remote>/<headRefName>`, so a push cannot land on another branch.
Then record the PR head and keep the brief out of git for every worktree of the repo:

```bash
HEAD_SHA=$(git rev-parse HEAD)
EXCLUDE="$(git rev-parse --git-common-dir)/info/exclude"
for pattern in '*.brief.json' '*.brief-findings.md'; do
  grep -qxF "$pattern" "$EXCLUDE" || echo "$pattern" >> "$EXCLUDE"
done
```

**Diff mode.** Put the worktree in diff mode, so VS Code shows the whole PR as uncommitted
changes. The Source Control panel then lists every changed file with a diff, and the editor gutter
marks changed lines in any file the reader reaches through F12:

```bash
git fetch origin <baseRefName>
MB=$(git merge-base origin/<baseRefName> "$HEAD_SHA")
git checkout --detach
git reset --mixed "$MB"
git diff --name-only --diff-filter=A "$MB" "$HEAD_SHA" | xargs git add --intent-to-add --
```

The last line marks the new files as intended additions, so they show as added, not untracked.

The files stay at the PR head. Only HEAD and the index move, and the branch ref does not move.
Record `HEAD_SHA` and the branch name in the state file. Use diff mode without asking in a
worktree this skill created. In a reused worktree, ask first, and offer it only when `git status`
is clean. Uncommitted work would otherwise mix into the PR diff. Never use diff mode in the main
tree.

To leave diff mode, run the commands below. Edits made in diff mode stay in the working tree as
changes against the PR head:

```bash
git reset --mixed "$HEAD_SHA" && git checkout <headRefName>
```

**Local mode.** With no target, work in the current checkout. Create no worktree, and never use
diff mode, because the index there holds the human's work. Compare against the remote default
branch:

```bash
WT=$(git rev-parse --show-toplevel)
DEFAULT=$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null || echo origin/main)
git fetch origin "${DEFAULT#origin/}"
MB=$(git merge-base "$DEFAULT" HEAD)
git ls-files --others --exclude-standard
```

Run the exclude step above in local mode too.

Pass `--base "$MB"` and no `--head` to `brief.py`, so the diff runs to the working tree. Untracked
files are absent from `git diff`. Name each one in the hand-off, so the human knows the brief
does not show it. Phase 6 has no comment option, and Phase 7 commits on the current branch.

**Next round.** If `$WT/<name>.brief.json` exists, this run is the next round of the same
review. Read its `round` and `snapshot`. The human re-runs `/brief` after another agent or they
changed the code, and Phase 7 starts a round itself after its own fixes. Bring the code up to
date first:

- PR mode: leave diff mode, run `git pull --ff-only`, record the new `HEAD_SHA`, and enter diff
  mode again.
- Local mode: change nothing.

The new snapshot is the state this round reviews. In PR mode it is `HEAD_SHA`. In local mode it is
`git stash create`, which writes a commit of the working tree without changing the tree or the
index. Use `HEAD` when that command prints nothing. If the new snapshot has no diff against the
last one, tell the human that nothing changed since round N, and stop.

## Phase 2: Start the review in the background

Skip this phase with `--no-review`. In a later round, the review covers only the changes since the
last round. Tell it that base, the last `snapshot`.

Launch it before writing the brief, so the two run at the same time:

```
Agent(
  subagent_type: "general-purpose",
  description: "background code review",
  prompt: "Invoke Skill(skill: 'code-review', args: '<n> <effort>'). The PR head is checked out
           at <WT>; read files there. (Local mode: args '<effort>', which reviews the current
           diff, and tell it the base is <MB>.) Do NOT call ReportFindings. Return markdown, most severe
           first: one block per finding with severity, path:line at the PR head, a one-sentence
           claim, and a concrete failure scenario. Mark each finding CONFIRMED or PLAUSIBLE.
           Return an empty list if nothing survives verification."
)
```

## Phase 3: Write the brief

The brief is the PR diff, reordered to follow the call path. Each changed function shows as its
diff hunks, in the order one function calls the next. The reader reads the change the way the code
runs. Every hunk appears exactly once, so the brief replaces the GitHub diff.

**Index the hunks.** Use the merge base and the PR head commit, never the working tree. In diff
mode the new files are not in the index, so a working-tree diff misses them.

`<skill dir>` is the base directory that the harness prints when this skill loads.

```bash
B=<skill dir>/scripts/brief.py
MB=$(git merge-base origin/<baseRefName> "$HEAD_SHA")
python3 $B hunks --base "$MB" --head "$HEAD_SHA" > <scratchpad>/brief-<name>-hunks.json
```

Each hunk has an id, a file, its first changed line, its counts, and the enclosing function that
git detected. Check the enclosing function by reading the code when it is blank or looks wrong.

**Find the paths.** Read the changed functions whole. An entry point is an outermost public way
into the changed code: a program instruction handler, an exported SDK function, a CLI
command, an HTTP route, a binary's `main`. A test is not an entry point. A path runs from an entry
point down through each changed function it reaches. Get the edges from the language server when
possible: load the `LSP` tool through ToolSearch and use the call hierarchy. Fall back to grep and
reading, and confirm each edge at its call site.

**Rank by risk, silently.** Read the tiers from the first of these files that exists:
`<repo root>/.claude/brief-risk.md`, then `~/.claude/brief/risk/<repo-name>.md`.
`<skill dir>/risk/example.md` shows the format. With no file, rank code that moves money, changes
stored data layout, or checks authority first, then other core code, then services and SDKs,
then tooling, tests and docs. Inside a tier,
more changed lines rank higher. The rank sets the order of the paths and of the rest of the diff.
Never print a tier label.

**Write the plan** to `<scratchpad>/brief-<name>-plan.json`:

```json
{
  "title": "PR #<n> <title>",
  "url": "<pr url>",
  "brief": "<at most 3 sentences: the problem and the approach>",
  "paths": [
    {
      "heading": "handle_trigger_market_order_v1 → trigger_and_route_order",
      "steps": [
        { "fn": "fill_trigger_order", "file": "<path>", "line": 812 },
        { "fn": "handle_trigger_market_order_v1", "hunks": ["h10", "h11", "h12"],
          "via": { "file": "<path>", "line": 830 } },
        { "fn": "trigger_and_route_order", "hunks": ["h5"],
          "via": { "file": "<path>", "line": 250 }, "note": "<optional, one sentence>" },
        { "fn": "arm_remainder", "same_as": "handle_trigger_market_order_v1 → trigger_and_route_order" }
      ]
    }
  ],
  "rest_order": ["src/**", "lib/**", "packages/**", "scripts/**"],
  "fold": ["**/tests/**", "**/*.test.ts", "docs/**"],
  "omit": ["**/generated/**", "*.lock"]
}
```

- A step with `hunks` is a tree node that opens the diff at its first hunk. A step without
  `hunks` is an unchanged caller and opens the file at `file` and `line`. `via` is the call
  site in the step above. The extension marks that line in blue and links the two steps, so
  `via` must be the exact line of the call. The tree nests each step under its caller: the step
  named by an optional `caller`, or else the nearest earlier step in the file of `via`. Give every
  step after the first a `via`, or a `caller` when there is no call line, such as an accounts
  struct. A step with neither starts a new top-level branch. `same_as` points at a function that an earlier path already showed.
- A path has 3 to 6 steps. Put the riskiest path first. Show an unchanged caller only when it joins
  two changed functions or names the entry point.
- Leave import hunks out of steps. A step opens at its first hunk, and an import hunk sends the
  reader to the top of the file. Imports go to "Rest of the diff".
- `note` is optional. Use it only for a fact the diff does not show, such as "every fill calls
  this". Never write a verdict.
- Hunks that no step places go to "Rest of the diff", grouped by file, in `rest_order`. Files that
  match `fold` go under "Tests and docs" and to the end of the diff. Files that match `omit` stay
  out of the multi-file diff. Use `omit` only for generated files.

**Write the brief** to the root of `$WT`, and start the findings file next to it:

```bash
python3 $B model --base "$MB" --head "$HEAD_SHA" --plan <scratchpad>/brief-<name>-plan.json > "$WT/<name>.brief.json"
printf '# Findings\n\n## Mine\n\n<!-- One finding per item. A path:line anchors it. -->\n\n## Claude\n\n_Review running._\n' > "$WT/<name>.brief-findings.md"
```

With `--no-review`, write `_No review._` in place of `_Review running._`.

In a later round, keep the plan from the last round in the scratchpad as the start. Hunk ids change
when the code changes, so index the hunks again and map the steps onto the new ids. Pass the
round arguments:

```bash
python3 $B model --base "$MB" --head "$HEAD_SHA" --plan <plan> \
  --round <n> --snapshot <new snapshot> --since <last snapshot> > "$WT/<name>.brief.json"
```

Never rewrite an existing findings file. It carries the findings of every round. Instead, move
the `file:line` link of every finding with no `**Outcome:**` line to where its code is now. For a
background review, add `_Review running (round <n>)._` at the end of `## Claude`. Phase 5
replaces that line.

The extension watches the brief file. A new round opens its diff of the changes since the last
round in the open window, with no reload.

In local mode, omit `--head`. The script refuses a plan that places a hunk twice or names an
unknown hunk. Fix the plan and run it again.

## Phase 4: Open it and hand off

The VS Code extension in `<skill dir>/vscode-ext/` reads the newest `*.brief.json` at the
workspace root. It shows the brief and the paths in a Brief view in the activity bar, and opens the
whole diff as one pinned multi-file diff in brief order. It marks each `via` call site in blue.
Install it before the first open. The script installs it into every VS Code profile that lacks
this version, and prints nothing when all of them have it:

```bash
python3 <skill dir>/scripts/ensure_extension.py
code -n --disable-workspace-trust "$WT"
```

If the script reports that it installed the extension into a profile, a VS Code window that was
already open needs "Developer: Reload Window". Say so in the hand-off.

A new worktree is untrusted, and VS Code turns off git in an untrusted window. The diffs then show
nothing. `--disable-workspace-trust` opens the window as trusted.

`code -n` on a folder that is already open only focuses that window. The extension watches the
brief file, so a new brief still opens the multi-file diff there. After a change to the extension
itself, that window needs "Developer: Reload Window".

The source of the extension is in `<skill dir>/vscode-ext/`. Its README says how to rebuild it.

Tell the human in at most 3 lines: the worktree path, whether the review is running, and to say
"done" when finished. In local mode, name the untracked files that the brief does not show.

## Phase 5: Land the bot's findings

Skip this phase with `--no-review`.

When the review agent returns, read `<name>.brief-findings.md` again first, because the human may
have edited it. Replace only the `_Review running._` line under `## Claude`. Each finding is one
item:

```markdown
- **F1** high, CONFIRMED · [trigger.rs:318](<src/controller/trigger.rs#L318>)
  The reward share rounds up, so two fires can pay more than the full reward.
```

Tell the human in one line how many findings landed. Do not summarize them in chat.

## Phase 6: Reconcile

When the human says done, read the findings file again. Take their findings from `## Mine`.
The extension writes a comment the human adds in the editor there as an item with an `M<n>` id
and a `file:line` link. A line that starts with `↳` under any item is the human's reply to it.
Treat a reply under a bot finding as the human's view of that finding. Merge them
with the bot's findings:

- Join a human finding and a bot finding that make the same claim into one item.
- Check every PLAUSIBLE finding and every human finding you cannot confirm from the text against
  the code. Then mark each as confirmed, refuted with the line that refutes it, or unsure.
- Drop nothing on your own authority. A refuted finding stays on the list, marked as refuted.

Then write a decision line under every finding in the findings file, so the human decides all of
them in one pass in the file:

```markdown
- **F1** high, CONFIRMED · [trigger.rs:318](<src/controller/trigger.rs#L318>)
  The reward share rounds up, so two fires can pay more than the full reward.
  **Action:** fix · the rounding is a one-line change
```

The action is `fix`, `comment` or `drop`, and the first word after `**Action:**` is the decision.
Write the recommendation first, with a reason of a few words. Recommend `fix` when the fix is
local and clear, `comment` when it needs a design decision from the author, and `drop` for a
refuted finding. Mark a refuted finding in its reason with the line that refutes it. With no PR,
`comment` is not an option.

Tell the human in at most 2 lines: how many findings have each action, and to edit the action
words in the file and say "go". The human may also add `fix: <how>` under an item to steer the fix.
Do not ask about findings one by one.

When the human says "go", read the file again and act on the action of every item.

## Phase 7: Act

**Fixes.** Do every `fix` item. Leave diff mode first, as Phase 1 describes. Check that `git status` then shows only
the edits made during the review. In local mode, there is no diff mode, and the tree can hold the
human's uncommitted work. Stage only the lines the fix changed, and ask before committing a file
that had uncommitted changes before the review. Make the edits in the worktree, one commit for each finding or
for each set of findings that share a cause. Run the checks the repo's `CLAUDE.md` and `AGENTS.md` require for the touched
paths. Write commit messages by those rules. Then show `git log --oneline origin/<head>..HEAD` and
ask before you push. Push with `git push`, never with a force push, unless the human asks for one.

**Comments.** Draft a comment for every `comment` item, then show all of them together in one
approval:
post, edit some, or cancel. Comment text states the fact about the code and the reason it matters,
with no first or second person and no reference to this review. The repo's comment rules take
precedence. Post them as one review:

```bash
# {"event":"COMMENT","body":"","comments":[{"path":"...","line":318,"side":"RIGHT","body":"..."}]}
gh api --method POST repos/<owner>/<repo>/pulls/<n>/reviews --input <scratchpad>/brief-<n>-review.json
```

GitHub rejects a comment on a line outside the diff. Move that comment to the nearest changed line
in the same hunk. If that also fails, put it into one top-level `gh pr comment` that carries the
`path:line`.

Record each outcome as a line under its item in the findings file:
`**Outcome:** fixed in <sha> (round <n>)`, `**Outcome:** commented (round <n>)` or
`**Outcome:** dropped (round <n>)`. The extension shows an item with an outcome as resolved.

When any `fix` landed, start the next round at once: run Phases 1 to 4 again as "Next round". The
human then reads the fixes as the changes since the last round. Do not ask first. When the human
says they are finished, end the review as below.
When the review ends, finish with the PR URL, the counts, and the worktree path. Ask whether to remove the worktree with
`git worktree remove`. Never remove the main tree. If no fix happened, leave diff mode before the
worktree is removed or reused.
