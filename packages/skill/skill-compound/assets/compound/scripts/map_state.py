"""Private files the code-map service keeps beside the cache in the user state directory.

The runtime record tells clients how to reach the running service and the registry lists
the projects it has served. The startup lock and the service log sit in the same folder.
"""

from __future__ import annotations

import contextlib
import json
import os
import tempfile
import time
from pathlib import Path
from typing import Any

try:
    import fcntl
except ImportError:  # pragma: no cover - Windows has no fcntl
    fcntl = None
    import msvcrt

try:
    from . import code_map as engine
    from . import viewer_access
    from .onboarding import _reject_symlink, _state_paths
except ImportError:  # direct script execution
    import code_map as engine
    import viewer_access
    from onboarding import _reject_symlink, _state_paths


# The service applies the query and path limits to requests as well as to the saved registry.
MAX_QUERY = 512
MAX_SOURCE_PATH = 4096
MAX_LOG_BYTES = 256 * 1024
REGISTRY_VERSION = 1
REGISTRY_FILE = "registry.json"
MAX_REGISTRY_PROJECTS = 32
MAX_REGISTRY_BYTES = 256 * 1024
MAX_REGISTRY_NAME = 256
MAX_RUNTIME_BYTES = 4096


class MapServerError(ValueError):
    def __init__(self, message: str, url: str | None = None):
        super().__init__(message)
        self.url = url


def _json(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=True, separators=(",", ":")).encode("utf-8")


def _runtime_for_repo(root: Path, write: bool) -> Path:
    try:
        directory, _ = engine._cache_location(root, write)
        if directory.exists():
            viewer_access.require_private_state(directory)
        return directory / "runtime.json"
    except (OSError, ValueError) as exc:
        raise MapServerError(str(exc)) from exc


def _runtime_without_repo() -> Path:
    state, _ = _state_paths()
    _reject_symlink(state, "state directory")
    directory = state / "code-map"
    if directory.is_symlink() or (directory.exists() and not directory.is_dir()):
        raise MapServerError(f"refusing unsafe code-map runtime directory: {directory}")
    if directory.exists():
        viewer_access.require_private_state(directory)
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
            _reject_symlink(directory, "code-map registry directory")
        path = directory / REGISTRY_FILE
        if path.is_symlink() or (path.exists() and not path.is_file()):
            raise MapServerError(f"refusing unsafe code-map registry: {path}")
        return path
    except MapServerError:
        raise
    except OSError as exc:
        raise MapServerError(f"could not prepare code-map registry: {exc}") from exc


def _printable(value: str) -> str:
    """Replace control characters, which the saved registry rejects in names and queries."""
    return "".join(" " if ord(character) < 32 or ord(character) == 127 else character for character in value)


def _registry_string(value: Any, maximum: int, controls: bool = False) -> str | None:
    if not isinstance(value, str) or not value or len(value) > maximum:
        return None
    if not controls and any(ord(character) < 32 or ord(character) == 127 for character in value):
        return None
    return value


def _read_registry() -> dict[str, dict[str, str]]:
    """Read only bounded registry metadata; roots are verified on ID lookup."""
    try:
        path = _registry_path(False)
        if not path.exists():
            return {}
        if os.name == "posix" and path.stat().st_mode & 0o077:
            return {}
        with path.open("rb") as handle:
            raw = handle.read(MAX_REGISTRY_BYTES + 1)
        if len(raw) > MAX_REGISTRY_BYTES:
            return {}
        value = json.loads(raw.decode("utf-8"))
    except (OSError, ValueError, RecursionError):
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
        # A directory name may hold a tab or newline; restoring re-validates the root against its ID.
        root = _registry_string(record.get("root"), MAX_SOURCE_PATH, controls=True)
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
    encoded = _json(payload)
    temporary: Path | None = None
    try:
        if path.exists():
            info = path.stat()
            if info.st_mode & 0o077 == 0 and info.st_size == len(encoded) and path.read_bytes() == encoded:
                return
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
        # Windows reports every writable file as mode 0o666, so only POSIX modes show who can read it.
        if os.name == "posix" and path.stat().st_mode & 0o077:
            return None, "runtime file permissions are unsafe"
        with path.open("rb") as handle:
            raw = handle.read(MAX_RUNTIME_BYTES + 1)
        if len(raw) > MAX_RUNTIME_BYTES:
            return None, "runtime file is invalid: size limit exceeded"
        value = json.loads(raw.decode("utf-8"))
    except (OSError, ValueError, RecursionError) as exc:
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
    if path.is_symlink() or (path.exists() and not path.is_file()):
        raise MapServerError(f"refusing unsafe startup lock: {path}")
    handle = path.open("a+")
    try:
        os.chmod(path, 0o600)
        deadline = time.monotonic() + timeout
        while True:
            try:
                if fcntl is not None:
                    fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                else:  # pragma: no cover - Windows, which like flock drops the lock when its holder exits
                    msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                break
            except (BlockingIOError, PermissionError):
                if time.monotonic() >= deadline:
                    raise MapServerError("timed out waiting for map service startup lock")
                time.sleep(0.05)
        yield
    finally:
        handle.close()


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
