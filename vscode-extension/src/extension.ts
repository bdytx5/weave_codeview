import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------

interface TraceRecord {
    call_id: string;
    function: string;
    op_name: string | null;
    wandb_url: string | null;
    source_file: string | null;
    source_line_start: number | null;
    source_line_end: number | null;
    timestamp_start: number;
    duration_s: number;
    inputs: Record<string, unknown>;
    output: unknown;
    error: { type: string; message: string; traceback: string } | string | null;
    git_repo_root: string | null;
    git_commit: string | null;
    git_dirty: boolean;
    git_snapshot_sha: string | null;
}

interface TraceStore {
    activeRunId: string | null;
    runTraces: Map<string, TraceRecord[]>;
    selectedCallId: string | null;
    focusedFn: string | null;
    suppressCursorFilter: boolean;
    highlightActive: boolean;
    snapshotRepoRoot: string | null;  // set when viewing old snapshot code
    snapshotDidStash: boolean;        // whether we auto-stashed before entering snapshot mode
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
    let fnName = (raw['function'] as string) ?? null;
    if (!fnName && raw['op_name']) {
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
        git_repo_root: (raw['git_repo_root'] as string) ?? null,
        git_commit: (raw['git_commit'] as string) ?? null,
        git_dirty: (raw['git_dirty'] as boolean) ?? false,
        git_snapshot_sha: (raw['git_snapshot_sha'] as string) ?? null,
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

// ---------------------------------------------------------------------------
// Environment checks
// ---------------------------------------------------------------------------

function runEnvironmentChecks(): void {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) { return; }
    const wsRoot = folders[0].uri.fsPath;

    // 1. Git repo check
    const isGitRepo = fs.existsSync(path.join(wsRoot, '.git'));
    if (!isGitRepo) {
        vscode.window.showWarningMessage(
            'CodeWeave: No git repo found in workspace. Code restore features will not work.',
            'Copy init command'
        ).then(choice => {
            if (choice === 'Copy init command') {
                vscode.env.clipboard.writeText('git init && git add . && git commit -m "init"');
                vscode.window.showInformationMessage('Copied: git init && git add . && git commit -m "init"');
            }
        });
    }

    // 2. Weave package check — must have jsonl_logging_trace_server
    try {
        const python = execSync('which python || which python3', { encoding: 'utf8' }).trim().split('\n')[0];
        const result = execSync(
            `${python} -c "from weave.trace_server_bindings.jsonl_logging_trace_server import attach_jsonl_logger; print('ok')"`,
            { encoding: 'utf8', cwd: wsRoot }
        ).trim();
        if (result !== 'ok') { throw new Error('import failed'); }
    } catch {
        vscode.window.showWarningMessage(
            'CodeWeave: Custom weave package not found. Install it to enable trace logging.',
            'Copy install command'
        ).then(choice => {
            if (choice === 'Copy install command') {
                vscode.env.clipboard.writeText('pip install git+https://github.com/bdytx5/codeweave_package.git');
                vscode.window.showInformationMessage('Copied: pip install git+https://github.com/bdytx5/codeweave_package.git');
            }
        });
    }
}

function getRunsDir(): string | null {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) { return null; }
    // Find the first workspace folder that actually has a runs/ directory
    for (const folder of folders) {
        const candidate = path.join(folder.uri.fsPath, 'runs');
        if (fs.existsSync(candidate)) { return candidate; }
    }
    // Fall back to first folder (runs/ doesn't exist yet)
    return path.join(folders[0].uri.fsPath, 'runs');
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

interface RunGitState {
    git_repo_root: string | null;
    git_commit: string | null;
    git_dirty: boolean;
    git_snapshot_sha: string | null;
}

function getRunGitState(runId: string): RunGitState | null {
    const runsDir = getRunsDir();
    if (!runsDir) { return null; }
    const filePath = path.join(runsDir, `${runId}.jsonl`);
    if (!fs.existsSync(filePath)) { return null; }
    let content: string;
    try { content = fs.readFileSync(filePath, 'utf8'); } catch { return null; }
    for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) { continue; }
        try {
            const raw = JSON.parse(trimmed);
            return {
                git_repo_root: (raw['git_repo_root'] as string) ?? null,
                git_commit: (raw['git_commit'] as string) ?? null,
                git_dirty: (raw['git_dirty'] as boolean) ?? false,
                git_snapshot_sha: (raw['git_snapshot_sha'] as string) ?? null,
            };
        } catch { continue; }
    }
    return null;
}

function runGit(args: string[], cwd: string): string {
    return execSync(['git', ...args].join(' '), { cwd, encoding: 'utf8' }).trim();
}

function getCurrentHeadSha(repoRoot: string): string | null {
    try {
        return runGit(['rev-parse', '--short', 'HEAD'], repoRoot);
    } catch {
        return null;
    }
}

function hasUncommittedChanges(repoRoot: string): boolean {
    try {
        return runGit(['status', '--porcelain'], repoRoot).length > 0;
    } catch {
        return false;
    }
}

// ---------------------------------------------------------------------------
// Tree items
// ---------------------------------------------------------------------------

class TraceRunItem extends vscode.TreeItem {
    public readonly gitState: RunGitState | null;

    constructor(public readonly runId: string) {
        super(parseRunLabel(runId), vscode.TreeItemCollapsibleState.Collapsed);
        this.gitState = getRunGitState(runId);
        const gs = this.gitState;
        if (gs?.git_commit) {
            const dirtyMark = gs.git_dirty ? '*' : '';
            this.description = `${gs.git_commit}${dirtyMark}${gs.git_snapshot_sha ? '  📸' : ''}`;
        }
        this.iconPath = new vscode.ThemeIcon('history');
        this.contextValue = gs?.git_snapshot_sha ? 'traceRunWithSnapshot' : 'traceRun';
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

            // Warn if run's code state differs from current HEAD
            const gs = element.gitState;
            if (gs?.git_repo_root) {
                const currentHead = getCurrentHeadSha(gs.git_repo_root);
                const runCommit = gs.git_dirty ? gs.git_snapshot_sha?.slice(0, 8) : gs.git_commit;
                const isStale = gs.git_dirty
                    ? gs.git_snapshot_sha !== null  // always stale if it was dirty at run time
                    : currentHead !== null && gs.git_commit !== null && !currentHead.startsWith(gs.git_commit) && !gs.git_commit.startsWith(currentHead);
                if (isStale) {
                    const label = parseRunLabel(runId);
                    const runDesc = gs.git_dirty ? `snapshot ${gs.git_snapshot_sha?.slice(0, 8)}` : `commit ${gs.git_commit}`;
                    vscode.window.showWarningMessage(
                        `CDWeave: Run "${label}" was recorded at a different code version (${runDesc}, current HEAD: ${currentHead ?? 'unknown'}).`,
                        'Switch to this code'
                    ).then(choice => {
                        if (choice === 'Switch to this code') {
                            vscode.commands.executeCommand('cdweave.restoreRunCode', element);
                        }
                    });
                }
            }

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
        items.push(new DetailItem('duration', `${trace.duration_s.toFixed(3)}s`));

        const ts = new Date(trace.timestamp_start * 1000);
        items.push(new DetailItem('called at', ts.toLocaleTimeString()));

        const inputEntries = Object.entries(trace.inputs);
        if (inputEntries.length === 0) {
            items.push(new DetailItem('inputs', '(none)'));
        } else {
            const inputChildren = inputEntries.map(([k, v]) => {
                const valStr = JSON.stringify(v);
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
            items.push(new DetailItem('inputs', undefined, vscode.TreeItemCollapsibleState.Expanded, inputChildren));
        }

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
        const { activeRunId, runTraces, focusedFn, selectedCallId, highlightActive } = this.store;
        if (!activeRunId || !highlightActive) {
            editor.setDecorations(this._highlight, []);
            editor.setDecorations(this._gutter, []);
            return;
        }

        const allTraces = runTraces.get(activeRunId) ?? [];
        const filePath = editor.document.uri.fsPath;

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

        let highlightTraces = fileTraces;
        if (focusedFn) {
            highlightTraces = highlightTraces.filter(t => t.function === focusedFn);
        } else if (selectedCallId) {
            const selected = highlightTraces.filter(t => t.call_id === selectedCallId);
            if (selected.length > 0) { highlightTraces = selected; }
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
        const cursorLine = position.line;

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
            const cappedInputs = inputsJson.length > 1000 ? inputsJson.slice(0, 1000) + '...' : inputsJson;
            md.appendMarkdown(`**Inputs:**\n\`\`\`json\n${cappedInputs}\n\`\`\`\n`);

            if (t.error) {
                const errStr = typeof t.error === 'string' ? t.error : `${t.error.type}: ${t.error.message}`;
                md.appendMarkdown(`**Error:** ${errStr}\n\n`);
            } else {
                const outputStr = JSON.stringify(t.output, null, 2);
                const cappedOutput = outputStr.length > 1000 ? outputStr.slice(0, 1000) + '...' : outputStr;
                md.appendMarkdown(`**Output:**\n\`\`\`\n${cappedOutput}\n\`\`\`\n`);
            }

            if (t.wandb_url) {
                md.appendMarkdown(`[View in W&B](${t.wandb_url})\n\n`);
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
        highlightActive: true,
        snapshotRepoRoot: null,
        snapshotDidStash: false,
    };

    const provider = new TraceTreeProvider(store);
    const allTracesProvider = new AllTracesProvider(store);
    const detailProvider = new TraceDetailProvider();
    const decorationManager = new DecorationManager(store, context);
    const hoverProvider = new TraceHoverProvider(store);

    // Status bar button shown while viewing snapshot code
    const snapshotStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    snapshotStatusBar.text = '$(history) Viewing old code — click to restore current';
    snapshotStatusBar.tooltip = 'You are viewing a snapshot of the code from a past run. Click to restore HEAD.';
    snapshotStatusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    snapshotStatusBar.command = 'cdweave.restoreMainCode';
    context.subscriptions.push(snapshotStatusBar);

    function enterSnapshotMode(repoRoot: string, didStash: boolean): void {
        store.snapshotRepoRoot = repoRoot;
        store.snapshotDidStash = didStash;
        snapshotStatusBar.show();
        const config = vscode.workspace.getConfiguration('files');
        config.update('readonlyInclude', { '**/*': true }, vscode.ConfigurationTarget.Workspace);
    }

    function exitSnapshotMode(): void {
        const repoRoot = store.snapshotRepoRoot;
        const didStash = store.snapshotDidStash;
        store.snapshotRepoRoot = null;
        store.snapshotDidStash = false;
        snapshotStatusBar.hide();
        const config = vscode.workspace.getConfiguration('files');
        config.update('readonlyInclude', undefined, vscode.ConfigurationTarget.Workspace);
        if (didStash && repoRoot) {
            try {
                runGit(['stash', 'pop'], repoRoot);
            } catch {
                vscode.window.showWarningMessage('CDWeave: Could not auto-pop stash. Run "git stash pop" manually.');
            }
        }
    }

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

    const hoverDisposable = vscode.languages.registerHoverProvider(
        { language: 'python' },
        hoverProvider
    );

    const clearFocusCmd = vscode.commands.registerCommand(
        'cdweave.clearFocus',
        () => {
            store.highlightActive = false;
            store.focusedFn = null;
            store.selectedCallId = null;
            provider.setFunctionFilter(null);
            allTracesProvider.refresh();
            decorationManager.clearAll();
        }
    );

    const openTraceUrlCmd = vscode.commands.registerCommand(
        'cdweave.openTraceUrl',
        (item: TraceCallItem) => {
            const url = traceUrl(item.trace);
            if (url) {
                vscode.env.openExternal(vscode.Uri.parse(url));
            } else {
                vscode.window.showInformationMessage('CDWeave: No W&B URL available for this trace.');
            }
        }
    );

    const restoreRunCodeCmd = vscode.commands.registerCommand(
        'cdweave.restoreRunCode',
        async (item: TraceRunItem) => {
            const gs = item.gitState;
            if (!gs?.git_snapshot_sha || !gs.git_repo_root) {
                vscode.window.showWarningMessage('CDWeave: No snapshot found for this run.');
                return;
            }
            const shortSha = gs.git_snapshot_sha.slice(0, 8);
            const choice = await vscode.window.showWarningMessage(
                `View code from run "${parseRunLabel(item.runId)}" (snapshot ${shortSha})?\n\nYour current changes will be stashed and restored when you click "Back to current code".`,
                { modal: true },
                'View snapshot'
            );
            if (choice !== 'View snapshot') { return; }
            try {
                const dirty = hasUncommittedChanges(gs.git_repo_root);
                if (dirty) {
                    runGit(['stash', 'push', '-u', '-m', `cdweave: before snapshot ${shortSha}`], gs.git_repo_root);
                }
                runGit(['checkout', gs.git_snapshot_sha, '--', '.'], gs.git_repo_root);
                enterSnapshotMode(gs.git_repo_root, dirty);
            } catch (e: unknown) {
                const err = e as { message?: string };
                vscode.window.showErrorMessage(`CDWeave: Restore failed — ${err.message ?? String(e)}`);
            }
        }
    );

    const restoreMainCodeCmd = vscode.commands.registerCommand(
        'cdweave.restoreMainCode',
        async (item?: TraceRunItem) => {
            // Can be called from status bar (no item) or tree context menu (item provided)
            const repoRoot = store.snapshotRepoRoot ?? item?.gitState?.git_repo_root ?? null;
            if (!repoRoot) {
                vscode.window.showWarningMessage('CDWeave: Not currently viewing a snapshot.');
                return;
            }
            try {
                runGit(['checkout', 'HEAD', '--', '.'], repoRoot);
                exitSnapshotMode();
                vscode.window.showInformationMessage('CDWeave: Restored to current code (HEAD).');
            } catch (e: unknown) {
                const err = e as { message?: string };
                vscode.window.showErrorMessage(`CDWeave: Restore failed — ${err.message ?? String(e)}`);
            }
        }
    );

    const selectTraceCmd = vscode.commands.registerCommand(
        'cdweave.selectTrace',
        async (item: TraceCallItem) => {
            store.activeRunId = item.runId;
            store.selectedCallId = item.trace.call_id;
            store.focusedFn = item.trace.function;
            store.suppressCursorFilter = true;
            store.highlightActive = true;

            const runsDir = getRunsDir();
            if (runsDir && !store.runTraces.has(item.runId)) {
                store.runTraces.set(item.runId, loadTracesFromFile(path.join(runsDir, `${item.runId}.jsonl`)));
            }

            allTracesProvider.refresh();
            detailProvider.showTrace(item.trace);

            try {
                const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(item.trace.source_file!));
                const editor = await vscode.window.showTextDocument(doc, { preserveFocus: false, preview: false });
                const decoratorLine = Math.max(0, item.trace.source_line_start! - 2);
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
    let watcher: vscode.FileSystemWatcher | undefined;
    if (workspaceFolders && workspaceFolders.length > 0) {
        watcher = vscode.workspace.createFileSystemWatcher('**/runs/*.jsonl');

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

    vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor && store.activeRunId) {
            decorationManager.applyToEditor(editor);
        }
    }, null, context.subscriptions);

    vscode.window.onDidChangeTextEditorSelection((event) => {
        if (!store.activeRunId) { return; }
        if (store.suppressCursorFilter) {
            store.suppressCursorFilter = false;
            return;
        }

        const editor = event.textEditor;
        const cursorLine = event.selections[0].active.line;
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

    provider.refresh();
    allTracesProvider.refresh();

    if (store.activeRunId) {
        decorationManager.applyToAllVisibleEditors();
    }

    runEnvironmentChecks();

    context.subscriptions.push(
        treeView,
        allTracesView,
        detailView,
        hoverDisposable,
        clearFocusCmd,
        openTraceUrlCmd,
        restoreRunCodeCmd,
        restoreMainCodeCmd,
        selectTraceCmd,
        { dispose: () => decorationManager.dispose() }
    );
}

export function deactivate() {}
