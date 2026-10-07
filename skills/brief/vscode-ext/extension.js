// Shows a PR brief (PR-<n>.brief.json at the workspace root) as a tree in the Source Control
// side bar, and opens the whole PR as one multi-file diff in the brief's order.
// Also handles vscode://chewingglass.brief/diff?file=<abs path>&base=<sha>&line=<n>&status=<M|A|D>.
const vscode = require("vscode");
const path = require("path");

function gitApi() {
  return vscode.extensions.getExtension("vscode.git").exports.getAPI(1);
}

async function openDiff({ file, base, line, status }) {
  const uri = vscode.Uri.file(file);
  const row = Math.max(line - 1, 0);
  const selection = new vscode.Range(row, 0, row, 0);

  if (status === "A") {
    await vscode.window.showTextDocument(uri, { selection, preview: true });
    return;
  }

  const original = gitApi().toGitUri(uri, base);
  if (status === "D") {
    await vscode.window.showTextDocument(original, { selection, preview: true });
    return;
  }

  const title = `${vscode.workspace.asRelativePath(uri)} (PR diff)`;
  await vscode.commands.executeCommand("vscode.diff", original, uri, title, { selection, preview: true });
}

// A multi-file diff opens as a preview tab, and the next file opened would replace it.
async function openChanges(title, changes) {
  await vscode.commands.executeCommand("vscode.changes", title, changes);
  await vscode.commands.executeCommand("workbench.action.keepEditor");
}

// From the base side of a diff, the line is the base line, so it can land a few lines off.
async function openFileAtCursor() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return;
  }

  const uri = editor.document.uri;
  const file = uri.scheme === "git" ? vscode.Uri.file(JSON.parse(uri.query).path) : uri;
  await vscode.window.showTextDocument(file, { selection: editor.selection, preview: false });
}

class Brief {
  constructor(uri, model, findings) {
    this.uri = uri;
    this.model = model;
    this.findings = findings;
    this.order = this.readingOrder();
  }

  findingsIn(hunks) {
    return this.findings
      .filter((f) => f.file && hunks.some((h) => h.file === f.file && f.line >= h.new_start && f.line < h.new_start + h.new_len))
      .map((f) => f.id);
  }

  status(file) {
    return this.model.statuses[file] || "M";
  }

  target(hunk) {
    return {
      file: path.join(this.model.root, hunk.file),
      base: this.model.base,
      line: hunk.line,
      status: this.status(hunk.file),
    };
  }

  readingOrder() {
    const hunks = [];
    for (const section of this.model.paths) {
      for (const step of section.steps) {
        hunks.push(...(step.hunks || []));
      }
    }

    for (const group of this.model.rest) {
      if (group.kind !== "omitted") {
        hunks.push(...group.hunks);
      }
    }

    return hunks;
  }

  hunkAt(uri, line) {
    const base = uri.scheme === "git";
    const file = base ? path.relative(this.model.root, JSON.parse(uri.query).path) : path.relative(this.model.root, uri.fsPath);
    const hunks = this.order.filter((hunk) => hunk.file === file);
    const start = (hunk) => (base ? hunk.old_start : hunk.new_start);
    const length = (hunk) => (base ? hunk.old_len : hunk.new_len);

    const containing = hunks.find((hunk) => line >= start(hunk) && line < start(hunk) + length(hunk));
    if (containing) {
      return containing;
    }

    const before = hunks.filter((hunk) => start(hunk) <= line);
    return before.length ? before[before.length - 1] : hunks[0];
  }

  changes(hunks) {
    const git = gitApi();
    const files = [...new Set(hunks.map((hunk) => hunk.file))];
    return files.map((file) => {
      const uri = vscode.Uri.file(path.join(this.model.root, file));
      const status = this.status(file);
      const original = status === "A" ? undefined : git.toGitUri(uri, this.model.base);
      const modified = status === "D" ? undefined : uri;
      return [uri, original, modified];
    });
  }
}

class Node extends vscode.TreeItem {
  constructor(label, collapsed, children = []) {
    super(label, collapsed ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    this.children = children;
  }
}

function counts(hunks) {
  const added = hunks.reduce((sum, hunk) => sum + hunk.added, 0);
  const deleted = hunks.reduce((sum, hunk) => sum + hunk.deleted, 0);
  return `+${added} −${deleted}`;
}

function hunkNode(hunk) {
  const node = new Node(`${path.basename(hunk.file)}:${hunk.line}`, false);
  node.description = `${counts([hunk])} ${hunk.enclosing}`;
  node.tooltip = `${hunk.file}:${hunk.line}`;
  node.iconPath = new vscode.ThemeIcon("diff");
  node.command = { command: "brief.openHunk", title: "Open", arguments: [hunk] };
  node.hunk = hunk;
  return node;
}

function stepNode(brief, step) {
  const hunks = step.hunks || [];
  const node = new Node(step.fn, false, hunks.length > 1 ? hunks.map(hunkNode) : []);
  const tooltip = new vscode.MarkdownString();

  if (step.via) {
    tooltip.appendMarkdown(`Called at \`${step.via.file}:${step.via.line}\`\n\n`);
  }

  if (step.note) {
    tooltip.appendMarkdown(step.note);
  }

  if (step.same_as) {
    node.description = `shown under ${step.same_as}`;
    node.iconPath = new vscode.ThemeIcon("arrow-up");
  } else if (hunks.length) {
    const flagged = brief.findingsIn(hunks);
    node.description = `${path.basename(hunks[0].file)} ${counts(hunks)}${flagged.length ? ` ⚠ ${flagged.join(" ")}` : ""}`;
    node.iconPath = new vscode.ThemeIcon("symbol-function");
    node.command = { command: "brief.openHunk", title: "Open", arguments: [hunks[0]] };
    node.hunk = hunks[0];
  } else {
    const row = Math.max(step.line - 1, 0);
    node.description = `${path.basename(step.file)}:${step.line} unchanged`;
    node.iconPath = new vscode.ThemeIcon("circle-outline");
    node.command = {
      command: "vscode.open",
      title: "Open",
      arguments: [vscode.Uri.file(path.join(brief.model.root, step.file)), { selection: new vscode.Range(row, 0, row, 0) }],
    };
  }

  node.tooltip = tooltip.value ? tooltip : undefined;
  return node;
}

function fileNode(brief, group) {
  const node = new Node(group.file, true, group.hunks.map(hunkNode));
  const flagged = brief.findingsIn(group.hunks);
  node.description = `${counts(group.hunks)}${flagged.length ? ` ⚠ ${flagged.join(" ")}` : ""}`;
  node.resourceUri = vscode.Uri.file(path.join(brief.model.root, group.file));
  return node;
}

function nestSteps(brief, steps) {
  const nodes = steps.map((step) => stepNode(brief, step));
  const top = [];
  steps.forEach((step, index) => {
    const parent = callerIndex(steps, index);
    (parent === undefined ? top : nodes[parent].children).push(nodes[index]);
  });

  for (const node of nodes) {
    if (node.children.length) {
      node.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
    }
  }

  return top;
}

function buildTree(brief) {
  const paths = brief.model.paths.map((section) => {
    const node = new Node(section.heading, true, nestSteps(brief, section.steps));
    node.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
    node.contextValue = "briefPath";
    node.section = section;
    return node;
  });

  const groups = [
    ["shown", "Rest of the diff"],
    ["folded", "Tests and docs"],
    ["omitted", "Generated, not in the diff view"],
  ];
  const rest = groups
    .map(([kind, label]) => {
      const files = brief.model.rest.filter((group) => group.kind === kind);
      return files.length ? new Node(label, true, files.map((group) => fileNode(brief, group))) : undefined;
    })
    .filter(Boolean);

  return [findingsNode(brief), ...paths, ...rest];
}

class TreeProvider {
  constructor() {
    this.roots = [];
    this.parents = new Map();
    this.emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.emitter.event;
  }

  set(roots) {
    this.roots = roots;
    this.parents = new Map();
    const walk = (nodes, parent) =>
      nodes.forEach((node) => {
        this.parents.set(node, parent);
        walk(node.children, node);
      });
    walk(roots, undefined);
    this.emitter.fire();
  }

  getTreeItem(node) {
    return node;
  }

  getChildren(node) {
    return node ? node.children : this.roots;
  }

  getParent(node) {
    return this.parents.get(node);
  }

  find(hunk) {
    for (const node of this.parents.keys()) {
      if (node.hunk === hunk && node.children.length === 0) {
        return node;
      }
    }

    return undefined;
  }
}

// A checkout can hold briefs from several runs. The newest one is the current review.
async function loadBrief() {
  const files = await vscode.workspace.findFiles("*.brief.json", null, 50);
  if (!files.length) {
    return undefined;
  }

  const stats = await Promise.all(files.map((uri) => vscode.workspace.fs.stat(uri)));
  const newest = files[stats.indexOf(stats.reduce((a, b) => (b.mtime > a.mtime ? b : a)))];
  const bytes = await vscode.workspace.fs.readFile(newest);
  const model = JSON.parse(Buffer.from(bytes).toString("utf8"));
  return new Brief(newest, model, await readFindings(findingsUri(newest), model.root));
}

function findingsUri(briefUri) {
  return vscode.Uri.file(briefUri.fsPath.replace(/\.brief\.json$/, ".brief-findings.md"));
}

async function readFindings(uri, root) {
  try {
    return parseFindings(Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8"), root);
  } catch {
    return [];
  }
}

const plain = (text) => text.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\*\*|`/g, "").trim();

// Items are "- " lines under "## Mine" or "## Claude". An indented line continues the item.
function parseFindings(text, root) {
  const items = [];
  let section;
  for (const line of text.split("\n")) {
    const heading = line.match(/^##\s+(Mine|Claude)/i);
    if (heading) {
      section = heading[1].toLowerCase();
    } else if (section && line.startsWith("- ")) {
      items.push({ source: section, lines: [line.slice(2)] });
    } else if (items.length && /^\s+\S/.test(line)) {
      items[items.length - 1].lines.push(line.trim());
    }
  }

  return items.map((item, index) => {
    const raw = item.lines.join("\n");
    const anchor = raw.match(/\(<?([^)#\s>]+)#L(\d+)>?\)/) || raw.match(/([\w./-]+\.\w+):(\d+)/);
    const file = anchor ? path.relative(root, path.resolve(root, anchor[1])) : undefined;
    const id = (raw.match(/\*\*(F\d+)\*\*/) || [])[1] || `${item.source === "mine" ? "M" : "F"}${index + 1}`;
    return { id, source: item.source, raw, file, line: anchor ? Number(anchor[2]) : undefined,
      header: plain(item.lines[0]), claim: plain(item.lines.slice(1).join(" ")) };
  });
}

function findingNode(finding) {
  const node = new Node(finding.claim || finding.header, false);
  node.description = finding.claim ? finding.header : undefined;
  node.tooltip = new vscode.MarkdownString(finding.raw);
  node.iconPath = new vscode.ThemeIcon(finding.source === "mine" ? "person" : "warning");
  if (finding.file) {
    node.command = { command: "brief.openTarget", title: "Open", arguments: [{ file: finding.file, line: finding.line }] };
  }

  return node;
}

function findingsNode(brief) {
  const uri = findingsUri(brief.uri);
  const node = new Node("Findings", true, brief.findings.map(findingNode));
  node.collapsibleState = brief.findings.length ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None;
  node.description = brief.findings.length ? `${brief.findings.length}, open ${path.basename(uri.fsPath)}` : path.basename(uri.fsPath);
  node.iconPath = new vscode.ThemeIcon("checklist");
  node.command = { command: "vscode.open", title: "Open", arguments: [uri, { preview: false }] };
  return node;
}

const FINDINGS_TEMPLATE = "# Findings\n\n## Mine\n\n## Claude\n\n_Review running._\n";

// Adds a line to the findings file: a new item at the end of "## Mine", or a reply under an item.
function insertFinding(text, entry, replyTo) {
  const lines = text.split("\n");
  if (replyTo) {
    const start = lines.findIndex((line) => line.startsWith("- ") && line.includes(`**${replyTo}**`));
    let end = start + 1;
    while (end < lines.length && /^\s+\S/.test(lines[end])) {
      end += 1;
    }

    lines.splice(end, 0, ...entry);
    return lines.join("\n");
  }

  const mine = lines.findIndex((line) => /^##\s+Mine/i.test(line));
  const next = lines.findIndex((line, index) => index > mine && /^##\s/.test(line));
  let at = next === -1 ? lines.length : next;
  while (at > mine + 1 && lines[at - 1].trim() === "") {
    at -= 1;
  }

  const gap = at < lines.length && lines[at].trim() !== "" ? [""] : [];
  lines.splice(at, 0, ...entry, ...gap);
  return lines.join("\n");
}

// Shows findings as comment threads on their lines, and writes new comments to the findings file.
class FindingsComments {
  constructor(getBrief) {
    this.getBrief = getBrief;
    this.threads = [];
    this.controller = vscode.comments.createCommentController("brief", "Brief findings");
    this.controller.commentingRangeProvider = {
      provideCommentingRanges: (document) => {
        const brief = getBrief();
        const inside = brief && document.uri.scheme === "file" && document.uri.fsPath.startsWith(brief.model.root);
        return inside ? [new vscode.Range(0, 0, Math.max(document.lineCount - 1, 0), 0)] : [];
      },
    };
  }

  show(brief) {
    this.threads.forEach((thread) => thread.dispose());
    this.threads = (brief ? brief.findings : [])
      .filter((finding) => finding.file)
      .map((finding) => {
        const uri = vscode.Uri.file(path.join(brief.model.root, finding.file));
        const comment = {
          body: new vscode.MarkdownString(finding.claim || finding.raw),
          mode: vscode.CommentMode.Preview,
          author: { name: finding.source === "mine" ? "Mine" : "Claude review" },
        };
        const thread = this.controller.createCommentThread(uri, lineRange(finding.line), [comment]);
        thread.label = finding.header;
        thread.findingId = finding.id;
        thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
        return thread;
      });
  }

  async save(reply) {
    const brief = this.getBrief();
    const uri = findingsUri(brief.uri);
    let text;
    try {
      text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
    } catch {
      text = FINDINGS_TEMPLATE;
    }

    const body = reply.text.trim().split("\n").map((line) => `  ${line}`);
    const replyTo = reply.thread.findingId;
    let entry = body.map((line, index) => (index === 0 ? `  ↳ ${line.trim()}` : line));
    if (!replyTo) {
      const file = path.relative(brief.model.root, reply.thread.uri.fsPath);
      const line = reply.thread.range.start.line + 1;
      const taken = brief.findings.filter((f) => /^M\d+$/.test(f.id)).map((f) => Number(f.id.slice(1)));
      const id = `M${Math.max(0, ...taken) + 1}`;
      entry = [`- **${id}** · [${path.basename(file)}:${line}](<${file}#L${line}>)`, ...body];
      reply.thread.dispose();
    }

    await vscode.workspace.fs.writeFile(uri, Buffer.from(insertFinding(text, entry, replyTo)));
  }
}

function diffLinkHandler(report) {
  return {
    handleUri(uri) {
      if (uri.path !== "/diff") {
        return;
      }

      const params = new URLSearchParams(uri.query);
      openDiff({
        file: params.get("file"),
        base: params.get("base"),
        line: Number(params.get("line") || 1),
        status: params.get("status") || "M",
      }).catch(report);
    },
  };
}

// One edge of a path: the line in the caller that calls the next step.
// The caller of a step is the step named by its `caller`, or else the nearest earlier step in the
// file that holds its call site. A step with neither starts a new top-level branch of the path.
function stepFiles(step) {
  return step.hunks ? step.hunks.map((hunk) => hunk.file) : [step.file];
}

function callerIndex(steps, index) {
  const step = steps[index];
  if (step.caller) {
    const named = steps.findIndex((s, i) => i < index && s.fn === step.caller);
    return named === -1 ? undefined : named;
  }

  if (!step.via) {
    return undefined;
  }

  for (let i = index - 1; i >= 0; i -= 1) {
    if (stepFiles(steps[i]).includes(step.via.file)) {
      return i;
    }
  }

  return index > 0 ? index - 1 : undefined;
}

// Where a step starts. A `same_as` step starts where the step it names starts.
function stepTarget(brief, step) {
  if (step.same_as) {
    const shown = brief.model.paths.flatMap((p) => p.steps).find((s) => s.fn === step.fn && !s.same_as);
    return shown ? stepTarget(brief, shown) : undefined;
  }

  if (step.hunks && step.hunks.length) {
    return step.hunks[0];
  }

  return step.file ? { file: step.file, line: step.line } : undefined;
}

function callEdges(brief) {
  const edges = [];
  for (const section of brief.model.paths) {
    section.steps.forEach((step, index) => {
      const callerAt = callerIndex(section.steps, index);
      if (!step.via || callerAt === undefined) {
        return;
      }

      const caller = section.steps[callerAt];
      const target = stepTarget(brief, step);
      if (!target) {
        return;
      }

      edges.push({ via: step.via, caller: caller.fn, callee: step.fn, target, path: section.heading });
    });
  }

  return edges;
}

function noteAt(line, text) {
  return { range: lineRange(line), renderOptions: { after: { contentText: `  ${text}`, color: "rgba(80,140,255,0.95)" } } };
}

function lineRange(line) {
  return new vscode.Range(line - 1, 0, line - 1, 0);
}

class CallSites {
  constructor() {
    this.edges = [];
    this.root = "";
    this.emitter = new vscode.EventEmitter();
    this.onDidChangeCodeLenses = this.emitter.event;
    this.decoration = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: "rgba(80,140,255,0.10)",
      borderStyle: "solid",
      borderColor: "rgba(80,140,255,0.85)",
      borderWidth: "0 0 0 3px",
      overviewRulerColor: "rgba(80,140,255,0.85)",
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    });
    this.note = vscode.window.createTextEditorDecorationType({ isWholeLine: true });
  }

  set(brief) {
    this.brief = brief;
    this.edges = brief ? callEdges(brief) : [];
    this.root = brief ? brief.model.root : "";
    this.emitter.fire();
    this.decorate(vscode.window.visibleTextEditors);
  }

  relative(uri) {
    return uri.scheme === "file" ? path.relative(this.root, uri.fsPath) : undefined;
  }

  // The note a click on this line's end means, as the target to go to.
  noteTarget(file, line) {
    for (const edge of this.edges) {
      if (edge.via.file === file && edge.via.line === line) {
        return edge.target;
      }

      if (edge.via.file === file && this.visibleAnchor(file, edge.via.line) === line) {
        return edge.via;
      }

      if (edge.target.file === file && edge.target.line === line) {
        return edge.via;
      }
    }

    return undefined;
  }

  isShown(target) {
    return this.visibleAnchor(target.file, target.line) === target.line && this.brief.order.some((h) => h.file === target.file);
  }

  decorate(editors) {
    for (const editor of editors) {
      const file = this.relative(editor.document.uri);
      if (!file) {
        continue;
      }

      const sites = [];
      const notes = [];
      for (const edge of this.edges) {
        if (edge.via.file === file) {
          sites.push(noteAt(edge.via.line, `→ calls ${edge.callee}`));
          const anchor = this.visibleAnchor(file, edge.via.line);
          if (anchor !== edge.via.line) {
            notes.push(noteAt(anchor, `${anchor < edge.via.line ? "↓" : "↑"} line ${edge.via.line} calls ${edge.callee} (hidden)`));
          }
        }

        if (edge.target.file === file) {
          notes.push(noteAt(edge.target.line, `← called from ${edge.caller} at ${path.basename(edge.via.file)}:${edge.via.line}`));
        }
      }

      editor.setDecorations(this.decoration, sites);
      editor.setDecorations(this.note, notes);
    }
  }

  // A diff hides lines outside its hunks, so a call site there needs a lens on a line it shows.
  visibleAnchor(file, line) {
    const hunks = this.brief ? this.brief.order.filter((hunk) => hunk.file === file) : [];
    const last = (hunk) => hunk.new_start + hunk.new_len - 1;
    if (!hunks.length || hunks.some((hunk) => line >= hunk.new_start && line <= last(hunk))) {
      return line;
    }

    const before = hunks.filter((hunk) => last(hunk) < line);
    return before.length ? last(before[before.length - 1]) : hunks[0].new_start;
  }

  provideCodeLenses(document) {
    const file = this.relative(document.uri);
    const lenses = [];
    for (const edge of this.edges) {
      if (edge.via.file === file) {
        lenses.push(new vscode.CodeLens(lineRange(edge.via.line), {
          title: `Next on path: ${edge.callee}`,
          command: "brief.openTarget",
          arguments: [edge.target],
        }));

        const anchor = this.visibleAnchor(file, edge.via.line);
        if (anchor !== edge.via.line) {
          lenses.push(new vscode.CodeLens(lineRange(anchor), {
            title: `${anchor < edge.via.line ? "↓" : "↑"} line ${edge.via.line} calls ${edge.callee} (hidden)`,
            command: "brief.openTarget",
            arguments: [edge.via],
          }));
        }
      }

      if (edge.target.file === file) {
        lenses.push(new vscode.CodeLens(lineRange(edge.target.line), {
          title: `← called from ${edge.caller} at ${path.basename(edge.via.file)}:${edge.via.line}`,
          command: "brief.openTarget",
          arguments: [edge.via],
        }));
      }
    }

    return lenses;
  }
}

// A note is text after the end of a line, and a click on it puts the cursor at that end. The
// click then goes to the note's target: in a diff already on screen when it shows that line,
// else in a single-file diff.
function followNoteClicks(callSites, nav) {
  return vscode.window.onDidChangeTextEditorSelection(async (event) => {
    const selection = event.selections[0];
    const file = callSites.relative(event.textEditor.document.uri);
    if (event.kind !== vscode.TextEditorSelectionChangeKind.Mouse || !file || !selection.isEmpty) {
      return;
    }

    const line = selection.active.line + 1;
    if (selection.active.character < event.textEditor.document.lineAt(line - 1).text.length) {
      return;
    }

    const target = callSites.noteTarget(file, line);
    if (!target) {
      return;
    }

    const targetPath = path.join(callSites.root, target.file);
    const shown = vscode.window.visibleTextEditors.find((e) => e.document.uri.scheme === "file" && e.document.uri.fsPath === targetPath);
    if (!shown || !callSites.isShown(target)) {
      return nav.openTarget(target);
    }

    const range = lineRange(target.line);
    shown.selection = new vscode.Selection(range.start, range.start);
    shown.revealRange(range, vscode.TextEditorRevealType.InCenter);
  });
}

// Selects the tree node of the hunk under the cursor, in the multi-file diff or any diff.
function followCursor(getBrief, provider, view, onHunk) {
  let shown;
  return vscode.window.onDidChangeTextEditorSelection(async (event) => {
    const brief = getBrief();
    if (!brief || !view.visible) {
      return;
    }

    const hunk = brief.hunkAt(event.textEditor.document.uri, event.selections[0].active.line + 1);
    const node = hunk && provider.find(hunk);
    if (!node || hunk === shown) {
      return;
    }

    shown = hunk;
    onHunk(hunk);
    await view.reveal(node, { select: true, focus: false });
  });
}

// Opens hunks and call targets, and keeps the tree selection on the hunk last opened.
class Navigator {
  constructor(provider, view) {
    this.provider = provider;
    this.view = view;
    this.brief = undefined;
    this.position = -1;
  }

  async openAll() {
    if (this.brief) {
      await openChanges(`${this.brief.model.title} (brief order)`, this.brief.changes(this.brief.order));
    }
  }

  async openPath(node) {
    const hunks = node.section.steps.flatMap((step) => step.hunks || []);
    await openChanges(node.section.heading, this.brief.changes(hunks));
  }

  async openHunk(hunk) {
    this.position = this.brief.order.indexOf(hunk);
    await openDiff(this.brief.target(hunk));

    const node = this.provider.find(hunk);
    if (node && this.view.visible) {
      await this.view.reveal(node, { select: true, focus: false });
    }
  }

  async openTarget(target) {
    const model = this.brief.model;
    const hunk = this.brief.order.find((h) => h.file === target.file && h.line === target.line);
    if (hunk) {
      return this.openHunk(hunk);
    }

    const file = path.join(model.root, target.file);
    const status = model.statuses[target.file];
    if (status) {
      return openDiff({ file, base: model.base, line: target.line, status });
    }

    return vscode.window.showTextDocument(vscode.Uri.file(file), { selection: lineRange(target.line), preview: true });
  }

  async move(delta) {
    if (!this.brief || !this.brief.order.length) {
      return;
    }

    this.position = Math.min(Math.max(this.position + delta, 0), this.brief.order.length - 1);
    await this.openHunk(this.brief.order[this.position]);
  }
}

function activate(context) {
  const provider = new TreeProvider();
  const callSites = new CallSites();
  const view = vscode.window.createTreeView("brief.view", { treeDataProvider: provider, showCollapseAll: true });
  const nav = new Navigator(provider, view);
  const comments = new FindingsComments(() => nav.brief);

  async function refresh(openOnLoad) {
    const brief = await loadBrief();
    nav.brief = brief;
    vscode.commands.executeCommand("setContext", "brief.active", Boolean(brief));
    callSites.set(brief);
    comments.show(brief);
    if (!brief) {
      provider.set([]);
      view.message = undefined;
      return;
    }

    const model = brief.model;
    view.title = model.title;
    view.message = `${model.brief}\n\n+${model.added} −${model.deleted}`;
    provider.set(buildTree(brief));

    // The multi-file diff opens once per brief version, not on every window reload.
    const key = `opened:${brief.uri.toString()}:${model.generated}`;
    if (openOnLoad && !context.workspaceState.get(key)) {
      await context.workspaceState.update(key, true);
      await nav.openAll();
      await vscode.commands.executeCommand("brief.view.focus");
    }
  }

  const report = (error) => vscode.window.showErrorMessage(`brief: ${error.message}`);
  const watcher = vscode.workspace.createFileSystemWatcher("**/*.brief.json");
  watcher.onDidChange(() => refresh(true).catch(report));
  watcher.onDidCreate(() => refresh(true).catch(report));
  watcher.onDidDelete(() => refresh(false).catch(report));
  const findingsWatcher = vscode.workspace.createFileSystemWatcher("**/*.brief-findings.md");
  findingsWatcher.onDidChange(() => refresh(false).catch(report));
  findingsWatcher.onDidCreate(() => refresh(false).catch(report));

  const commands = {
    "brief.openAll": () => nav.openAll(),
    "brief.openPath": (node) => nav.openPath(node),
    "brief.openHunk": (hunk) => nav.openHunk(hunk),
    "brief.openTarget": (target) => nav.openTarget(target),
    "brief.next": () => nav.move(1),
    "brief.previous": () => nav.move(-1),
    "brief.openFileAtCursor": openFileAtCursor,
    "brief.refresh": () => refresh(false),
    "brief.saveFinding": (reply) => comments.save(reply).catch(report),
  };

  context.subscriptions.push(
    view,
    watcher,
    findingsWatcher,
    comments.controller,
    ...Object.entries(commands).map(([id, run]) => vscode.commands.registerCommand(id, run)),
    vscode.languages.registerCodeLensProvider({ scheme: "file" }, callSites),
    vscode.window.onDidChangeVisibleTextEditors((editors) => callSites.decorate(editors)),
    followNoteClicks(callSites, nav),
    followCursor(() => nav.brief, provider, view, (hunk) => (nav.position = nav.brief.order.indexOf(hunk))),
    vscode.window.registerUriHandler(diffLinkHandler(report))
  );

  refresh(true).catch(report);
}

module.exports = { activate };
