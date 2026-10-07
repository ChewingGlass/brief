# brief

`brief` is a Claude Code skill and a VS Code extension for reviewing a change in the order its
code runs.

GitHub shows a diff file by file, in alphabetical order. `brief` finds the entry points of the
change, follows each call path down through the changed functions, and puts the riskiest path
first. VS Code then shows:

- A **Brief view** with a 3-sentence summary and the call paths as a tree. Each step sits under
  the step that calls it, and a click opens the diff at that line.
- One **multi-file diff** of the whole change in that order, in the real diff editor, so syntax
  highlighting, hover and go-to-definition work.
- A **blue marker** on each call site of a path. A click on its note goes to the next step.
- **Findings as comments.** A comment on any line is saved as a finding. A background
  `/code-review` adds its own findings beside yours.

## Workflow

1. Run `/brief`. VS Code opens the Brief view and the diff. A background review starts unless you
   pass `--no-review`.
2. Read. Leave a comment on any line that needs one. Each comment is saved as a finding in
   `<name>.brief-findings.md`, and the review's findings land in the same file.
3. Say "done". Claude merges your findings with the review's and checks each one against the
   code. Under each finding it writes a recommended action and a reason:
   `**Action:** fix · the guard is a one-line change`. The action is `fix`, `comment` or `drop`.
4. Edit the action words in the file. Add `fix: <how>` under an item to steer a fix.
5. Say "go". Claude makes every fix as commits on the branch and drafts every PR comment. It shows
   the comments and the commits for one approval before anything is posted or pushed.
6. When fixes landed, Claude starts the next round by itself. VS Code opens the changes since the
   last round, so you read only the fixes. Comment again and say "done", and the loop repeats until
   you say you are finished.

### Rounds

A review often takes several rounds: you comment, an agent fixes, you read the fixes, you comment
again. `brief` keeps one review across those rounds.

- The findings file carries every round. A handled finding gets an `**Outcome:**` line, such as
  `fixed in abc123 (round 2)`, and shows as resolved in VS Code. Open findings move with their
  code.
- Each round records the state you reviewed. In local mode, uncommitted edits count, and the
  snapshot is a `git stash create` commit, which leaves your files and index alone.
- Run `/brief` again in the same Claude session whenever the code changed in another way, such as
  your own edits or another agent's commits. It starts the next round from the last state you
  reviewed.
- The Brief view shows a **Round N** node with the files changed since the last round. The history
  button reopens that diff, and the diff button opens the whole change.

The open VS Code window picks up each new round by itself. Reload it only after the extension
itself updates.

## Install

You need Claude Code, VS Code with the `code` command on your `PATH`, `git`, `python3`, and the
GitHub CLI `gh` for pull requests. In Claude Code:

```
/plugin marketplace add ChewingGlass/brief
/plugin install brief@chewingglass
```

The skill installs the VS Code extension the first time it runs. It installs it into every VS
Code profile. If a VS Code window is already open, run "Developer: Reload Window" there once.

## Use

```
/brief 123                  # review PR 123 in its own worktree
/brief https://github.com/org/repo/pull/123
/brief                      # review the current branch against the default branch
/brief 123 --no-review      # skip the background Claude review
```

In VS Code:

| Action | How |
| --- | --- |
| Next or previous hunk in brief order | `Alt+]` and `Alt+[` |
| Open the real file at the cursor of a diff | `Alt+O` |
| Add a finding | Click `+` in the gutter of a line, then **Add finding** |
| Reopen the whole diff | The diff button in the Brief view title |

Say "done" to Claude when you finish reading.

## Risk order

The order of the paths comes from a risk file. Put one at `<repo>/.claude/brief-risk.md` or
`~/.claude/brief/risk/<repo-name>.md`. `skills/brief/risk/example.md` shows the format. Without a
file, the skill uses generic tiers.

## Layout

- `skills/brief/SKILL.md` is the skill.
- `skills/brief/scripts/brief.py` indexes the hunks of a diff and turns the plan into the brief.
- `skills/brief/scripts/ensure_extension.py` installs the extension.
- `skills/brief/vscode-ext/` is the extension source and the built `brief.vsix`. Its README says
  how to rebuild it.
