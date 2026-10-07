# Brief VS Code extension

The extension reads the newest `*.brief.json` at the workspace root, which the `brief` skill
writes. It adds a Brief view to the activity bar and opens the change as one pinned multi-file
diff in the order of the brief.

- The Brief view shows the brief and the call paths. Each step sits under the step that calls it.
  A click on a step or a hunk opens the diff at that line.
- `Alt+]` and `Alt+[` move to the next and the previous hunk in brief order.
- A blue line marks each call site on a path. A click on its note goes to the step it calls.
- `Alt+O` opens the real file at the cursor of a diff.
- A comment on any line writes a finding to `<name>.brief-findings.md`. The findings show as
  comment threads on their lines and in the Findings node of the view.

The skill installs the extension on first run with `scripts/ensure_extension.py`. To rebuild it
after a change:

    bunx @vscode/vsce@3.6.0 package --no-dependencies --allow-missing-repository -o brief.vsix
    python3 ../scripts/ensure_extension.py

Bump `version` in `package.json` first. The install script skips a profile that already has the
same version.
