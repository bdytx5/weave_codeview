#!/usr/bin/env python3
"""
Terminal Code Viewer - A split-pane file browser and viewer
"""
import os
from pathlib import Path
from textual.app import App, ComposeResult
from textual.widgets import Header, Footer, DirectoryTree, Static, RichLog
from textual.containers import Container, VerticalScroll
from textual.binding import Binding
from rich.syntax import Syntax
from rich.text import Text


class CodeViewerApp(App):
    """A terminal-based code viewer application"""

    CSS = """
    Screen {
        layout: vertical;
        overflow: hidden hidden;
    }

    #file-tree-container {
        height: 30%;
        border: solid $accent;
        margin-bottom: 1;
        overflow-y: auto;
    }

    DirectoryTree {
        width: 100%;
        height: 100%;
    }

    #code-viewer-container {
        height: 70%;
        border: solid $accent;
    }

    RichLog {
        width: 100%;
        height: 100%;
        padding: 0 1;
    }

    .focused {
        border: solid $success;
    }
    """

    BINDINGS = [
        Binding("q", "quit", "Quit"),
        Binding("tab", "toggle_focus", "Switch Focus"),
        Binding("escape", "focus_tree", "Focus Tree"),
        ("ctrl+c", "quit", "Quit"),
    ]

    def __init__(self, start_path: str = "."):
        super().__init__()
        self.start_path = Path(start_path).resolve()
        self.tree_focused = True

    def compose(self) -> ComposeResult:
        """Create child widgets"""
        yield Header()

        with Container(id="file-tree-container"):
            yield DirectoryTree(self.start_path, id="file-tree")

        with VerticalScroll(id="code-viewer-container"):
            yield RichLog(id="code-viewer", wrap=False, highlight=True)

        yield Footer()

    def on_mount(self) -> None:
        """Set up the app after mounting"""
        self.title = "Code Viewer"
        self.sub_title = str(self.start_path)

        # Set initial message
        code_viewer = self.query_one("#code-viewer", RichLog)
        code_viewer.write(Text("Select a file to view", style="dim italic"))

        # Focus the tree initially
        self.query_one("#file-tree", DirectoryTree).focus()
        self.update_focus_styles()

    def action_toggle_focus(self) -> None:
        """Toggle focus between tree and code viewer"""
        self.tree_focused = not self.tree_focused
        if self.tree_focused:
            self.query_one("#file-tree", DirectoryTree).focus()
        else:
            self.query_one("#code-viewer-container", VerticalScroll).focus()
        self.update_focus_styles()

    def action_focus_tree(self) -> None:
        """Focus the file tree"""
        self.tree_focused = True
        self.query_one("#file-tree", DirectoryTree).focus()
        self.update_focus_styles()

    def update_focus_styles(self) -> None:
        """Update border styles based on focus"""
        tree_container = self.query_one("#file-tree-container")
        viewer_container = self.query_one("#code-viewer-container")

        if self.tree_focused:
            tree_container.add_class("focused")
            viewer_container.remove_class("focused")
        else:
            tree_container.remove_class("focused")
            viewer_container.add_class("focused")

    def on_directory_tree_file_selected(self, event: DirectoryTree.FileSelected) -> None:
        """Handle file selection from directory tree"""
        file_path = event.path

        # Update subtitle to show current file
        self.sub_title = str(file_path)

        # Display the file in the code viewer
        code_viewer = self.query_one("#code-viewer", RichLog)
        self.display_file(code_viewer, file_path)

    def display_file(self, code_viewer: RichLog, file_path: Path) -> None:
        """Display a file with syntax highlighting"""
        code_viewer.clear()

        try:
            # Read file content
            content = file_path.read_text()
            lines = content.splitlines()

            # DEMO: Highlight lines 8-10 in demo.py with green background
            highlight_line_numbers = set()
            if file_path.name == "demo.py":
                highlight_line_numbers = {8, 9, 10}

            # Build output with line numbers and highlighting
            for line_num, line in enumerate(lines, start=1):
                line_num_text = Text(f"{line_num:4d}  ", style="dim")

                if line_num in highlight_line_numbers:
                    line_text = Text(line, style="on green4")
                    combined = line_num_text + line_text
                else:
                    line_text = Text(line)
                    combined = line_num_text + line_text

                code_viewer.write(combined)

        except Exception as e:
            error_text = Text(f"Error reading file: {e}", style="bold red")
            code_viewer.write(error_text)


def _patch_textual_size() -> None:
    """Patch textual's internal driver to return the real terminal size."""
    import struct, fcntl, termios, subprocess
    size = None

    try:
        with open("/dev/tty", "rb") as tty:
            packed = fcntl.ioctl(tty.fileno(), termios.TIOCGWINSZ, b"\x00" * 8)
            rows, cols = struct.unpack("HHHH", packed)[:2]
            if rows > 0 and cols > 0:
                size = (cols, rows)
    except Exception:
        pass

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
        try:
            from textual.drivers.linux_driver import LinuxDriver
            LinuxDriver._get_terminal_size = lambda self: size
        except Exception:
            pass
        try:
            from textual.drivers.mac_driver import MacDriver
            MacDriver._get_terminal_size = lambda self: size
        except Exception:
            pass


def main():
    import sys
    start_path = sys.argv[1] if len(sys.argv) > 1 else "."
    _patch_textual_size()
    CodeViewerApp(start_path=start_path).run()


if __name__ == "__main__":
    main()
