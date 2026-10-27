#!/usr/bin/env python3
"""Build a bounded repository map from Git's current file inventory."""

from __future__ import annotations

import argparse
import ast
import datetime as dt
import hashlib
import json
import os
import posixpath
import re
import selectors
import stat
import subprocess
import sys
import tempfile
import time
import urllib.parse
from pathlib import Path, PurePosixPath
from typing import Any
try:
    from .onboarding import _reject_symlink_chain, _state_paths
    from .workspace_imports import load_workspace_packages, resolve_workspace_import
except ImportError:  # direct script execution
    from onboarding import _reject_symlink_chain, _state_paths
    from workspace_imports import load_workspace_packages, resolve_workspace_import

DEFAULT_MAX_CHARS = 2500
MAX_CHARS = 12000
DEFAULT_MAX_FILES = 2000
MAX_FILES = 20000
MAX_FILE_BYTES = 1024 * 1024
MAX_READ_BYTES = 64 * 1024 * 1024
MAX_SYMBOLS = 512
MAX_DEPS = 256
MAX_IMPORTS = MAX_DEPS * 2
MAX_PARSE_NOTE_CHARS = 160
GIT_TIMEOUT = 5
CACHE_VERSION = 7
ANALYSIS_KINDS = {"python-ast", "javascript-outline", "metadata"}
MAX_ALIAS_CONFIGS = 64
MAX_ALIAS_CONFIG_BYTES = 64 * 1024
MAX_ALIAS_RULES = 2048
MAX_ALIAS_EXTENDS_DEPTH = 16
MAX_ALIAS_READS = 128
MAX_ALIAS_TARGETS = 8
MAX_COCHANGE_COMMITS = 30
MAX_COCHANGE_FILES = 60
MAX_COCHANGE_RESULTS = 6
MAX_GIT_LOG_BYTES = 1024 * 1024
MAX_GIT_INVENTORY_BYTES = 4 * 1024 * 1024
SKIP_DIRS = {".git", "vendor", "node_modules"}
BUILD_DIRS = {"build", "dist"}
PRIVATE_NAMES = {"credentials", "credential", "secrets", "secret", "keys", "id_rsa", "id_ed25519"}
CONFIG_NAMES = {
    "cargo.toml", "dockerfile", "go.mod", "makefile", "package.json", "pyproject.toml", "procfile",
    "requirements.txt", "setup.cfg", "setup.py", "tsconfig.json", "vite.config.js", "webpack.config.js",
}
NON_CODE_NAMES = {
    ".codeowners", ".cursorignore", ".dockerignore", ".editorconfig", ".gitattributes", ".gitignore",
    ".gitmodules", ".gitkeep", ".npmignore", "authors", "changelog", "copying", "license", "notice", "readme",
}
NON_CODE_SUFFIXES = {
    ".adoc", ".bmp", ".csv", ".gif", ".ico", ".jpeg", ".jpg", ".lock", ".log", ".map", ".md",
    ".mdc", ".markdown", ".png", ".rst", ".svg", ".text", ".txt", ".webp",
    ".bin", ".jsonl", ".otf", ".ttf", ".woff", ".woff2", ".xls", ".xlsx",
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
JS_IMPORT = re.compile(
    r"(?:\bimport\s+(?:[^'\";]*?\s+from\s+)?|\bexport\s+[^'\";]*?\s+from\s+)['\"]([^'\"]+)['\"]"
)
JS_CALL_IMPORT = re.compile(r"\b(?:require|import)\s*\(\s*['\"]([^'\"]+)['\"]\s*\)")
JS_SYMBOLS = (
    (re.compile(r"^\s*(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)"), "function"),
    (re.compile(r"^\s*(?:export\s+(?:default\s+)?)?class\s+([A-Za-z_$][\w$]*)"), "class"),
    (re.compile(r"^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)"), "interface"),
    (re.compile(r"^\s*(?:export\s+)?(?:type|enum)\s+([A-Za-z_$][\w$]*)"), "type"),
    (re.compile(r"^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\("), "function"),
    (re.compile(r"^\s*(?:export\s+)?(?:declare\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)"), "variable"),
)
JS_EXPORT_DECL = re.compile(
    r"^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)",
    re.MULTILINE,
)
JS_EXPORT_LIST = re.compile(r"\bexport\s*\{([^}]*)\}")
_COCHANGE_CACHE: dict[tuple[str, str], dict[str, list[dict[str, Any]]]] = {}
class CodeMapError(ValueError):
    pass
def _now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")


def _clamp(value: int, low: int, high: int) -> int:
    return max(low, min(high, value))
def _repo_path(raw: str | os.PathLike[str]) -> Path:
    path = Path(raw).expanduser()
    if not path.is_absolute():
        path = Path.cwd() / path
    try:
        path = path.resolve(strict=True)
    except OSError as exc:
        raise CodeMapError(f"could not resolve repository: {exc}") from exc
    if not path.is_dir():
        raise CodeMapError(f"repository is not a directory: {path}")
    return path
def _git(path: Path, *args: str) -> subprocess.CompletedProcess[bytes] | None:
    try:
        return subprocess.run(
            ["git", "-C", str(path), *args], capture_output=True, check=False, timeout=GIT_TIMEOUT
        )
    except (OSError, subprocess.TimeoutExpired):
        return None


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
def _git_context(supplied: Path) -> tuple[Path, str, list[str], list[str]]:
    root_result = _git(supplied, "rev-parse", "--show-toplevel")
    if root_result is None or root_result.returncode != 0:
        return supplied, "", [], ["Git inventory unavailable; use native search to inspect this repository"]
    try:
        root = Path(os.fsdecode(root_result.stdout.strip())).resolve(strict=True)
    except OSError:
        return supplied, "", [], ["Git root unavailable; use native search to inspect this repository"]
    head_result = _git(root, "rev-parse", "HEAD")
    head = os.fsdecode(head_result.stdout.strip()) if head_result and head_result.returncode == 0 else ""
    inventory_data = _bounded_git_output(
        root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], MAX_GIT_INVENTORY_BYTES
    )
    if inventory_data is None:
        return root, head, [], ["Git inventory unavailable or exceeded the bounded output limit; inspect with native search"]
    inventory = []
    for raw in inventory_data.split(b"\0"):
        rel = os.fsdecode(raw) if raw else ""
        if _safe_relative(rel):
            inventory.append(PurePosixPath(rel).as_posix())
    return root, head, sorted(set(inventory)), []


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


def _git_changes_result(root: Path) -> tuple[dict[str, str], str | None]:
    """Return bounded porcelain statuses keyed by the current path.

    The inventory remains authoritative for which files enter the model, so a
    deleted path can never become a metadata-only ghost in the result.
    """
    raw_status = _bounded_git_output(
        root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], MAX_GIT_LOG_BYTES
    )
    if raw_status is None:
        return {}, "Git status unavailable or exceeded the bounded output limit; changed-file metadata is unavailable"
    changes: dict[str, str] = {}
    parts = raw_status.split(b"\0")
    index = 0
    while index < len(parts):
        raw = parts[index]
        index += 1
        if not raw:
            continue
        try:
            record = os.fsdecode(raw)
        except (UnicodeDecodeError, ValueError):
            continue
        if len(record) < 3:
            continue
        status = record[:2]
        path = PurePosixPath(record[3:]).as_posix()
        if not _safe_relative(path):
            continue
        if "R" in status:
            # In NUL-delimited porcelain output the second path is the old
            # name. The first path is the current destination.
            if index < len(parts):
                index += 1
            kind = "renamed"
        elif "C" in status:
            if index < len(parts):
                index += 1
            kind = "added"
        elif "?" in status:
            kind = "untracked"
        elif "A" in status:
            kind = "added"
        elif "D" in status:
            kind = "deleted"
        elif any(character in status for character in "MTUX"):
            kind = "modified"
        else:
            continue
        changes[path] = kind
    return changes, None


def _git_changes(root: Path) -> dict[str, str]:
    return _git_changes_result(root)[0]


def _git_state(root: Path) -> tuple[str, dict[str, str], str | None]:
    changes, note = _git_changes_result(root)
    return _git_branch(root), changes, note


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
def _private(rel: str) -> bool:
    for part in PurePosixPath(rel).parts:
        lower = part.lower()
        if part.startswith(".env") or lower in PRIVATE_NAMES or "credential" in lower or "secret" in lower:
            return True
        if lower.endswith((".pem", ".key", ".p12", ".pfx")) or re.search(r"(?:^|[-_.])key(?:[-_.]|$)", lower):
            return True
    return False
def _skip_dir(rel: str, *, git_inventory: bool = False) -> bool:
    skipped = SKIP_DIRS if git_inventory else SKIP_DIRS | BUILD_DIRS
    return any(part.lower() in skipped for part in PurePosixPath(rel).parts[:-1])
def _language(rel: str) -> str | None:
    name = PurePosixPath(rel).name.lower()
    if name in CONFIG_NAMES:
        return "python" if name.endswith(".py") else "javascript" if name.endswith(".js") else "config"
    if name == "dockerfile" or name.startswith("dockerfile."):
        return "config"
    return LANGUAGES.get(PurePosixPath(rel).suffix.lower())
def _entry_config(rel: str) -> bool:
    name = PurePosixPath(rel).name.lower()
    return name in CONFIG_NAMES or name == "dockerfile" or name.startswith("dockerfile.")


def _non_code_path(rel: str) -> bool:
    path = PurePosixPath(rel)
    return path.name.lower() in NON_CODE_NAMES or path.suffix.lower() in NON_CODE_SUFFIXES


def _exclusion_reason(rel: str, reason: str | None) -> str | None:
    if reason == "unsupported format" and _non_code_path(rel):
        return "non-code file"
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
def _python_outline(text: str) -> tuple[list[dict[str, Any]], list[list[Any]], list[str], str | None]:
    try:
        tree = ast.parse(text)
    except (SyntaxError, ValueError, TypeError):
        return [], [], [], "Python file could not be parsed"
    symbols: list[dict[str, Any]] = []
    imports: list[list[Any]] = []
    for node in sorted(ast.walk(tree), key=lambda item: getattr(item, "lineno", 0)):
        line = int(getattr(node, "lineno", 1))
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            args = list(node.args.posonlyargs) + list(node.args.args) + list(node.args.kwonlyargs)
            names = [arg.arg for arg in args]
            if node.args.vararg:
                names.append("*" + node.args.vararg.arg)
            if node.args.kwarg:
                names.append("**" + node.args.kwarg.arg)
            symbols.append({"name": node.name, "kind": "function", "line": line, "signature": f"{node.name}({', '.join(names)})"[:128]})
        elif isinstance(node, ast.ClassDef):
            symbols.append({"name": node.name, "kind": "class", "line": line})
        elif isinstance(node, ast.Import):
            imports.extend([[alias.name, 0, None] for alias in node.names])
        elif isinstance(node, ast.ImportFrom):
            imports.extend([[node.module or "", int(node.level), alias.name] for alias in node.names])
    note = f"Python symbol outline capped at {MAX_SYMBOLS} entries" if len(symbols) > MAX_SYMBOLS else None
    return symbols[:MAX_SYMBOLS], imports[:MAX_IMPORTS], _python_exports(tree), note


def _python_exports(tree: ast.Module) -> list[str]:
    explicit: list[str] = []
    for node in tree.body:
        if isinstance(node, ast.Assign):
            targets = node.targets
        elif isinstance(node, ast.AnnAssign):
            targets = [node.target]
        else:
            continue
        if any(isinstance(target, ast.Name) and target.id == "__all__" for target in targets):
            try:
                value = ast.literal_eval(node.value)
            except (ValueError, TypeError, SyntaxError):
                value = ()
            if isinstance(value, (list, tuple)):
                explicit = [item for item in value if isinstance(item, str)]
            break
    if explicit:
        return list(dict.fromkeys(explicit))[:MAX_SYMBOLS]
    names = [
        node.name for node in tree.body
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))
        and not node.name.startswith("_")
    ]
    return list(dict.fromkeys(names))[:MAX_SYMBOLS]
def _javascript_outline(text: str) -> tuple[list[dict[str, Any]], list[str]]:
    symbols: list[dict[str, Any]] = []
    for line, source in enumerate(text.splitlines(), 1):
        for expression, kind in JS_SYMBOLS:
            match = expression.search(source)
            if match:
                symbols.append({"name": match.group(1), "kind": kind, "line": line})
                break
        if len(symbols) == MAX_SYMBOLS:
            break
    return symbols, (JS_IMPORT.findall(text) + JS_CALL_IMPORT.findall(text))[:MAX_IMPORTS]


def _javascript_exports(text: str) -> list[str]:
    names = JS_EXPORT_DECL.findall(text)
    for group in JS_EXPORT_LIST.findall(text):
        for item in group.split(","):
            source = item.strip().split(" as ", 1)[0].strip()
            if re.fullmatch(r"[A-Za-z_$][\w$]*", source):
                names.append(source)
    return list(dict.fromkeys(names))[:MAX_SYMBOLS]
def _read_parse(info: dict[str, Any], remaining: int) -> tuple[dict[str, Any] | None, int, str | None]:
    fp = info["fingerprint"]
    if fp["size"] > MAX_FILE_BYTES:
        return None, 0, "source outline exceeds the 1 MiB file limit; file metadata retained"
    if fp["size"] > remaining:
        return None, 0, "64 MiB total read budget reached; file metadata retained"
    if remaining <= 0:
        return None, 0, "64 MiB total read budget reached; file metadata retained"
    limit = min(MAX_FILE_BYTES, remaining)
    try:
        with info["absolute"].open("rb") as source:
            data = source.read(limit + 1)
    except OSError:
        return None, 0, "unreadable files were skipped"
    consumed = len(data)
    if consumed > limit:
        current = _fingerprint(info["absolute"])
        if current and current["size"] > MAX_FILE_BYTES:
            return None, min(consumed, remaining), "source outline exceeds the 1 MiB file limit; file metadata retained"
        return None, min(consumed, remaining), "64 MiB total read budget reached; file metadata retained"
    if b"\0" in data:
        return None, consumed, "binary or non-UTF-8 files were skipped"
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        return None, consumed, "binary or non-UTF-8 files were skipped"
    if _fingerprint(info["absolute"]) != fp:
        return None, consumed, "changing files were skipped after re-stat"
    symbols: list[dict[str, Any]] = []
    imports: list[Any] = []
    note = None
    analysis = "metadata"
    exports: list[str] = []
    if info["language"] == "python":
        analysis = "python-ast"
        symbols, imports, exports, note = _python_outline(text)
    elif info["language"] in {"javascript", "typescript"}:
        analysis = "javascript-outline"
        symbols, imports = _javascript_outline(text)
        exports = _javascript_exports(text)
    entry = {
        "fingerprint": fp,
        "language": info["language"],
        "symbols": symbols,
        "imports": imports,
        "lines": len(text.splitlines()),
        "analysis": analysis,
        "exports": exports,
    }
    if note:
        entry["parse_note"] = note[:MAX_PARSE_NOTE_CHARS]
    return entry, consumed, note
def _python_modules(known: set[str]) -> dict[str, str | None]:
    modules: dict[str, str | None] = {}
    for path in known:
        if PurePosixPath(path).suffix not in {".py", ".pyw"}:
            continue
        parts = PurePosixPath(path).parts
        for offset in range(len(parts)):
            suffix = "/".join(parts[offset:])
            if suffix in modules and modules[suffix] != path:
                modules[suffix] = None
            else:
                modules[suffix] = path
    return modules


def _python_dep(path: str, module: str, level: int, imported: str | None, known: set[str], modules: dict[str, str | None] | None = None) -> str | None:
    source = PurePosixPath(path)
    base = source.parent
    for _ in range(max(0, level - 1)):
        base = base.parent
    if level == 0:
        base = PurePosixPath(module.replace(".", "/"))
    elif module:
        base /= module.replace(".", "/")
    candidates = []
    if imported and (module or level):
        candidates += [str(base / imported) + ext for ext in (".py", ".pyw", "/__init__.py")]
    if str(base) not in {"", "."}:
        candidates += [str(base) + ext for ext in (".py", ".pyw", "/__init__.py")]
    for candidate in candidates:
        normalized = PurePosixPath(candidate).as_posix()
        if normalized in known:
            return normalized
    if level == 0:
        for candidate in candidates:
            active = "src/" + PurePosixPath(candidate).as_posix()
            if active in known:
                return active
        lookup = _python_modules(known) if modules is None else modules
        for candidate in candidates:
            match = lookup.get(PurePosixPath(candidate).as_posix())
            if match:
                return match
    return None


def _config_relative(config_dir: PurePosixPath, value: Any) -> str | None:
    if not isinstance(value, str) or not value or len(value) > 512:
        return None
    candidate = posixpath.normpath(posixpath.join(config_dir.as_posix(), value))
    if candidate == ".." or candidate.startswith("../") or candidate.startswith("/"):
        return None
    return PurePosixPath(candidate).as_posix()


def _strip_jsonc(text: str) -> str:
    """Remove JSONC comments without interpreting config code."""
    output: list[str] = []
    index = 0
    in_string = False
    escaped = False
    while index < len(text):
        character = text[index]
        following = text[index + 1] if index + 1 < len(text) else ""
        if in_string:
            output.append(character)
            if escaped:
                escaped = False
            elif character == "\\":
                escaped = True
            elif character == '"':
                in_string = False
            index += 1
            continue
        if character == '"':
            in_string = True
            output.append(character)
            index += 1
        elif character == "/" and following == "/":
            index += 2
            while index < len(text) and text[index] not in "\r\n":
                index += 1
        elif character == "/" and following == "*":
            index += 2
            while index + 1 < len(text) and text[index:index + 2] != "*/":
                if text[index] in "\r\n":
                    output.append(text[index])
                index += 1
            index = min(len(text), index + 2)
        else:
            output.append(character)
            index += 1
    return re.sub(r",(\s*[}\]])", r"\1", "".join(output))


def _load_alias_configs(root: Path, candidates: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    configs: list[dict[str, Any]] = []
    cache: dict[str, dict[str, Any] | None] = {}
    reads = 0

    def load(rel: str, active: set[str]) -> dict[str, Any] | None:
        nonlocal reads
        if rel in active or len(active) >= MAX_ALIAS_EXTENDS_DEPTH:
            return None
        if rel in cache:
            return cache[rel]
        if rel not in candidates or reads >= MAX_ALIAS_READS:
            return None
        reads += 1
        info = candidates[rel]
        try:
            absolute = info["absolute"]
            if (absolute.resolve() != (root / rel).resolve() or not absolute.resolve().is_relative_to(root.resolve())
                    or info["fingerprint"]["size"] > MAX_ALIAS_CONFIG_BYTES):
                return None
            with absolute.open("rb") as source:
                data = source.read(MAX_ALIAS_CONFIG_BYTES + 1)
            if len(data) > MAX_ALIAS_CONFIG_BYTES or _fingerprint(absolute) != info["fingerprint"]:
                return None
            text = data.decode("utf-8")
            payload = json.loads(_strip_jsonc(text))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError, RecursionError, KeyError):
            return None
        if not isinstance(payload, dict):
            return None
        directory = PurePosixPath(rel).parent
        parent = None
        extends = payload.get("extends")
        if isinstance(extends, str) and (extends.startswith("./") or extends.startswith("../")):
            target = _config_relative(directory, extends)
            if target is not None:
                options = [target, target + ".json", posixpath.join(target, "tsconfig.json")]
                for option in options:
                    if option in candidates:
                        parent = load(option, active | {rel})
                        break
        compiler = payload.get("compilerOptions")
        if not isinstance(compiler, dict):
            compiler = {}
        base_url = parent["base_url"] if parent else None
        if "baseUrl" in compiler:
            base_url = _config_relative(directory, compiler["baseUrl"])
        paths = parent["paths"] if parent else []
        if isinstance(compiler.get("paths"), dict):
            paths = []
            paths_base = PurePosixPath(base_url) if base_url is not None else directory
            for pattern, targets in list(compiler["paths"].items())[:MAX_ALIAS_RULES]:
                if not isinstance(pattern, str) or not pattern or len(pattern) > 512 or pattern.count("*") > 1 or not isinstance(targets, list):
                    continue
                normalized = [target for target in (_config_relative(paths_base, value) for value in targets[:MAX_ALIAS_TARGETS]) if target is not None]
                if normalized:
                    paths.append((pattern, normalized))
        result = {"directory": directory.as_posix(), "base_url": base_url, "paths": paths}
        cache[rel] = result
        return result

    names = {"tsconfig.json", "jsconfig.json"}
    ordered = sorted(candidates, key=lambda rel: (len(PurePosixPath(rel).parts), rel))
    for rel in ordered:
        if len(configs) >= MAX_ALIAS_CONFIGS:
            break
        if PurePosixPath(rel).name.lower() in names:
            config = load(rel, set())
            if config and (config["base_url"] or config["paths"]):
                configs.append(config)
    return configs


def _alias_match(spec: str, pattern: str) -> str | None:
    if "*" not in pattern:
        return "" if spec == pattern else None
    prefix, suffix = pattern.split("*", 1)
    if not spec.startswith(prefix) or (suffix and not spec.endswith(suffix)):
        return None
    end = len(spec) - len(suffix) if suffix else len(spec)
    value = spec[len(prefix):end]
    return value if value else None


def _config_applies(config: dict[str, Any], path: str) -> bool:
    directory = config["directory"]
    parent = PurePosixPath(path).parent.as_posix()
    return directory in {"", "."} or parent == directory or parent.startswith(directory + "/")


def _javascript_candidates(base: str, known: set[str]) -> str | None:
    base = posixpath.normpath(base)
    if base == ".." or base.startswith("../") or base.startswith("/"):
        return None
    suffix = PurePosixPath(base).suffix.lower()
    extensions = (".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs", ".json")
    candidates: list[str] = []
    if suffix:
        stem = base[:-len(suffix)]
        if base in known:
            return base
        if suffix in {".js", ".jsx", ".mjs", ".cjs"}:
            candidates += [stem + ext for ext in extensions if ext != suffix]
        candidates.append(base)
    else:
        candidates += [base + ext for ext in extensions]
    candidates += [f"{base}/index{ext}" for ext in extensions]
    for candidate in candidates:
        normalized = PurePosixPath(candidate).as_posix()
        if normalized in known:
            return normalized
    return None


def _javascript_alias_dep(path: str, spec: str, known: set[str], configs: list[dict[str, Any]]) -> str | None:
    applicable = sorted(
        (config for config in configs if _config_applies(config, path)),
        key=lambda config: (len(config["directory"].split("/")), config["directory"]),
        reverse=True,
    )
    for config in applicable[:1]:
        rules = sorted(config["paths"], key=lambda item: ("*" not in item[0], len(item[0])), reverse=True)
        for pattern, targets in rules:
            wildcard = _alias_match(spec, pattern)
            if wildcard is None:
                continue
            for target in targets:
                candidate = target.replace("*", wildcard)
                dependency = _javascript_candidates(candidate, known)
                if dependency:
                    return dependency
        if config["base_url"]:
            dependency = _javascript_candidates(posixpath.join(config["base_url"], spec), known)
            if dependency:
                return dependency
    return None


def _javascript_dep(path: str, spec: str, known: set[str], configs: list[dict[str, Any]] | None = None) -> str | None:
    if not spec.startswith("."):
        if configs:
            return _javascript_alias_dep(path, spec, known, configs)
        return None
    spec = spec.split("?", 1)[0].split("#", 1)[0]
    base = posixpath.normpath(posixpath.join(PurePosixPath(path).parent.as_posix(), spec))
    return _javascript_candidates(base, known)


def _python_import_spec(module: str, level: int, imported: str | None) -> str:
    if level:
        return "." * level + (module or "")
    return module or imported or ""


def _bounded_git_output(root: Path, arguments: list[str], max_bytes: int) -> bytes | None:
    process: subprocess.Popen[bytes] | None = None
    selector: selectors.BaseSelector | None = None
    try:
        process = subprocess.Popen(
            ["git", "-C", str(root), *arguments],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
        )
        assert process.stdout is not None
        selector = selectors.DefaultSelector()
        selector.register(process.stdout, selectors.EVENT_READ)
        chunks: list[bytes] = []
        size = 0
        deadline = time.monotonic() + GIT_TIMEOUT
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise subprocess.TimeoutExpired("git log", GIT_TIMEOUT)
            if not selector.select(remaining):
                raise subprocess.TimeoutExpired("git log", GIT_TIMEOUT)
            block = os.read(process.stdout.fileno(), min(65536, max_bytes + 1 - size))
            if not block:
                break
            chunks.append(block)
            size += len(block)
            if size > max_bytes:
                process.kill()
                process.wait(timeout=1)
                return None
        data = b"".join(chunks)
        if len(data) > max_bytes:
            process.kill()
            process.wait(timeout=1)
            return None
        process.wait(timeout=max(0.0, deadline - time.monotonic()))
        return data if process.returncode == 0 else None
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


def _record(path: str, entry: dict[str, Any], known: set[str], aliases: list[dict[str, Any]] | None = None, changes: dict[str, str] | None = None, cochanges: dict[str, list[dict[str, Any]]] | None = None, modules: dict[str, str | None] | None = None, packages: dict[str, Any] | None = None) -> dict[str, Any]:
    dependencies: list[str] = []
    unresolved: list[str] = []
    if entry["language"] == "python":
        for module, level, imported in entry["imports"]:
            dep = _python_dep(path, module, level, imported, known, modules)
            if dep and dep != path and dep not in dependencies:
                dependencies.append(dep)
            elif not dep:
                spec = _python_import_spec(module, level, imported)
                if spec and spec not in unresolved:
                    unresolved.append(spec)
    elif entry["language"] in {"javascript", "typescript"}:
        for spec in entry["imports"]:
            dep = _javascript_dep(path, spec, known, aliases)
            if not dep and packages:
                dep = resolve_workspace_import(spec, known, packages, _javascript_candidates)
            if dep and dep != path and dep not in dependencies:
                dependencies.append(dep)
            elif not dep and spec not in unresolved:
                unresolved.append(spec)
    record = {
        "path": path,
        "language": entry["language"],
        "symbols": entry["symbols"][:MAX_SYMBOLS],
        "dependencies": dependencies[:MAX_DEPS],
        "lines": entry["lines"],
        "analysis": entry["analysis"],
        "exports": entry["exports"][:MAX_SYMBOLS],
        "unresolved_imports": unresolved[:MAX_DEPS],
        "changed": (changes or {}).get(path, ""),
        "cochanges": list((cochanges or {}).get(path, ()))[:MAX_COCHANGE_RESULTS],
    }
    if entry.get("parse_note"):
        record["outline_note"] = entry["parse_note"]
    return record
def _rank(records: list[dict[str, Any]], query: str) -> list[dict[str, Any]]:
    terms = re.findall(r"[a-z0-9_]+", query.lower())
    by_path = {record["path"]: record for record in records}
    reverse = {path: set() for path in by_path}
    for record in records:
        for dependency in record["dependencies"]:
            if dependency in reverse:
                reverse[dependency].add(record["path"])
    scores: dict[str, int] = {}
    base_scores: dict[str, int] = {}
    for path, record in by_path.items():
        names = " ".join(symbol["name"] + " " + symbol.get("signature", "") for symbol in record["symbols"]).lower()
        score = sum(5 for term in terms if term in path.lower()) + sum(4 for term in terms if term in names)
        if not terms and _entry_config(path):
            score += 6
        base_scores[path] = score
        degree = len(record.get("dependencies", ())) + len(reverse[path])
        score += min(2, (degree + 3) // 4)
        if record.get("changed") in {"added", "modified", "untracked", "renamed"}:
            score += 1
        scores[path] = score
    matched = [path for path, score in base_scores.items() if score]
    for path in matched:
        for neighbor in set(by_path[path]["dependencies"]) | reverse[path]:
            if neighbor in scores:
                scores[neighbor] = max(scores[neighbor], 2)
        for cochange in by_path[path].get("cochanges", ()):
            neighbor = cochange.get("path") if isinstance(cochange, dict) else None
            if neighbor in scores:
                scores[neighbor] = max(scores[neighbor], 1)
    return sorted(records, key=lambda record: (-scores[record["path"]], not _entry_config(record["path"]), record["path"]))
def _note(notes: list[str], value: str) -> None:
    if value and value not in notes:
        notes.append(value)
def _valid_fp(value: Any) -> bool:
    return isinstance(value, dict) and all(isinstance(value.get(key), int) and value[key] >= 0 for key in ("ctime_ns", "inode", "size", "mtime_ns"))


def _valid_entry(value: Any) -> bool:
    if not isinstance(value, dict) or set(value) - {"fingerprint", "language", "symbols", "imports", "parse_note", "lines", "analysis", "exports"}:
        return False
    if not _valid_fp(value.get("fingerprint")) or not isinstance(value.get("language"), str):
        return False
    if not isinstance(value.get("lines"), int) or value["lines"] < 0:
        return False
    if value.get("analysis") not in ANALYSIS_KINDS:
        return False
    expected_analysis = {
        "python": "python-ast",
        "javascript": "javascript-outline",
        "typescript": "javascript-outline",
    }.get(value["language"], "metadata")
    if value["analysis"] != expected_analysis:
        return False
    if "parse_note" in value and (
        not isinstance(value["parse_note"], str)
        or not value["parse_note"]
        or len(value["parse_note"]) > MAX_PARSE_NOTE_CHARS
    ):
        return False
    if not isinstance(value.get("symbols"), list) or len(value["symbols"]) > MAX_SYMBOLS:
        return False
    for symbol in value["symbols"]:
        if not isinstance(symbol, dict) or set(symbol) - {"name", "kind", "line", "signature"}:
            return False
        if not isinstance(symbol.get("name"), str) or not isinstance(symbol.get("kind"), str) or not isinstance(symbol.get("line"), int):
            return False
        if "signature" in symbol and not isinstance(symbol["signature"], str):
            return False
    exports = value.get("exports")
    if not isinstance(exports, list) or len(exports) > MAX_SYMBOLS or not all(isinstance(item, str) for item in exports):
        return False
    imports = value.get("imports")
    if not isinstance(imports, list) or len(imports) > MAX_IMPORTS:
        return False
    if value["language"] == "python":
        return all(isinstance(item, list) and len(item) == 3 and isinstance(item[0], str) and isinstance(item[1], int) and item[1] >= 0 and (item[2] is None or isinstance(item[2], str)) for item in imports)
    return all(isinstance(item, str) for item in imports)
def _cache_location(root: Path, write: bool) -> tuple[Path, Path]:
    try:
        state, _ = _state_paths()
        try:
            resolved_state = state.resolve(strict=False)
        except RuntimeError:
            resolved_state = state
        try:
            resolved_state.relative_to(root)
        except ValueError:
            pass
        else:
            raise CodeMapError(f"refusing code-map cache inside repository: {state}")
        _reject_symlink_chain(state, "state parent")
        if state.exists() and not state.is_dir():
            raise CodeMapError(f"state path is not a directory: {state}")
        directory = state / "code-map"
        try:
            resolved_directory = directory.resolve(strict=False)
        except RuntimeError:
            resolved_directory = directory
        try:
            resolved_directory.relative_to(root)
        except ValueError:
            pass
        else:
            raise CodeMapError(f"refusing code-map cache inside repository: {directory}")
        if directory.exists() and (directory.is_symlink() or not directory.is_dir()):
            raise CodeMapError(f"refusing unsafe code-map cache directory: {directory}")
        if write:
            state.mkdir(parents=True, exist_ok=True)
            _reject_symlink_chain(state, "state parent")
            directory.mkdir(exist_ok=True)
            _reject_symlink_chain(directory, "code-map cache parent")
        elif not directory.exists():
            return directory, directory / (hashlib.sha256(str(root).encode()).hexdigest() + ".json")
        path = directory / (hashlib.sha256(str(root).encode()).hexdigest() + ".json")
        if path.is_symlink() or (path.exists() and not path.is_file()):
            raise CodeMapError(f"refusing unsafe code-map cache: {path}")
        return directory, path
    except CodeMapError:
        raise
    except (OSError, ValueError) as exc:
        raise CodeMapError(f"code-map cache unavailable: {exc}") from exc
def _load_entries(root: Path, candidates: dict[str, dict[str, Any]]) -> tuple[dict[str, Any], str | None]:
    try:
        _, path = _cache_location(root, False)
    except CodeMapError as exc:
        return {}, str(exc)
    if not path.exists():
        return {}, None
    try:
        if path.stat().st_size > 8 * 1024 * 1024:
            return {}, "code-map cache is too large"
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        return {}, f"code-map cache is invalid: {exc}"
    if not isinstance(payload, dict):
        return {}, "code-map cache has an unsupported shape"
    version = payload.get("version")
    if version != CACHE_VERSION:
        if isinstance(version, int) and 0 <= version < CACHE_VERSION:
            return {}, "code-map cache requires migration"
        return {}, "code-map cache has an unsupported shape"
    raw = payload.get("entries")
    if not isinstance(raw, dict):
        return {}, "code-map cache entries are invalid"
    reusable: dict[str, Any] = {}
    for path_name, entry in raw.items():
        current = candidates.get(path_name)
        if isinstance(path_name, str) and current and _valid_entry(entry) and entry["fingerprint"] == current["fingerprint"] and entry["language"] == current["language"]:
            reusable[path_name] = entry
    return reusable, None
def _write_json(root: Path, entries: dict[str, Any]) -> None:
    directory, path = _cache_location(root, True)
    if path.exists() and path.is_symlink():
        raise CodeMapError(f"refusing symlink code-map cache: {path}")
    encoded = json.dumps({"version": CACHE_VERSION, "entries": entries}, ensure_ascii=True, separators=(",", ":"))
    if len(encoded.encode("utf-8")) > 8 * 1024 * 1024:
        raise CodeMapError("code-map cache exceeds 8 MiB")
    temporary: Path | None = None
    try:
        if path.exists() and path.stat().st_size == len(encoded) and path.read_bytes() == encoded.encode("utf-8"):
            return
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=directory, prefix=".code-map-", suffix=".tmp", delete=False) as handle:
            temporary = Path(handle.name)
            handle.write(encoded)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
        temporary = None
    except OSError as exc:
        raise CodeMapError(f"could not write code-map cache: {exc}") from exc
    finally:
        if temporary:
            try:
                temporary.unlink()
            except OSError:
                pass
def _build(root: Path, head: str, inventory: list[str], notes: list[str], query: str, max_files: int, use_cache: bool, refresh: bool) -> dict[str, Any]:
    candidates: dict[str, dict[str, Any]] = {}
    skipped = 0
    excluded = 0
    excluded_reasons: dict[str, int] = {}
    for rel in inventory:
        candidate, reason = _candidate(root, rel, git_inventory=True)
        if candidate:
            candidates[rel] = candidate
        else:
            exclusion = _exclusion_reason(rel, reason)
            if exclusion:
                excluded += 1
                excluded_reasons[exclusion] = excluded_reasons.get(exclusion, 0) + 1
            else:
                skipped += 1
                _note(notes, reason or "inventory entry skipped")
    terms = re.findall(r"[a-z0-9_]+", query.lower())
    order = sorted(candidates, key=lambda path: (
        -sum(term in path.lower() for term in terms), not _entry_config(path),
        any(part.lower() in {"test", "tests"} for part in PurePosixPath(path).parts), path,
    ))
    inventory_capped = len(order) > MAX_FILES
    if inventory_capped:
        skipped += len(order) - MAX_FILES
        _note(notes, f"file inventory cap reached at {MAX_FILES} files")
        order = order[:MAX_FILES]
        candidates = {path: candidates[path] for path in order}
    cached, cache_note = ({}, None) if (refresh or not use_cache) else _load_entries(root, candidates)
    if cache_note and "invalid" in cache_note.lower():
        _note(notes, "invalid cache entries were reparsed")
    elif cache_note and "requires migration" not in cache_note.lower():
        _note(notes, cache_note)
    entries: dict[str, Any] = {}
    reusable: dict[str, Any] = {}
    remaining = MAX_READ_BYTES
    pending = 0
    limited = 0
    for rel in order:
        info = candidates[rel]
        entry = cached.get(rel)
        if entry is None:
            entry, consumed, parse_note = _read_parse(info, remaining)
            remaining = max(0, remaining - consumed)
            if parse_note:
                _note(notes, parse_note)
            if entry is None:
                bounded = parse_note and ("read budget" in parse_note or "file limit" in parse_note)
                if not bounded:
                    skipped += 1
                    continue
                pending += int("read budget" in parse_note)
                limited += 1
                entry = {
                    "fingerprint": info["fingerprint"], "language": info["language"],
                    "symbols": [], "imports": [], "lines": 0, "analysis": "metadata", "exports": [],
                    "parse_note": parse_note,
                }
            else:
                reusable[rel] = entry
        else:
            reusable[rel] = entry
            if entry.get("parse_note"):
                _note(notes, entry["parse_note"])
        entries[rel] = entry
    budget_hit = bool(limited) or inventory_capped
    known = set(entries)
    aliases = _load_alias_configs(root, candidates)
    packages = load_workspace_packages(root, candidates)
    branch, changes, git_state_note = _git_state(root)
    if git_state_note:
        _note(notes, git_state_note)
    cochanges = _cochanges(root, head, known)
    modules = _python_modules(known)
    records = [_record(path, entry, known, aliases, changes, cochanges, modules, packages) for path, entry in entries.items()]
    ranked = _rank(records, query)
    file_cap = len(ranked) > max_files
    truncated = file_cap or budget_hit
    if file_cap:
        skipped += len(ranked) - max_files
        _note(notes, f"file cap reached at {max_files} files")
    if any(info["language"] in {"python", "javascript", "typescript"} for info in candidates.values()):
        _note(notes, "Python and JavaScript/TypeScript import links are heuristic and incomplete; aliases, dynamic imports, and unresolved modules need native search")
    selected = sorted(ranked[:max_files], key=lambda record: record["path"])
    model = {
        "root_name": repository_name(root),
        "generated_at": _now(),
        "head": head,
        "coverage": {
            "inventory": len(inventory), "indexed": len(selected), "truncated": truncated,
            "skipped": skipped, "excluded": excluded, "excluded_reasons": excluded_reasons,
            "pending": pending, "limited": limited,
            "notes": notes[:24],
        },
        "files": selected,
        "focus": [record["path"] for record in _rank(selected, query)[:12]],
    }
    if branch:
        model["branch"] = branch
    if use_cache:
        try:
            _write_json(root, {path: reusable[path] for path in sorted(reusable)})
        except CodeMapError as exc:
            _note(model["coverage"]["notes"], f"cache unavailable: {exc}")
    return model


def _text(model: dict[str, Any], limit: int) -> str:
    coverage = model["coverage"]
    notes = coverage.get("notes", [])
    if not isinstance(notes, list):
        notes = []
    partial = bool(coverage.get("truncated")) or bool(coverage.get("skipped")) or any(
        "import links are heuristic" not in note for note in notes if isinstance(note, str)
    )
    lines = [
        f"Code map: {json.dumps(model['root_name'], ensure_ascii=True)}",
        f"Head: {model['head'] or '(unavailable)' }",
        f"Coverage: {coverage.get('indexed', 0)}/{coverage.get('inventory', 0)} files indexed; "
        f"{coverage.get('excluded', 0)} excluded; {coverage.get('skipped', 0)} skipped; "
        f"{'partial' if partial else 'complete'}",
        "Source confirmation: metadata only; inspect listed files before changing behavior.",
        "Focus:",
    ]
    excluded_reasons = coverage.get("excluded_reasons", {})
    if isinstance(excluded_reasons, dict) and excluded_reasons:
        summary = ", ".join(f"{count} {reason}" for reason, count in sorted(excluded_reasons.items()))
        lines.append("Excluded: " + summary)
    by_path = {file["path"]: file for file in model["files"]}
    for path in model["focus"]:
        file = by_path.get(path)
        if not file:
            continue
        symbol_values = file["symbols"][:8]
        symbols = ", ".join((symbol.get("signature") or symbol["name"]) + f" ({symbol['kind']}:{symbol['line']})" for symbol in symbol_values)
        if len(file["symbols"]) > len(symbol_values):
            symbols += f" (+{len(file['symbols']) - len(symbol_values)} more symbols)"
        dependency_values = file["dependencies"][:12]
        dependencies = ", ".join(json.dumps(dep, ensure_ascii=True) for dep in dependency_values)
        if len(file["dependencies"]) > len(dependency_values):
            dependencies += f" (+{len(file['dependencies']) - len(dependency_values)} more deps)"
        line = f"- {json.dumps(path, ensure_ascii=True)} [{file['language']}]"
        if symbols:
            line += " symbols: " + symbols
        if dependencies:
            line += " deps: " + dependencies
        lines.append(line)
    if notes:
        lines.append("Notes: " + "; ".join(notes))
    value = "\n".join(lines)
    if len(value) <= limit:
        return value
    suffix = "\n[output truncated; inspect JSON or the live viewer for the bounded full map]"
    return (value[: max(0, limit - len(suffix))] + suffix)[-limit:]
def build_map(repo: str | os.PathLike[str], *, query: str = "", max_chars: int = DEFAULT_MAX_CHARS, max_files: int = DEFAULT_MAX_FILES, no_cache: bool = False, refresh: bool = False, output_format: str = "text") -> tuple[dict[str, Any], str]:
    if output_format not in {"text", "json"}:
        raise CodeMapError(f"unsupported output format: {output_format}")
    root_input = _repo_path(repo)
    root, head, inventory, notes = _git_context(root_input)
    model = _build(root, head, inventory, notes, query, _clamp(int(max_files), 1, MAX_FILES), not no_cache, refresh)
    max_chars = _clamp(int(max_chars), 500, MAX_CHARS)
    if output_format == "text":
        return model, _text(model, max_chars)
    if output_format == "json":
        return model, json.dumps(model, ensure_ascii=True, separators=(",", ":"))
    raise CodeMapError("unsupported output format")
def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Create a bounded repository code map")
    parser.add_argument("--repo", required=True, metavar="PATH")
    parser.add_argument("--query", default="", metavar="TEXT")
    parser.add_argument("--format", choices=("text", "json", "html"), default="text")
    parser.add_argument("--no-cache", action="store_true")
    parser.add_argument("--refresh", action="store_true")
    parser.add_argument("--open", action="store_true", dest="open_html")
    parser.add_argument("--max-chars", type=int, default=DEFAULT_MAX_CHARS)
    parser.add_argument("--max-files", type=int, default=DEFAULT_MAX_FILES)
    return parser
def _server_api():
    try:
        from . import map_server
    except ImportError:
        import map_server
    return map_server


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    if args.format == "html" and args.no_cache:
        print("the live viewer requires a local service and cannot be combined with --no-cache", file=sys.stderr)
        return 2
    try:
        if args.format == "html":
            url = _server_api().open_map(args.repo, query=args.query, open_browser=args.open_html)
            sys.stdout.write(url + "\n")
            return 0
        if args.no_cache:
            model, rendered = build_map(args.repo, query=args.query, max_chars=args.max_chars, max_files=args.max_files, no_cache=True, refresh=args.refresh, output_format=args.format)
        else:
            try:
                model = _server_api().get_model(args.repo, query=args.query, max_files=_clamp(args.max_files, 1, MAX_FILES), refresh=args.refresh)
            except (OSError, ValueError, ImportError) as exc:
                print(f"local viewer unavailable; using an in-process map: {exc}", file=sys.stderr)
                model, _ = build_map(args.repo, query=args.query, max_files=args.max_files, refresh=args.refresh)
            rendered = _text(model, _clamp(args.max_chars, 500, MAX_CHARS)) if args.format == "text" else json.dumps(model, ensure_ascii=True, separators=(",", ":"))
        sys.stdout.write(rendered)
        return 0
    except (CodeMapError, OSError, ValueError, ImportError) as exc:
        print(f"code-map error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
