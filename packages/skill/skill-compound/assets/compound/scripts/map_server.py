#!/usr/bin/env python3
"""Small authenticated loopback service for the Compound code-map viewer."""

from __future__ import annotations

import argparse
import codecs
import contextlib
import dataclasses
import datetime as dt
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
import tempfile
import threading
import time
import urllib.parse
import webbrowser
from pathlib import Path, PurePosixPath
from typing import Any

try:
    import fcntl
except ImportError:  # pragma: no cover - Windows has no fcntl
    fcntl = None

try:
    from . import code_map as engine
    from .onboarding import _reject_symlink_chain, _state_paths
except ImportError:  # direct script execution
    import code_map as engine
    from onboarding import _reject_symlink_chain, _state_paths


SERVICE = "compound-code-map"
PROTOCOL = 1
DEFAULT_PORT = 43127
MAX_BODY = 64 * 1024
MAX_RESPONSE = 8 * 1024 * 1024
MAX_QUERY = 512
MAX_LOG_BYTES = 256 * 1024
MAX_HANDOFF = 16 * 1024
INDEX_MAX_FILES = 5000
MAX_SOURCE_BYTES = 64 * 1024
MAX_SOURCE_PATH = 4096
MAX_GIT_STATUS_BYTES = 256 * 1024
REGISTRY_VERSION = 1
REGISTRY_FILE = "registry.json"
MAX_REGISTRY_PROJECTS = 32
MAX_REGISTRY_BYTES = 256 * 1024
MAX_REGISTRY_NAME = 256
MODEL_WAIT = 30.0
MAX_LOADED_PROJECTS = 8
MAX_INDEX_WORKERS = 4
ASSET_NAMES = ("code-map.html", "code-map.css", "code-map.js", "map-graph.js")
ASSET_TYPES = {
    "code-map.html": "text/html; charset=utf-8",
    "code-map.css": "text/css; charset=utf-8",
    "code-map.js": "text/javascript; charset=utf-8",
    "map-graph.js": "text/javascript; charset=utf-8",
}
ASSET_DIR = Path(__file__).resolve().parent.parent / "assets"


class MapServerError(ValueError):
    def __init__(self, message: str, url: str | None = None):
        super().__init__(message)
        self.url = url


def _now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")


def _json(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=True, separators=(",", ":")).encode("utf-8")


def _build_assets() -> tuple[dict[str, bytes], str]:
    assets: dict[str, bytes] = {}
    digest = hashlib.sha256()
    for script in (Path(__file__), Path(engine.__file__)):
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
        digest.update(name.encode("utf-8"))
        digest.update(b"\0")
        digest.update(value)
    return assets, digest.hexdigest()[:24]


_CLIENT_ASSETS, BUILD_SIGNATURE = _build_assets()


def _git_branch(status: bytes) -> str:
    """Extract only the local branch name from porcelain's bounded header."""
    header = status.split(b"\n", 1)[0]
    if not header.startswith(b"## "):
        return ""
    try:
        value = os.fsdecode(header[3:].strip())
    except (UnicodeDecodeError, ValueError):
        return ""
    if value.startswith("No commits yet on "):
        value = value[len("No commits yet on "):]
    if value in {"HEAD", "HEAD (no branch)", "(no branch)"}:
        return ""
    return value.split("...", 1)[0].split(" [", 1)[0]


def _git_state_fingerprint(root: Path) -> tuple[str, str] | None:
    """Fallback for engines that predate the model's bounded Git state fields."""
    command = [
        "git",
        "-C",
        str(root),
        "status",
        "--porcelain=v1",
        "--branch",
        "-z",
        "--untracked-files=all",
    ]
    process: subprocess.Popen[bytes] | None = None
    stream: Any = None
    raw = b""
    truncated = False
    try:
        process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        stream = process.stdout
        if stream is None:
            return None
        raw = stream.read(MAX_GIT_STATUS_BYTES + 1)
        if not isinstance(raw, bytes):
            return None
        truncated = len(raw) > MAX_GIT_STATUS_BYTES
        if truncated:
            with contextlib.suppress(OSError):
                process.kill()
        try:
            process.wait(timeout=float(getattr(engine, "GIT_TIMEOUT", 5)))
        except subprocess.TimeoutExpired:
            with contextlib.suppress(OSError):
                process.kill()
            with contextlib.suppress(OSError, subprocess.TimeoutExpired):
                process.wait(timeout=1)
            return None
        if process.returncode != 0 and not truncated:
            return None
    except (OSError, ValueError, subprocess.TimeoutExpired):
        if process is not None:
            with contextlib.suppress(OSError):
                process.kill()
            with contextlib.suppress(OSError, subprocess.TimeoutExpired):
                process.wait(timeout=1)
        return None
    finally:
        if stream is not None:
            with contextlib.suppress(OSError, ValueError):
                stream.close()
    if truncated:
        raw = raw[:MAX_GIT_STATUS_BYTES]
    digest = hashlib.sha256()
    digest.update(raw)
    digest.update(b"\0truncated=")
    digest.update(b"1" if truncated else b"0")
    return _git_branch(raw), digest.hexdigest()


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
        root, _, _, _ = engine._git_context(supplied)
        return root
    except (OSError, ValueError) as exc:
        raise MapServerError(str(exc)) from exc


def _project_id(root: Path) -> str:
    return hashlib.sha256(str(root).encode("utf-8")).hexdigest()


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
    base_flags = os.O_RDONLY | cloexec | nofollow
    supports_dir_fd = getattr(os, "supports_dir_fd", ())
    if nofollow and os.open in supports_dir_fd:
        current = os.open(str(root), base_flags | directory)
        try:
            if not stat.S_ISDIR(os.fstat(current).st_mode):
                raise OSError("source root is not a directory")
            for component in parts[:-1]:
                child = os.open(component, base_flags | directory, dir_fd=current)
                try:
                    if not stat.S_ISDIR(os.fstat(child).st_mode):
                        raise OSError("source parent is not a directory")
                except BaseException:
                    with contextlib.suppress(OSError):
                        os.close(child)
                    raise
                os.close(current)
                current = child
            fd = os.open(parts[-1], base_flags, dir_fd=current)
            os.close(current)
            current = -1
            return fd
        finally:
            if current >= 0:
                with contextlib.suppress(OSError):
                    os.close(current)
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
    return {
        "path": relative,
        "content": content,
        "language": language,
        "lines": len(content.splitlines()),
        "truncated": truncated,
    }


def _runtime_for_repo(root: Path, write: bool) -> Path:
    try:
        directory, _ = engine._cache_location(root, write)
        return directory / "runtime.json"
    except (OSError, ValueError) as exc:
        raise MapServerError(str(exc)) from exc


def _runtime_without_repo() -> Path:
    state, _ = _state_paths()
    _reject_symlink_chain(state, "state parent")
    directory = state / "code-map"
    if directory.is_symlink() or (directory.exists() and not directory.is_dir()):
        raise MapServerError(f"refusing unsafe code-map runtime directory: {directory}")
    return directory / "runtime.json"


def _registry_path(write: bool = False) -> Path:
    """Return the private process registry beside the user runtime state."""
    runtime = _runtime_without_repo()
    directory = runtime.parent
    try:
        if directory.is_symlink() or (directory.exists() and not directory.is_dir()):
            raise MapServerError(f"refusing unsafe code-map registry directory: {directory}")
        if write:
            directory.mkdir(parents=True, exist_ok=True)
            _reject_symlink_chain(directory, "code-map registry parent")
        path = directory / REGISTRY_FILE
        if path.is_symlink() or (path.exists() and not path.is_file()):
            raise MapServerError(f"refusing unsafe code-map registry: {path}")
        return path
    except MapServerError:
        raise
    except OSError as exc:
        raise MapServerError(f"could not prepare code-map registry: {exc}") from exc


def _registry_string(value: Any, maximum: int) -> str | None:
    if not isinstance(value, str) or not value or len(value) > maximum:
        return None
    if any(ord(character) < 32 or ord(character) == 127 for character in value):
        return None
    return value


def _read_registry() -> dict[str, dict[str, str]]:
    """Read only bounded registry metadata; roots are verified on ID lookup."""
    try:
        path = _registry_path(False)
        if not path.exists():
            return {}
        if path.stat().st_mode & 0o077:
            return {}
        with path.open("rb") as handle:
            raw = handle.read(MAX_REGISTRY_BYTES + 1)
        if len(raw) > MAX_REGISTRY_BYTES:
            return {}
        value = json.loads(raw.decode("utf-8"))
    except (MapServerError, OSError, UnicodeError, json.JSONDecodeError):
        return {}
    if not isinstance(value, dict) or value.get("version") != REGISTRY_VERSION:
        return {}
    records = value.get("projects")
    if not isinstance(records, list):
        return {}
    entries: dict[str, dict[str, str]] = {}
    for record in records[:MAX_REGISTRY_PROJECTS]:
        if not isinstance(record, dict):
            continue
        project_id = _registry_string(record.get("id"), 64)
        root = _registry_string(record.get("root"), MAX_SOURCE_PATH)
        name = _registry_string(record.get("name"), MAX_REGISTRY_NAME)
        query = record.get("query", "")
        if project_id is None or len(project_id) != 64 or any(character not in "0123456789abcdef" for character in project_id):
            continue
        if root is None or not Path(root).is_absolute() or name is None:
            continue
        query = query if isinstance(query, str) else ""
        if len(query) > MAX_QUERY or any(ord(character) < 32 or ord(character) == 127 for character in query):
            continue
        if project_id in entries:
            continue
        entries[project_id] = {"id": project_id, "root": root, "name": name, "query": query}
    return entries


def _write_registry(entries: dict[str, dict[str, str]]) -> None:
    """Atomically save at most the newest bounded set of canonical roots."""
    path = _registry_path(True)
    records = list(entries.values())[-MAX_REGISTRY_PROJECTS:]
    payload = {"version": REGISTRY_VERSION, "projects": records}
    temporary: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", dir=path.parent, prefix=".registry-", suffix=".tmp", delete=False
        ) as handle:
            temporary = Path(handle.name)
            json.dump(payload, handle, ensure_ascii=True, separators=(",", ":"))
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
        temporary = None
    except OSError as exc:
        raise MapServerError(f"could not write code-map registry: {exc}") from exc
    finally:
        if temporary:
            with contextlib.suppress(OSError):
                temporary.unlink()


def _write_runtime(path: Path, value: dict[str, Any]) -> None:
    if path.is_symlink() or (path.exists() and not path.is_file()):
        raise MapServerError(f"refusing unsafe runtime file: {path}")
    temporary: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, prefix=".runtime-", suffix=".tmp", delete=False) as handle:
            temporary = Path(handle.name)
            json.dump(value, handle, ensure_ascii=True, separators=(",", ":"))
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
        temporary = None
    except OSError as exc:
        raise MapServerError(f"could not write map service runtime: {exc}") from exc
    finally:
        if temporary:
            try:
                temporary.unlink()
            except OSError:
                pass


def _read_runtime(path: Path) -> tuple[dict[str, Any] | None, str | None]:
    try:
        if path.is_symlink() or not path.is_file():
            return None, "runtime file is unavailable"
        if path.stat().st_mode & 0o077:
            return None, "runtime file permissions are unsafe"
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        return None, f"runtime file is invalid: {exc}"
    if not isinstance(value, dict):
        return None, "runtime file has an invalid shape"
    if not isinstance(value.get("pid"), int) or value["pid"] <= 0:
        return None, "runtime pid is invalid"
    if not isinstance(value.get("port"), int) or not 0 < value["port"] <= 65535:
        return None, "runtime port is invalid"
    if not isinstance(value.get("token"), str) or len(value["token"]) < 20:
        return None, "runtime token is invalid"
    build = value.get("build_signature", value.get("build"))
    if not isinstance(build, str) or not build:
        return None, "runtime build is invalid"
    return {"pid": value["pid"], "port": value["port"], "token": value["token"], "build_signature": build}, None


@contextlib.contextmanager
def _startup_lock(directory: Path, timeout: float = 10.0):
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / ".startup.lock"
    if fcntl is not None:
        if path.is_symlink() or (path.exists() and not path.is_file()):
            raise MapServerError(f"refusing unsafe startup lock: {path}")
        handle = path.open("a+")
        try:
            os.chmod(path, 0o600)
            deadline = time.monotonic() + timeout
            while True:
                try:
                    fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    if time.monotonic() >= deadline:
                        raise MapServerError("timed out waiting for map service startup lock")
                    time.sleep(0.05)
            yield
        finally:
            try:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
            finally:
                handle.close()
    else:  # pragma: no cover - exercised only on platforms without fcntl
        deadline = time.monotonic() + timeout
        while True:
            try:
                fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
                os.close(fd)
                break
            except FileExistsError:
                if time.monotonic() >= deadline:
                    raise MapServerError("timed out waiting for map service startup lock")
                time.sleep(0.05)
        try:
            yield
        finally:
            try:
                path.unlink()
            except OSError:
                pass


def _request(port: int, method: str, path: str, token: str | None = None, body: dict[str, Any] | None = None, timeout: float = 2.0) -> tuple[int, dict[str, Any] | None, bytes]:
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
    try:
        status, value, _ = _request(runtime["port"], "GET", "/api/health", runtime["token"], timeout=0.5)
    except MapServerError:
        return None
    if status != 200 or not value or value.get("service") != SERVICE:
        return None
    return value


def _shutdown_owned(runtime: dict[str, Any], wait: float = 3.0) -> bool:
    health = _health(runtime)
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
        if _health(runtime) is None:
            return True
        time.sleep(0.05)
    return False


def _prepare_log(directory: Path) -> Path:
    path = directory / "server.log"
    try:
        if path.is_symlink() or (path.exists() and not path.is_file()):
            raise MapServerError(f"refusing unsafe map service log: {path}")
        if path.exists() and path.stat().st_size > MAX_LOG_BYTES:
            path.write_bytes(b"")
        path.touch(mode=0o600, exist_ok=True)
        os.chmod(path, 0o600)
    except MapServerError:
        raise
    except OSError as exc:
        raise MapServerError(f"could not prepare map service log: {exc}") from exc
    return path


def _spawn(root: Path, runtime_path: Path, port: int) -> dict[str, Any]:
    log_path = _prepare_log(runtime_path.parent)
    command = [sys.executable, str(Path(__file__).resolve()), "serve", "--port", str(port)]
    handoff = _json({"repo": str(root)})
    if len(handoff) > MAX_HANDOFF:
        raise MapServerError("repository handoff is too large")
    try:
        with log_path.open("ab") as log:
            process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=log, stderr=log, start_new_session=True, close_fds=True)
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
            if health and health.get("protocol") == PROTOCOL and health.get("build") == BUILD_SIGNATURE and health.get("pid") == runtime["pid"]:
                return runtime
        if process.poll() is not None:
            break
        time.sleep(0.05)
    if process.poll() is None:
        raise MapServerError("map service did not become healthy before startup timeout")
    raise MapServerError("map service exited during startup; inspect the state server.log")


def _ensure_service(root: Path) -> dict[str, Any]:
    runtime_path = _runtime_for_repo(root, True)
    with _startup_lock(runtime_path.parent):
        runtime, _ = _read_runtime(runtime_path)
        if runtime:
            health = _health(runtime)
            if health and health.get("pid") == runtime["pid"] and health.get("port") == runtime["port"]:
                if health.get("protocol") == PROTOCOL and health.get("build") == BUILD_SIGNATURE and runtime.get("build_signature") == BUILD_SIGNATURE:
                    return runtime
                if not _shutdown_owned(runtime):
                    raise MapServerError("an incompatible map service owns the configured port")
        return _spawn(root, runtime_path, _port())


def _register(runtime: dict[str, Any], root: Path, query: str, max_files: int, refresh: bool = False, requery: bool = False) -> dict[str, Any]:
    status, value, raw = _request(
        runtime["port"],
        "POST",
        "/api/register",
        runtime["token"],
        {"root": str(root), "query": query[:MAX_QUERY], "max_files": max(1, min(5000, int(max_files))), "refresh": bool(refresh), "requery": bool(requery)},
    )
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


def open_map(repo: str | os.PathLike[str], query: str = "", open_browser: bool = True) -> str:
    """Register a repository and return its stable loopback viewer URL."""
    url, _, _ = _open_registered(repo, query, 5000, requery=True)
    if open_browser:
        try:
            opened = webbrowser.open(url)
        except Exception as exc:
            raise MapServerError(f"browser launch failed for {url}: {exc}", url=url) from exc
        if not opened:
            raise MapServerError(f"browser launch failed for {url}", url=url)
    return url


def get_model(repo: str | os.PathLike[str], query: str = "", max_files: int = 2000, refresh: bool = False) -> dict[str, Any]:
    """Return the canonical metadata model through the persistent service."""
    _, runtime, root = _open_registered(repo, query, max_files, refresh=refresh, requery=True)
    project = _project_id(root)
    deadline = time.monotonic() + MODEL_WAIT
    while True:
        status, value, raw = _request(runtime["port"], "GET", "/api/status?" + urllib.parse.urlencode({"project": project}), runtime["token"])
        if status != 200 or value is None:
            detail = raw.decode("utf-8", "replace")[:300]
            raise MapServerError(f"map index unavailable ({status}): {detail}")
        if value.get("error") and not value.get("indexing"):
            raise MapServerError(f"map index failed: {value['error']}")
        if not value.get("indexing"):
            break
        if time.monotonic() >= deadline:
            raise MapServerError("map index did not become ready before the bounded wait")
        time.sleep(0.1)
    path = "/api/map?" + urllib.parse.urlencode({
        "project": project,
        "query": query[:MAX_QUERY],
        "max_files": max(1, min(INDEX_MAX_FILES, int(max_files))),
    })
    status, value, raw = _request(runtime["port"], "GET", path, runtime["token"])
    if status != 200 or not value or not isinstance(value.get("model"), dict):
        detail = raw.decode("utf-8", "replace")[:300]
        raise MapServerError(f"map model unavailable ({status}): {detail}")
    return value["model"]


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
    last_used: float = 0.0
    lock: Any = dataclasses.field(default_factory=threading.RLock, repr=False)


def _project_model(model: dict[str, Any], query: str, max_files: int) -> dict[str, Any]:
    """Bound a response without shrinking the daemon's shared index."""
    records = list(model.get("files", []))
    try:
        ranked = engine._rank(records, query[:MAX_QUERY])
    except (AttributeError, TypeError):
        ranked = records
    selected = sorted(ranked[:max_files], key=lambda record: record.get("path", ""))
    result = dict(model)
    result["files"] = selected
    result["focus"] = [record["path"] for record in engine._rank(selected, query[:MAX_QUERY])[:12]]
    coverage = dict(model.get("coverage", {}))
    response_skipped = max(0, len(ranked) - len(selected))
    coverage["indexed"] = len(selected)
    coverage["truncated"] = bool(coverage.get("truncated") or response_skipped)
    coverage["skipped"] = int(coverage.get("skipped", 0)) + response_skipped
    if response_skipped and "response file cap" not in coverage.get("notes", []):
        notes = list(coverage.get("notes", []))
        notes.append(f"response file cap reached at {max_files} files")
        coverage["notes"] = notes[:24]
    result["coverage"] = coverage
    return result


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
        self.port = port
        self.assets = assets
        self.projects: dict[str, Project] = {}
        self._registry: dict[str, dict[str, str]] = {}
        self._registry_loaded = False
        self.lock = threading.RLock()
        self._index_slots = threading.BoundedSemaphore(MAX_INDEX_WORKERS)
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
            name = project.name[:MAX_REGISTRY_NAME]
            query = project.query[:MAX_QUERY]
        self._registry.pop(project.id, None)
        self._registry[project.id] = {
            "id": project.id,
            "root": str(project.root),
            "name": name,
            "query": query,
        }
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
            _reject_symlink_chain(raw_root, "registered repository")
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
            self.projects.pop(project_id, None)

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

    def _refresh_worker(self, project: Project) -> None:
        self._index_slots.acquire()
        try:
            display_name = engine.repository_name(project.root)
            model, _ = engine.build_map(project.root, query="", max_files=INDEX_MAX_FILES, output_format="json")
            git_state = _model_git_state(model)
            if git_state is None and not hasattr(engine, "_git_state"):
                git_state = _git_state_fingerprint(project.root)
            if git_state and git_state[0] and "branch" not in model:
                model["branch"] = git_state[0]
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
                if git_state is not None:
                    project.git_fingerprint = git_state
                project.name = model.get("root_name", display_name)
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
                        project.indexing = False
                    self._remember(project)
                    self._evict_loaded(keep=project)
            finally:
                self._index_slots.release()

    def _refresh(self, project: Project, force: bool = False) -> None:
        """Queue one bounded index build without holding the service lock."""
        try:
            display_name = engine.repository_name(project.root)
        except Exception:
            display_name = ""
        with project.lock:
            if display_name and display_name != project.name:
                project.name = display_name
                force = True
            now = time.monotonic()
            if project.indexing or (not force and now - project.last_check < 2.0):
                return
            project.last_check = now
            project.indexing = True
        worker = threading.Thread(
            target=self._refresh_worker,
            args=(project,),
            name="compound-map-index",
            daemon=True,
        )
        try:
            worker.start()
        except RuntimeError as exc:
            with project.lock:
                project.indexing = False
                project.error = str(exc)[:500]
                project.updated_at = _now()

    def register(self, root: Path, query: str, max_files: int, refresh: bool = False, requery: bool = False) -> Project:
        project_id = _project_id(root)
        with self.lock:
            self._load_registry()
            project = self.projects.get(project_id)
            force = refresh
            if project is None:
                project = Project(project_id, root.name, root, query[:MAX_QUERY], INDEX_MAX_FILES)
                project.last_used = time.monotonic()
                self.projects[project_id] = project
                force = True
            else:
                with project.lock:
                    project.last_used = time.monotonic()
                    query_changed = requery and project.query != query[:MAX_QUERY]
                    if query_changed:
                        project.query = query[:MAX_QUERY]
                force = refresh or query_changed
            self._remember(project)
            self._evict_loaded(keep=project)
        self._refresh(project, force=force)
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

    def status(self, project: Project) -> dict[str, Any]:
        self._refresh(project)
        with project.lock:
            return {"project": {"id": project.id, "name": project.name}, "revision": project.revision, "indexing": project.indexing, "error": project.error, "updated_at": project.updated_at}

    def _model_snapshot(
        self, project: Project, max_files: int | None = None, query: str | None = None
    ) -> tuple[dict[str, Any] | None, dict[str, str], int, bool, str | None]:
        self._refresh(project)
        with project.lock:
            current = project.model
            project_info = {"id": project.id, "name": project.name}
            revision = project.revision
            indexing = project.indexing
            error = project.error
            selected_query = project.query if query is None else query
        if current is None:
            return None, project_info, revision, indexing, error
        requested = INDEX_MAX_FILES if max_files is None else max(1, min(INDEX_MAX_FILES, int(max_files)))
        return _project_model(current, selected_query, requested), project_info, revision, indexing, error

    def model(self, project: Project, max_files: int | None = None, query: str | None = None) -> dict[str, Any] | None:
        model, _, _, _, _ = self._model_snapshot(project, max_files, query)
        return model

    def map_response(self, project: Project, max_files: int | None = None, query: str | None = None) -> tuple[dict[str, Any] | None, bytes]:
        """Serialize a map response under the transport cap without shrinking the index."""
        cap = INDEX_MAX_FILES if max_files is None else max(1, min(INDEX_MAX_FILES, int(max_files)))
        response_capped = False
        while True:
            model, project_info, revision, indexing, error = self._model_snapshot(project, cap, query=query)
            if model is None:
                return None, _json({"project": project_info, "revision": revision, "indexing": indexing, "error": error, "model": None})
            if response_capped:
                model = _mark_response_cap(model)
            payload = {"project": project_info, "revision": revision, "model": model}
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

    def _authorized(self) -> bool:
        return self.headers.get("Authorization", "") == f"Bearer {self.service.token}"

    def _headers(self, content_type: str) -> None:
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(self._body)))
        self.send_header("Cache-Control", "no-store")
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
            self._respond(200, _json({"service": SERVICE, "protocol": PROTOCOL, "build": BUILD_SIGNATURE, "pid": os.getpid(), "port": self.server.server_port}))
            return
        if parsed.path == "/api/projects":
            projects = self.service.project_list()
            self._respond(200, _json({"projects": projects, "version": BUILD_SIGNATURE}))
            return
        if parsed.path == "/api/file":
            params = urllib.parse.parse_qs(parsed.query, keep_blank_values=True)
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
        if parsed.path in {"/api/status", "/api/map"}:
            project_id = urllib.parse.parse_qs(parsed.query).get("project", [""])[0]
            with self.service.lock:
                project = self.service.project(project_id)
            if project is None:
                self._error(404, "unknown project")
                return
            params = urllib.parse.parse_qs(parsed.query)
            if parsed.path == "/api/status":
                self._respond(200, _json(self.service.status(project)))
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
            self._respond(200, body, ASSET_TYPES[name])
            return
        self._error(404, "not found")

    def do_POST(self) -> None:  # noqa: N802
        if not self._route_guard():
            return
        parsed = urllib.parse.urlsplit(self.path)
        if parsed.path not in {"/api/register", "/api/shutdown"}:
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
    assets, _ = _build_assets()
    token = secrets.token_urlsafe(32)
    try:
        httpd = MapHTTPServer(("127.0.0.1", port), MapHandler)
    except OSError as exc:
        raise MapServerError(f"could not bind map service to 127.0.0.1:{port}: {exc}") from exc
    actual_port = int(httpd.server_address[1])
    service = MapService(token, actual_port, assets)
    httpd.service = service  # type: ignore[attr-defined]
    service.httpd = httpd
    runtime = {"pid": os.getpid(), "port": actual_port, "token": token, "build_signature": BUILD_SIGNATURE, "build": BUILD_SIGNATURE}
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
        print(json.dumps({"status": "stopped", "pid": runtime["pid"]}, ensure_ascii=True))
        return 0
    print(json.dumps({"status": "stale", "pid": runtime["pid"], "error": "owned service did not accept shutdown"}, ensure_ascii=True))
    return 1


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Serve the Compound code-map viewer on loopback")
    commands = parser.add_subparsers(dest="command", required=True)
    opening = commands.add_parser("open")
    opening.add_argument("--repo", required=True)
    opening.add_argument("--query", default="")
    opening.add_argument("--no-open", action="store_true")
    commands.add_parser("status")
    commands.add_parser("stop")
    serving = commands.add_parser("serve", help=argparse.SUPPRESS)
    serving.add_argument("--port", type=int, default=None)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        if args.command == "open":
            print(open_map(args.repo, args.query, not args.no_open))
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
