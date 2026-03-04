from __future__ import annotations

import inspect
from pathlib import Path
from typing import Any

from ._git import set_git_path
from ._logger import attach


def _patch_weave_op() -> None:
    import weave
    original_op = weave.op

    def patched_op(fn=None, **kwargs):
        if fn is None:
            # called as @weave.op(...)
            def decorator(f):
                wrapper = original_op(**kwargs)(f)
                _attach_source(f, wrapper)
                return wrapper
            return decorator
        # called as @weave.op
        wrapper = original_op(fn, **kwargs)
        _attach_source(fn, wrapper)
        return wrapper

    weave.op = patched_op


def _attach_source(fn: Any, wrapper: Any) -> None:
    try:
        source_file = inspect.getfile(fn)
        source_lines, source_line_start = inspect.getsourcelines(fn)
        source_line_end = source_line_start + len(source_lines) - 1
    except (TypeError, OSError):
        source_file = None
        source_line_start = None
        source_line_end = None
    wrapper._source_file = source_file
    wrapper._source_line_start = source_line_start
    wrapper._source_line_end = source_line_end


def init(client: Any, git_path: str | None = None, log_path: str | Path | None = None) -> Any:
    """Attach CodeWeave local JSONL logging to a weave client.

    Args:
        client:    The WeaveClient returned by weave.init().
        git_path:  Optional path to your git repo for code snapshotting.
        log_path:  Optional override for the JSONL log file path.

    Returns:
        The same client, unchanged.

    Example:
        import weave
        import codeweave

        client = codeweave.init(weave.init("my-project"), git_path="/path/to/repo")
    """
    if git_path:
        set_git_path(git_path)
    _patch_weave_op()
    attach(client, log_path=log_path)
    return client


__all__ = ["init", "set_git_path", "attach"]
