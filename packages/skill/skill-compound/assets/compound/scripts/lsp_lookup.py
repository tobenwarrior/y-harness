#!/usr/bin/env python3
"""Strictly opt-in, bounded stdlib LSP definition/reference lookup.

Unlike :mod:`symbol_lookup`, this adapter asks a caller-selected language server
for semantic locations. It never discovers, installs, or starts a server unless
an explicit executable argument vector is passed to ``lookup_lsp``/the CLI.
Returned locations contain only sanitized workspace-relative paths and
positions; source text is sent to the server for ``textDocument/didOpen`` but is
never returned.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import queue
import shutil
import signal
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request
from pathlib import Path, PurePosixPath
from typing import Any, Sequence

try:
    from . import code_map
    from .safe_open import open_regular_nofollow
except ImportError:  # direct script execution
    import code_map
    from safe_open import open_regular_nofollow

DEFAULT_TIMEOUT = 8.0
MIN_TIMEOUT = 0.1
MAX_TIMEOUT = 20.0
MAX_SOURCE_BYTES = 256 * 1024
MAX_COMMAND_ARGS = 64
MAX_COMMAND_BYTES = 8192
MAX_FRAME_BYTES = 2 * 1024 * 1024
MAX_TOTAL_PROTOCOL_BYTES = 4 * 1024 * 1024
MAX_HEADER_BYTES = 8192
MAX_RESULTS = 1000
DEFAULT_MAX_RESULTS = 100
MIN_OUTPUT_BYTES = 4096
DEFAULT_MAX_OUTPUT_BYTES = 12 * 1024
MAX_OUTPUT_BYTES = 64 * 1024
MAX_EXAMINED_RESULTS = 2000
_READER_CHUNK_BYTES = 4096
# LSP languageId values where they differ from code_map's language labels.
LANGUAGE_IDS = {".tsx": "typescriptreact", ".jsx": "javascriptreact", ".jsonc": "jsonc", ".fish": "fish",
                **dict.fromkeys((".sh", ".bash", ".zsh"), "shellscript")}


class LspLookupError(ValueError):
    """Invalid request, unavailable server, or invalid LSP exchange."""


def _bounded_int(value: int, low: int, high: int, name: str) -> int:
    if isinstance(value, bool):
        raise LspLookupError(f"{name} must be an integer")
    try:
        result = int(value)
    except (TypeError, ValueError, OverflowError) as exc:
        raise LspLookupError(f"{name} must be an integer") from exc
    return max(low, min(result, high))


def _bounded_timeout(value: float) -> float:
    try:
        timeout = float(value)
    except (TypeError, ValueError, OverflowError) as exc:
        raise LspLookupError("timeout must be a finite number") from exc
    if not math.isfinite(timeout):
        raise LspLookupError("timeout must be a finite number")
    return max(MIN_TIMEOUT, min(timeout, MAX_TIMEOUT))


def _relative_path(value: str) -> str:
    if not isinstance(value, str) or not value or len(value) > 4096:
        raise LspLookupError("file must be a repository-relative source path")
    if "\\" in value or any(ord(char) < 32 or ord(char) == 127 for char in value):
        raise LspLookupError("file path contains an unsafe character")
    path = PurePosixPath(value)
    if path.is_absolute() or any(part in {"", ".", ".."} for part in value.split("/")):
        raise LspLookupError("file must be a normalized repository-relative path")
    return path.as_posix()


def _caller_path(path: str) -> str:
    """Pin a relative path to the caller's directory, since the server starts in the root; joined, not normalized, so ``..`` resolves as the kernel does."""
    return path if os.path.isabs(path) else os.path.join(os.getcwd(), path)


def _command_argv(command: Sequence[str]) -> list[str]:
    if isinstance(command, (str, bytes)) or not isinstance(command, Sequence):
        raise LspLookupError("server_command must be an explicit argument vector")
    if not command or len(command) > MAX_COMMAND_ARGS:
        raise LspLookupError(f"server_command must contain 1 to {MAX_COMMAND_ARGS} arguments")
    argv: list[str] = []
    encoded_size = 0
    for item in command:
        if not isinstance(item, str) or "\0" in item:
            raise LspLookupError("server_command arguments must be NUL-free strings")
        encoded_size += len(item.encode("utf-8", errors="strict"))
        argv.append(item)
    if not argv[0] or encoded_size > MAX_COMMAND_BYTES:
        raise LspLookupError(f"server_command must be non-empty and at most {MAX_COMMAND_BYTES} UTF-8 bytes")

    # Resolve only the exact executable the caller named. No shell, package
    # manager, workspace script, or fallback executable is considered. Symlinks
    # are kept because virtualenv interpreters and rustup proxies depend on the
    # path they were invoked by.
    if os.path.dirname(argv[0]):
        executable = os.path.expanduser(argv[0])
        resolved = executable if os.path.isfile(executable) and os.access(executable, os.X_OK) else None
    else:
        resolved = shutil.which(argv[0])
    if resolved is None:
        raise LspLookupError("explicit language-server executable is unavailable")
    argv[0] = _caller_path(resolved)
    return argv


def _server_env() -> dict[str, str]:
    """Return the caller's environment with PATH pinned like argv[0], for programs the server runs by name."""
    env = dict(os.environ)
    if "PATH" in env:
        env["PATH"] = os.pathsep.join(map(_caller_path, env["PATH"].split(os.pathsep)))
    return env


def _language_id(relative: str, language: str) -> str:
    name, suffix = code_map._name_and_suffix(relative)
    if language != "config":
        return LANGUAGE_IDS.get(suffix, language)
    name = "dockerfile" if name.startswith("dockerfile.") else name
    return name if name in {"dockerfile", "makefile", "go.mod"} else code_map.LANGUAGES.get(suffix, "plaintext")


def _indexed_source(root: Path, relative: str) -> tuple[str, str, set[str]]:
    """Read a safe indexed source file and retain the inventory for filtering results."""
    try:
        inventory_root, _head, inventory_list, notes = code_map._git_context(root)
    except (OSError, ValueError) as exc:
        raise LspLookupError("repository source inventory is unavailable") from exc
    if inventory_list is None or notes or inventory_root != root:
        raise LspLookupError("repository source inventory is unavailable")
    inventory = set(inventory_list)
    if relative not in inventory:
        raise LspLookupError("file is not in the indexed repository source inventory")
    candidate, reason = code_map._candidate(root, relative, git_inventory=True)
    if candidate is None:
        if reason == "private or symlink path":
            raise LspLookupError("file is private, excluded, or traverses a symlink")
        raise LspLookupError("file is not an indexable source file")
    fingerprint = candidate["fingerprint"]
    if fingerprint["size"] > MAX_SOURCE_BYTES:
        raise LspLookupError(f"source file exceeds the {MAX_SOURCE_BYTES}-byte input limit")
    try:
        fd = open_regular_nofollow(root, relative)
        with os.fdopen(fd, "rb") as source:
            before = os.fstat(source.fileno())
            if before.st_size > MAX_SOURCE_BYTES or any(
                getattr(before, attr) != fingerprint[key]
                for key, attr in (("size", "st_size"), ("inode", "st_ino"), ("mtime_ns", "st_mtime_ns"), ("ctime_ns", "st_ctime_ns"))
            ):
                raise LspLookupError("source file changed or exceeds the input limit")
            data = source.read(MAX_SOURCE_BYTES + 1)
            after = os.fstat(source.fileno())
            if len(data) > MAX_SOURCE_BYTES or (
                before.st_size, before.st_ino, before.st_mtime_ns, before.st_ctime_ns
            ) != (
                after.st_size, after.st_ino, after.st_mtime_ns, after.st_ctime_ns
            ) or code_map._fingerprint(root / relative) != fingerprint:
                raise LspLookupError("source file changed or exceeds the input limit")
    except LspLookupError:
        raise
    except (OSError, ValueError) as exc:
        raise LspLookupError("source file could not be opened safely") from exc
    if b"\0" in data:
        raise LspLookupError("binary source files cannot be opened by the language server")
    try:
        # Editors hide a byte-order mark, so columns and didOpen text exclude it.
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise LspLookupError("source file is not valid UTF-8") from exc
    return text, _language_id(relative, candidate["language"]), inventory


def _line_prefix(text: str, line: int, column: int) -> str:
    """Return the line text before a 1-based code-point position, which must exist."""
    if isinstance(line, bool) or isinstance(column, bool) or not isinstance(line, int) or not isinstance(column, int):
        raise LspLookupError("line and column must be integers")
    if line < 1 or column < 1:
        raise LspLookupError("line and column are 1-based positive integers")
    # LSP ends lines at \n, \r\n and \r, and the position after a final line break is valid.
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    if line > len(lines):
        raise LspLookupError("line is past the end of the source file")
    content = lines[line - 1]
    if column > len(content) + 1:
        raise LspLookupError("column is past the end of the source line")
    return content[: column - 1]


def _lsp_position(prefix: str, line: int, encoding: str) -> dict[str, int]:
    if encoding == "utf-8":
        character = len(prefix.encode("utf-8"))
    elif encoding == "utf-16":
        character = len(prefix.encode("utf-16-le")) // 2
    elif encoding == "utf-32":
        character = len(prefix)
    else:
        raise LspLookupError(f"language server selected unsupported position encoding: {encoding}")
    return {"line": line - 1, "character": character}


def _frame(message: dict[str, Any]) -> bytes:
    try:
        body = json.dumps(message, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
    except (TypeError, ValueError, UnicodeEncodeError) as exc:
        raise LspLookupError("could not encode an LSP message") from exc
    if len(body) > MAX_FRAME_BYTES:
        raise LspLookupError(f"LSP request exceeds the {MAX_FRAME_BYTES}-byte frame limit")
    return b"Content-Length: " + str(len(body)).encode("ascii") + b"\r\n\r\n" + body


class _JsonRpc:
    """Small framed JSON-RPC client with bounded pipes and one total deadline."""

    def __init__(self, process: subprocess.Popen[bytes], deadline: float, workspace_folders: list[dict[str, str]]):
        self.process = process
        self.deadline = deadline
        self.workspace_folders = workspace_folders
        self.buffer = bytearray()
        self.received_bytes = 0
        self.sent_bytes = 0
        self.next_id = 1
        self._pumped = 0
        self._chunks: queue.Queue[bytes | BaseException | None] = queue.Queue()
        self._closed = threading.Event()
        self._write_done = threading.Event()
        self._write_done.set()
        assert process.stdout is not None
        self._reader = threading.Thread(target=self._pump_stdout, daemon=True)
        self._reader.start()

    def _pump_stdout(self) -> None:
        # Keep reading while a request is written, so a server that writes before
        # it reads cannot block both pipes; the protocol byte limit bounds the queue.
        assert self.process.stdout is not None
        fd = self.process.stdout.fileno()
        try:
            while not self._closed.is_set() and self._pumped <= MAX_TOTAL_PROTOCOL_BYTES:
                block = os.read(fd, _READER_CHUNK_BYTES)
                if not block:
                    self._chunks.put(None)
                    return
                self._pumped += len(block)
                self._chunks.put(block)
        except BaseException as exc:  # delivered to the protocol owner
            self._chunks.put(exc)

    def _remaining(self) -> float:
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            raise LspLookupError("language-server process timed out")
        return remaining

    def _write(self, data: bytes) -> None:
        self.sent_bytes += len(data)
        if self.sent_bytes > MAX_TOTAL_PROTOCOL_BYTES:
            raise LspLookupError("language-server request byte limit exceeded")
        assert self.process.stdin is not None
        failure: list[BaseException] = []

        def writer() -> None:
            try:
                self.process.stdin.write(data)
                self.process.stdin.flush()
            except BaseException as exc:
                failure.append(exc)
            finally:
                self._write_done.set()

        self._write_done.clear()
        threading.Thread(target=writer, daemon=True).start()
        # The reader stops at the byte limit, and a server then blocked on its
        # output never reads this request, so the wait checks the limit in slices.
        while not self._write_done.wait(0.05):
            if self._pumped > MAX_TOTAL_PROTOCOL_BYTES:
                raise LspLookupError("language-server response byte limit exceeded")
            if time.monotonic() >= self.deadline:
                raise LspLookupError("language-server process timed out while sending a request")
        if failure:
            raise LspLookupError("language server closed its input stream") from failure[0]

    def _more(self) -> None:
        try:
            item = self._chunks.get(timeout=self._remaining())
        except queue.Empty as exc:
            raise LspLookupError("language-server process timed out waiting for a response") from exc
        if isinstance(item, BaseException):
            raise LspLookupError("could not read language-server output") from item
        if item is None:
            raise LspLookupError("language server closed its output stream before replying")
        self.received_bytes += len(item)
        if self.received_bytes > MAX_TOTAL_PROTOCOL_BYTES:
            raise LspLookupError("language-server response byte limit exceeded")
        self.buffer.extend(item)

    def _read_message(self) -> dict[str, Any]:
        delimiter = b"\r\n\r\n"
        while delimiter not in self.buffer:
            if len(self.buffer) > MAX_HEADER_BYTES:
                raise LspLookupError("malformed LSP response header")
            self._more()
        header_end = self.buffer.index(delimiter)
        if header_end > MAX_HEADER_BYTES:
            raise LspLookupError("malformed LSP response header")
        raw_header = bytes(self.buffer[:header_end])
        del self.buffer[: header_end + len(delimiter)]
        try:
            headers = raw_header.decode("ascii").split("\r\n")
        except UnicodeDecodeError as exc:
            raise LspLookupError("malformed LSP response header") from exc
        lengths = []
        for header in headers:
            name, separator, value = header.partition(":")
            if not separator:
                raise LspLookupError("malformed LSP response header")
            if name.strip().lower() == "content-length":
                lengths.append(value.strip())
        if len(lengths) != 1 or not lengths[0].isdigit():
            raise LspLookupError("malformed LSP Content-Length")
        length = int(lengths[0])
        if length > MAX_FRAME_BYTES:
            raise LspLookupError("language-server response frame exceeds the byte limit")
        while len(self.buffer) < length:
            self._more()
        body = bytes(self.buffer[:length])
        del self.buffer[:length]
        try:
            message = json.loads(
                body.decode("utf-8"),
                parse_constant=lambda _value: (_ for _ in ()).throw(ValueError("invalid JSON constant")),
            )
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError, RecursionError) as exc:
            raise LspLookupError("malformed JSON in language-server response") from exc
        if not isinstance(message, dict) or message.get("jsonrpc") != "2.0":
            raise LspLookupError("malformed JSON-RPC response")
        return message

    def _server_request(self, message: dict[str, Any]) -> None:
        method = message.get("method")
        request_id = message.get("id")
        params = message.get("params")
        if not isinstance(method, str):
            raise LspLookupError("malformed language-server request")
        if method == "workspace/configuration":
            items = params.get("items", []) if isinstance(params, dict) else []
            result: Any = [None] * len(items) if isinstance(items, list) else []
            response = {"jsonrpc": "2.0", "id": request_id, "result": result}
        elif method == "workspace/workspaceFolders":
            response = {"jsonrpc": "2.0", "id": request_id, "result": self.workspace_folders}
        elif method in {"client/registerCapability", "client/unregisterCapability", "window/workDoneProgress/create"}:
            response = {"jsonrpc": "2.0", "id": request_id, "result": None}
        elif method == "workspace/applyEdit":
            response = {"jsonrpc": "2.0", "id": request_id, "result": {"applied": False}}
        else:
            response = {
                "jsonrpc": "2.0", "id": request_id,
                "error": {"code": -32601, "message": "unsupported client request"},
            }
        self._write(_frame(response))

    def request(self, method: str, params: dict[str, Any] | None = None) -> Any:
        request_id = self.next_id
        self.next_id += 1
        outgoing: dict[str, Any] = {"jsonrpc": "2.0", "id": request_id, "method": method}
        if params is not None:
            outgoing["params"] = params
        self._write(_frame(outgoing))
        while True:
            message = self._read_message()
            if "method" in message:
                if "id" in message:
                    self._server_request(message)
                # Notifications carry no source data to our caller and are ignored.
                continue
            if "id" not in message:
                raise LspLookupError("malformed JSON-RPC response")
            if type(message["id"]) is not int or message["id"] != request_id:
                raise LspLookupError("unexpected JSON-RPC response id")
            if "error" in message:
                error = message["error"]
                code = error.get("code") if isinstance(error, dict) else "unknown"
                raise LspLookupError(f"language-server {method} request failed (error code {code})")
            if "result" not in message:
                raise LspLookupError("malformed JSON-RPC response")
            return message["result"]

    def notify(self, method: str, params: dict[str, Any] | None = None) -> None:
        message: dict[str, Any] = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            message["params"] = params
        self._write(_frame(message))

    def close_reader(self) -> None:
        self._closed.set()

    def write_pending(self) -> bool:
        return not self._write_done.is_set()


def _server_argv_or_error(command: Sequence[str]) -> list[str]:
    try:
        return _command_argv(command)
    except (UnicodeError, OSError) as exc:
        raise LspLookupError("explicit language-server executable is unavailable") from exc


def _position_encoding(capabilities: dict[str, Any]) -> str:
    encoding = capabilities.get("positionEncoding", "utf-16")
    if encoding not in {"utf-8", "utf-16", "utf-32"}:
        raise LspLookupError("language server selected an unsupported position encoding")
    return encoding


def _provider_enabled(capabilities: dict[str, Any], key: str) -> bool:
    provider = capabilities.get(key)
    return provider is True or isinstance(provider, dict)


def _uri_to_indexed_path(uri: Any, root: Path, inventory: set[str]) -> str | None:
    if not isinstance(uri, str) or len(uri) > 8192:
        return None
    try:
        parsed = urllib.parse.urlsplit(uri)
        if parsed.scheme.lower() != "file" or parsed.netloc.lower() not in {"", "localhost"}:
            return None
        if parsed.query or parsed.fragment:
            return None
        local_path = Path(urllib.request.url2pathname(parsed.path))
        if not local_path.is_absolute() or any(part == ".." for part in local_path.parts):
            return None
        relative = local_path.relative_to(root).as_posix()
        relative = _relative_path(relative)
    except (ValueError, UnicodeError, OSError):
        return None
    if relative not in inventory or code_map._private(relative) or code_map._skip_dir(relative, git_inventory=True):
        return None
    try:
        fd = open_regular_nofollow(root, relative)
        os.close(fd)
    except (OSError, LspLookupError):
        return None
    return relative


def _location_parts(location: Any, *, link: bool) -> tuple[Any, Any, Any]:
    if not isinstance(location, dict):
        raise LspLookupError("malformed language-server location response")
    if link:
        uri = location.get("targetUri")
        range_value = location.get("targetSelectionRange", location.get("targetRange"))
    else:
        uri = location.get("uri")
        range_value = location.get("range")
    if not isinstance(range_value, dict):
        raise LspLookupError("malformed language-server location range")
    start = range_value.get("start")
    if not isinstance(start, dict):
        raise LspLookupError("malformed language-server location position")
    line = start.get("line")
    character = start.get("character")
    if (
        isinstance(line, bool) or not isinstance(line, int) or line < 0
        or isinstance(character, bool) or not isinstance(character, int) or character < 0
    ):
        raise LspLookupError("malformed language-server location position")
    return uri, line, character


def _locations(
    raw: Any,
    *,
    kind: str,
    root: Path,
    inventory: set[str],
    max_results: int,
) -> tuple[list[dict[str, Any]], bool, int]:
    if raw is None:
        values: list[Any] = []
        link = False
    elif isinstance(raw, list):
        values = raw
        link = kind == "definitions" and any(
            isinstance(item, dict) and "targetUri" in item for item in raw[:MAX_EXAMINED_RESULTS]
        )
    elif isinstance(raw, dict):
        values = [raw]
        link = kind == "definitions" and "targetUri" in raw
    else:
        raise LspLookupError("malformed language-server location result")

    truncated = len(values) > MAX_EXAMINED_RESULTS
    filtered = 0
    result: list[dict[str, Any]] = []
    seen: set[tuple[str, int, int]] = set()
    paths: dict[str, str | None] = {}
    for location in values[:MAX_EXAMINED_RESULTS]:
        uri, line, character = _location_parts(location, link=link)
        if not isinstance(uri, str):
            filtered += 1
            continue
        if uri not in paths:
            paths[uri] = _uri_to_indexed_path(uri, root, inventory)
        relative = paths[uri]
        if relative is None:
            filtered += 1
            continue
        key = (relative, line, character)
        if key in seen:
            continue
        seen.add(key)
        if len(result) >= max_results:
            truncated = True
            continue
        result.append({"path": relative, "line": line + 1, "column": character + 1})
    if len(values) > MAX_EXAMINED_RESULTS:
        filtered += len(values) - MAX_EXAMINED_RESULTS
    return result, truncated, filtered


def _encoded_size(result: dict[str, Any]) -> int:
    output = result["coverage"]["output"]
    output["bytes"] = 0
    for _ in range(4):
        size = len(json.dumps(result, ensure_ascii=True, separators=(",", ":")).encode("utf-8"))
        if output["bytes"] == size:
            return size
        output["bytes"] = size
    return len(json.dumps(result, ensure_ascii=True, separators=(",", ":")).encode("utf-8"))


def _fit_output(result: dict[str, Any], byte_limit: int) -> dict[str, Any]:
    output = result["coverage"]["output"]
    if _encoded_size(result) <= byte_limit:
        return result
    output["truncated"] = True
    result["coverage"]["complete"] = False
    for key in ("references", "definitions"):
        original = result[key]
        if not original:
            continue
        result["coverage"]["results_truncated"][key] = True
        low, high, best = 0, len(original) - 1, -1
        while low <= high:
            middle = (low + high) // 2
            result[key] = original[:middle]
            if _encoded_size(result) <= byte_limit:
                best = middle
                low = middle + 1
            else:
                high = middle - 1
        result[key] = original[:max(0, best)]
        if _encoded_size(result) <= byte_limit:
            return result
    raise LspLookupError("output byte limit is too small for the LSP result metadata")


def lookup_lsp(
    repo: str | os.PathLike[str],
    file: str,
    line: int,
    column: int,
    server_command: Sequence[str],
    *,
    max_results: int = DEFAULT_MAX_RESULTS,
    timeout: float = DEFAULT_TIMEOUT,
    max_output_bytes: int = DEFAULT_MAX_OUTPUT_BYTES,
) -> dict[str, Any]:
    """Query explicit LSP ``definition`` and ``references`` for a source position.

    ``file`` is a normalized repository-relative indexed path. ``line`` and
    ``column`` are 1-based Unicode-code-point positions. The returned ``column``
    is 1-based in the server-negotiated LSP encoding. The subprocess is never
    started without the caller's explicit ``server_command`` argument vector.
    """
    root = code_map._repo_path(repo)
    relative = _relative_path(file)
    max_results = _bounded_int(max_results, 1, MAX_RESULTS, "max_results")
    timeout_value = _bounded_timeout(timeout)
    output_limit = _bounded_int(max_output_bytes, MIN_OUTPUT_BYTES, MAX_OUTPUT_BYTES, "max_output_bytes")
    command = _server_argv_or_error(server_command)
    text, language, inventory = _indexed_source(root, relative)
    prefix = _line_prefix(text, line, column)
    document_uri = (root / relative).as_uri()

    process: subprocess.Popen[bytes] | None = None
    rpc: _JsonRpc | None = None
    deadline = 0.0
    try:
        kwargs: dict[str, Any] = {
            "args": command,
            "cwd": str(root),
            "env": _server_env(),
            "stdin": subprocess.PIPE,
            "stdout": subprocess.PIPE,
            "stderr": subprocess.DEVNULL,
            "shell": False,
            "close_fds": True,
        }
        if os.name == "posix":
            kwargs["start_new_session"] = True
        try:
            process = subprocess.Popen(**kwargs)
        except OSError as exc:
            raise LspLookupError("could not start the explicitly supplied language-server command") from exc
        deadline = time.monotonic() + timeout_value
        workspace_folders = [{"uri": root.as_uri(), "name": root.name}]
        rpc = _JsonRpc(process, deadline, workspace_folders)
        initialize = rpc.request(
            "initialize",
            {
                "processId": os.getpid(),
                "clientInfo": {"name": "compound-lsp-lookup", "version": "1"},
                "rootUri": root.as_uri(),
                "workspaceFolders": workspace_folders,
                "capabilities": {
                    "general": {"positionEncodings": ["utf-16"]},
                    "textDocument": {
                        "definition": {"dynamicRegistration": False},
                        "references": {"dynamicRegistration": False},
                        "synchronization": {"dynamicRegistration": False},
                    },
                    "workspace": {"workspaceFolders": True, "configuration": False},
                    "window": {"workDoneProgress": False},
                },
            },
        )
        if not isinstance(initialize, dict) or not isinstance(initialize.get("capabilities"), dict):
            raise LspLookupError("malformed language-server initialize response")
        capabilities = initialize["capabilities"]
        missing = [
            name for key, name in (
                ("definitionProvider", "textDocument/definition"),
                ("referencesProvider", "textDocument/references"),
            ) if not _provider_enabled(capabilities, key)
        ]
        if missing:
            raise LspLookupError("language server lacks required capability: " + ", ".join(missing))
        encoding = _position_encoding(capabilities)
        position = _lsp_position(prefix, line, encoding)
        rpc.notify("initialized", {})
        rpc.notify(
            "textDocument/didOpen",
            {"textDocument": {"uri": document_uri, "languageId": language, "version": 1, "text": text}},
        )
        query = {"textDocument": {"uri": document_uri}, "position": position}
        definitions_raw = rpc.request("textDocument/definition", query)
        references_raw = rpc.request(
            "textDocument/references", {**query, "context": {"includeDeclaration": True}}
        )
        definitions, definitions_truncated, definitions_filtered = _locations(
            definitions_raw, kind="definitions", root=root, inventory=inventory, max_results=max_results
        )
        references, references_truncated, references_filtered = _locations(
            references_raw, kind="references", root=root, inventory=inventory, max_results=max_results
        )
        rpc.request("shutdown")
        rpc.notify("exit")
        if process.stdin is not None:
            process.stdin.close()
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise LspLookupError("language-server process timed out during shutdown")
        try:
            return_code = process.wait(timeout=remaining)
        except subprocess.TimeoutExpired as exc:
            raise LspLookupError("language server did not exit after shutdown") from exc
        if return_code != 0:
            raise LspLookupError(f"language server exited with status {return_code}")
        complete = not any((definitions_truncated, references_truncated, definitions_filtered, references_filtered))
        result = {
            "mode": "lsp",
            "query": {"file": relative, "line": line, "column": column},
            "position_encoding": encoding,
            "definitions": definitions,
            "references": references,
            "coverage": {
                "complete": complete,
                "results_truncated": {
                    "definitions": definitions_truncated,
                    "references": references_truncated,
                },
                "locations_filtered": {
                    "definitions": definitions_filtered,
                    "references": references_filtered,
                },
                "capabilities": {"definition": True, "references": True},
                "limits": {
                    "timeout_seconds": timeout_value,
                    "source_bytes": MAX_SOURCE_BYTES,
                    "protocol_frame_bytes": MAX_FRAME_BYTES,
                    "protocol_bytes_each_direction": MAX_TOTAL_PROTOCOL_BYTES,
                    "results_per_request": max_results,
                    "examined_locations_per_response": MAX_EXAMINED_RESULTS,
                },
                "protocol_bytes": {"sent": rpc.sent_bytes, "received": rpc.received_bytes},
                "output": {"bytes": 0, "truncated": False},
            },
        }
        return _fit_output(result, output_limit)
    except LspLookupError:
        raise
    except (OSError, ValueError, TypeError, subprocess.SubprocessError) as exc:
        raise LspLookupError("language-server exchange failed") from exc
    finally:
        if rpc is not None:
            rpc.close_reader()
        if process is not None:
            running = process.poll() is None
            try:
                if os.name == "posix":
                    # Helpers the server started stay in its group after it exits.
                    os.killpg(process.pid, signal.SIGKILL)
                elif running:
                    process.kill()
            except (OSError, ProcessLookupError):
                pass
            if running:
                try:
                    process.wait(timeout=1)
                except subprocess.TimeoutExpired:
                    pass
            # A write still blocked on a pipe that a detached helper holds open keeps
            # the stdin lock, so closing would hang; the collector closes it later.
            if process.stdin is not None and (rpc is None or not rpc.write_pending()):
                try:
                    process.stdin.close()
                except OSError:
                    pass
            if process.stdout is not None:
                try:
                    process.stdout.close()
                except OSError:
                    pass


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Opt-in LSP definition/reference lookup (JSON, no source snippets)."
    )
    parser.add_argument("--repo", required=True, metavar="PATH")
    parser.add_argument("--file", required=True, metavar="REPO_RELATIVE_PATH")
    parser.add_argument("--line", required=True, type=int, metavar="1_BASED")
    parser.add_argument("--column", required=True, type=int, metavar="1_BASED")
    parser.add_argument(
        "--server-command-json", required=True, metavar="JSON_ARRAY",
        help="explicit argv, e.g. '[\"pyright-langserver\",\"--stdio\"]'; never shell-split",
    )
    parser.add_argument("--max-results", type=int, default=DEFAULT_MAX_RESULTS)
    parser.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT)
    parser.add_argument("--max-output-bytes", type=int, default=DEFAULT_MAX_OUTPUT_BYTES)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        command = json.loads(args.server_command_json)
        if not isinstance(command, list):
            raise LspLookupError("--server-command-json must be a JSON array of strings")
        result = lookup_lsp(
            args.repo,
            args.file,
            args.line,
            args.column,
            command,
            max_results=args.max_results,
            timeout=args.timeout,
            max_output_bytes=args.max_output_bytes,
        )
    except (LspLookupError, OSError, ValueError, TypeError) as exc:
        print(f"lsp-lookup error: {exc}", file=sys.stderr)
        return 2
    sys.stdout.write(json.dumps(result, ensure_ascii=True, separators=(",", ":")) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
