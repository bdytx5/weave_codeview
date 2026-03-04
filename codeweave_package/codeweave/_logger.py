from __future__ import annotations

import inspect
import json
import sys
import time
import uuid
from pathlib import Path
from typing import Any

from ._git import capture_git_state

_callsite_cache: dict[str, dict[str, Any]] = {}

_SKIP_PREFIXES = (
    "weave",
    "openai",
    "httpx",
    "anyio",
    "asyncio",
    "concurrent",
    "threading",
    "codeweave",
)


def _capture_callsite() -> dict[str, Any]:
    best: dict[str, Any] | None = None
    for frame_info in inspect.stack():
        fname = frame_info.filename
        parts = fname.replace("\\", "/").split("/")
        skip = any(
            any(part.startswith(p) for p in _SKIP_PREFIXES)
            for part in parts
        )
        if skip or fname == "<string>" or fname.startswith("<"):
            continue
        candidate = {
            "callsite_file": fname,
            "callsite_line": frame_info.lineno,
            "callsite_function": frame_info.function,
        }
        if frame_info.function != "<module>":
            return candidate
        if best is None:
            best = candidate
    return best or {}


def _default_log_path(project: str | None = None) -> Path:
    import os
    ts = time.strftime("%Y%m%d_%H%M%S")
    uid = str(uuid.uuid4())[:8]
    safe_project = "".join(c if c.isalnum() or c in "-_." else "_" for c in (project or "default"))
    runs_dir = Path(os.path.expanduser("~")) / ".cache" / "codeweave" / safe_project
    runs_dir.mkdir(parents=True, exist_ok=True)
    return runs_dir / f"{ts}_{uid}.jsonl"


def _safe_json(obj: Any) -> Any:
    try:
        json.dumps(obj)
        return obj
    except (TypeError, ValueError):
        return repr(obj)


def _dt_to_ts(dt: Any) -> float | None:
    if dt is None:
        return None
    try:
        return dt.timestamp()
    except Exception:
        return None


def _find_remote_server(server: Any) -> Any:
    if type(server).__name__ in ("RemoteHTTPTraceServer", "StainlessRemoteHTTPTraceServer"):
        return server
    next_server = getattr(server, "_next_trace_server", None)
    if next_server is not None:
        return _find_remote_server(next_server)
    return None


def _wandb_url(op_name: str | None, call_id: str | None) -> str | None:
    if not op_name or not call_id:
        return None
    try:
        parts = op_name.removeprefix("weave:///").split("/")
        entity, project = parts[0], parts[1]
        return f"https://wandb.ai/{entity}/{project}/r/call/{call_id}"
    except (IndexError, AttributeError):
        return None


def _is_patched_lib_op(op_name: str | None) -> bool:
    if not op_name:
        return False
    short = op_name.split("/")[-1].split(":")[0]
    return "." in short


def _source_for_op_name(op_name: str | None) -> dict[str, Any]:
    if not op_name:
        return {}
    raw = op_name.split("/")[-1].split(":")[0]
    short = raw.split(".")[-1]
    for module in list(sys.modules.values()):
        try:
            obj = getattr(module, short, None)
        except Exception:
            continue
        try:
            source_file = obj is not None and getattr(obj, "_source_file", None)
        except Exception:
            continue
        if obj is not None and source_file:
            name = getattr(getattr(obj, "resolve_fn", obj), "__name__", short)
            return {
                "function": name,
                "source_file": source_file,
                "source_line_start": obj._source_line_start,
                "source_line_end": obj._source_line_end,
            }
    return {}


def attach(client: Any, log_path: str | Path | None = None) -> Path:
    project = getattr(client, "project", None)
    resolved_path = Path(log_path) if log_path else _default_log_path(project)
    resolved_path.parent.mkdir(parents=True, exist_ok=True)

    run_id = resolved_path.stem
    git_info = capture_git_state(run_id)

    remote_server = _find_remote_server(client.server)
    if remote_server is None:
        raise RuntimeError(
            "Could not find RemoteHTTPTraceServer. "
            "Call codeweave.init() right after weave.init()."
        )

    proc = remote_server.call_processor
    if proc is None:
        raise RuntimeError("No call_processor found on the remote server.")

    _orig_create_call = client.create_call

    def _patched_create_call(*args: Any, **kw: Any) -> Any:
        callsite = _capture_callsite()
        call = _orig_create_call(*args, **kw)
        call_id = getattr(call, "id", None)
        if call_id and callsite:
            _callsite_cache[call_id] = callsite
        return call

    client.create_call = _patched_create_call

    original_fn = proc.processor_fn
    _pending: dict[str, dict[str, Any]] = {}

    def _append(entry: dict[str, Any]) -> None:
        with resolved_path.open("a", encoding="utf-8") as f:
            f.write(json.dumps({**entry, **git_info}) + "\n")

    def patched_fn(batch: list[Any], **kwargs: Any) -> None:
        from weave.trace_server_bindings.models import CompleteBatchItem, EndBatchItem, StartBatchItem

        for item in batch:
            if isinstance(item, StartBatchItem):
                s = item.req.start
                if s.id:
                    _pending[s.id] = {
                        "op_name": s.op_name,
                        "timestamp_start": _dt_to_ts(s.started_at),
                        "inputs": _safe_json(s.inputs),
                        "parent_id": s.parent_id,
                        "trace_id": s.trace_id,
                        "attributes": _safe_json(s.attributes),
                    }

        for item in batch:
            if isinstance(item, CompleteBatchItem):
                call = item.req
                ts_start = _dt_to_ts(call.started_at)
                ts_end = _dt_to_ts(call.ended_at)
                callsite = _callsite_cache.pop(call.id, {})
                source = callsite if _is_patched_lib_op(call.op_name) else (_source_for_op_name(call.op_name) or callsite)
                _append({
                    "call_id": call.id,
                    "op_name": call.op_name,
                    "wandb_url": _wandb_url(call.op_name, call.id),
                    "timestamp_start": ts_start,
                    "timestamp_end": ts_end,
                    "duration_s": (ts_end - ts_start) if ts_end and ts_start else None,
                    "inputs": _safe_json(call.inputs),
                    "output": _safe_json(call.output),
                    "error": call.exception,
                    "parent_id": call.parent_id,
                    "trace_id": call.trace_id,
                    "attributes": _safe_json(call.attributes),
                    "summary": _safe_json(dict(call.summary) if call.summary else {}),
                    "callsite_file": callsite.get("callsite_file"),
                    "callsite_line": callsite.get("callsite_line"),
                    **source,
                })

            elif isinstance(item, EndBatchItem):
                e = item.req.end
                pending = _pending.pop(e.id, {})
                ts_start = pending.get("timestamp_start")
                ts_end = _dt_to_ts(e.ended_at)
                op_name = pending.get("op_name")
                callsite = _callsite_cache.pop(e.id, {})
                source = callsite if _is_patched_lib_op(op_name) else (_source_for_op_name(op_name) or callsite)
                _append({
                    "call_id": e.id,
                    "op_name": op_name,
                    "wandb_url": _wandb_url(op_name, e.id),
                    "timestamp_start": ts_start,
                    "timestamp_end": ts_end,
                    "duration_s": (ts_end - ts_start) if ts_end and ts_start else None,
                    "inputs": pending.get("inputs"),
                    "output": _safe_json(e.output),
                    "error": e.exception,
                    "parent_id": pending.get("parent_id"),
                    "trace_id": pending.get("trace_id"),
                    "attributes": pending.get("attributes"),
                    "summary": _safe_json(dict(e.summary) if e.summary else {}),
                    "callsite_file": callsite.get("callsite_file"),
                    "callsite_line": callsite.get("callsite_line"),
                    **source,
                })

        original_fn(batch, **kwargs)

    proc.processor_fn = patched_fn
    return resolved_path
