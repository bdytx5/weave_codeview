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
    parent_id: string | null;
    trace_id: string | null;
    git_repo_root: string | null;
    git_commit: string | null;
    git_dirty: boolean;
    git_snapshot_sha: string | null;
    callsite_file: string | null;
    callsite_line: number | null;
}

interface TraceStore {
    activeRunId: string | null;
    activeProject: string | null;
    runTraces: Map<string, TraceRecord[]>;
    selectedCallId: string | null;
    focusedFn: string | null;
    suppressCursorFilter: boolean;
    highlightActive: boolean;
    snapshotRepoRoot: string | null;
    snapshotOriginalCommit: string | null;
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
    // For monkey-patched ops (e.g. openai), weave has no @weave.op source info
    // but we capture callsite_* at call time — use those as fallback.
    if (!fnName) {
        fnName = (raw['callsite_function'] as string) ?? null;
    }
    const sourceFile = (raw['source_file'] as string) ?? (raw['callsite_file'] as string) ?? null;
    const sourceLineStart = (raw['source_line_start'] as number)
        ?? (raw['callsite_line'] as number)
        ?? null;
    const sourceLineEnd = (raw['source_line_end'] as number)
        ?? (raw['callsite_line'] as number)
        ?? null;
    return {
        call_id: raw['call_id'] as string,
        function: fnName ?? '(unknown)',
        op_name: (raw['op_name'] as string) ?? null,
        wandb_url: (raw['wandb_url'] as string) ?? null,
        source_file: sourceFile,
        source_line_start: sourceLineStart,
        source_line_end: sourceLineEnd,
        timestamp_start: raw['timestamp_start'] as number,
        duration_s: (raw['duration_s'] as number) ?? 0,
        inputs: (raw['inputs'] as Record<string, unknown>) ?? {},
        output: raw['output'] ?? null,
        error: (raw['error'] as TraceRecord['error']) ?? null,
        parent_id: (raw['parent_id'] as string) ?? null,
        trace_id: (raw['trace_id'] as string) ?? null,
        git_repo_root: (raw['git_repo_root'] as string) ?? null,
        git_commit: (raw['git_commit'] as string) ?? null,
        git_dirty: (raw['git_dirty'] as boolean) ?? false,
        git_snapshot_sha: (raw['git_snapshot_sha'] as string) ?? null,
        callsite_file: (raw['callsite_file'] as string) ?? null,
        callsite_line: (raw['callsite_line'] as number) ?? null,
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

    // 1. Git repo check — use git itself, not just .git folder presence (repo root may be parent)
    let isGitRepo = false;
    try {
        const result = execSync('git rev-parse --show-toplevel', { cwd: wsRoot, encoding: 'utf8' }).trim();
        isGitRepo = result.length > 0;
    } catch { isGitRepo = false; }
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

const CODEWEAVE_CACHE = path.join(
    process.env['HOME'] || process.env['USERPROFILE'] || '~',
    '.cache', 'codeweave'
);

function getProjects(): string[] {
    try {
        return fs.readdirSync(CODEWEAVE_CACHE)
            .filter(f => fs.statSync(path.join(CODEWEAVE_CACHE, f)).isDirectory())
            .sort();
    } catch { return []; }
}

function getRunsDir(project: string): string {
    return path.join(CODEWEAVE_CACHE, project);
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

function getRunGitState(runId: string, project: string): RunGitState | null {
    const runsDir = getRunsDir(project);
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

function getActualRepoRoot(recordedRoot: string | null): string | null {
    // Build candidate list: recorded root + all workspace folders
    const candidates: string[] = [];
    if (recordedRoot) { candidates.push(recordedRoot); }
    for (const f of vscode.workspace.workspaceFolders ?? []) { candidates.push(f.uri.fsPath); }
    for (const c of candidates) {
        try {
            const root = runGit(['rev-parse', '--show-toplevel'], c);
            if (root) { return root; }
        } catch { continue; }
    }
    return null;
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

    constructor(
        public readonly runId: string,
        public readonly project: string,
    ) {
        super(parseRunLabel(runId), vscode.TreeItemCollapsibleState.Collapsed);
        this.gitState = getRunGitState(runId, project);
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
        selected = false,
        hasChildren = false
    ) {
        super(trace.function, hasChildren ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
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

type TreeElement = TraceRunItem | TraceCallItem;

class TraceTreeProvider implements vscode.TreeDataProvider<TreeElement> {
    private _onDidChangeTreeData = new vscode.EventEmitter<TreeElement | undefined | null | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
    public treeView: vscode.TreeView<TreeElement> | undefined;

    constructor(private readonly store: TraceStore) {}

    refresh(): void {
        // Auto-select first project if none selected
        if (!this.store.activeProject) {
            const projects = getProjects();
            if (projects.length > 0) { this.store.activeProject = projects[0]; }
        }
        this._updateTitle();
        this._onDidChangeTreeData.fire();
    }

    setProject(project: string): void {
        this.store.activeProject = project;
        this.store.activeRunId = null;
        this.store.runTraces.clear();
        this._updateTitle();
        this._onDidChangeTreeData.fire();
    }

    private _updateTitle(): void {
        if (this.treeView) {
            this.treeView.title = this.store.activeProject
                ? `Runs — ${this.store.activeProject}`
                : 'Runs';
        }
    }

    setFunctionFilter(fnName: string | null): void {
        this.store.focusedFn = fnName;
        this._onDidChangeTreeData.fire();
    }

    invalidateRun(runId: string): void {
        this.store.runTraces.delete(runId);
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: TreeElement): vscode.TreeItem { return element; }

    getChildren(element?: TreeElement): vscode.ProviderResult<TreeElement[]> {
        // Root: list runs for active project
        if (!element) {
            if (!this.store.activeProject) { return []; }
            const runsDir = getRunsDir(this.store.activeProject);
            let runIds: string[] = [];
            try {
                runIds = fs.readdirSync(runsDir)
                    .filter(f => f.endsWith('.jsonl'))
                    .map(f => f.replace(/\.jsonl$/, ''))
                    .sort().reverse();
            } catch { return []; }
            return runIds.map(id => new TraceRunItem(id, this.store.activeProject!));
        }

        // Run → list root calls (no parent)
        if (element instanceof TraceRunItem) {
            const runId = element.runId;
            const project = element.project;
            if (!this.store.runTraces.has(runId)) {
                const runsDir = getRunsDir(project);
                const traces = loadTracesFromFile(path.join(runsDir, `${runId}.jsonl`));
                this.store.runTraces.set(runId, traces);
            }
            const traces = this.store.runTraces.get(runId) ?? [];
            const childIds = new Set(traces.filter(t => t.parent_id).map(t => t.parent_id!));
            return traces
                .filter(t => !t.parent_id)
                .map(t => new TraceCallItem(t, runId, false, childIds.has(t.call_id)));
        }

        // Call → list nested child calls
        if (element instanceof TraceCallItem) {
            const traces = this.store.runTraces.get(element.runId) ?? [];
            const childIds = new Set(traces.filter(t => t.parent_id).map(t => t.parent_id!));
            return traces
                .filter(t => t.parent_id === element.trace.call_id)
                .map(t => new TraceCallItem(t, element.runId, false, childIds.has(t.call_id)));
        }

        return [];
    }

    getParent(element: TreeElement): vscode.ProviderResult<TreeElement | null> {
        if (element instanceof TraceRunItem) { return null; }
        if (element instanceof TraceCallItem) { return new TraceRunItem(element.runId, this.store.activeProject ?? ''); }
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
        if (selectedCallId) {
            const selected = highlightTraces.filter(t => t.call_id === selectedCallId);
            if (selected.length > 0) { highlightTraces = selected; }
        } else if (focusedFn) {
            highlightTraces = highlightTraces.filter(t => t.function === focusedFn);
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
    const savedProject = context.globalState.get<string>('activeProject') ?? null;
    const store: TraceStore = {
        activeRunId: null,
        activeProject: savedProject,
        runTraces: new Map(),
        selectedCallId: null,
        focusedFn: null,
        suppressCursorFilter: false,
        highlightActive: true,
        snapshotRepoRoot: null,
        snapshotOriginalCommit: null,
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

    function enterSnapshotMode(repoRoot: string, originalCommit: string | null): void {
        store.snapshotRepoRoot = repoRoot;
        store.snapshotOriginalCommit = originalCommit;
        snapshotStatusBar.show();
    }

    function exitSnapshotMode(): void {
        store.snapshotRepoRoot = null;
        store.snapshotOriginalCommit = null;
        snapshotStatusBar.hide();
    }

    const treeView = vscode.window.createTreeView('cdweaveTraceTree', {
        treeDataProvider: provider,
        showCollapseAll: true,
    });
    provider.treeView = treeView;
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

    const unlockFilesCmd = vscode.commands.registerCommand('cdweave.unlockFiles', () => {
        store.snapshotRepoRoot = null;
        store.snapshotOriginalCommit = null;
        snapshotStatusBar.hide();
        vscode.window.showInformationMessage('CodeWeave: Snapshot mode cleared.');
    });

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
            const repoRoot = getActualRepoRoot(gs.git_repo_root);
            const effectiveRoot = repoRoot ?? gs.git_repo_root;
            const dirty = hasUncommittedChanges(effectiveRoot);

            if (dirty) {
                const choice = await vscode.window.showErrorMessage(
                    'CodeWeave: You have uncommitted changes. Commit them first.',
                    { modal: true },
                    'Commit Now'
                );
                if (choice !== 'Commit Now') { return; }
                const msg = await vscode.window.showInputBox({
                    prompt: 'Commit message',
                    value: 'wip',
                });
                if (!msg) { return; }
                try {
                    runGit(['add', '-A'], effectiveRoot);
                    runGit(['commit', '-m', msg], effectiveRoot);
                } catch (e: unknown) {
                    const err = e as { message?: string };
                    vscode.window.showErrorMessage(`CodeWeave: Commit failed — ${err.message ?? String(e)}`);
                    return;
                }
            }

            try {
                const currentCommit = getCurrentHeadSha(effectiveRoot);
                runGit(['checkout', gs.git_snapshot_sha, '--', '.'], effectiveRoot);
                enterSnapshotMode(effectiveRoot, currentCommit);
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
                const restoreTarget = store.snapshotOriginalCommit ?? getCurrentHeadSha(repoRoot);
                if (restoreTarget) {
                    runGit(['reset', '--hard', restoreTarget], repoRoot);
                }
                exitSnapshotMode();
                vscode.window.showInformationMessage('CDWeave: Restored to current code.');
            } catch (e: unknown) {
                const err = e as { message?: string };
                vscode.window.showErrorMessage(`CDWeave: Restore failed — ${err.message ?? String(e)}`);
            }
        }
    );

    function formatValue(val: unknown, indent: number): string {
        const pad = '  '.repeat(indent);
        if (val === null || val === undefined) { return 'null'; }
        if (typeof val === 'string') { return val; }
        if (typeof val !== 'object') { return String(val); }
        const entries = Object.entries(val as Record<string, unknown>);
        if (entries.length === 0) { return '{}'; }
        return '\n' + entries.map(([k, v]) => `${pad}- ${k}: ${formatValue(v, indent + 1)}`).join('\n');
    }

    function formatTrace(t: TraceRecord): string {
        const name = t.function;
        const lines: string[] = [];
        lines.push(`[${name}]`);
        lines.push(`  inputs: ${formatValue(t.inputs, 2)}`);
        if (t.error) {
            const errStr = typeof t.error === 'string' ? t.error : `${t.error.type}: ${t.error.message}`;
            lines.push(`  error: ${errStr}`);
        } else {
            lines.push(`  output: ${formatValue(t.output, 2)}`);
        }
        return lines.join('\n');
    }

    const copyRunTracesCmd = vscode.commands.registerCommand(
        'cdweave.copyRunTraces',
        async (item: TraceRunItem) => {
            const runsDir = getRunsDir(item.project);
            const traces = loadTracesFromFile(path.join(runsDir, `${item.runId}.jsonl`));
            if (traces.length === 0) {
                vscode.window.showInformationMessage('CDWeave: No traces found for this run.');
                return;
            }
            const outerTraces = traces.filter(t => !t.parent_id);
            await vscode.env.clipboard.writeText(outerTraces.map(formatTrace).join('\n\n'));
            const choice = await vscode.window.showInformationMessage(
                `CDWeave: Copied ${outerTraces.length} outer trace(s). Copy all ${traces.length} (including nested)?`,
                'Copy All'
            );
            if (choice === 'Copy All') {
                await vscode.env.clipboard.writeText(traces.map(formatTrace).join('\n\n'));
                vscode.window.showInformationMessage(`CDWeave: Copied all ${traces.length} trace(s).`);
            }
        }
    );

    const copyTraceCmd = vscode.commands.registerCommand(
        'cdweave.copyTrace',
        async (item: TraceCallItem) => {
            await vscode.env.clipboard.writeText(formatTrace(item.trace));
            vscode.window.showInformationMessage('CDWeave: Copied trace to clipboard.');
        }
    );

    const goToCallSiteCmd = vscode.commands.registerCommand(
        'cdweave.goToCallSite',
        async (item: TraceCallItem) => {
            const file = item.trace.callsite_file;
            const line = item.trace.callsite_line;
            if (!file || line === null) {
                vscode.window.showInformationMessage('CDWeave: No call site info available for this trace.');
                return;
            }
            try {
                const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
                const editor = await vscode.window.showTextDocument(doc, { preserveFocus: false, preview: false });
                const pos = new vscode.Position(line - 1, 0);
                editor.selection = new vscode.Selection(pos, pos);
                editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
            } catch {
                vscode.window.showErrorMessage(`CDWeave: Could not open ${file}`);
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

            if (!store.runTraces.has(item.runId)) {
                const runsDir = getRunsDir(store.activeProject!);
                store.runTraces.set(item.runId, loadTracesFromFile(path.join(runsDir, `${item.runId}.jsonl`)));
            }

            allTracesProvider.refresh();
            detailProvider.showTrace(item.trace);

            if (item.trace.source_file) {
                try {
                    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(item.trace.source_file));
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
        }
    );

    // Watch ~/.cache/codeweave/**/*.jsonl for new runs across all projects
    const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(vscode.Uri.file(CODEWEAVE_CACHE), '**/*.jsonl')
    );

    watcher.onDidCreate(() => {
        provider.refresh();
        allTracesProvider.refresh();
    });

    watcher.onDidChange((uri) => {
        const runId = path.basename(uri.fsPath, '.jsonl');
        provider.invalidateRun(runId);
        if (runId === store.activeRunId) {
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

    // Always show the CodeWeave sidebar on activation
    vscode.commands.executeCommand('workbench.view.extension.cdweave-sidebar');

    const showCmd = vscode.commands.registerCommand('cdweave.show', () => {
        vscode.commands.executeCommand('workbench.view.extension.cdweave-sidebar');
    });

    const selectProjectCmd = vscode.commands.registerCommand('cdweave.selectProject', async () => {
        const projects = getProjects();
        if (projects.length === 0) {
            vscode.window.showInformationMessage('CodeWeave: No projects found in ~/.cache/codeweave/');
            return;
        }
        const picked = await vscode.window.showQuickPick(
            projects.map(p => ({
                label: p,
                description: p === store.activeProject ? '(active)' : undefined,
            })),
            { placeHolder: 'Select a project to view runs' }
        );
        if (picked) {
            provider.setProject(picked.label);
            allTracesProvider.refresh();
            context.globalState.update('activeProject', picked.label);
        }
    });

    context.subscriptions.push(showCmd, selectProjectCmd);

    context.subscriptions.push(
        treeView,
        allTracesView,
        detailView,
        hoverDisposable,
        unlockFilesCmd,
        clearFocusCmd,
        openTraceUrlCmd,
        restoreRunCodeCmd,
        restoreMainCodeCmd,
        copyRunTracesCmd,
        copyTraceCmd,
        goToCallSiteCmd,
        selectTraceCmd,
        { dispose: () => decorationManager.dispose() }
    );
}

export function deactivate() {}
