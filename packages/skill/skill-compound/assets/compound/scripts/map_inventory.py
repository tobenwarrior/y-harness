"""The code map's file inventory: bounded Git reads and which paths may be indexed."""

from __future__ import annotations

import asyncio
import os
import re
import selectors
import stat
import subprocess
import time
import urllib.parse
from pathlib import Path, PurePosixPath
from typing import Any, cast

GIT_TIMEOUT = 5
GIT_READ = ("git", "--no-optional-locks", "-c", "core.fsmonitor=false")
MAX_COCHANGE_COMMITS = 30
MAX_COCHANGE_FILES = 60
MAX_COCHANGE_RESULTS = 6
MAX_GIT_LOG_BYTES = 1024 * 1024
MAX_GIT_FILTER_CONFIG_BYTES = 16 * 1024
MAX_GIT_INVENTORY_BYTES = 4 * 1024 * 1024
INVENTORY_CAP_NOTE = "Git inventory capped at 4 MiB of paths; later files are not indexed"
UNTRACKED_INVENTORY_NOTE = "Git untracked inventory unavailable. Showing tracked paths only."
SKIP_DIRS = {".git", "vendor", "node_modules"}
BUILD_DIRS = {"build", "dist"}
SKIP_AND_BUILD_DIRS = SKIP_DIRS | BUILD_DIRS
PRIVATE_KEY_PART = re.compile(r"(?:^|[-_.])key(?:[-_.]|$)")
PRIVATE_NAMES = {"credentials", "credential", "secrets", "secret", "keys", "id_rsa", "id_ed25519"}
CONFIG_NAMES = {
    "cargo.toml", "dockerfile", "go.mod", "makefile", "package.json", "pyproject.toml", "procfile",
    "requirements.txt", "setup.cfg", "setup.py", "tsconfig.json", "vite.config.js", "webpack.config.js",
}
NON_CODE_NAMES = {
    ".codeowners", ".cursorignore", ".dockerignore", ".editorconfig", ".gitattributes", ".gitignore",
    ".gitmodules", ".gitkeep", ".npmignore", "authors", "changelog", "copying", "license", "notice", "readme",
    "codeowners", "go.sum", "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", ".mailmap",
    ".nvmrc", ".node-version", ".python-version", ".ruby-version", ".tool-versions", ".npmrc", ".yarnrc",
    ".prettierrc", ".prettierignore", ".eslintignore", ".flake8", ".coveragerc", ".pylintrc", ".clang-format",
}
NON_CODE_SUFFIXES = {
    ".adoc", ".bmp", ".csv", ".gif", ".ico", ".jpeg", ".jpg", ".lock", ".log", ".map", ".md",
    ".mdc", ".markdown", ".png", ".rst", ".svg", ".text", ".txt", ".webp",
    ".bin", ".jsonl", ".otf", ".ttf", ".woff", ".woff2", ".xls", ".xlsx",
    ".avif", ".class", ".db", ".diff", ".dll", ".dylib", ".eot", ".exe", ".gz", ".jar", ".lockb", ".mov",
    ".mp3", ".mp4", ".parquet", ".patch", ".pdf", ".pkl", ".pyc", ".snap", ".so", ".sqlite", ".tar", ".tgz",
    ".tiff", ".wasm", ".wav", ".zip",
}
LANGUAGES = {
    **dict.fromkeys((".py", ".pyw"), "python"),
    **dict.fromkeys((".js", ".jsx", ".mjs", ".cjs"), "javascript"),
    **dict.fromkeys((".ts", ".tsx", ".mts", ".cts"), "typescript"),
    **dict.fromkeys((".c", ".h"), "c"),
    **dict.fromkeys((".cc", ".cpp", ".cxx", ".hh", ".hpp"), "cpp"),
    ".cs": "csharp", ".go": "go", ".rs": "rust", ".java": "java", ".rb": "ruby",
    ".php": "php", ".swift": "swift", ".kt": "kotlin", ".kts": "kotlin", ".scala": "scala",
    **dict.fromkeys((".sh", ".bash", ".zsh", ".fish"), "shell"),
    ".sql": "sql", ".html": "html", ".htm": "html", ".css": "css", ".scss": "scss",
    ".less": "less", ".vue": "vue", ".svelte": "svelte", ".json": "json", ".jsonc": "json",
    ".yaml": "yaml", ".yml": "yaml", ".toml": "toml", ".xml": "xml", ".plist": "xml",
    ".ini": "ini", ".cfg": "ini", ".service": "ini",
    ".conf": "ini", ".properties": "properties", ".gradle": "groovy", ".proto": "protobuf",
}
_COCHANGE_CACHE: dict[tuple[str, str], dict[str, list[dict[str, Any]]]] = {}


def _git(path: Path, *args: str) -> subprocess.CompletedProcess[bytes] | None:
    try:
        return subprocess.run(
            [*GIT_READ, "-C", str(path), *args], capture_output=True, check=False, timeout=GIT_TIMEOUT
        )
    except (OSError, subprocess.TimeoutExpired):
        return None


class _WindowsOutputProtocol(asyncio.SubprocessProtocol):
    """Collect one bounded stdout stream from an asyncio subprocess transport."""

    def __init__(
        self,
        loop: asyncio.AbstractEventLoop,
        max_bytes: int,
        keep_prefix: bool,
        ok_statuses: tuple[int, ...],
    ) -> None:
        self._done = loop.create_future()
        self._closed = loop.create_future()
        self._max_bytes = max_bytes
        self._keep_prefix = keep_prefix
        self._ok_statuses = ok_statuses
        self._data = bytearray()
        self._transport: asyncio.SubprocessTransport | None = None
        self._pipe_error: BaseException | None = None
        self._returncode: int | None = None
        self._process_exited = False
        self._stdout_closed = False
        self._overflow = False

    @property
    def done(self) -> asyncio.Future[bytes | None]:
        return self._done

    @property
    def closed(self) -> asyncio.Future[None]:
        return self._closed

    def connection_made(self, transport: asyncio.BaseTransport) -> None:
        self._transport = cast(asyncio.SubprocessTransport, transport)

    def pipe_data_received(self, fd: int, data: bytes) -> None:
        if fd != 1 or self._overflow:
            return
        remaining = self._max_bytes + 1 - len(self._data)
        if remaining <= 0:
            self._overflow = True
            self._finish_overflow()
            return
        self._data.extend(data[:remaining])
        if len(data) > remaining or len(self._data) > self._max_bytes:
            self._overflow = True
            self._finish_overflow()

    def pipe_connection_lost(self, fd: int, exc: BaseException | None) -> None:
        if fd != 1:
            return
        self._stdout_closed = True
        self._pipe_error = exc
        self._finish()

    def process_exited(self) -> None:
        self._process_exited = True
        if self._transport is not None:
            self._returncode = self._transport.get_returncode()
        self._finish()

    def connection_lost(self, exc: BaseException | None) -> None:
        if not self._closed.done():
            self._closed.set_result(None)

    def close(self) -> None:
        if self._transport is not None:
            self._transport.close()

    def _finish_overflow(self) -> None:
        if not self._done.done():
            self._done.set_result(bytes(self._data) if self._keep_prefix else None)
        self.close()

    def _finish(self) -> None:
        if self._done.done() or not self._stdout_closed or not self._process_exited:
            return
        if self._pipe_error is not None:
            result = None
        elif self._returncode in self._ok_statuses:
            result = bytes(self._data)
        else:
            result = None
        self._done.set_result(result)


async def _read_windows_command_output(
    command: list[str], max_bytes: int, keep_prefix: bool, env: dict[str, str] | None,
    ok_statuses: tuple[int, ...], deadline: float,
) -> bytes | None:
    loop = asyncio.get_running_loop()
    protocol = _WindowsOutputProtocol(loop, max_bytes, keep_prefix, ok_statuses)
    transport: asyncio.SubprocessTransport | None = None
    try:
        transport, _ = await loop.subprocess_exec(
            lambda: protocol,
            *command,
            stdin=None,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            env=env,
        )
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            protocol.close()
            return None
        try:
            return await asyncio.wait_for(asyncio.shield(protocol.done), remaining)
        except asyncio.TimeoutError:
            protocol.close()
            return None
    except (OSError, ValueError):
        return None
    finally:
        if transport is not None:
            protocol.close()
            if not protocol.closed.done():
                try:
                    await asyncio.wait_for(asyncio.shield(protocol.closed), 1.0)
                except asyncio.TimeoutError:
                    pass


def _bounded_windows_command_output(
    command: list[str], max_bytes: int, keep_prefix: bool, *, env: dict[str, str] | None,
    ok_statuses: tuple[int, ...], timeout: float,
) -> bytes | None:
    """Run one bounded Windows command through the Proactor subprocess transport."""
    loop = asyncio.ProactorEventLoop()
    try:
        return loop.run_until_complete(
            _read_windows_command_output(
                command, max_bytes, keep_prefix, env, ok_statuses, time.monotonic() + timeout,
            )
        )
    finally:
        loop.close()


def _bounded_git_output(
    root: Path, arguments: list[str], max_bytes: int, keep_prefix: bool = False, *,
    env: dict[str, str] | None = None, ok_statuses: tuple[int, ...] = (0,), timeout: float = GIT_TIMEOUT,
    config_options: list[str] | None = None,
) -> bytes | None:
    """Return Git's output, or None past ``max_bytes`` unless ``keep_prefix`` keeps the first ``max_bytes + 1``."""
    command = [*GIT_READ, *(config_options or ()), "-C", str(root), *arguments]
    if os.name == "nt":
        return _bounded_windows_command_output(
            command, max_bytes, keep_prefix, env=env, ok_statuses=ok_statuses, timeout=timeout,
        )
    process: subprocess.Popen[bytes] | None = None
    selector: selectors.BaseSelector | None = None
    try:
        process = subprocess.Popen(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            env=env,
        )
        assert process.stdout is not None
        selector = selectors.DefaultSelector()
        selector.register(process.stdout, selectors.EVENT_READ)
        chunks: list[bytes] = []
        size = 0
        deadline = time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise subprocess.TimeoutExpired("git output", timeout)
            if not selector.select(remaining):
                raise subprocess.TimeoutExpired("git output", timeout)
            block = os.read(process.stdout.fileno(), min(65536, max_bytes + 1 - size))
            if not block:
                break
            chunks.append(block)
            size += len(block)
            if size > max_bytes:
                process.kill()
                process.wait(timeout=1)
                return b"".join(chunks) if keep_prefix else None
        data = b"".join(chunks)
        process.wait(timeout=max(0.0, deadline - time.monotonic()))
        return data if process.returncode in ok_statuses else None
    except (OSError, subprocess.TimeoutExpired):
        if process is not None:
            try:
                process.kill()
                process.wait(timeout=1)
            except (OSError, subprocess.TimeoutExpired):
                pass
        return None
    finally:
        if selector is not None:
            selector.close()
        if process is not None and process.stdout is not None:
            process.stdout.close()


def _remote_name(value: str) -> str | None:
    remote = value.strip()
    if not remote or any(character.isspace() or ord(character) < 32 or ord(character) == 127 for character in remote):
        return None
    path = ""
    if "://" in remote:
        try:
            parsed = urllib.parse.urlsplit(remote)
            hostname = parsed.hostname
        except ValueError:
            return None
        if parsed.scheme.lower() not in {"http", "https", "ssh", "git", "git+ssh"} or not hostname:
            return None
        path = parsed.path
    else:
        match = re.fullmatch(r"(?:[^@/\s:]+@)?[^/\s:]+:(?P<path>[^?#\s]+)", remote)
        if not match:
            return None
        path = match.group("path")
    candidate = PurePosixPath(path.rstrip("/")).name
    if candidate.lower().endswith(".git"):
        candidate = candidate[:-4]
    if not candidate or candidate in {".", ".."} or any(character in candidate for character in "/\\:@"):
        return None
    if any(ord(character) < 32 or ord(character) == 127 for character in candidate):
        return None
    return candidate


def repository_name(root: Path) -> str:
    """Return a safe display name without changing the canonical repository path."""
    fallback = root.name
    result = _git(root, "remote", "get-url", "origin")
    if result is None or result.returncode != 0:
        return fallback
    try:
        remote = os.fsdecode(result.stdout)
    except (UnicodeDecodeError, ValueError):
        return fallback
    return _remote_name(remote) or fallback


def _safe_relative(value: str) -> bool:
    path = PurePosixPath(value)
    return bool(value) and not path.is_absolute() and ".." not in path.parts


def _has_exact_parents(root: Path, relative: str, checked: set[str]) -> bool:
    """Check a path's parent spellings before handing it to a Git pathspec."""
    parent = root
    for part in relative.split("/")[:-1]:
        directory = parent / part
        spelling = str(directory)
        if spelling not in checked:
            try:
                with os.scandir(parent) as entries:
                    if not any(entry.name == part and entry.is_dir(follow_symlinks=False) for entry in entries):
                        return False
            except OSError:
                return False
            checked.add(spelling)
        parent = directory
    return True


def _git_inventory(root: Path, *, paths: list[str] | None = None) -> tuple[bytes | None, list[str]]:
    """Return bounded NUL-terminated paths, scoping exact lookup paths where possible."""
    tracked, untracked, notes = _git_inventory_parts(root, paths=paths)
    return (None if tracked is None else tracked + untracked), notes


def _git_inventory_parts(root: Path, *, paths: list[str] | None = None) -> tuple[bytes | None, bytes, list[str]]:
    """Keep the tracked and untracked paths separate for the viewer's change labels."""
    if paths == []:
        return b"", b"", []
    command = ["ls-files"] if paths is None else ["--literal-pathspecs", "ls-files"]
    scope = [] if paths is None else ["--", *paths]
    env = None
    if paths is not None:
        # Global Git pathspec settings can conflict with --literal-pathspecs.
        env = os.environ.copy()
        for name in ("GIT_GLOB_PATHSPECS", "GIT_ICASE_PATHSPECS", "GIT_NOGLOB_PATHSPECS"):
            env.pop(name, None)
    tracked = _bounded_git_output(
        root, [*command, "--cached", "-z", *scope], MAX_GIT_INVENTORY_BYTES, keep_prefix=True, env=env,
    )
    if tracked is None:
        return None, b"", []
    if paths is not None and len(tracked) <= MAX_GIT_INVENTORY_BYTES:
        tracked_names = set(tracked.split(b"\0")[:-1])
        paths = [path for path in paths if os.fsencode(path) not in tracked_names]
        if not paths:
            return tracked, b"", []
        scope = ["--", *paths]
    # Untracked paths get what tracked ones leave but at least a quarter, so an unignored dependency folder cannot
    # crowd out tracked source and a tracked tree past the cap cannot hide the files just created.
    reserve = max(MAX_GIT_INVENTORY_BYTES - len(tracked), MAX_GIT_INVENTORY_BYTES // 4)
    # Git can echo a pathspec's parent spelling on case-insensitive volumes. Keep Git's canonical
    # inventory when an exact parent cannot be confirmed or Unicode normalization may differ.
    checked: set[str] = set()
    if paths is None or not all(path.isascii() and _has_exact_parents(root, path, checked) for path in paths):
        command, scope = ["ls-files"], []
    others = _bounded_git_output(
        root, [*command, "--others", "--exclude-standard", "-z", *scope], reserve, keep_prefix=True, env=env,
    )
    notes = []
    if others is None:
        others = b""
        notes.append(UNTRACKED_INVENTORY_NOTE)
    if len(tracked) + len(others) > MAX_GIT_INVENTORY_BYTES:
        notes.append(INVENTORY_CAP_NOTE)
    # Keep the complete entries read so far.
    others = others[:others.rfind(b"\0", 0, reserve) + 1]
    return tracked[:tracked.rfind(b"\0", 0, MAX_GIT_INVENTORY_BYTES - len(others)) + 1], others, notes


def _git_root(supplied: Path) -> tuple[Path, str | None]:
    root_result = _git(supplied, "rev-parse", "--show-toplevel")
    if root_result is None or root_result.returncode != 0:
        return supplied, "Git inventory unavailable; use native search to inspect this repository"
    try:
        root = Path(os.fsdecode(root_result.stdout.removesuffix(b"\n"))).resolve(strict=True)  # names may end in spaces
    except OSError:
        return supplied, "Git root unavailable; use native search to inspect this repository"
    return root, None


def _git_context(
    supplied: Path, inventory_result: tuple[bytes | None, list[str]] | None = None,
) -> tuple[Path, str, list[str] | None, list[str]]:
    """Return None for an unavailable inventory and an empty list for a completed empty one."""
    result = _git(supplied, "rev-parse", "--show-toplevel", "--quiet", "--verify", "HEAD")
    if result is not None and not result.stdout:
        return supplied, "", None, ["Git inventory unavailable; use native search to inspect this repository"]
    raw_root = raw_head = b""
    if result and result.returncode == 0:
        # Split from the end because a worktree name can contain newlines.
        raw_root, _, raw_head = result.stdout.removesuffix(b"\n").rpartition(b"\n")
    elif result and result.returncode == 1:
        # A worktree with no commits still prints its root.
        raw_root = result.stdout.removesuffix(b"\n")
    if raw_root:
        try:
            root = Path(os.fsdecode(raw_root)).resolve(strict=True)
        except OSError:
            return supplied, "", None, ["Git root unavailable; use native search to inspect this repository"]
        head = os.fsdecode(raw_head)
    else:
        root, note = _git_root(supplied)
        if note is not None:
            return root, "", None, [note]
        head_result = _git(root, "rev-parse", "HEAD")
        head = os.fsdecode(head_result.stdout.strip()) if head_result and head_result.returncode == 0 else ""
    inventory_data, notes = _git_inventory(root) if inventory_result is None or root != supplied else inventory_result
    if inventory_data is None:
        return root, head, None, ["Git inventory unavailable; inspect with native search"]
    inventory = []
    for raw in inventory_data.split(b"\0"):
        rel = os.fsdecode(raw) if raw else ""
        if _safe_relative(rel):
            inventory.append(PurePosixPath(rel).as_posix())
    return root, head, sorted(set(inventory)), notes


def _git_branch(root: Path) -> str:
    result = _git(root, "symbolic-ref", "--quiet", "--short", "HEAD")
    if result is None or result.returncode != 0:
        return ""
    try:
        branch = os.fsdecode(result.stdout).strip()
    except (UnicodeDecodeError, ValueError):
        return ""
    if not branch or any(ord(character) < 32 or ord(character) == 127 for character in branch):
        return ""
    return branch[:256]


def _git_status(root: Path, options: list[str], max_bytes: int) -> bytes | None:
    """Read status with external clean filters disabled for the effective Git configuration."""
    keys = _bounded_git_output(
        root, ["config", "--null", "--name-only", "--get-regexp", r"^filter\..*\.(clean|process|required)$"],
        MAX_GIT_FILTER_CONFIG_BYTES, ok_statuses=(0, 1),
    )
    if keys is None:
        return None
    drivers = sorted({os.fsdecode(key).rsplit(".", 1)[0] for key in keys.split(b"\0") if key})
    if any("=" in driver or not driver.isprintable() for driver in drivers):
        return None
    overrides = ["-c", "status.aheadBehind=false"]
    for driver in drivers:
        overrides.extend(("-c", f"{driver}.clean=", "-c", f"{driver}.process=", "-c", f"{driver}.required=false"))
    return _bounded_git_output(root, ["status", "--ignore-submodules=dirty", *options], max_bytes,
                               config_options=overrides)


def _git_status_snapshot(root: Path, *, untracked: bool) -> bytes | None:
    mode = "all" if untracked else "no"
    return _git_status(root, ["--porcelain=v2", "--branch", "-z", f"--untracked-files={mode}"],
                       MAX_GIT_INVENTORY_BYTES)


def _parse_git_state(root: Path, raw_status: bytes, untracked: bytes = b"") -> tuple[str, dict[str, str], str | None]:
    """Read the branch and current paths from a complete NUL-delimited status."""
    branch = ""
    changes: dict[str, str] = {}
    path_fields = {b"1 ": 8, b"2 ": 9, b"u ": 10}
    records = iter(raw_status.split(b"\0"))
    for raw in records:
        if raw.startswith(b"# branch.head "):
            name = os.fsdecode(raw.removeprefix(b"# branch.head "))
            # The detached marker can also be a real branch name.
            branch = _git_branch(root) if name == "(detached)" else name[:256]
            continue
        if raw.startswith(b"? "):
            name = raw[2:]
            kind = "untracked"
        else:
            path_field = path_fields.get(raw[:2])
            if path_field is None:
                continue
            if path_field == 9:
                # The next record is the original path, even if it looks like a status record.
                next(records, None)
            parts = raw.split(b" ", path_field)
            if len(parts) != path_field + 1:
                continue
            name, status = parts[-1], parts[1]
            if b"R" in status:
                kind = "renamed"
            elif b"C" in status or b"A" in status:
                kind = "added"
            elif b"D" in status:
                kind = "deleted"
            elif any(flag in status for flag in b"MTUX"):
                kind = "modified"
            else:
                continue
        path = PurePosixPath(os.fsdecode(name)).as_posix()
        if name and _safe_relative(path):
            changes[path] = kind
    for raw in untracked.split(b"\0"):
        path = PurePosixPath(os.fsdecode(raw)).as_posix()
        if raw and _safe_relative(path):
            changes.setdefault(path, "untracked")
    return branch, changes, None


def _git_changes_result(root: Path) -> tuple[dict[str, str], str | None]:
    _, changes, note = _git_state(root)
    return changes, note


def _git_changes(root: Path) -> dict[str, str]:
    return _git_changes_result(root)[0]


def _git_state(root: Path) -> tuple[str, dict[str, str], str | None]:
    raw_status = _git_status_snapshot(root, untracked=True)
    if raw_status is None:
        return _git_branch(root), {}, "Git status unavailable or exceeded the bounded output limit; changed-file metadata is unavailable"
    return _parse_git_state(root, raw_status)


def _bounded_git_log(root: Path) -> bytes:
    return _bounded_git_output(
        root,
        ["log", f"-n{MAX_COCHANGE_COMMITS}", "--no-renames", "--name-only", "--format=commit:%H", "-z"],
        MAX_GIT_LOG_BYTES,
    ) or b""


def _cochanges(root: Path, head: str, known: set[str]) -> dict[str, list[dict[str, Any]]]:
    """Return top cochanged paths from a small, HEAD-keyed history cache."""
    if not head:
        return {}
    key = (str(root), head)
    cached = _COCHANGE_CACHE.get(key)
    if cached is not None:
        return _cochanges_for_known(cached, known)
    counts: dict[str, dict[str, int]] = {}
    current: list[str] = []
    commits: list[list[str]] = []
    after_marker = False
    for raw in _bounded_git_log(root).split(b"\0"):
        try:
            token = os.fsdecode(raw)
        except (UnicodeDecodeError, ValueError):
            continue
        if token.startswith("commit:"):
            if current:
                commits.append(current)
            current = []
            after_marker = True
        elif token:
            if after_marker and token.startswith("\n"):
                token = token[1:]
            after_marker = False
            if token:
                current.append(PurePosixPath(token).as_posix())
    if current:
        commits.append(current)
    for changed in commits[:MAX_COCHANGE_COMMITS]:
        paths = sorted({path for path in changed if _safe_relative(path)})
        if len(paths) > MAX_COCHANGE_FILES:
            continue
        paths = [path for path in paths if not _private(path) and not _skip_dir(path, git_inventory=True)]
        for path in paths:
            peers = counts.setdefault(path, {})
            for peer in paths:
                if peer != path:
                    peers[peer] = peers.get(peer, 0) + 1
    result = {
        path: [
            {"path": peer, "count": count}
            for peer, count in sorted(peers.items(), key=lambda item: (-item[1], item[0]))
        ]
        for path, peers in counts.items()
    }
    _COCHANGE_CACHE[key] = result
    while len(_COCHANGE_CACHE) > 8:
        _COCHANGE_CACHE.pop(next(iter(_COCHANGE_CACHE)))
    return _cochanges_for_known(result, known)


def _cochanges_for_known(raw: dict[str, list[dict[str, Any]]], known: set[str]) -> dict[str, list[dict[str, Any]]]:
    return {
        path: [item for item in peers if item.get("path") in known][:MAX_COCHANGE_RESULTS]
        for path, peers in raw.items()
        if path in known
    }


def _fingerprint(path: Path) -> dict[str, int] | None:
    try:
        value = path.lstat()
    except OSError:
        return None
    return {key: int(getattr(value, attr)) for key, attr in (
        ("ctime_ns", "st_ctime_ns"), ("inode", "st_ino"), ("size", "st_size"), ("mtime_ns", "st_mtime_ns")
    )}


def _has_symlink_ancestor(path: Path, root: Path) -> bool:
    current = path
    try:
        while True:
            if current.is_symlink():
                return True
            if current == root or current.parent == current:
                return False
            current = current.parent
    except OSError:
        return True


# Callers pass normalized POSIX paths, so string splits stand in for PurePosixPath.
def _private(rel: str) -> bool:
    for part in rel.split("/"):
        lower = part.lower()
        if part.startswith(".env") or lower in PRIVATE_NAMES or "credential" in lower or "secret" in lower:
            return True
        if lower.endswith((".pem", ".key", ".p12", ".pfx")) or "key" in lower and PRIVATE_KEY_PART.search(lower):
            return True
    return False


def _skip_dir(rel: str, *, git_inventory: bool = False) -> bool:
    skipped = SKIP_DIRS if git_inventory else SKIP_AND_BUILD_DIRS
    return any(part.lower() in skipped for part in rel.split("/")[:-1])


def _name_and_suffix(rel: str) -> tuple[str, str]:
    name = rel.rpartition("/")[2].lower()
    dot = name.rfind(".")
    return name, name[dot:] if 0 < dot < len(name) - 1 else ""


def _language(rel: str) -> str | None:
    name, suffix = _name_and_suffix(rel)
    if name in CONFIG_NAMES:
        return "python" if name.endswith(".py") else "javascript" if name.endswith(".js") else "config"
    if name == "dockerfile" or name.startswith("dockerfile."):
        return "config"
    return None if name in NON_CODE_NAMES else LANGUAGES.get(suffix)


def _non_code_path(rel: str) -> bool:
    name, suffix = _name_and_suffix(rel)
    return name in NON_CODE_NAMES or suffix in NON_CODE_SUFFIXES


def _exclusion_reason(rel: str, reason: str | None) -> str | None:
    if reason == "unsupported format" and _non_code_path(rel):
        return "non-code file"
    if reason == "private or symlink path" and _skip_dir(rel, git_inventory=True) and not _private(rel):
        return "vendored dependency folder"
    if reason in {"private or symlink path", "non-regular path"}:
        return reason
    return None


def _candidate(root: Path, rel: str, *, git_inventory: bool = False) -> tuple[dict[str, Any] | None, str | None]:
    path = root / rel
    fp = _fingerprint(path)
    if _private(rel) or _skip_dir(rel, git_inventory=git_inventory) or _has_symlink_ancestor(path, root):
        return None, "private or symlink path"
    if fp is None:
        return None, "path disappeared"
    try:
        if not stat.S_ISREG(path.lstat().st_mode):
            return None, "non-regular path"
    except OSError:
        return None, "path disappeared"
    language = _language(rel)
    if language is None:
        return None, "unsupported format"
    return {"path": rel, "absolute": path, "language": language, "fingerprint": fp}, None
