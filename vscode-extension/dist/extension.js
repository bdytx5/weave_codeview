"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/extension.ts
var extension_exports = {};
__export(extension_exports, {
  activate: () => activate,
  deactivate: () => deactivate
});
module.exports = __toCommonJS(extension_exports);
var vscode = __toESM(require("vscode"));
var fs = __toESM(require("fs"));
var path = __toESM(require("path"));
function parseRunLabel(stem) {
  const parts = stem.split("_");
  if (parts.length >= 2) {
    const date = parts[0];
    const timePart = parts[1];
    if (date.length === 8 && timePart.length === 6) {
      return `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)} ${timePart.slice(0, 2)}:${timePart.slice(2, 4)}:${timePart.slice(4)}`;
    }
  }
  return stem;
}
function normaliseTrace(raw) {
  let fnName = raw["function"] ?? null;
  if (!fnName && raw["op_name"]) {
    const opName = raw["op_name"];
    fnName = opName.split("/").pop()?.split(":")[0] ?? opName;
  }
  return {
    call_id: raw["call_id"],
    function: fnName ?? "(unknown)",
    op_name: raw["op_name"] ?? null,
    wandb_url: raw["wandb_url"] ?? null,
    source_file: raw["source_file"] ?? null,
    source_line_start: raw["source_line_start"] ?? null,
    source_line_end: raw["source_line_end"] ?? null,
    timestamp_start: raw["timestamp_start"],
    duration_s: raw["duration_s"] ?? 0,
    inputs: raw["inputs"] ?? {},
    output: raw["output"] ?? null,
    error: raw["error"] ?? null
  };
}
function loadTracesFromFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  let content;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch {
    return [];
  }
  const traces = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      traces.push(normaliseTrace(JSON.parse(trimmed)));
    } catch {
    }
  }
  traces.sort((a, b) => (a.timestamp_start || 0) - (b.timestamp_start || 0));
  return traces;
}
function traceUrl(trace) {
  return trace.wandb_url ?? null;
}
function getRunsDir() {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return null;
  }
  return path.join(folders[0].uri.fsPath, "runs");
}
var TraceRunItem = class extends vscode.TreeItem {
  constructor(runId) {
    super(parseRunLabel(runId), vscode.TreeItemCollapsibleState.Collapsed);
    this.runId = runId;
    this.iconPath = new vscode.ThemeIcon("history");
    this.contextValue = "traceRun";
  }
};
var TraceCallItem = class extends vscode.TreeItem {
  constructor(trace, runId, selected = false) {
    super(trace.function, vscode.TreeItemCollapsibleState.None);
    this.trace = trace;
    this.runId = runId;
    this.description = `${trace.duration_s.toFixed(3)}s${trace.wandb_url ? "  \u{1F369}" : ""}`;
    if (selected) {
      this.iconPath = new vscode.ThemeIcon("arrow-right", new vscode.ThemeColor("charts.yellow"));
    } else if (trace.error) {
      this.iconPath = new vscode.ThemeIcon("circle-filled", new vscode.ThemeColor("charts.red"));
    } else {
      this.iconPath = new vscode.ThemeIcon("circle-filled", new vscode.ThemeColor("charts.green"));
    }
    this.command = {
      command: "cdweave.selectTrace",
      title: "Select Trace",
      arguments: [this]
    };
    this.contextValue = trace.wandb_url ? "traceCallWithUrl" : "traceCall";
  }
};
var TraceTreeProvider = class {
  constructor(store) {
    this.store = store;
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
  }
  refresh() {
    const runsDir = getRunsDir();
    if (runsDir) {
      try {
        const files = fs.readdirSync(runsDir).filter((f) => f.endsWith(".jsonl")).sort().reverse();
        if (files.length > 0 && this.store.activeRunId === null) {
          this.store.activeRunId = files[0].replace(/\.jsonl$/, "");
        }
      } catch {
      }
    }
    this._onDidChangeTreeData.fire();
  }
  setFunctionFilter(fnName) {
    this.store.focusedFn = fnName;
    this._onDidChangeTreeData.fire();
  }
  invalidateRun(runId) {
    this.store.runTraces.delete(runId);
    this._onDidChangeTreeData.fire();
  }
  getTreeItem(element) {
    return element;
  }
  getChildren(element) {
    if (!element) {
      const runsDir = getRunsDir();
      if (!runsDir) {
        return [];
      }
      let files = [];
      try {
        files = fs.readdirSync(runsDir).filter((f) => f.endsWith(".jsonl")).sort().reverse();
      } catch {
        return [];
      }
      return files.map((f) => new TraceRunItem(f.replace(/\.jsonl$/, "")));
    }
    if (element instanceof TraceRunItem) {
      const runId = element.runId;
      if (!this.store.runTraces.has(runId)) {
        const runsDir = getRunsDir();
        if (!runsDir) {
          return [];
        }
        const traces2 = loadTracesFromFile(path.join(runsDir, `${runId}.jsonl`));
        this.store.runTraces.set(runId, traces2);
      }
      const traces = this.store.runTraces.get(runId) ?? [];
      return traces.map((t) => new TraceCallItem(t, runId));
    }
    return [];
  }
  getParent(element) {
    if (element instanceof TraceRunItem) {
      return null;
    }
    if (element instanceof TraceCallItem) {
      return new TraceRunItem(element.runId);
    }
    return null;
  }
};
var DetailItem = class extends vscode.TreeItem {
  constructor(label, description, collapsible = vscode.TreeItemCollapsibleState.None, children = []) {
    super(label, collapsible);
    this.children = children;
    this.description = description;
    this.contextValue = "detailItem";
  }
};
var TraceDetailProvider = class {
  constructor() {
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    this._items = [];
  }
  showTrace(trace) {
    if (!trace) {
      this._items = [];
      this._onDidChangeTreeData.fire();
      return;
    }
    const items = [];
    items.push(new DetailItem("duration", `${trace.duration_s.toFixed(3)}s`));
    const ts = new Date(trace.timestamp_start * 1e3);
    const timeStr = ts.toLocaleTimeString();
    items.push(new DetailItem("called at", timeStr));
    const inputEntries = Object.entries(trace.inputs);
    if (inputEntries.length === 0) {
      items.push(new DetailItem("inputs", "(none)"));
    } else {
      const inputChildren = inputEntries.map(([k, v]) => {
        const valStr = JSON.stringify(v);
        if (typeof v === "object" && v !== null) {
          const nested = this._buildObjectNodes(v);
          return new DetailItem(
            k,
            nested.length > 0 ? void 0 : valStr,
            nested.length > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
            nested
          );
        }
        return new DetailItem(k, valStr);
      });
      items.push(new DetailItem(
        "inputs",
        void 0,
        vscode.TreeItemCollapsibleState.Expanded,
        inputChildren
      ));
    }
    if (trace.error) {
      const errChildren = [
        new DetailItem("type", trace.error.type),
        new DetailItem("message", trace.error.message)
      ];
      items.push(new DetailItem("error", void 0, vscode.TreeItemCollapsibleState.Expanded, errChildren));
    } else {
      const outVal = trace.output;
      if (typeof outVal === "object" && outVal !== null) {
        const nested = this._buildObjectNodes(outVal);
        items.push(new DetailItem(
          "output",
          nested.length > 0 ? void 0 : JSON.stringify(outVal),
          nested.length > 0 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None,
          nested
        ));
      } else {
        items.push(new DetailItem("output", JSON.stringify(outVal)));
      }
    }
    this._items = items;
    this._onDidChangeTreeData.fire();
  }
  _buildObjectNodes(obj) {
    return Object.entries(obj).map(([k, v]) => {
      if (typeof v === "object" && v !== null) {
        const nested = this._buildObjectNodes(v);
        return new DetailItem(
          k,
          nested.length > 0 ? void 0 : JSON.stringify(v),
          nested.length > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
          nested
        );
      }
      return new DetailItem(k, JSON.stringify(v));
    });
  }
  getTreeItem(element) {
    return element;
  }
  getChildren(element) {
    if (!element) {
      return this._items;
    }
    return element.children;
  }
};
var AllTracesProvider = class {
  constructor(store) {
    this.store = store;
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    this._cachedItems = [];
  }
  refresh() {
    this._cachedItems = [];
    this._onDidChangeTreeData.fire();
  }
  getTreeItem(element) {
    return element;
  }
  getParent() {
    return null;
  }
  getChildren() {
    if (!this.store.activeRunId) {
      this._cachedItems = [];
      return [];
    }
    let traces = this.store.runTraces.get(this.store.activeRunId) ?? [];
    if (this.store.focusedFn) {
      traces = traces.filter((t) => t.function === this.store.focusedFn);
    }
    this._cachedItems = traces.map(
      (t) => new TraceCallItem(t, this.store.activeRunId, t.call_id === this.store.selectedCallId)
    );
    return this._cachedItems;
  }
};
var DecorationManager = class {
  constructor(store, context) {
    this.store = store;
    this._highlight = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor("editor.findMatchHighlightBackground"),
      borderWidth: "0 0 0 3px",
      borderStyle: "solid",
      borderColor: new vscode.ThemeColor("charts.blue"),
      overviewRulerColor: new vscode.ThemeColor("charts.blue"),
      overviewRulerLane: vscode.OverviewRulerLane.Right
    });
    this._gutter = vscode.window.createTextEditorDecorationType({
      gutterIconPath: context.asAbsolutePath("media/dot.svg"),
      gutterIconSize: "60%"
    });
  }
  applyToEditor(editor) {
    const { activeRunId, runTraces, focusedFn, selectedCallId } = this.store;
    if (!activeRunId) {
      editor.setDecorations(this._highlight, []);
      editor.setDecorations(this._gutter, []);
      return;
    }
    const allTraces = runTraces.get(activeRunId) ?? [];
    const filePath = editor.document.uri.fsPath;
    const fileTraces = allTraces.filter((t) => t.source_file === filePath && t.source_line_start !== null);
    const gutterSeen = /* @__PURE__ */ new Set();
    const gutterRanges = [];
    for (const t of fileTraces) {
      if (!gutterSeen.has(t.function)) {
        gutterSeen.add(t.function);
        const decoratorLine = Math.max(0, t.source_line_start - 2);
        gutterRanges.push(new vscode.Range(decoratorLine, 0, decoratorLine, 0));
      }
    }
    let highlightTraces = fileTraces;
    if (focusedFn) {
      highlightTraces = highlightTraces.filter((t) => t.function === focusedFn);
    } else if (selectedCallId) {
      const selected = highlightTraces.filter((t) => t.call_id === selectedCallId);
      if (selected.length > 0) {
        highlightTraces = selected;
      }
    }
    const highlightRanges = highlightTraces.map((t) => {
      const startLine = Math.max(0, t.source_line_start - 2);
      const endLine = t.source_line_end - 1;
      return new vscode.Range(startLine, 0, endLine, 0);
    });
    editor.setDecorations(this._highlight, highlightRanges);
    editor.setDecorations(this._gutter, gutterRanges);
  }
  applyToAllVisibleEditors() {
    for (const editor of vscode.window.visibleTextEditors) {
      this.applyToEditor(editor);
    }
  }
  clearAll() {
    for (const editor of vscode.window.visibleTextEditors) {
      editor.setDecorations(this._highlight, []);
      editor.setDecorations(this._gutter, []);
    }
  }
  dispose() {
    this._highlight.dispose();
    this._gutter.dispose();
  }
};
var TraceHoverProvider = class {
  constructor(store) {
    this.store = store;
  }
  provideHover(document, position) {
    if (!this.store.activeRunId) {
      return void 0;
    }
    const allTraces = this.store.runTraces.get(this.store.activeRunId) ?? [];
    const filePath = document.uri.fsPath;
    const cursorLine = position.line;
    const matches = allTraces.filter(
      (t) => t.source_file === filePath && t.source_line_start !== null && t.source_line_end !== null && cursorLine >= Math.max(0, t.source_line_start - 2) && cursorLine <= t.source_line_end - 1
    );
    if (matches.length === 0) {
      return void 0;
    }
    const fnName = matches[0].function;
    const md = new vscode.MarkdownString();
    md.isTrusted = true;
    md.appendMarkdown(`### \`${fnName}\`

`);
    matches.forEach((t, i) => {
      const ts = new Date(t.timestamp_start * 1e3);
      const timeStr = `${ts.getHours().toString().padStart(2, "0")}:${ts.getMinutes().toString().padStart(2, "0")}:${ts.getSeconds().toString().padStart(2, "0")}`;
      md.appendMarkdown(`**Call ${i + 1}** \u2014 ${timeStr}  
`);
      const inputsJson = JSON.stringify(t.inputs, null, 2);
      const cappedInputs = inputsJson.length > 1e3 ? inputsJson.slice(0, 1e3) + "\u2026" : inputsJson;
      md.appendMarkdown(`**Inputs:**
\`\`\`json
${cappedInputs}
\`\`\`
`);
      if (t.error) {
        const errStr = typeof t.error === "string" ? t.error : `${t.error.type}: ${t.error.message}`;
        md.appendMarkdown(`**Error:** ${errStr}

`);
      } else {
        const outputStr = JSON.stringify(t.output, null, 2);
        const cappedOutput = outputStr.length > 1e3 ? outputStr.slice(0, 1e3) + "\u2026" : outputStr;
        md.appendMarkdown(`**Output:**
\`\`\`
${cappedOutput}
\`\`\`
`);
      }
      if (t.wandb_url) {
        md.appendMarkdown(`[\u{1F369} View in W&B](${t.wandb_url})

`);
      }
      if (i < matches.length - 1) {
        md.appendMarkdown("\n---\n\n");
      }
    });
    const firstMatch = matches[0];
    const hoverRange = new vscode.Range(
      Math.max(0, firstMatch.source_line_start - 2),
      0,
      firstMatch.source_line_end - 1,
      0
    );
    return new vscode.Hover(md, hoverRange);
  }
};
function activate(context) {
  const store = {
    activeRunId: null,
    runTraces: /* @__PURE__ */ new Map(),
    selectedCallId: null,
    focusedFn: null,
    suppressCursorFilter: false
  };
  const provider = new TraceTreeProvider(store);
  const allTracesProvider = new AllTracesProvider(store);
  const detailProvider = new TraceDetailProvider();
  const decorationManager = new DecorationManager(store, context);
  const hoverProvider = new TraceHoverProvider(store);
  const treeView = vscode.window.createTreeView("cdweaveTraceTree", {
    treeDataProvider: provider,
    showCollapseAll: true
  });
  const allTracesView = vscode.window.createTreeView("cdweaveAllTraces", {
    treeDataProvider: allTracesProvider
  });
  const detailView = vscode.window.createTreeView("cdweaveTraceDetail", {
    treeDataProvider: detailProvider
  });
  const hoverDisposable = vscode.languages.registerHoverProvider(
    { language: "python" },
    hoverProvider
  );
  const openTraceUrlCmd = vscode.commands.registerCommand(
    "cdweave.openTraceUrl",
    (item) => {
      const url = traceUrl(item.trace);
      if (url) {
        vscode.env.openExternal(vscode.Uri.parse(url));
      } else {
        vscode.window.showInformationMessage("CDWeave: No W&B URL available for this trace (missing op_name).");
      }
    }
  );
  const selectTraceCmd = vscode.commands.registerCommand(
    "cdweave.selectTrace",
    async (item) => {
      store.activeRunId = item.runId;
      store.selectedCallId = item.trace.call_id;
      store.focusedFn = item.trace.function;
      store.suppressCursorFilter = true;
      const runsDir = getRunsDir();
      if (runsDir && !store.runTraces.has(item.runId)) {
        store.runTraces.set(item.runId, loadTracesFromFile(path.join(runsDir, `${item.runId}.jsonl`)));
      }
      allTracesProvider.refresh();
      detailProvider.showTrace(item.trace);
      try {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(item.trace.source_file));
        const editor = await vscode.window.showTextDocument(doc, { preserveFocus: false, preview: false });
        const decoratorLine = Math.max(0, item.trace.source_line_start - 2);
        editor.revealRange(
          new vscode.Range(decoratorLine, 0, decoratorLine, 0),
          vscode.TextEditorRevealType.InCenterIfOutsideViewport
        );
        decorationManager.applyToAllVisibleEditors();
      } catch {
        vscode.window.showErrorMessage(`CDWeave: Could not open ${item.trace.source_file}`);
      }
    }
  );
  const workspaceFolders = vscode.workspace.workspaceFolders;
  let watcher;
  if (workspaceFolders && workspaceFolders.length > 0) {
    watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(workspaceFolders[0], "runs/*.jsonl")
    );
    watcher.onDidCreate(() => {
      provider.refresh();
      allTracesProvider.refresh();
    });
    watcher.onDidChange((uri) => {
      const runId = path.basename(uri.fsPath, ".jsonl");
      provider.invalidateRun(runId);
      const runsDir = getRunsDir();
      if (runId === store.activeRunId && runsDir) {
        store.runTraces.set(runId, loadTracesFromFile(uri.fsPath));
        allTracesProvider.refresh();
        decorationManager.applyToAllVisibleEditors();
      }
    });
    watcher.onDidDelete((uri) => {
      const runId = path.basename(uri.fsPath, ".jsonl");
      store.runTraces.delete(runId);
      if (store.activeRunId === runId) {
        store.activeRunId = null;
        store.selectedCallId = null;
        decorationManager.clearAll();
      }
      provider.refresh();
      allTracesProvider.refresh();
    });
    context.subscriptions.push(watcher);
  }
  vscode.window.onDidChangeActiveTextEditor((editor) => {
    if (editor && store.activeRunId) {
      decorationManager.applyToEditor(editor);
    }
  }, null, context.subscriptions);
  vscode.window.onDidChangeTextEditorSelection((event) => {
    if (!store.activeRunId) {
      return;
    }
    if (store.suppressCursorFilter) {
      store.suppressCursorFilter = false;
      return;
    }
    const editor = event.textEditor;
    const cursorLine = event.selections[0].active.line;
    const traces = store.runTraces.get(store.activeRunId) ?? [];
    const filePath = editor.document.uri.fsPath;
    const hit = traces.find(
      (t) => t.source_file === filePath && t.source_line_start !== null && t.source_line_end !== null && cursorLine >= Math.max(0, t.source_line_start - 2) && cursorLine <= t.source_line_end - 1
    );
    const fnName = hit ? hit.function : null;
    if (fnName !== store.focusedFn) {
      provider.setFunctionFilter(fnName);
      allTracesProvider.refresh();
      decorationManager.applyToEditor(editor);
    }
  }, null, context.subscriptions);
  provider.refresh();
  allTracesProvider.refresh();
  if (store.activeRunId) {
    decorationManager.applyToAllVisibleEditors();
  }
  context.subscriptions.push(
    treeView,
    allTracesView,
    detailView,
    hoverDisposable,
    openTraceUrlCmd,
    selectTraceCmd,
    { dispose: () => decorationManager.dispose() }
  );
}
function deactivate() {
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  activate,
  deactivate
});
//# sourceMappingURL=extension.js.map
