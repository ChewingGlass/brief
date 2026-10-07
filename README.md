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

When you are done, Claude merges your findings with the review's. For each one it asks whether to
fix it on the branch, leave a PR comment, or drop it.

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
