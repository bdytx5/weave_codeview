#!/usr/bin/env python3
"""CodeWeave terminal UI"""
from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path
from typing import Any

from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.containers import Container, VerticalScroll, Horizontal
from textual.widgets import Footer, Header, ListItem, ListView, RichLog, Static, Tree
from textual.widgets.tree import TreeNode
from rich.text import Text

CACHE_DIR = Path(os.path.expanduser("~")) / ".cache" / "codeweave"
LAST_PROJECT_FILE = CACHE_DIR / ".last_project"
DEBUG_LOG = CACHE_DIR / "exception_log.txt"

def _dbg(msg: str) -> None:
    try:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        with DEBUG_LOG.open("a") as f:
            import traceback, datetime
            f.write(f"\n[{datetime.datetime.now().isoformat()}] {msg}\n")
            f.write(traceback.format_exc() if traceback.format_exc().strip() != "NoneType: None" else "")
    except Exception:
        pass

# ---------------------------------------------------------------------------
# Data helpers
# ---------------------------------------------------------------------------

def _get_projects() -> list[str]:
    try:
        return sorted(p.name for p in CACHE_DIR.iterdir() if p.is_dir() and not p.name.startswith("."))
    except Exception:
        return []


def _get_runs(project: str) -> list[str]:
    try:
        return sorted((f.stem for f in (CACHE_DIR / project).glob("*.jsonl")), reverse=True)
    except Exception:
        return []


def _load_run(project: str, run_id: str) -> list[dict[str, Any]]:
    path = CACHE_DIR / project / f"{run_id}.jsonl"
    records: list[dict] = []
    try:
        for line in path.read_text().splitlines():
            line = line.strip()
            if line:
                try:
                    records.append(json.loads(line))
                except Exception:
                    pass
    except Exception:
        pass
    records.sort(key=lambda r: r.get("timestamp_start") or 0)
    return records


def _parse_run_label(stem: str) -> str:
    parts = stem.split("_")
    if len(parts) >= 2 and len(parts[0]) == 8 and len(parts[1]) == 6:
        d, t = parts[0], parts[1]
        return f"{d[:4]}-{d[4:6]}-{d[6:]} {t[:2]}:{t[2:4]}:{t[4:]}"
    return stem


def _fn_name(record: dict) -> str:
    name = record.get("function")
    if not name and record.get("op_name"):
        name = record["op_name"].split("/")[-1].split(":")[0]
    return name or record.get("callsite_function") or "(unknown)"


def _save_last_project(project: str) -> None:
    try:
        LAST_PROJECT_FILE.write_text(project)
    except Exception:
        pass


def _load_last_project() -> str | None:
    try:
        p = LAST_PROJECT_FILE.read_text().strip()
        return p if p else None
    except Exception:
        return None


def _build_children_map(records: list[dict]) -> dict[str, list[dict]]:
    children: dict[str, list[dict]] = {}
    for r in records:
        pid = r.get("parent_id") or "__root__"
        children.setdefault(pid, []).append(r)
    return children


def _node_label(record: dict) -> str:
    name = _fn_name(record)
    dur = f"{record['duration_s']:.2f}s" if record.get("duration_s") is not None else "?"
    err = " ✗" if record.get("error") else " ✓"
    url = " 🔗" if record.get("wandb_url") else ""
    return f"{name}  [{dur}]{err}{url}"


def _short(val: Any, maxlen: int = 120) -> str:
    if val is None:
        return "null"
    s = json.dumps(val) if not isinstance(val, str) else val
    return (s[:maxlen] + "…") if len(s) > maxlen else s


# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------

class CodeWeaveApp(App):

    CSS = """
    Screen {
        layout: vertical;
        overflow: hidden hidden;
    }

    #top-bar {
        height: 1;
        background: $accent-darken-3;
        color: $text-muted;
        padding: 0 2;
    }

    #main {
        layout: horizontal;
        height: 1fr;
    }

    #left {
        width: 34;
        layout: vertical;
        overflow: hidden hidden;
        border-right: solid $accent-darken-2;
    }

    #runs-box {
        height: 35%;
        layout: vertical;
        overflow: hidden hidden;
        border-bottom: solid $accent-darken-2;
    }

    #calls-box {
        height: 1fr;
        layout: vertical;
        overflow: hidden hidden;
    }

    .box-title {
        height: 1;
        background: $accent-darken-3;
        color: $text-muted;
        padding: 0 1;
    }

    ListView, Tree {
        width: 100%;
        height: 1fr;
    }

    #right {
        width: 1fr;
        layout: vertical;
        overflow: hidden hidden;
    }

    #code-box {
        height: 60%;
        layout: vertical;
        overflow: hidden hidden;
        border-bottom: solid $accent-darken-2;
    }

    #detail-box {
        height: 1fr;
        layout: vertical;
        overflow: hidden hidden;
    }

    #action-bar {
        height: 1;
        background: $accent-darken-3;
        padding: 0 1;
        color: $accent;
    }

    VerticalScroll {
        width: 100%;
        height: 1fr;
    }

    RichLog {
        width: 100%;
        height: 100%;
        padding: 0 1;
    }
    """

    BINDINGS = [
        Binding("q", "quit", "Quit"),
        Binding("escape", "focus_runs", "Runs"),
        Binding("r", "back_to_runs", "Back"),
        Binding("p", "pick_project", "Project"),
        Binding("c", "copy_trace", "Copy"),
        Binding("o", "open_url", "W&B"),
        Binding("j", "jump_callsite", "Jump"),
        Binding("1", "focus_runs", "Runs"),
        Binding("2", "focus_calls", "Calls"),
    ]

    def __init__(self, project: str | None = None):
        super().__init__()
        projects = _get_projects()
        self._project: str | None = None
        if project and project in projects:
            self._project = project
        else:
            self._project = _load_last_project() or (projects[0] if projects else None)
        self._run_ids: list[str] = []
        self._records: list[dict] = []
        self._selected: dict | None = None

    def compose(self) -> ComposeResult:
        yield Header()
        yield Static(id="top-bar")
        with Horizontal(id="main"):
            with Container(id="left"):
                with Container(id="runs-box"):
                    yield Static("Runs", classes="box-title")
                    yield ListView(id="runs-list")
                with Container(id="calls-box"):
                    yield Static("Calls", classes="box-title")
                    yield Tree("(select a run)", id="calls-tree")
            with Container(id="right"):
                with Container(id="code-box"):
                    yield Static("Source", classes="box-title")
                    with VerticalScroll(id="code-scroll"):
                        yield RichLog(id="code-viewer", wrap=False, highlight=False, auto_scroll=False)
                with Container(id="detail-box"):
                    yield Static("[c] Copy   [o] W&B   [j] Jump to callsite", id="action-bar")
                    with VerticalScroll(id="detail-scroll"):
                        yield RichLog(id="detail-viewer", wrap=True, highlight=False, auto_scroll=False)
        yield Footer()

    def on_mount(self) -> None:
        _dbg(f"[5] on_mount fired, project={self._project}, run_ids will load now")
        self.title = "CodeWeave"
        self._update_top_bar()
        self._load_runs()
        self.query_one("#runs-list", ListView).focus()


    # ------------------------------------------------------------------
    # Data
    # ------------------------------------------------------------------

    def _update_top_bar(self) -> None:
        self.query_one("#top-bar", Static).update(
            f" project: {self._project or '(none)'}   p=switch project   r=back to runs   1/2=focus runs/calls"
        )

    def _load_runs(self) -> None:
        if self._project:
            _save_last_project(self._project)
        self._selected = None
        self._update_top_bar()

        lv = self.query_one("#runs-list", ListView)
        lv.clear()
        self._run_ids = _get_runs(self._project) if self._project else []
        for run_id in self._run_ids:
            lv.append(ListItem(Static(f" {_parse_run_label(run_id)}")))

        self._reset_tree("(select a run)")
        self._clear_code()
        self._clear_detail()

    def _reset_tree(self, label: str) -> None:
        self.query_one("#calls-tree", Tree).reset(label)

    def _load_calls(self, run_id: str) -> None:
        _dbg(f"[3] _load_calls fired, run_id={run_id}, records will load from project={self._project}")
        self._records = _load_run(self._project, run_id)  # type: ignore[arg-type]
        _dbg(f"[3] _load_calls loaded {len(self._records)} records")

        self._reset_tree(_parse_run_label(run_id))
        tree = self.query_one("#calls-tree", Tree)
        tree.root.expand()

        children_map = _build_children_map(self._records)
        self._populate_tree(tree.root, "__root__", children_map)

        self._clear_code()
        self._clear_detail()
        tree.focus()
        self._set_active("calls-box")

    def _populate_tree(self, node: TreeNode, parent_id: str, children_map: dict) -> None:
        for record in children_map.get(parent_id, []):
            call_id = record.get("call_id", "")
            label = _node_label(record)
            has_children = call_id in children_map
            if has_children:
                child = node.add(label, data=record, expand=True)
                self._populate_tree(child, call_id, children_map)
            else:
                node.add_leaf(label, data=record)

    def _clear_code(self) -> None:
        cv = self.query_one("#code-viewer", RichLog)
        cv.clear()
        cv.write(Text("Select a call to view source.", style="dim italic"))

    def _clear_detail(self) -> None:
        dv = self.query_one("#detail-viewer", RichLog)
        dv.clear()
        dv.write(Text("Select a call to view details.", style="dim italic"))

    def _show_call(self, record: dict) -> None:
        _dbg(f"[4] _show_call fired, fn={_fn_name(record)}, src_file={record.get('source_file')}")
        try:
            self._selected = record
            self._render_source(record)
            self._render_detail(record)
            self._set_active("code-box")
            self.query_one("#code-scroll", VerticalScroll).focus()
        except Exception as e:
            _dbg(f"[4] EXCEPTION in _show_call: {e}")

    def _render_source(self, record: dict) -> None:
        cv = self.query_one("#code-viewer", RichLog)
        cv.clear()

        src_file = record.get("source_file") or record.get("callsite_file")
        src_start = record.get("source_line_start")
        src_end = record.get("source_line_end")
        callsite_line = record.get("callsite_line")

        if not src_file:
            cv.write(Text("No source file recorded.", style="dim italic"))
            return

        try:
            lines = Path(src_file).read_text(encoding="utf-8", errors="replace").splitlines()
        except Exception as e:
            cv.write(Text(f"Cannot read {src_file}: {e}", style="bold red"))
            return

        fn_lines: set[int] = set(range(src_start, src_end + 1)) if src_start and src_end else set()

        cv.write(Text(f" {src_file}", style="dim"))
        cv.write(Text(""))

        for i, line in enumerate(lines, start=1):
            num = Text(f"{i:4d}  ", style="dim")
            in_fn = i in fn_lines
            is_cs = bool(callsite_line and i == callsite_line)
            if in_fn and is_cs:
                code = Text(line, style="bold black on yellow")
            elif in_fn:
                code = Text(line, style="on navy_blue")
            elif is_cs:
                code = Text(line, style="bold black on dark_goldenrod")
            else:
                code = Text(line)
            cv.write(num + code)

        # Scroll so the highlighted region starts near the top (after layout)
        target_line = src_start or callsite_line or 1
        def _scroll() -> None:
            self.query_one("#code-scroll", VerticalScroll).scroll_to(
                y=max(0, target_line - 3), animate=False
            )
        self.call_after_refresh(_scroll)

    def _render_detail(self, record: dict) -> None:
        dv = self.query_one("#detail-viewer", RichLog)
        dv.clear()

        name = _fn_name(record)
        dur = f"{record['duration_s']:.3f}s" if record.get("duration_s") is not None else "?"
        err_flag = "  ✗" if record.get("error") else ""
        dv.write(Text(f" {name}   {dur}{err_flag}", style="bold cyan"))
        dv.write(Text(""))

        sf = record.get("source_file")
        ss = record.get("source_line_start")
        se = record.get("source_line_end")
        cf = record.get("callsite_file")
        cl = record.get("callsite_line")
        if sf and ss:
            dv.write(Text(f" def     {Path(sf).name}  L{ss}–{se}", style="yellow"))
        if cf and cl:
            dv.write(Text(f" called  {Path(cf).name}  L{cl}", style="yellow"))

        commit = record.get("git_commit")
        if commit:
            dirty = "*" if record.get("git_dirty") else ""
            snap = "  📸" if record.get("git_snapshot_sha") else ""
            dv.write(Text(f" git     {commit}{dirty}{snap}", style="dim"))

        dv.write(Text(""))
        dv.write(Text(" inputs", style="bold"))
        inputs = record.get("inputs") or {}
        if isinstance(inputs, dict):
            for k, v in inputs.items():
                dv.write(Text(f"   {k}: {_short(v)}", style="green"))
        else:
            dv.write(Text(f"   {_short(inputs)}", style="green"))

        dv.write(Text(""))
        if record.get("error"):
            err = record["error"]
            dv.write(Text(" error", style="bold red"))
            if isinstance(err, dict):
                dv.write(Text(f"   {err.get('type','')}: {err.get('message','')}", style="red"))
                for line in (err.get("traceback") or "").splitlines()[-5:]:
                    dv.write(Text(f"   {line}", style="dim red"))
            else:
                dv.write(Text(f"   {err}", style="red"))
        else:
            dv.write(Text(" output", style="bold"))
            dv.write(Text(f"   {_short(record.get('output'), maxlen=400)}", style="white"))

        url = record.get("wandb_url")
        if url:
            dv.write(Text(""))
            dv.write(Text(f" wandb  {url}", style="dim blue"))

    # ------------------------------------------------------------------
    # Focus helpers
    # ------------------------------------------------------------------

    _BOX_IDS = ["runs-box", "calls-box", "code-box", "detail-box"]

    def _set_active(self, box_id: str) -> None:
        for bid in self._BOX_IDS:
            el = self.query_one(f"#{bid}")
            if bid == box_id:
                el.add_class("active")
            else:
                el.remove_class("active")

    # ------------------------------------------------------------------
    # Events
    # ------------------------------------------------------------------

    def on_list_view_selected(self, event: ListView.Selected) -> None:
        _dbg(f"[1] on_list_view_selected fired, index={event.list_view.index}")
        try:
            idx = event.list_view.index
            if idx is not None and idx < len(self._run_ids):
                self._load_calls(self._run_ids[idx])
        except Exception as e:
            _dbg(f"[1] EXCEPTION in on_list_view_selected: {e}")

    def on_tree_node_highlighted(self, event: Tree.NodeHighlighted) -> None:
        _dbg(f"[2] on_tree_node_highlighted fired, node={event.node.label}, has_data={event.node.data is not None}")
        try:
            record = event.node.data
            if record:
                self._show_call(record)
        except Exception as e:
            _dbg(f"[2] EXCEPTION in on_tree_node_highlighted: {e}")

    # ------------------------------------------------------------------
    # Actions
    # ------------------------------------------------------------------

    def action_focus_runs(self) -> None:
        self.query_one("#runs-list", ListView).focus()
        self._set_active("runs-box")

    def action_focus_calls(self) -> None:
        self.query_one("#calls-tree", Tree).focus()
        self._set_active("calls-box")

    def action_back_to_runs(self) -> None:
        self._load_runs()
        self.query_one("#runs-list", ListView).focus()
        self._set_active("runs-box")

    def action_pick_project(self) -> None:
        projects = _get_projects()
        if not projects:
            return
        idx = (projects.index(self._project) + 1) % len(projects) if self._project in projects else 0
        self._project = projects[idx]
        self._load_runs()

    def action_copy_trace(self) -> None:
        if not self._selected:
            self.notify("No call selected.")
            return
        r = self._selected
        lines = [f"[{_fn_name(r)}]"]
        inputs = r.get("inputs") or {}
        if isinstance(inputs, dict):
            for k, v in inputs.items():
                lines.append(f"  {k}: {_short(v)}")
        if r.get("error"):
            err = r["error"]
            msg = f"{err.get('type','')}: {err.get('message','')}" if isinstance(err, dict) else str(err)
            lines.append(f"  error: {msg}")
        else:
            lines.append(f"  output: {_short(r.get('output'))}")
        try:
            subprocess.run(["pbcopy"], input="\n".join(lines).encode(), check=True)
            self.notify("Copied to clipboard.")
        except Exception:
            self.notify("\n".join(lines)[:120], title="pbcopy unavailable")

    def action_open_url(self) -> None:
        if not self._selected:
            self.notify("No call selected.")
            return
        url = self._selected.get("wandb_url")
        if url:
            subprocess.Popen(["open", url])
            self.notify("Opening W&B...")
        else:
            self.notify("No W&B URL for this call.")

    def action_jump_callsite(self) -> None:
        if not self._selected:
            self.notify("No call selected.")
            return
        f = self._selected.get("callsite_file") or self._selected.get("source_file")
        l = self._selected.get("callsite_line") or self._selected.get("source_line_start")
        if f and l:
            subprocess.Popen(["code", "-g", f"{f}:{l}"])
            self.notify(f"Opened {Path(f).name}:{l}")
        else:
            self.notify("No callsite info available.")


# ---------------------------------------------------------------------------
# Size patch + entry point
# ---------------------------------------------------------------------------

def _patch_textual_size() -> tuple[int, int] | None:
    import struct, fcntl, termios, os as _os
    size = None

    # Method 1: /dev/tty ioctl
    try:
        with open("/dev/tty", "rb") as tty:
            packed = fcntl.ioctl(tty.fileno(), termios.TIOCGWINSZ, b"\x00" * 8)
            rows, cols = struct.unpack("HHHH", packed)[:2]
            if rows > 0 and cols > 0:
                size = (cols, rows)
    except Exception:
        pass

    # Method 2: stty size via /dev/tty
    if not size:
        try:
            out = subprocess.check_output(
                ["stty", "size"], stdin=open("/dev/tty"), stderr=subprocess.DEVNULL, text=True
            ).strip()
            rows, cols = out.split()
            size = (int(cols), int(rows))
        except Exception:
            pass

    if size:
        cols, rows = size
        _os.environ["COLUMNS"] = str(cols)
        _os.environ["LINES"] = str(rows)

    return size


def main() -> None:
    import sys, os
    project = sys.argv[1] if len(sys.argv) > 1 else None
    # Fix mouse clicks in iTerm2 (textual >= 2.0 requires LC_TERMINAL to be set)
    if not os.environ.get("LC_TERMINAL"):
        os.environ["LC_TERMINAL"] = "iTerm2"
    _patch_textual_size()
    CodeWeaveApp(project=project).run()


if __name__ == "__main__":
    main()
