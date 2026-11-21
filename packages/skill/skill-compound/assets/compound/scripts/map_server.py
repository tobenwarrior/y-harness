#!/usr/bin/env python3
"""Loopback-only service for the Compound code-map viewer.

Project reads require a local credential. Control calls require the runtime token.
"""

from __future__ import annotations

import argparse
import codecs
import contextlib
import dataclasses
import datetime as dt
import functools
import hashlib
import http.client
import http.server
import json
import os
import secrets
import signal
import stat
import subprocess
import sys
import threading
import time
import urllib.parse
import webbrowser
from pathlib import Path, PurePosixPath
from typing import Any

try:
    from . import code_map as engine
    from . import viewer_access
    from .onboarding import _reject_symlink
    from .safe_open import open_regular_nofollow
    from .reference_cache import IdentifierPostingsCache
    from . import symbol_lookup as lookup_engine
    from .map_state import (
        MAX_QUERY, MAX_REGISTRY_NAME, MAX_REGISTRY_PROJECTS, MAX_SOURCE_PATH, MapServerError, _json, _prepare_log,
        _printable, _read_registry, _read_runtime, _runtime_for_repo, _runtime_without_repo, _startup_lock,
        _write_registry, _write_runtime,
    )
except ImportError:  # direct script execution
    import code_map as engine
    import viewer_access
    from onboarding import _reject_symlink
    from safe_open import open_regular_nofollow
    from reference_cache import IdentifierPostingsCache
    import symbol_lookup as lookup_engine
    from map_state import (
        MAX_QUERY, MAX_REGISTRY_NAME, MAX_REGISTRY_PROJECTS, MAX_SOURCE_PATH, MapServerError, _json, _prepare_log,
        _printable, _read_registry, _read_runtime, _runtime_for_repo, _runtime_without_repo, _startup_lock,
        _write_registry, _write_runtime,
    )


SERVICE = "compound-code-map"
PROTOCOL = 2
DEFAULT_PORT = 43127
MAX_BODY = 64 * 1024
MAX_RESPONSE = 8 * 1024 * 1024
MAX_HANDOFF = 16 * 1024
INDEX_MAX_FILES = 20000
RESPONSE_MAX_FILES = 5000
MAX_SOURCE_BYTES = 64 * 1024
MAX_GIT_STATUS_BYTES = 256 * 1024
MODEL_WAIT = 30.0
INDEX_STATUS_WAIT = 0.5
# An index pass can hold the GIL for seconds, so a busy service answers late.
REQUEST_TIMEOUT = 5.0
MAX_LOADED_PROJECTS = 8
MAX_INDEX_WORKERS = 4
ASSET_NAMES = ("code-map.html", "code-map.css", "code-map.js", "map-graph.js")
ASSET_TYPES = {".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8"}
ASSET_DIR = Path(__file__).resolve().parent.parent / "assets"


def _now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")


def _build_assets() -> tuple[dict[str, bytes], str]:
    assets: dict[str, bytes] = {}
    digest = hashlib.sha256()
    modules = ("map_inventory", "map_state", "workspace_imports", "language_outlines", "language_imports", "safe_open", "symbol_lookup", "reference_cache", "viewer_access")
    for script in (Path(__file__), Path(engine.__file__), *(Path(engine.__file__).with_name(f"{name}.py") for name in modules)):
        try:
            digest.update(script.read_bytes())
        except OSError:
            pass
    for name in ASSET_NAMES:
        path = ASSET_DIR / name
        try:
            value = path.read_bytes()
        except OSError:
            value = b""
        assets[name] = value
        digest.update(name.encode("utf-8") + b"\0" + value)
    return assets, digest.hexdigest()[:24]


@functools.cache
def _client_bundle() -> tuple[dict[str, bytes], str]:
    return _build_assets()


def __getattr__(name: str) -> Any:
    if name == "BUILD_SIGNATURE":
        return _client_bundle()[1]
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


def _inventory_fingerprint(
    root: Path, inventory_result: tuple[bytes | None, list[str]] | None = None, *, status: bytes | None = None,
) -> str:
    """The engine's capped Git inventory, a bounded Git status and worktree metadata, or "" (never a cache hit) when Git fails."""
    if inventory_result is None:
        inventory_result = engine._git_inventory(root)
    inventory, notes = inventory_result
    if inventory is None or engine.UNTRACKED_INVENTORY_NOTE in notes:
        return ""
    # A complete inventory already covers untracked paths and their metadata.
    capped = engine.INVENTORY_CAP_NOTE in notes
    if status is None:
        status = engine._git_status_snapshot(root, untracked=capped)
    if not status:
        return ""
    digest = hashlib.sha256(status)
    digest.update(inventory)
    digest.update(b"\0capped=" + (b"1" if capped else b"0"))
    paths = sorted(set(inventory.split(b"\0")))
    for raw in paths:
        if not raw:
            continue
        rel = os.fsdecode(raw)
        if not engine._safe_relative(rel):
            raise MapServerError("Git inventory contains an unsafe path")
        try:
            info = (root / rel).lstat()
        except OSError:
            digest.update(raw + b"\0missing\0")
            continue
        digest.update(raw + b"\0")
        digest.update(f"{info.st_mode}:{info.st_size}:{info.st_mtime_ns}:{info.st_ctime_ns}:{info.st_ino}".encode())
        digest.update(b"\0")
    return digest.hexdigest()


def _model_git_state(model: Any) -> tuple[str, str] | None:
    """Hash branch and indexed status labels without another Git invocation."""
    if not isinstance(model, dict):
        return None
    branch = model.get("branch", "")
    files = model.get("files")
    if not isinstance(branch, str) or not isinstance(files, list):
        return None
    encoded = bytearray()
    truncated = False
    try:
        branch_bytes = branch.encode("utf-8", "strict")
    except UnicodeError:
        return None
    for record in sorted((item for item in files if isinstance(item, dict)), key=lambda item: str(item.get("path", ""))):
        path = record.get("path")
        changed = record.get("changed")
        if not isinstance(path, str) or not isinstance(changed, str):
            return None
        if not changed:
            continue
        try:
            item = path.encode("utf-8", "strict") + b"\0" + changed.encode("utf-8", "strict") + b"\0"
        except UnicodeError:
            return None
        if len(encoded) + len(item) > MAX_GIT_STATUS_BYTES:
            truncated = True
            break
        encoded.extend(item)
    digest = hashlib.sha256()
    digest.update(branch_bytes)
    digest.update(b"\0")
    digest.update(encoded)
    digest.update(b"\0truncated=" + (b"1" if truncated else b"0"))
    return branch, digest.hexdigest()


def _port(raw: str | int | None = None) -> int:
    value = os.environ.get("COMPOUND_MAP_PORT", str(DEFAULT_PORT)) if raw is None else str(raw)
    try:
        result = int(value)
    except ValueError as exc:
        raise MapServerError(f"invalid map service port: {value}") from exc
    if not 0 <= result <= 65535:
        raise MapServerError(f"invalid map service port: {value}")
    return result


def _canonical_repo(repo: str | os.PathLike[str]) -> Path:
    try:
        supplied = engine._repo_path(repo)
        root, _ = engine._git_root(supplied)
        return root
    except (OSError, ValueError) as exc:
        raise MapServerError(str(exc)) from exc


def _project_id(root: Path) -> str:
    return hashlib.sha256(str(root).encode("utf-8", "surrogateescape")).hexdigest()


def _source_relative(value: Any) -> str:
    if not isinstance(value, str) or not value or len(value) > MAX_SOURCE_PATH:
        raise MapServerError("invalid source path")
    if "\x00" in value or "\\" in value:
        raise MapServerError("invalid source path")
    try:
        normalized = PurePosixPath(value).as_posix()
    except (TypeError, ValueError):
        raise MapServerError("invalid source path")
    if normalized != value or not engine._safe_relative(value):
        raise MapServerError("invalid source path")
    parts = PurePosixPath(value).parts
    if not parts or any(part in {"", ".", ".."} for part in parts):
        raise MapServerError("invalid source path")
    return value


def _source_path(root: Path, relative: str) -> Path:
    """Validate a repository-relative source path without resolving its leaf."""
    try:
        relative = _source_relative(relative)
        if engine._private(relative) or engine._skip_dir(relative, git_inventory=True):
            raise MapServerError("source file unavailable")
        if engine._has_symlink_ancestor(root, root):
            raise MapServerError("source file unavailable")
        root_stat = root.lstat()
        if not stat.S_ISDIR(root_stat.st_mode):
            raise MapServerError("source file unavailable")
        candidate = root.joinpath(*PurePosixPath(relative).parts)
        candidate.relative_to(root)
        if engine._has_symlink_ancestor(candidate, root):
            raise MapServerError("source file unavailable")
        candidate_stat = candidate.lstat()
        if not stat.S_ISREG(candidate_stat.st_mode):
            raise MapServerError("source file unavailable")
        return candidate
    except MapServerError:
        raise
    except (OSError, RuntimeError, ValueError):
        raise MapServerError("source file unavailable")


def _open_source_fd(root: Path, relative: str) -> int:
    """Open a validated source path while refusing symlink components where supported."""
    parts = PurePosixPath(relative).parts
    if not parts:
        raise OSError("empty source path")
    nofollow = getattr(os, "O_NOFOLLOW", 0)
    cloexec = getattr(os, "O_CLOEXEC", 0)
    directory = getattr(os, "O_DIRECTORY", 0)
    base_flags = os.O_RDONLY | cloexec | nofollow | getattr(os, "O_NONBLOCK", 0)
    supports_dir_fd = getattr(os, "supports_dir_fd", ())
    if nofollow and os.open in supports_dir_fd and os.name == "posix":
        return open_regular_nofollow(root, relative)
    # The preflight symlink walk plus O_NOFOLLOW on the leaf is the safest
    # portable fallback when dirfd operations are unavailable.
    return os.open(str(root.joinpath(*parts)), base_flags)


def _read_source_preview(root: Path, relative: str, language: str) -> dict[str, Any]:
    _source_path(root, relative)
    fd = -1
    try:
        fd = _open_source_fd(root, relative)
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode):
            raise OSError("source file is not regular")
        remaining = MAX_SOURCE_BYTES + 1
        chunks: list[bytes] = []
        while remaining:
            chunk = os.read(fd, remaining)
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        data = b"".join(chunks)
        after = os.fstat(fd)
        if not stat.S_ISREG(after.st_mode):
            raise OSError("source file is not regular")
        if any(getattr(before, field) != getattr(after, field) for field in ("st_dev", "st_ino", "st_size", "st_mtime_ns", "st_ctime_ns")):
            raise OSError("source file changed while reading")
    except (OSError, UnicodeError, ValueError):
        raise MapServerError("source file unavailable")
    finally:
        if fd >= 0:
            with contextlib.suppress(OSError):
                os.close(fd)

    if b"\0" in data:
        raise MapServerError("source file unavailable")
    truncated = len(data) > MAX_SOURCE_BYTES or after.st_size > MAX_SOURCE_BYTES
    prefix = data[:MAX_SOURCE_BYTES]
    try:
        validator = codecs.getincrementaldecoder("utf-8")("strict")
        validator.decode(data, final=after.st_size <= len(data))
        decoder = codecs.getincrementaldecoder("utf-8")("strict")
        decoder.decode(prefix, final=False)
        pending, _ = decoder.getstate()
        if pending:
            content = prefix[:-len(pending)].decode("utf-8")
        else:
            content = prefix.decode("utf-8")
    except UnicodeDecodeError:
        raise MapServerError("source file unavailable")
    return {"path": relative, "content": content, "language": language, "lines": len(engine.split_lines(content)), "truncated": truncated}


def _request(port: int, method: str, path: str, token: str | None = None, body: dict[str, Any] | None = None, timeout: float = REQUEST_TIMEOUT) -> tuple[int, dict[str, Any] | None, bytes]:
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=timeout)
    payload = _json(body) if body is not None else None
    headers = {"Host": f"127.0.0.1:{port}", "Accept": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if payload is not None:
        headers["Content-Type"] = "application/json"
        headers["Content-Length"] = str(len(payload))
    try:
        connection.request(method, path, body=payload, headers=headers)
        response = connection.getresponse()
        raw = response.read(MAX_RESPONSE)
        try:
            decoded = json.loads(raw.decode("utf-8")) if raw else None
        except (UnicodeDecodeError, json.JSONDecodeError):
            decoded = None
        return response.status, decoded if isinstance(decoded, dict) else None, raw
    except (OSError, http.client.HTTPException) as exc:
        raise MapServerError(f"map service unavailable: {exc}") from exc
    finally:
        connection.close()


def _health(runtime: dict[str, Any]) -> dict[str, Any] | None:
    """Return the service's health, {} when its port is reachable but gives no valid health answer, or None when nothing listens."""
    try:
        status, value, _ = _request(runtime["port"], "GET", "/api/health", runtime["token"])
    except MapServerError as exc:
        return None if isinstance(exc.__cause__, ConnectionRefusedError) else {}
    if status != 200 or not value or value.get("service") != SERVICE:
        return {}
    return value


def _shutdown_owned(runtime: dict[str, Any], wait: float = 3.0) -> bool:
    health = _health(runtime)
    if health is None:
        return True
    if not health or health.get("pid") != runtime["pid"] or health.get("port") != runtime["port"]:
        return False
    try:
        status, _, _ = _request(runtime["port"], "POST", "/api/shutdown", runtime["token"], body={})
    except MapServerError:
        return False
    if status != 200:
        return False
    deadline = time.monotonic() + wait
    while time.monotonic() < deadline:
        if not _health(runtime):
            return True
        time.sleep(0.05)
    return False


def _spawn(root: Path, runtime_path: Path, port: int) -> dict[str, Any]:
    build = _client_bundle()[1]
    log_path = _prepare_log(runtime_path.parent)
    command = [sys.executable, "-B", str(Path(__file__).resolve()), "serve", "--port", str(port)]
    handoff = _json({"repo": str(root)})
    if len(handoff) > MAX_HANDOFF:
        raise MapServerError("repository handoff is too large")
    try:
        with log_path.open("ab") as log:
            # The shared service outlives this caller, so it must not keep the caller's directory busy.
            process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=log, stderr=log, cwd=runtime_path.parent, start_new_session=True, close_fds=True)
    except OSError as exc:
        raise MapServerError(f"could not start map service: {exc}") from exc
    threading.Thread(target=process.wait, daemon=True).start()
    try:
        if process.stdin is None:
            raise OSError("map service stdin is unavailable")
        process.stdin.write(handoff)
        process.stdin.close()
    except OSError as exc:
        with contextlib.suppress(OSError):
            if process.stdin is not None:
                process.stdin.close()
        raise MapServerError(f"could not hand off repository to map service: {exc}") from exc
    deadline = time.monotonic() + 10.0
    while time.monotonic() < deadline:
        runtime, _ = _read_runtime(runtime_path)
        if runtime:
            health = _health(runtime)
            if health and health.get("protocol") == PROTOCOL and health.get("build") == build and health.get("pid") == runtime["pid"]:
                return runtime
        if process.poll() is not None:
            break
        time.sleep(0.05)
    if process.poll() is None:
        raise MapServerError("map service did not become healthy before startup timeout")
    try:
        other = _request(port, "GET", "/api/health")[1] or {}
    except MapServerError as exc:
        runtime, _ = _read_runtime(runtime_path)
        if runtime and runtime["port"] == port and isinstance(exc.__cause__, TimeoutError):
            # A timeout, unlike a refusal, means the port is held; this state directory records its own service there.
            raise MapServerError(f"map service (pid {runtime['pid']}) is busy; retry") from exc
        other = {}
    if other.get("service") == SERVICE:
        runtime, _ = _read_runtime(runtime_path)
        if runtime and other.get("pid") == runtime["pid"]:
            # This state directory's own service answered only after the startup probes gave up.
            if other.get("protocol") == PROTOCOL and other.get("build") == build:
                return runtime
            raise MapServerError(f"map service (pid {runtime['pid']}) is busy; retry")
        raise MapServerError(f"another map service (pid {other.get('pid')}) holds port {port}, but this state directory has no usable record of it; stop it or set COMPOUND_MAP_PORT")
    raise MapServerError("map service exited during startup; inspect the state server.log")


def _ensure_service(root: Path) -> dict[str, Any]:
    runtime_path = _runtime_for_repo(root, True)
    with _startup_lock(runtime_path.parent):
        build = _client_bundle()[1]
        runtime, _ = _read_runtime(runtime_path)
        if runtime:
            health = _health(runtime)
            if health and health.get("pid") == runtime["pid"] and health.get("port") == runtime["port"]:
                if health.get("protocol") == PROTOCOL and health.get("build") == build and runtime.get("build_signature") == build:
                    return runtime
                if not _shutdown_owned(runtime):
                    raise MapServerError("an incompatible map service owns the configured port")
        return _spawn(root, runtime_path, _port())


def _register(runtime: dict[str, Any], root: Path, query: str, max_files: int, refresh: bool = False, requery: bool = False) -> dict[str, Any]:
    request = {"root": str(root), "query": query[:MAX_QUERY], "max_files": max(1, min(5000, int(max_files))), "refresh": bool(refresh), "requery": bool(requery)}
    status, value, raw = _request(runtime["port"], "POST", "/api/register", runtime["token"], request)
    if status != 200 or value is None:
        detail = raw.decode("utf-8", "replace")[:300]
        raise MapServerError(f"map registration failed ({status}): {detail}")
    return value


def _open_registered(repo: str | os.PathLike[str], query: str, max_files: int, refresh: bool = False, requery: bool = False) -> tuple[str, dict[str, Any], Path]:
    root = _canonical_repo(repo)
    runtime = _ensure_service(root)
    _register(runtime, root, query, max_files, refresh=refresh, requery=requery)
    project = _project_id(root)
    params = {"project": project}
    if query:
        params["query"] = query[:MAX_QUERY]
    url = f"http://127.0.0.1:{runtime['port']}/?{urllib.parse.urlencode(params)}"
    return url, runtime, root


def open_map(repo: str | os.PathLike[str], query: str = "", open_browser: bool = True, *, private_link: bool = False) -> str:
    """Register a repository. Browser launches use a private local redirect."""
    url, runtime, root = _open_registered(repo, query, 5000, requery=True)
    if not open_browser and not private_link:
        return url
    try:
        opener = viewer_access.launch_link(_runtime_for_repo(root, False).parent, _project_id(root), url, runtime["token"])
    except (OSError, ValueError) as exc:
        raise MapServerError(f"could not prepare the private browser link: {exc}") from exc
    if open_browser:
        try:
            opened = webbrowser.open(opener)
        except Exception as exc:
            raise MapServerError(f"browser launch failed for {opener}: {exc}", url=opener) from exc
        if not opened:
            raise MapServerError(f"browser launch failed for {opener}", url=opener)
    return opener if private_link else url

def _wait_for_index(runtime: dict[str, Any], project: str) -> dict[str, Any]:
    deadline = time.monotonic() + MODEL_WAIT
    path = "/api/status?" + urllib.parse.urlencode({"project": project, "wait": 1})
    while True:
        status, value, raw = _request(runtime["port"], "GET", path, runtime["token"])
        if status != 200 or value is None:
            detail = raw.decode("utf-8", "replace")[:300]
            raise MapServerError(f"map index unavailable ({status}): {detail}")
        if not value.get("indexing"):
            return value
        if time.monotonic() >= deadline:
            raise MapServerError("map index did not become ready before the bounded wait")


def _agent_response(repo: str | os.PathLike[str], query: str, max_files: int, refresh: bool, max_chars: int | None = None) -> Any:
    # The explicit response query does not replace the viewer's saved query.
    _, runtime, root = _open_registered(repo, "", max_files, refresh=refresh)
    project = _project_id(root)
    error = _wait_for_index(runtime, project).get("error")
    if error:
        raise MapServerError(f"map index failed: {error}")
    params = {"project": project, "query": query[:MAX_QUERY], "max_files": max(1, min(RESPONSE_MAX_FILES, int(max_files)))}
    key = "model" if max_chars is None else "text"
    if max_chars is not None:
        params["max_chars"] = engine._clamp(int(max_chars), 500, engine.MAX_CHARS)
    path = ("/api/map?" if max_chars is None else "/api/summary?") + urllib.parse.urlencode(params)
    status, value, raw = _request(runtime["port"], "GET", path, runtime["token"])
    expected_type = dict if max_chars is None else str
    if status != 200 or not value or not isinstance(value.get(key), expected_type):
        detail = raw.decode("utf-8", "replace")[:300]
        raise MapServerError(f"map {key} unavailable ({status}): {detail}")
    return value[key]


def get_model(repo: str | os.PathLike[str], query: str = "", max_files: int = 2000, refresh: bool = False) -> dict[str, Any]:
    """Return the canonical metadata model through the persistent service."""
    return _agent_response(repo, query, max_files, refresh)


def get_text(repo: str | os.PathLike[str], query: str = "", max_files: int = 2000, max_chars: int = 2500, refresh: bool = False) -> str:
    """Return bounded agent context without transferring the full metadata model."""
    return _agent_response(repo, query, max_files, refresh, max_chars)


def get_lookup(repo: str | os.PathLike[str], symbol: str, **options: Any) -> dict[str, Any]:
    """Use the explicitly authorized local service for a bounded lexical lookup."""
    max_files = int(options.get("max_files", lookup_engine.DEFAULT_MAX_FILES))
    _, runtime, root = _open_registered(repo, "", max_files, requery=False)
    project = _project_id(root)
    # The lookup reads the cache this index pass writes, so a cold service builds the model once.
    _wait_for_index(runtime, project)
    request = {**options, "project": project, "symbol": symbol}
    timeout = min(30.0, max(10.0, float(options.get("max_seconds", lookup_engine.DEFAULT_TIMEOUT)) + 10.0))
    status, value, raw = _request(runtime["port"], "POST", "/api/lookup", runtime["token"], request, timeout=timeout)
    if status != 200 or value is None:
        detail = raw.decode("utf-8", "replace")[:300]
        raise MapServerError(f"map lookup unavailable ({status}): {detail}")
    return value


@dataclasses.dataclass
class Project:
    id: str
    name: str
    root: Path
    query: str
    max_files: int
    model: dict[str, Any] | None = None
    revision: int = 0
    indexing: bool = False
    error: str | None = None
    updated_at: str = ""
    last_check: float = 0.0
    git_fingerprint: tuple[str, str] | None = None
    rerun: bool | None = None
    last_used: float = 0.0
    inventory_fingerprint: str | None = None
    stalled: bool = False
    reparse: bool = False
    lock: threading.Condition = dataclasses.field(default_factory=threading.Condition, repr=False)


def _rank_model(model: dict[str, Any], query: str, root: Path | None) -> tuple[list[dict[str, Any]], set[str] | None]:
    """Rank the index once for a response, retaining matches for focused queries."""
    records = list(model.get("files", []))
    query = query[:MAX_QUERY]
    query_matches: set[str] = set()
    try:
        ranked = engine._rank(records, query, root, query_matches=query_matches)
    except (AttributeError, TypeError):
        ranked = records
    focused = engine._query_terms(query)[0] or engine._literal_query_names(query)
    return ranked, query_matches if focused else None


def _project_ranked_model(
    model: dict[str, Any], ranked: list[dict[str, Any]], query_matches: set[str] | None, max_files: int,
) -> dict[str, Any]:
    """Bound a response without shrinking the daemon's shared index."""
    selected = sorted(ranked[:max_files], key=lambda record: record.get("path", ""))
    result = dict(model)
    result["files"] = selected
    result["focus"] = [record["path"] for record in ranked[:min(12, max_files)]]
    if query_matches is not None:
        result["query_matches"] = [path for path in result["focus"] if path in query_matches]
    else:
        result.pop("query_matches", None)
    coverage = dict(model.get("coverage", {}))
    response_skipped = max(0, len(ranked) - len(selected))
    coverage["available"] = len(ranked)
    coverage["response_skipped"] = response_skipped
    coverage["indexed"] = len(selected)
    coverage["truncated"] = bool(coverage.get("truncated") or response_skipped)
    coverage["skipped"] = int(coverage.get("skipped", 0)) + response_skipped
    if response_skipped and "response file cap" not in coverage.get("notes", []):
        notes = list(coverage.get("notes", []))
        notes.append(f"response file cap reached at {max_files} files")
        coverage["notes"] = notes[:24]
    result["coverage"] = coverage
    return result


def _project_model(model: dict[str, Any], query: str, max_files: int, root: Path | None = None) -> dict[str, Any]:
    ranked, matches = _rank_model(model, query, root)
    return _project_ranked_model(model, ranked, matches, max_files)


def _mark_response_cap(model: dict[str, Any]) -> dict[str, Any]:
    """Record a byte-cap reduction while preserving the model's skip counts."""
    result = dict(model)
    coverage = dict(model.get("coverage", {}))
    coverage["truncated"] = True
    notes = list(coverage.get("notes", [])) if isinstance(coverage.get("notes", []), list) else []
    selected = len(model.get("files", [])) if isinstance(model.get("files"), list) else 0
    note = f"response size cap reached at {selected} files"
    if note not in notes:
        notes.append(note)
    coverage["notes"] = notes[:24]
    result["coverage"] = coverage
    return result


class MapService:
    def __init__(self, token: str, port: int, assets: dict[str, bytes]):
        self.token = token
        self.viewer_token = viewer_access.read_token(token)
        self.instance = secrets.token_hex(8)
        self.port = port
        self.assets = assets
        self.projects: dict[str, Project] = {}
        self._registry: dict[str, dict[str, str]] = {}
        self._registry_loaded = False
        self.lock = threading.RLock()
        self._index_slots = threading.BoundedSemaphore(MAX_INDEX_WORKERS)
        self._lookup_slots = threading.BoundedSemaphore(2)
        self._reference_cache = IdentifierPostingsCache(max_entries=2000)
        self.httpd: MapHTTPServer | None = None

    def _load_registry(self) -> None:
        if not self._registry_loaded:
            self._registry = _read_registry()
            self._registry_loaded = True

    def _save_registry(self) -> None:
        try:
            _write_registry(self._registry)
        except (MapServerError, OSError):
            # The service remains usable when a user cache is unavailable;
            # registration is simply ephemeral for that invocation.
            return

    def _remember(self, project: Project) -> None:
        self._load_registry()
        with project.lock:
            name = _printable(project.name[:MAX_REGISTRY_NAME])
            query = project.query[:MAX_QUERY]
        self._registry.pop(project.id, None)
        self._registry[project.id] = {"id": project.id, "root": str(project.root), "name": name, "query": query}
        while len(self._registry) > MAX_REGISTRY_PROJECTS:
            self._registry.pop(next(iter(self._registry)))
        self._save_registry()

    def _restore(self, project_id: str) -> Project | None:
        self._load_registry()
        entry = self._registry.get(project_id)
        if entry is None:
            return None
        try:
            raw_root = Path(entry["root"])
            if not raw_root.is_absolute():
                raise ValueError("registered repository is not absolute")
            _reject_symlink(raw_root, "registered repository")
            root = _canonical_repo(raw_root)
            if _project_id(root) != project_id:
                raise ValueError("registered repository identity changed")
            project = Project(project_id, entry["name"], root, entry["query"], INDEX_MAX_FILES)
        except (OSError, RuntimeError, TypeError, ValueError, KeyError):
            # Drop invalid, missing, private, or symlinked roots without
            # exposing their stored path through the HTTP API.
            self._registry.pop(project_id, None)
            self._save_registry()
            return None
        self.projects[project_id] = project
        return project

    def _evict_loaded(self, keep: Project | None = None) -> None:
        """Drop idle in-memory models while retaining their registry records."""
        while len(self.projects) > MAX_LOADED_PROJECTS:
            candidates: list[tuple[float, str]] = []
            for project_id, project in self.projects.items():
                if project is keep:
                    continue
                with project.lock:
                    if project.indexing:
                        continue
                    candidates.append((project.last_used, project_id))
            if not candidates:
                return
            _, project_id = min(candidates)
            evicted = self.projects.pop(project_id, None)
            if evicted is not None:
                self._reference_cache.invalidate_root(evicted.root)

    def project_list(self) -> list[dict[str, str]]:
        """List safe IDs and display names without validating/indexing roots."""
        with self.lock:
            self._load_registry()
            values: dict[str, dict[str, str]] = {}
            for project in self.projects.values():
                with project.lock:
                    values[project.id] = {"id": project.id, "name": project.name}
            for project_id, entry in self._registry.items():
                values.setdefault(project_id, {"id": project_id, "name": entry["name"]})
            return sorted(values.values(), key=lambda item: item["name"])

    def _refresh_worker(self, project: Project, force: bool = False) -> None:
        # A request that arrives mid-build queues one more pass and keeps the project
        # indexing until it finishes, so waiting callers never receive older files.
        while True:
            self._index_once(project, force)
            with project.lock:
                if project.rerun is None:
                    project.indexing = False
                    project.lock.notify_all()
                    return
                force, project.rerun = project.rerun, None

    def _index_once(self, project: Project, force: bool) -> None:
        self._index_slots.acquire()
        try:
            tracked, untracked, notes = engine._git_inventory_parts(project.root)
            inventory_result = (None if tracked is None else tracked + untracked), notes
            capped = engine.INVENTORY_CAP_NOTE in notes
            status = None
            if tracked is not None and engine.UNTRACKED_INVENTORY_NOTE not in notes:
                status = engine._git_status_snapshot(project.root, untracked=capped)
            before = _inventory_fingerprint(project.root, inventory_result, status=status or b"")
            with project.lock:
                pending = project.model.get("coverage", {}).get("pending", 0) if project.model else 0
                unchanged = bool(before) and project.model is not None and project.inventory_fingerprint == before
                # Files deferred by the read budget force another pass only while passes parse more of them.
                reuse = not force and unchanged and (not pending or project.stalled) and not project.error
                if not reuse:
                    refresh, project.reparse = project.reparse, False
            if reuse:
                # Rebuilds already obtain the display name in the engine.
                display_name = engine.repository_name(project.root)
                with project.lock:
                    if project.name != display_name or project.model.get("root_name") != display_name:
                        project.model = {**project.model, "root_name": display_name}
                        project.name = display_name
                        project.revision += 1
                        project.updated_at = _now()
                return
            git_snapshot = engine._parse_git_state(project.root, status, b"" if capped else untracked) if status else None
            model = engine._build_model(
                project.root, query="", max_files=INDEX_MAX_FILES, refresh=refresh,
                inventory_result=inventory_result if before else None, git_state=git_snapshot,
            )
            if model["coverage"].get("inventory_available") is False:
                raise MapServerError(model["coverage"]["notes"][0])
            untracked_missing = engine.UNTRACKED_INVENTORY_NOTE in model["coverage"]["notes"]
            after = _inventory_fingerprint(project.root) if before and not untracked_missing else ""
            git_state = _model_git_state(model)
            with project.lock:
                old = project.model
                stable_old = dict(old) if old else None
                if stable_old is not None:
                    stable_old.pop("generated_at", None)
                stable_new = dict(model)
                stable_new.pop("generated_at", None)
                if old is None or stable_old != stable_new or (git_state is not None and project.git_fingerprint != git_state):
                    project.revision += 1
                project.model = model
                # A concurrent edit must force another build on the next check.
                project.inventory_fingerprint = after if before == after else None
                # A refresh parses from an empty cache, so its pending count says nothing about progress.
                project.stalled = not refresh and unchanged and bool(pending) and model.get("coverage", {}).get("pending", 0) >= pending
                if git_state is not None:
                    project.git_fingerprint = git_state
                project.name = model.get("root_name", project.name)
                project.error = None
                project.updated_at = _now()
        except Exception as exc:
            message = str(exc).replace(str(project.root), "<repository>")
            with project.lock:
                project.error = message[:500] or exc.__class__.__name__
                project.updated_at = _now()
        finally:
            try:
                with self.lock:
                    with project.lock:
                        project.last_check = time.monotonic()
                    self._remember(project)
                    self._evict_loaded(keep=project)
            finally:
                self._index_slots.release()

    def _refresh(self, project: Project, force: bool = False, recheck: bool = False) -> None:
        """Queue one bounded index build without holding the service lock.

        Polls check at most every 2 seconds, or every 30 while Git cannot fingerprint the
        repository and each check rebuilds; explicit requests (recheck) always check.
        """
        with project.lock:
            now = time.monotonic()
            if project.indexing:
                if force or recheck:
                    project.rerun = bool(force or project.rerun)
                return
            if not force and not recheck and now - project.last_check < (30.0 if project.inventory_fingerprint == "" else 2.0):
                return
            project.last_check = now
            project.indexing = True
        worker = threading.Thread(target=self._refresh_worker, args=(project, force), name="compound-map-index", daemon=True)
        try:
            worker.start()
        except RuntimeError as exc:
            with project.lock:
                project.indexing = False
                project.error = str(exc)[:500]
                project.updated_at = _now()
                project.lock.notify_all()

    def register(self, root: Path, query: str, max_files: int, refresh: bool = False, requery: bool = False) -> Project:
        project_id = _project_id(root)
        # The saved registry rejects control characters, and ranking only reads word characters.
        query = _printable(query)
        with self.lock:
            self._load_registry()
            project = self.projects.get(project_id)
            force = refresh
            if project is None:
                name = root.name
                saved = self._registry.get(project_id)
                if saved is not None and saved["root"] == str(root):
                    name = saved["name"]
                    if not requery:
                        query = saved["query"]
                project = Project(project_id, name, root, query[:MAX_QUERY], INDEX_MAX_FILES)
                project.last_used = time.monotonic()
                self.projects[project_id] = project
                force = True
            else:
                with project.lock:
                    project.last_used = time.monotonic()
                    query_changed = requery and project.query != query[:MAX_QUERY]
                    if query_changed:
                        project.query = query[:MAX_QUERY]
                force = refresh
            with project.lock:
                # Like the in-process --refresh, an explicit refresh also reparses cached file outlines.
                project.reparse = project.reparse or refresh
            self._remember(project)
            self._evict_loaded(keep=project)
        self._refresh(project, force=force, recheck=True)
        return project

    def project(self, project_id: str) -> Project | None:
        with self.lock:
            if not isinstance(project_id, str) or len(project_id) != 64:
                return None
            project = self.projects.get(project_id)
            if project is None:
                project = self._restore(project_id)
            if project is not None:
                with project.lock:
                    project.last_used = time.monotonic()
                self._evict_loaded(keep=project)
            return project

    def status(self, project: Project, wait: bool = False) -> dict[str, Any]:
        self._refresh(project)
        with project.lock:
            if wait:
                project.lock.wait_for(lambda: not project.indexing, timeout=INDEX_STATUS_WAIT)
            return {"project": {"id": project.id, "name": project.name}, "revision": project.revision, "instance": self.instance, "indexing": project.indexing, "error": project.error, "updated_at": project.updated_at}

    def _index_snapshot(
        self, project: Project, query: str | None,
    ) -> tuple[dict[str, Any] | None, dict[str, str], int, bool, str | None, str]:
        self._refresh(project)
        with project.lock:
            current = project.model
            project_info = {"id": project.id, "name": project.name}
            revision = project.revision
            indexing = project.indexing
            error = project.error
            selected_query = project.query if query is None else query
        return None if error else current, project_info, revision, indexing, error, selected_query

    def _model_snapshot(
        self, project: Project, max_files: int | None = None, query: str | None = None, *,
        exact_summary: bool = False,
    ) -> tuple[dict[str, Any] | None, dict[str, str], int, bool, str | None]:
        current, project_info, revision, indexing, error, selected_query = self._index_snapshot(project, query)
        if current is None:
            return None, project_info, revision, indexing, error
        if exact_summary:
            exact, exact_symbol = engine._summary_target(
                current["files"], selected_query, allow_symbol=not current["coverage"].get("truncated"),
            )
            if exact is not None:
                target = exact["path"]
                model = {**current, "files": [exact], "focus": [target], "query_matches": [target]}
                if exact_symbol is not None:
                    model["exact_symbol"] = exact_symbol
                return model, project_info, revision, indexing, error
        requested = RESPONSE_MAX_FILES if max_files is None else max(1, min(RESPONSE_MAX_FILES, int(max_files)))
        return _project_model(current, selected_query, requested, project.root), project_info, revision, indexing, error

    def model(self, project: Project, max_files: int | None = None, query: str | None = None) -> dict[str, Any] | None:
        model, _, _, _, _ = self._model_snapshot(project, max_files, query)
        return model

    def summary_response(self, project: Project, max_files: int | None, query: str, max_chars: int) -> tuple[dict[str, Any] | None, bytes]:
        """Render bounded agent context inside the service rather than sending the index."""
        model, project_info, revision, indexing, error = self._model_snapshot(project, max_files, query, exact_summary=True)
        if model is None:
            return None, _json({"project": project_info, "revision": revision, "indexing": indexing, "error": error, "model": None})
        text = engine._text(model, engine._clamp(max_chars, 500, engine.MAX_CHARS), query)
        return model, _json({"project": project_info, "revision": revision, "text": text})

    def map_response(self, project: Project, max_files: int | None = None, query: str | None = None) -> tuple[dict[str, Any] | None, bytes]:
        """Serialize a map response under the transport cap without shrinking the index."""
        cap = RESPONSE_MAX_FILES if max_files is None else max(1, min(RESPONSE_MAX_FILES, int(max_files)))
        current, project_info, revision, indexing, error, selected_query = self._index_snapshot(project, query)
        if current is None:
            return None, _json({"project": project_info, "revision": revision, "indexing": indexing, "error": error, "model": None})
        ranked, matches = _rank_model(current, selected_query, project.root)
        response_capped = False
        while True:
            model = _project_ranked_model(current, ranked, matches, cap)
            if response_capped:
                model = _mark_response_cap(model)
            payload = {"project": project_info, "revision": revision, "instance": self.instance, "model": model}
            body = _json(payload)
            if len(body) <= MAX_RESPONSE:
                return model, body
            files = model.get("files")
            if not isinstance(files, list) or len(files) <= 1 or cap <= 1:
                return model, body
            response_capped = True
            next_cap = max(1, cap // 2)
            if next_cap >= cap:
                next_cap = max(1, len(files) // 2)
            cap = next_cap

    def lookup(self, project: Project, request: dict[str, Any]) -> dict[str, Any]:
        """Run a bounded authenticated lookup with memory-only postings."""
        if not self._lookup_slots.acquire(blocking=False):
            raise MapServerError("lookup service busy")
        try:
            return lookup_engine.lookup_symbols(
                project.root, request.get("symbol"),
                max_files=int(request.get("max_files", lookup_engine.DEFAULT_MAX_FILES)),
                max_results=int(request.get("max_results", lookup_engine.DEFAULT_MAX_RESULTS)),
                max_seconds=float(request.get("max_seconds", lookup_engine.DEFAULT_TIMEOUT)),
                max_file_bytes=int(request.get("max_file_bytes", lookup_engine.DEFAULT_MAX_FILE_BYTES)),
                max_total_bytes=int(request.get("max_total_bytes", lookup_engine.DEFAULT_MAX_TOTAL_BYTES)),
                max_output_bytes=int(request.get("max_output_bytes", lookup_engine.DEFAULT_MAX_OUTPUT_BYTES)),
                reference_cache=self._reference_cache,
            )
        finally:
            self._lookup_slots.release()

    def source(self, project: Project, relative: str) -> dict[str, Any]:
        self._refresh(project)
        with project.lock:
            model = project.model
            root = project.root
            if not isinstance(model, dict):
                raise MapServerError("source file unavailable")
            files = model.get("files")
            if not isinstance(files, list):
                raise MapServerError("source file unavailable")
            record = next((item for item in files if isinstance(item, dict) and item.get("path") == relative), None)
            if record is None or not isinstance(record.get("language"), str):
                raise MapServerError("source file unavailable")
            language = record["language"]
        return _read_source_preview(root, relative, language)


class MapHTTPServer(http.server.ThreadingHTTPServer):
    allow_reuse_address = True
    daemon_threads = True

    def handle_error(self, request: Any, client_address: Any) -> None:
        # Clients that disconnect mid-request are routine; their tracebacks would only grow the log.
        if not isinstance(sys.exc_info()[1], ConnectionError):
            super().handle_error(request, client_address)


class MapHandler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_args: Any) -> None:
        return

    @property
    def service(self) -> MapService:
        return self.server.service  # type: ignore[attr-defined]

    def _same_origin(self) -> bool:
        host = self.headers.get("Host", "")
        host_name, separator, host_port = host.partition(":")
        if host_name != "127.0.0.1" or (separator and host_port != str(self.server.server_port)):
            return False
        origin = self.headers.get("Origin")
        if not origin:
            return True
        return origin == f"http://127.0.0.1:{self.server.server_port}"

    def _authorized(self, *, read: bool = False) -> bool:
        header = self.headers.get("Authorization", "")
        return viewer_access.bearer_matches(header, self.service.token) or (
            read and viewer_access.bearer_matches(header, self.service.viewer_token)
        )

    def _headers(self, content_type: str) -> None:
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(self._body)))
        if self.close_connection:
            self.send_header("Connection", "close")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'")

    def _respond(self, status: int, body: bytes, content_type: str = "application/json; charset=utf-8") -> None:
        self._body = body
        self.send_response(status)
        self._headers(content_type)
        self.end_headers()
        self.wfile.write(body)

    def _error(self, status: int, message: str) -> None:
        self._respond(status, _json({"error": message}))

    def _route_guard(self) -> bool:
        if not self._same_origin():
            self._error(403, "host or origin is not allowed")
            return False
        return True

    def do_GET(self) -> None:  # noqa: N802
        if not self._route_guard():
            return
        parsed = urllib.parse.urlsplit(self.path)
        if parsed.path == "/api/health":
            self._respond(200, _json({"service": SERVICE, "protocol": PROTOCOL, "build": _client_bundle()[1], "pid": os.getpid(), "port": self.server.server_port}))
            return
        if parsed.path.startswith("/api/") and not self._authorized(read=True):
            self._error(401, "authorization required")
            return
        if parsed.path == "/api/projects":
            projects = self.service.project_list()
            self._respond(200, _json({"projects": projects, "version": _client_bundle()[1]}))
            return
        if parsed.path == "/api/file":
            # Indexed paths keep undecodable name bytes as surrogate escapes, so a percent-encoded byte must decode to one.
            params = urllib.parse.parse_qs(parsed.query, keep_blank_values=True, errors="surrogateescape")
            project_values = params.get("project", [])
            path_values = params.get("path", [])
            if len(project_values) != 1 or len(path_values) != 1:
                self._error(400, "project and source path are required")
                return
            try:
                relative = _source_relative(path_values[0])
            except MapServerError:
                self._error(400, "invalid source path")
                return
            with self.service.lock:
                project = self.service.project(project_values[0])
            if project is None:
                self._error(404, "unknown project")
                return
            try:
                source = self.service.source(project, relative)
            except (MapServerError, OSError, TypeError, ValueError):
                self._error(404, "source file unavailable")
                return
            self._respond(200, _json(source))
            return
        if parsed.path in {"/api/status", "/api/map", "/api/summary"}:
            params = urllib.parse.parse_qs(parsed.query, keep_blank_values=True)
            project_id = params.get("project", [""])[0]
            with self.service.lock:
                project = self.service.project(project_id)
            if project is None:
                self._error(404, "unknown project")
                return
            if parsed.path == "/api/status":
                wait = params.get("wait") == ["1"]
                if wait and not self._authorized():
                    self._error(401, "authorization required")
                    return
                self._respond(200, _json(self.service.status(project, wait=wait)))
                return
            requested = params.get("max_files", [None])[0]
            try:
                maximum = int(requested) if requested is not None else None
            except ValueError:
                self._error(400, "invalid max_files")
                return
            query = params.get("query", [project.query])[0]
            if not isinstance(query, str) or len(query) > MAX_QUERY:
                self._error(400, "query is invalid")
                return
            if parsed.path == "/api/summary":
                try:
                    max_chars = int(params.get("max_chars", [engine.DEFAULT_MAX_CHARS])[0])
                except ValueError:
                    self._error(400, "invalid max_chars")
                    return
                model, body = self.service.summary_response(project, maximum, query, max_chars)
            else:
                model, body = self.service.map_response(project, maximum, query=query)
            if model is None:
                try:
                    pending = json.loads(body.decode("utf-8"))
                except (UnicodeDecodeError, json.JSONDecodeError):
                    pending = {}
                if not isinstance(pending, dict):
                    self._error(503, "map is unavailable")
                    return
                if pending.get("error") and not pending.get("indexing"):
                    self._error(503, str(pending["error"]))
                    return
                if not pending.get("indexing"):
                    self._error(503, "map is unavailable")
                    return
                self._respond(202, body)
                return
            if len(body) > MAX_RESPONSE:
                self._error(413, "map response exceeds service limit")
                return
            self._respond(200, body)
            return
        if parsed.path in {"/", "/index.html", "/code-map.html", "/code-map.css", "/code-map.js", "/map-graph.js"}:
            name = "code-map.html" if parsed.path in {"/", "/index.html"} else parsed.path.rsplit("/", 1)[-1]
            body = self.service.assets.get(name)
            if body is None:
                self._error(404, "asset unavailable")
                return
            self._respond(200, body, ASSET_TYPES[PurePosixPath(name).suffix])
            return
        self._error(404, "not found")

    def do_POST(self) -> None:  # noqa: N802
        # Rejections leave the body unread, so close rather than parse it as another request.
        self.close_connection = True
        if not self._route_guard():
            return
        parsed = urllib.parse.urlsplit(self.path)
        if parsed.path not in {"/api/register", "/api/shutdown", "/api/lookup"}:
            self._error(404, "not found")
            return
        if not self._authorized():
            self._error(401, "authorization required")
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = MAX_BODY + 1
        if length < 0 or length > MAX_BODY:
            self._error(413, "request body too large")
            return
        try:
            value = json.loads(self.rfile.read(length).decode("utf-8")) if length else {}
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._error(400, "invalid JSON")
            return
        if not isinstance(value, dict):
            self._error(400, "invalid request")
            return
        if parsed.path == "/api/shutdown":
            self._respond(200, _json({"stopping": True}))
            threading.Thread(target=self.server.shutdown, daemon=True).start()
            return
        if parsed.path == "/api/lookup":
            project = self.service.project(value.get("project"))
            if project is None:
                self._error(404, "unknown project")
                return
            try:
                result = self.service.lookup(project, value)
            except MapServerError as exc:
                self._error(503, str(exc)[:500])
                return
            except (OSError, TypeError, ValueError, OverflowError) as exc:
                self._error(400, str(exc).replace(str(project.root), "<repository>")[:500])
                return
            self._respond(200, _json(result))
            return
        raw_root = value.get("root")
        if not isinstance(raw_root, str) or not raw_root:
            self._error(400, "repository is required")
            return
        try:
            root = _canonical_repo(raw_root)
            query = value.get("query", "")
            maximum = int(value.get("max_files", 5000))
            refresh = bool(value.get("refresh", False))
            requery = bool(value.get("requery", False))
            if not isinstance(query, str) or len(query) > MAX_QUERY:
                raise MapServerError("query is invalid")
            project = self.service.register(root, query, maximum, refresh=refresh, requery=requery)
        except (MapServerError, OSError, TypeError, ValueError) as exc:
            self._error(400, str(exc)[:500])
            return
        self._respond(200, _json({"project": {"id": project.id, "name": project.name}, "revision": project.revision, "error": project.error}))


def _read_handoff() -> str:
    stream = getattr(sys.stdin, "buffer", sys.stdin)
    try:
        raw = stream.read(MAX_HANDOFF + 1)
    except (OSError, ValueError) as exc:
        raise MapServerError(f"could not read map service handoff: {exc}") from exc
    if isinstance(raw, str):
        raw = raw.encode("utf-8")
    if len(raw) > MAX_HANDOFF:
        raise MapServerError("map service handoff is too large")
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise MapServerError("map service handoff is invalid") from exc
    repo = value.get("repo") if isinstance(value, dict) else None
    if not isinstance(repo, str) or not repo:
        raise MapServerError("map service handoff has no repository")
    return repo


def _serve(repo: str | None, port: int) -> int:
    if repo is None:
        repo = _read_handoff()
    root = _canonical_repo(repo)
    runtime_path = _runtime_for_repo(root, True)
    assets, build = _client_bundle()
    token = secrets.token_urlsafe(32)
    try:
        httpd = MapHTTPServer(("127.0.0.1", port), MapHandler)
    except OSError as exc:
        raise MapServerError(f"could not bind map service to 127.0.0.1:{port}: {exc}") from exc
    actual_port = int(httpd.server_address[1])
    service = MapService(token, actual_port, assets)
    httpd.service = service  # type: ignore[attr-defined]
    service.httpd = httpd
    runtime = {"pid": os.getpid(), "port": actual_port, "token": token, "build_signature": build, "build": build}

    def keep_runtime() -> None:
        # The CLI finds this service only through its runtime file, so restore it after a cache cleanup.
        if not runtime_path.exists():
            with contextlib.suppress(MapServerError, OSError):
                _write_runtime(_runtime_for_repo(root, True), runtime)

    httpd.service_actions = keep_runtime  # type: ignore[method-assign]
    try:
        _write_runtime(runtime_path, runtime)
        for signal_name in (signal.SIGINT, signal.SIGTERM):
            signal.signal(signal_name, lambda *_args: threading.Thread(target=httpd.shutdown, daemon=True).start())
        httpd.serve_forever(poll_interval=0.1)
    finally:
        httpd.server_close()
        try:
            current, _ = _read_runtime(runtime_path)
            if current and current["pid"] == runtime["pid"] and current["token"] == runtime["token"]:
                runtime_path.unlink()
        except OSError:
            pass
    return 0


def _status() -> int:
    try:
        path = _runtime_without_repo()
        runtime, error = _read_runtime(path)
    except (MapServerError, OSError, ValueError) as exc:
        print(json.dumps({"status": "unavailable", "error": str(exc)}, ensure_ascii=True))
        return 1
    if runtime is None:
        print(json.dumps({"status": "stopped", "error": error}, ensure_ascii=True))
        return 0
    health = _health(runtime)
    if health and health.get("protocol") == PROTOCOL and health.get("pid") == runtime["pid"]:
        print(json.dumps({"status": "running", "pid": runtime["pid"], "port": runtime["port"], "build": health.get("build", "")}, ensure_ascii=True))
        return 0
    if health is None:
        print(json.dumps({"status": "stopped", "pid": runtime["pid"], "error": "service exited without removing its runtime file"}, ensure_ascii=True))
        return 0
    print(json.dumps({"status": "stale", "pid": runtime["pid"], "port": runtime["port"], "error": "service is not responding"}, ensure_ascii=True))
    return 1


def _stop() -> int:
    try:
        path = _runtime_without_repo()
        runtime, error = _read_runtime(path)
    except (MapServerError, OSError, ValueError) as exc:
        print(json.dumps({"status": "unavailable", "error": str(exc)}, ensure_ascii=True))
        return 1
    if runtime is None:
        print(json.dumps({"status": "stopped", "error": error}, ensure_ascii=True))
        return 0
    if _shutdown_owned(runtime):
        # A service that crashed or was killed leaves its runtime file behind.
        with contextlib.suppress(OSError):
            if _read_runtime(path)[0] == runtime:
                path.unlink()
        print(json.dumps({"status": "stopped", "pid": runtime["pid"]}, ensure_ascii=True))
        return 0
    print(json.dumps({"status": "stale", "pid": runtime["pid"], "error": "owned service did not accept shutdown"}, ensure_ascii=True))
    return 1


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Serve the Compound code-map viewer on loopback")
    commands = parser.add_subparsers(dest="command", required=True, metavar="{open,status,stop}")
    opening = commands.add_parser("open", help="start or reuse the viewer and print its URL")
    opening.add_argument("--repo", required=True)
    opening.add_argument("--query", default="")
    launch = opening.add_mutually_exclusive_group()
    launch.add_argument("--no-open", action="store_true", help="print only the loopback service URL")
    launch.add_argument("--link", action="store_true", help="print a private browser launch link without opening it")
    commands.add_parser("status", help="report whether the shared viewer service is running")
    commands.add_parser("stop", help="stop the shared viewer service for every project")
    # Internal: `open` launches the service with this subcommand.
    serving = commands.add_parser("serve")
    serving.add_argument("--port", type=int, default=None)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        if args.command == "open":
            try:
                if args.link:
                    url = open_map(args.repo, args.query, False, private_link=True)
                else:
                    url = open_map(args.repo, args.query, not args.no_open)
            except MapServerError as exc:
                if exc.url is None:
                    raise
                print("browser launch failed. Open the private launch link manually.", file=sys.stderr)
                url = exc.url
            print(url)
            return 0
        if args.command == "status":
            return _status()
        if args.command == "stop":
            return _stop()
        return _serve(None, _port(args.port))
    except (MapServerError, OSError) as exc:
        print(f"map-server error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
