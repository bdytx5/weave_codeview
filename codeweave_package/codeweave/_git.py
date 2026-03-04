from __future__ import annotations

import os
import subprocess
import tempfile
from typing import Any


def set_git_path(path: str) -> None:
    os.environ["WEAVE_GIT_PATH"] = path


def _git(args: list[str], cwd: str) -> str:
    try:
        return subprocess.check_output(
            ["git"] + args, cwd=cwd, stderr=subprocess.DEVNULL, text=True
        ).strip()
    except Exception:
        return ""


def capture_git_state(run_id: str) -> dict[str, Any]:
    cwd = os.environ.get("WEAVE_GIT_PATH")
    if not cwd:
        return {"git_repo_root": None, "git_commit": None, "git_dirty": False, "git_snapshot_sha": None}

    repo_root = _git(["rev-parse", "--show-toplevel"], cwd)
    if not repo_root:
        return {"git_repo_root": None, "git_commit": None, "git_dirty": False, "git_snapshot_sha": None}

    commit = _git(["rev-parse", "--short", "HEAD"], repo_root)
    status = _git(["status", "--porcelain"], repo_root)
    dirty = bool(status)

    snapshot_sha = None
    if dirty:
        tmp_index = tempfile.mktemp(prefix=".cdweave_idx_", dir=os.path.join(repo_root, ".git"))
        env = {**os.environ, "GIT_INDEX_FILE": tmp_index}
        try:
            if _git(["rev-parse", "HEAD"], repo_root):
                subprocess.check_call(
                    ["git", "read-tree", "HEAD"],
                    cwd=repo_root, env=env,
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                )
            subprocess.check_call(
                ["git", "add", "-A"],
                cwd=repo_root, env=env,
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
            tree_sha = subprocess.check_output(
                ["git", "write-tree"], cwd=repo_root, env=env, text=True
            ).strip()
            head_sha = _git(["rev-parse", "HEAD"], repo_root)
            msg = f"cdweave snapshot: {run_id}"
            commit_tree_args = ["git", "commit-tree", tree_sha, "-m", msg]
            if head_sha:
                commit_tree_args += ["-p", head_sha]
            snapshot_sha = subprocess.check_output(
                commit_tree_args, cwd=repo_root, text=True
            ).strip()
            ref = f"refs/cdweave/{run_id}"
            _git(["update-ref", ref, snapshot_sha], repo_root)
        except Exception:
            snapshot_sha = None
        finally:
            for f in (tmp_index, tmp_index + ".lock"):
                try:
                    os.unlink(f)
                except Exception:
                    pass

    return {
        "git_repo_root": repo_root,
        "git_commit": commit,
        "git_dirty": dirty,
        "git_snapshot_sha": snapshot_sha,
    }
