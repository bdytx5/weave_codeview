import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------

interface TraceRecord {
    call_id: string;
    function: string;          // normalised — derived from op_name if not present
    op_name: string | null;
    wandb_url: string | null;  // pre-built by logger
    source_file: string | null;
    source_line_start: number | null;
    source_line_end: number | null;
    timestamp_start: number;
    duration_s: number;
    inputs: Record<string, unknown>;
    output: unknown;
    error: { type: string; message: string; traceback: string } | string | null;
}

interface TraceStore {
    activeRunId: string | null;
    runTraces: Map<string, TraceRecord[]>;
    selectedCallId: string | null;
    focusedFn: string | null;
    suppressCursorFilter: boolean;  // true after selectTrace fires; suppresses next cursor-based filter
}

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

function parseRunLabel(stem: string): string {
    const parts = stem.split('_');
    if (parts.length >= 2) {
        const date = parts[0];
        const timePart = parts[1];
        if (date.length === 8 && timePart.length === 6) {
            return `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)} ${timePart.slice(0, 2)}:${timePart.slice(2, 4)}:${timePart.slice(4)}`;
        }
    }
    return stem;
}

function normaliseTrace(raw: Record<string, unknown>): TraceRecord {
    // Support both cdwv format (has 'function') and real weave format (has 'op_name')
    let fnName = (raw['function'] as string) ?? null;
    if (!fnName && raw['op_name']) {
        // "weave:///project/op/my_func:abc123"  →  "my_func"
        const opName = raw['op_name'] as string;
        fnName = opName.split('/').pop()?.split(':')[0] ?? opName;
    }
    return {
        call_id: raw['call_id'] as string,
        function: fnName ?? '(unknown)',
        op_name: (raw['op_name'] as string) ?? null,
        wandb_url: (raw['wandb_url'] as string) ?? null,
        source_file: (raw['source_file'] as string) ?? null,
        source_line_start: (raw['source_line_start'] as number) ?? null,
        source_line_end: (raw['source_line_end'] as number) ?? null,
        timestamp_start: raw['timestamp_start'] as number,
        duration_s: (raw['duration_s'] as number) ?? 0,
        inputs: (raw['inputs'] as Record<string, unknown>) ?? {},
        output: raw['output'] ?? null,
        error: (raw['error'] as TraceRecord['error']) ?? null,
    };
}

function loadTracesFromFile(filePath: string): TraceRecord[] {
    if (!fs.existsSync(filePath)) { return []; }
    let content: string;
    try { content = fs.readFileSync(filePath, 'utf8'); } catch { return []; }
    const traces: TraceRecord[] = [];
    for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) { continue; }
        try { traces.push(normaliseTrace(JSON.parse(trimmed))); } catch { /* skip malformed */ }
    }
    traces.sort((a, b) => (a.timestamp_start || 0) - (b.timestamp_start || 0));
    return traces;
}

function traceUrl(trace: TraceRecord): string | null {
    return trace.wandb_url ?? null;
}

function getRunsDir(): string | null {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) { return null; }
    return path.join(folders[0].uri.fsPath, 'runs');
}

// ---------------------------------------------------------------------------
// Tree items
// ---------------------------------------------------------------------------

class TraceRunItem extends vscode.TreeItem {
    constructor(public readonly runId: string) {
        super(parseRunLabel(runId), vscode.TreeItemCollapsibleState.Collapsed);
        this.iconPath = new vscode.ThemeIcon('history');
        this.contextValue = 'traceRun';
    }
}

class TraceCallItem extends vscode.TreeItem {
    constructor(
        public readonly trace: TraceRecord,
        public readonly runId: string,
        selected = false
    ) {
        super(trace.function, vscode.TreeItemCollapsibleState.None);
        this.description = `${trace.duration_s.toFixed(3)}s${trace.wandb_url ? '  🍩' : ''}`;
        if (selected) {
            this.iconPath = new vscode.ThemeIcon('arrow-right', new vscode.ThemeColor('charts.yellow'));
        } else if (trace.error) {
            this.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.red'));
        } else {
            this.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.green'));
        }
        this.command = {
            command: 'cdweave.selectTrace',
            title: 'Select Trace',
            arguments: [this],
        };
        this.contextValue = trace.wandb_url ? 'traceCallWithUrl' : 'traceCall';
    }
}

// ---------------------------------------------------------------------------
// TraceTreeProvider
// ---------------------------------------------------------------------------

class TraceTreeProvider implements vscode.TreeDataProvider<TraceRunItem | TraceCallItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<TraceRunItem | TraceCallItem | undefined | null | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    constructor(private readonly store: TraceStore) {}

    refresh(): void {
        const runsDir = getRunsDir();
        if (runsDir) {
            try {
                const files = fs.readdirSync(runsDir)
                    .filter(f => f.endsWith('.jsonl'))
                    .sort()
                    .reverse();
                if (files.length > 0 && this.store.activeRunId === null) {
                    this.store.activeRunId = files[0].replace(/\.jsonl$/, '');
                }
            } catch { /* runs dir missing */ }
        }
        this._onDidChangeTreeData.fire();
    }

    setFunctionFilter(fnName: string | null): void {
        this.store.focusedFn = fnName;
        this._onDidChangeTreeData.fire();
    }

    invalidateRun(runId: string): void {
        this.store.runTraces.delete(runId);
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: TraceRunItem | TraceCallItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: TraceRunItem | TraceCallItem): vscode.ProviderResult<(TraceRunItem | TraceCallItem)[]> {
        if (!element) {
            // Root: list runs
            const runsDir = getRunsDir();
            if (!runsDir) { return []; }
            let files: string[] = [];
            try {
                files = fs.readdirSync(runsDir)
                    .filter(f => f.endsWith('.jsonl'))
                    .sort()
                    .reverse();
            } catch { return []; }
            return files.map(f => new TraceRunItem(f.replace(/\.jsonl$/, '')));
        }

        if (element instanceof TraceRunItem) {
            const runId = element.runId;
            if (!this.store.runTraces.has(runId)) {
                const runsDir = getRunsDir();
                if (!runsDir) { return []; }
                const traces = loadTracesFromFile(path.join(runsDir, `${runId}.jsonl`));
                this.store.runTraces.set(runId, traces);
            }
            const traces = this.store.runTraces.get(runId) ?? [];
            return traces.map(t => new TraceCallItem(t, runId));
        }

        return [];
    }

    getParent(element: TraceRunItem | TraceCallItem): vscode.ProviderResult<TraceRunItem | null> {
        if (element instanceof TraceRunItem) { return null; }
        if (element instanceof TraceCallItem) { return new TraceRunItem(element.runId); }
        return null;
    }
}

// ---------------------------------------------------------------------------
// TraceDetailProvider
// ---------------------------------------------------------------------------

class DetailItem extends vscode.TreeItem {
    constructor(
        label: string,
        description?: string,
        collapsible = vscode.TreeItemCollapsibleState.None,
        public readonly children: DetailItem[] = []
    ) {
        super(label, collapsible);
        this.description = description;
        this.contextValue = 'detailItem';
    }
}

class TraceDetailProvider implements vscode.TreeDataProvider<DetailItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private _items: DetailItem[] = [];

    showTrace(trace: TraceRecord | null): void {
        if (!trace) {
            this._items = [];
            this._onDidChangeTreeData.fire();
            return;
        }

        const items: DetailItem[] = [];

        // duration
        items.push(new DetailItem('duration', `${trace.duration_s.toFixed(3)}s`));

        // timestamp
        const ts = new Date(trace.timestamp_start * 1000);
        const timeStr = ts.toLocaleTimeString();
        items.push(new DetailItem('called at', timeStr));

        // inputs
        const inputEntries = Object.entries(trace.inputs);
        if (inputEntries.length === 0) {
            items.push(new DetailItem('inputs', '(none)'));
        } else {
            const inputChildren = inputEntries.map(([k, v]) => {
                const valStr = JSON.stringify(v);
                // If the value is an object/array, make it expandable
                if (typeof v === 'object' && v !== null) {
                    const nested = this._buildObjectNodes(v as Record<string, unknown>);
                    return new DetailItem(
                        k, nested.length > 0 ? undefined : valStr,
                        nested.length > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
                        nested
                    );
                }
                return new DetailItem(k, valStr);
            });
            items.push(new DetailItem(
                'inputs', undefined,
                vscode.TreeItemCollapsibleState.Expanded,
                inputChildren
            ));
        }

        // output or error
        if (trace.error) {
            const errChildren = [
                new DetailItem('type', trace.error.type),
                new DetailItem('message', trace.error.message),
            ];
            items.push(new DetailItem('error', undefined, vscode.TreeItemCollapsibleState.Expanded, errChildren));
        } else {
            const outVal = trace.output;
            if (typeof outVal === 'object' && outVal !== null) {
                const nested = this._buildObjectNodes(outVal as Record<string, unknown>);
                items.push(new DetailItem(
                    'output', nested.length > 0 ? undefined : JSON.stringify(outVal),
                    nested.length > 0 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None,
                    nested
                ));
            } else {
                items.push(new DetailItem('output', JSON.stringify(outVal)));
            }
        }

        this._items = items;
        this._onDidChangeTreeData.fire();
    }

    private _buildObjectNodes(obj: Record<string, unknown>): DetailItem[] {
        return Object.entries(obj).map(([k, v]) => {
            if (typeof v === 'object' && v !== null) {
                const nested = this._buildObjectNodes(v as Record<string, unknown>);
                return new DetailItem(
                    k, nested.length > 0 ? undefined : JSON.stringify(v),
                    nested.length > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
                    nested
                );
            }
            return new DetailItem(k, JSON.stringify(v));
        });
    }

    getTreeItem(element: DetailItem): vscode.TreeItem { return element; }

    getChildren(element?: DetailItem): DetailItem[] {
        if (!element) { return this._items; }
        return element.children;
    }
}

// ---------------------------------------------------------------------------
// AllTracesProvider
// ---------------------------------------------------------------------------

class AllTracesProvider implements vscode.TreeDataProvider<TraceCallItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private _cachedItems: TraceCallItem[] = [];

    constructor(private readonly store: TraceStore) {}

    refresh(): void {
        this._cachedItems = [];
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: TraceCallItem): vscode.TreeItem { return element; }

    getParent(): null { return null; }

    getChildren(): TraceCallItem[] {
        if (!this.store.activeRunId) { this._cachedItems = []; return []; }
        let traces = this.store.runTraces.get(this.store.activeRunId) ?? [];
        if (this.store.focusedFn) {
            traces = traces.filter(t => t.function === this.store.focusedFn);
        }
        this._cachedItems = traces.map(t =>
            new TraceCallItem(t, this.store.activeRunId!, t.call_id === this.store.selectedCallId)
        );
        return this._cachedItems;
    }
}

// ---------------------------------------------------------------------------
// DecorationManager
// ---------------------------------------------------------------------------

class DecorationManager {
    private _highlight: vscode.TextEditorDecorationType;
    private _gutter: vscode.TextEditorDecorationType;

    constructor(
        private readonly store: TraceStore,
        context: vscode.ExtensionContext
    ) {
        this._highlight = vscode.window.createTextEditorDecorationType({
            isWholeLine: true,
            backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
            borderWidth: '0 0 0 3px',
            borderStyle: 'solid',
            borderColor: new vscode.ThemeColor('charts.blue'),
            overviewRulerColor: new vscode.ThemeColor('charts.blue'),
            overviewRulerLane: vscode.OverviewRulerLane.Right,
        });

        this._gutter = vscode.window.createTextEditorDecorationType({
            gutterIconPath: context.asAbsolutePath('media/dot.svg'),
            gutterIconSize: '60%',
        });
    }

    applyToEditor(editor: vscode.TextEditor): void {
        const { activeRunId, runTraces, focusedFn, selectedCallId } = this.store;
        if (!activeRunId) {
            editor.setDecorations(this._highlight, []);
            editor.setDecorations(this._gutter, []);
            return;
        }

        const allTraces = runTraces.get(activeRunId) ?? [];
        const filePath = editor.document.uri.fsPath;

        // Only traces with source info can decorate
        const fileTraces = allTraces.filter(t => t.source_file === filePath && t.source_line_start !== null);
        const gutterSeen = new Set<string>();
        const gutterRanges: vscode.Range[] = [];
        for (const t of fileTraces) {
            if (!gutterSeen.has(t.function)) {
                gutterSeen.add(t.function);
                const decoratorLine = Math.max(0, t.source_line_start! - 2);
                gutterRanges.push(new vscode.Range(decoratorLine, 0, decoratorLine, 0));
            }
        }

        // Highlight: filtered by focusedFn if set
        let highlightTraces = fileTraces;
        if (focusedFn) {
            highlightTraces = highlightTraces.filter(t => t.function === focusedFn);
        } else if (selectedCallId) {
            const selected = highlightTraces.filter(t => t.call_id === selectedCallId);
            if (selected.length > 0) {
                highlightTraces = selected;
            }
        }

        const highlightRanges: vscode.Range[] = highlightTraces.map(t => {
            const startLine = Math.max(0, t.source_line_start! - 2);
            const endLine = t.source_line_end! - 1;
            return new vscode.Range(startLine, 0, endLine, 0);
        });

        editor.setDecorations(this._highlight, highlightRanges);
        editor.setDecorations(this._gutter, gutterRanges);
    }

    applyToAllVisibleEditors(): void {
        for (const editor of vscode.window.visibleTextEditors) {
            this.applyToEditor(editor);
        }
    }

    clearAll(): void {
        for (const editor of vscode.window.visibleTextEditors) {
            editor.setDecorations(this._highlight, []);
            editor.setDecorations(this._gutter, []);
        }
    }

    dispose(): void {
        this._highlight.dispose();
        this._gutter.dispose();
    }
}

// ---------------------------------------------------------------------------
// TraceHoverProvider
// ---------------------------------------------------------------------------

class TraceHoverProvider implements vscode.HoverProvider {
    constructor(private readonly store: TraceStore) {}

    provideHover(
        document: vscode.TextDocument,
        position: vscode.Position
    ): vscode.ProviderResult<vscode.Hover> {
        if (!this.store.activeRunId) { return undefined; }

        const allTraces = this.store.runTraces.get(this.store.activeRunId) ?? [];
        const filePath = document.uri.fsPath;
        const cursorLine = position.line; // 0-indexed

        const matches = allTraces.filter(t =>
            t.source_file === filePath &&
            t.source_line_start !== null &&
            t.source_line_end !== null &&
            cursorLine >= Math.max(0, t.source_line_start - 2) &&
            cursorLine <= t.source_line_end - 1
        );

        if (matches.length === 0) { return undefined; }

        const fnName = matches[0].function;
        const md = new vscode.MarkdownString();
        md.isTrusted = true;
        md.appendMarkdown(`### \`${fnName}\`\n\n`);

        matches.forEach((t, i) => {
            const ts = new Date(t.timestamp_start * 1000);
            const timeStr = `${ts.getHours().toString().padStart(2, '0')}:${ts.getMinutes().toString().padStart(2, '0')}:${ts.getSeconds().toString().padStart(2, '0')}`;
            md.appendMarkdown(`**Call ${i + 1}** — ${timeStr}  \n`);

            const inputsJson = JSON.stringify(t.inputs, null, 2);
            const cappedInputs = inputsJson.length > 1000 ? inputsJson.slice(0, 1000) + '…' : inputsJson;
            md.appendMarkdown(`**Inputs:**\n\`\`\`json\n${cappedInputs}\n\`\`\`\n`);

            if (t.error) {
                const errStr = typeof t.error === 'string' ? t.error : `${t.error.type}: ${t.error.message}`;
                md.appendMarkdown(`**Error:** ${errStr}\n\n`);
            } else {
                const outputStr = JSON.stringify(t.output, null, 2);
                const cappedOutput = outputStr.length > 1000 ? outputStr.slice(0, 1000) + '…' : outputStr;
                md.appendMarkdown(`**Output:**\n\`\`\`\n${cappedOutput}\n\`\`\`\n`);
            }

            if (t.wandb_url) {
                md.appendMarkdown(`[🍩 View in W&B](${t.wandb_url})\n\n`);
            }

            if (i < matches.length - 1) { md.appendMarkdown('\n---\n\n'); }
        });

        const firstMatch = matches[0];
        const hoverRange = new vscode.Range(
            Math.max(0, firstMatch.source_line_start! - 2), 0,
            firstMatch.source_line_end! - 1, 0
        );

        return new vscode.Hover(md, hoverRange);
    }
}

// ---------------------------------------------------------------------------
// activate
// ---------------------------------------------------------------------------

export function activate(context: vscode.ExtensionContext) {
    const store: TraceStore = {
        activeRunId: null,
        runTraces: new Map(),
        selectedCallId: null,
        focusedFn: null,
        suppressCursorFilter: false,
    };

    const provider = new TraceTreeProvider(store);
    const allTracesProvider = new AllTracesProvider(store);
    const detailProvider = new TraceDetailProvider();
    const decorationManager = new DecorationManager(store, context);
    const hoverProvider = new TraceHoverProvider(store);

    // Register tree views
    const treeView = vscode.window.createTreeView('cdweaveTraceTree', {
        treeDataProvider: provider,
        showCollapseAll: true,
    });
    const allTracesView = vscode.window.createTreeView('cdweaveAllTraces', {
        treeDataProvider: allTracesProvider,
    });
    const detailView = vscode.window.createTreeView('cdweaveTraceDetail', {
        treeDataProvider: detailProvider,
    });

    // Register hover provider for Python files
    const hoverDisposable = vscode.languages.registerHoverProvider(
        { language: 'python' },
        hoverProvider
    );

    // Register openTraceUrl command — opens W&B trace page in browser
    const openTraceUrlCmd = vscode.commands.registerCommand(
        'cdweave.openTraceUrl',
        (item: TraceCallItem) => {
            const url = traceUrl(item.trace);
            if (url) {
                vscode.env.openExternal(vscode.Uri.parse(url));
            } else {
                vscode.window.showInformationMessage('CDWeave: No W&B URL available for this trace (missing op_name).');
            }
        }
    );

    // Register selectTrace command
    const selectTraceCmd = vscode.commands.registerCommand(
        'cdweave.selectTrace',
        async (item: TraceCallItem) => {
            store.activeRunId = item.runId;
            store.selectedCallId = item.trace.call_id;
            store.focusedFn = item.trace.function;
            store.suppressCursorFilter = true;

            const runsDir = getRunsDir();
            if (runsDir && !store.runTraces.has(item.runId)) {
                store.runTraces.set(item.runId, loadTracesFromFile(path.join(runsDir, `${item.runId}.jsonl`)));
            }

            // Refresh Selected Traces — getChildren will mark the selected item with arrow icon
            allTracesProvider.refresh();

            // Show trace details in the detail panel
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

    // File watcher
    const workspaceFolders = vscode.workspace.workspaceFolders;
    let watcher: vscode.FileSystemWatcher | undefined;
    if (workspaceFolders && workspaceFolders.length > 0) {
        watcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(workspaceFolders[0], 'runs/*.jsonl')
        );

        watcher.onDidCreate(() => {
            provider.refresh();
            allTracesProvider.refresh();
        });

        watcher.onDidChange((uri) => {
            const runId = path.basename(uri.fsPath, '.jsonl');
            provider.invalidateRun(runId);
            const runsDir = getRunsDir();
            if (runId === store.activeRunId && runsDir) {
                store.runTraces.set(runId, loadTracesFromFile(uri.fsPath));
                allTracesProvider.refresh();
                decorationManager.applyToAllVisibleEditors();
            }
        });

        watcher.onDidDelete((uri) => {
            const runId = path.basename(uri.fsPath, '.jsonl');
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

    // Active editor changed → apply decorations
    vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor && store.activeRunId) {
            decorationManager.applyToEditor(editor);
        }
    }, null, context.subscriptions);

    // Cursor movement → filter sidebar to focused function
    vscode.window.onDidChangeTextEditorSelection((event) => {
        if (!store.activeRunId) { return; }

        // If selectTrace just fired, skip this event and clear the flag
        if (store.suppressCursorFilter) {
            store.suppressCursorFilter = false;
            return;
        }

        const editor = event.textEditor;
        const cursorLine = event.selections[0].active.line; // 0-indexed
        const traces = store.runTraces.get(store.activeRunId) ?? [];
        const filePath = editor.document.uri.fsPath;

        const hit = traces.find(t =>
            t.source_file === filePath &&
            t.source_line_start !== null &&
            t.source_line_end !== null &&
            cursorLine >= Math.max(0, t.source_line_start - 2) &&
            cursorLine <= t.source_line_end - 1
        );

        const fnName = hit ? hit.function : null;
        if (fnName !== store.focusedFn) {
            provider.setFunctionFilter(fnName);
            allTracesProvider.refresh();
            decorationManager.applyToEditor(editor);
        }
    }, null, context.subscriptions);

    // Initial refresh
    provider.refresh();
    allTracesProvider.refresh();

    // Apply decorations to already-open editors once traces are loaded
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

export function deactivate() {}
