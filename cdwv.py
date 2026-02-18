import json
import time
import uuid
import functools
import traceback
import inspect
from pathlib import Path

RUNS_DIR = Path("runs")

# One file per process — set at import time
_run_id = time.strftime("%Y%m%d_%H%M%S") + "_" + str(uuid.uuid4())[:8]
LOG_FILE = RUNS_DIR / f"{_run_id}.jsonl"


def _serialize(obj):
    try:
        json.dumps(obj)
        return obj
    except TypeError:
        return repr(obj)


def _write_log(entry):
    LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
    with LOG_FILE.open("a", encoding="utf-8") as f:
        f.write(json.dumps(entry) + "\n")


class wv:
    @staticmethod
    def op(fn):
        try:
            source_file = inspect.getfile(fn)
            source_lines, source_line_start = inspect.getsourcelines(fn)
            source_line_end = source_line_start + len(source_lines) - 1
        except (TypeError, OSError):
            source_file = None
            source_line_start = None
            source_line_end = None

        @functools.wraps(fn)
        def wrapper(*args, **kwargs):
            call_id = str(uuid.uuid4())
            start_time = time.time()

            log_base = {
                "call_id": call_id,
                "function": fn.__name__,
                "timestamp_start": start_time,
                "inputs": {
                    "args": [_serialize(a) for a in args],
                    "kwargs": {k: _serialize(v) for k, v in kwargs.items()},
                },
                "source_file": source_file,
                "source_line_start": source_line_start,
                "source_line_end": source_line_end,
            }

            try:
                result = fn(*args, **kwargs)

                end_time = time.time()

                log_entry = {
                    **log_base,
                    "timestamp_end": end_time,
                    "duration_s": end_time - start_time,
                    "output": _serialize(result),
                    "error": None,
                }

                _write_log(log_entry)
                return result

            except Exception as e:
                end_time = time.time()

                log_entry = {
                    **log_base,
                    "timestamp_end": end_time,
                    "duration_s": end_time - start_time,
                    "output": None,
                    "error": {
                        "type": type(e).__name__,
                        "message": str(e),
                        "traceback": traceback.format_exc(),
                    },
                }

                _write_log(log_entry)
                raise

        return wrapper
