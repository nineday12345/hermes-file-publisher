from __future__ import annotations

import os
import secrets
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import FileResponse

router = APIRouter()

ENV_ROOT_KEYS = (
    "HERMES_FILE_PUBLISHER_ROOT",
    "HERMES_FILE_MANAGER_ROOT",
    "HERMES_DATA_DIR",
)


def _truthy(value: str | None) -> bool:
    return str(value or "").strip().lower() in {"1", "true", "yes", "on"}


def _configured_root() -> Path:
    for key in ENV_ROOT_KEYS:
        value = os.environ.get(key)
        if value:
            return Path(value).expanduser()

    hermes_home = os.environ.get("HERMES_HOME")
    candidates: list[Path] = []
    if hermes_home:
        candidates.append(Path(hermes_home).expanduser() / "data")

    candidates.extend(
        [
            Path("/data"),
            Path.cwd() / "data",
            Path.home() / ".hermes" / "data",
        ]
    )

    for candidate in candidates:
        if candidate.exists():
            return candidate
    return candidates[-1]


def _root() -> Path:
    return _configured_root().resolve(strict=False)


def _relative_path(path: Path, root: Path) -> str:
    try:
        return path.relative_to(root).as_posix()
    except ValueError:
        return ""


def _resolve_inside(raw_path: str | None, *, follow_final_symlink: bool = True) -> Path:
    root = _root()
    rel = (raw_path or "").strip().replace("\\", "/")
    if rel in {"", ".", "/"}:
        target = root
    elif follow_final_symlink:
        target = (root / rel.lstrip("/")).resolve(strict=False)
    else:
        raw_target = root / rel.lstrip("/")
        resolved_parent = raw_target.parent.resolve(strict=False)
        try:
            resolved_parent.relative_to(root)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="Path escapes configured root") from exc
        target = resolved_parent / raw_target.name

    try:
        target.relative_to(root)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Path escapes configured root") from exc
    return target


def _optional_token() -> str:
    return os.environ.get("HERMES_FILE_PUBLISHER_TOKEN", "").strip()


def _require_plugin_token(request: Request) -> None:
    expected = _optional_token()
    if not expected:
        return

    provided = (
        request.headers.get("x-file-publisher-token")
        or request.query_params.get("token")
        or ""
    ).strip()
    if not secrets.compare_digest(provided, expected):
        raise HTTPException(status_code=401, detail="Invalid file publisher token")


def _entry_type(path: Path) -> str:
    if path.is_symlink():
        return "symlink"
    if path.is_dir():
        return "directory"
    if path.is_file():
        return "file"
    return "other"


def _file_item(path: Path, root: Path) -> dict[str, Any]:
    kind = _entry_type(path)
    try:
        stat = path.lstat() if kind == "symlink" else path.stat()
        size = stat.st_size if kind == "file" else None
        modified_at = datetime.fromtimestamp(stat.st_mtime, timezone.utc).isoformat()
    except OSError:
        size = None
        modified_at = None

    return {
        "name": path.name,
        "path": _relative_path(path, root),
        "type": kind,
        "size": size,
        "modified_at": modified_at,
        "downloadable": kind == "file",
        "deletable": kind in {"file", "directory", "symlink"},
    }


def _sort_key(item: dict[str, Any]) -> tuple[int, str]:
    return (0 if item["type"] == "directory" else 1, item["name"].lower())


@router.get("/config")
async def config(request: Request) -> dict[str, Any]:
    _require_plugin_token(request)
    root = _root()
    return {
        "root": str(root),
        "exists": root.exists(),
        "token_required": bool(_optional_token()),
        "recursive_delete": _truthy(os.environ.get("HERMES_FILE_PUBLISHER_RECURSIVE_DELETE")),
        "max_entries": int(os.environ.get("HERMES_FILE_PUBLISHER_MAX_ENTRIES", "500")),
    }


@router.get("/files")
async def list_files(
    request: Request,
    path: str = Query(default=""),
    q: str = Query(default=""),
    include_hidden: bool = Query(default=False),
) -> dict[str, Any]:
    _require_plugin_token(request)
    root = _root()
    target = _resolve_inside(path)
    if not root.exists():
        raise HTTPException(status_code=404, detail=f"Root does not exist: {root}")
    if not target.exists():
        raise HTTPException(status_code=404, detail="Path not found")
    if not target.is_dir():
        raise HTTPException(status_code=400, detail="Path is not a directory")

    query = q.strip().lower()
    max_entries = max(1, int(os.environ.get("HERMES_FILE_PUBLISHER_MAX_ENTRIES", "500")))
    entries: list[dict[str, Any]] = []

    try:
        for child in target.iterdir():
            if not include_hidden and child.name.startswith("."):
                continue
            if query and query not in child.name.lower():
                continue
            entries.append(_file_item(child, root))
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail="Permission denied") from exc
    except OSError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    entries.sort(key=_sort_key)
    truncated = len(entries) > max_entries
    entries = entries[:max_entries]

    parent = ""
    if target != root:
        parent = _relative_path(target.parent, root)

    return {
        "root": str(root),
        "path": _relative_path(target, root),
        "parent": parent,
        "items": entries,
        "truncated": truncated,
        "count": len(entries),
    }


@router.get("/download")
async def download(
    request: Request,
    path: str = Query(..., min_length=1),
) -> FileResponse:
    _require_plugin_token(request)
    target = _resolve_inside(path)
    if not target.exists():
        raise HTTPException(status_code=404, detail="File not found")
    if not target.is_file():
        raise HTTPException(status_code=400, detail="Path is not a file")
    return FileResponse(
        target,
        filename=target.name,
        media_type="application/octet-stream",
    )


@router.delete("/files")
async def delete_file(request: Request, payload: dict[str, Any]) -> dict[str, Any]:
    _require_plugin_token(request)
    target = _resolve_inside(str(payload.get("path") or ""), follow_final_symlink=False)
    confirm = bool(payload.get("confirm"))
    if not confirm:
        raise HTTPException(status_code=400, detail="Delete confirmation is required")
    if target == _root():
        raise HTTPException(status_code=400, detail="Cannot delete root directory")
    if not target.exists() and not target.is_symlink():
        raise HTTPException(status_code=404, detail="Path not found")

    recursive_delete = _truthy(os.environ.get("HERMES_FILE_PUBLISHER_RECURSIVE_DELETE"))
    try:
        if target.is_dir() and not target.is_symlink():
            if recursive_delete:
                shutil.rmtree(target)
            else:
                target.rmdir()
        else:
            target.unlink()
    except OSError as exc:
        detail = "Directory is not empty" if target.is_dir() else str(exc)
        raise HTTPException(status_code=409, detail=detail) from exc

    return {"ok": True, "path": str(payload.get("path") or "")}
