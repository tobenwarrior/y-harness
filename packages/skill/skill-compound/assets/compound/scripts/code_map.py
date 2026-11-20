#!/usr/bin/env python3
"""Build a bounded repository map from Git's current file inventory."""

from __future__ import annotations

import argparse
import contextlib
import ast
import datetime as dt
import functools
import hashlib
import json
import math
import os
import posixpath
import re
import stat
import sys
import tempfile
import unicodedata
from collections import Counter
from pathlib import Path, PurePosixPath
from typing import Any, Callable, Iterator
try:
    from .onboarding import _reject_symlink, _state_paths
    from .workspace_imports import (
        MAX_PACKAGE_FILES,
        load_workspace_aliases,
        load_workspace_packages,
        resolve_workspace_alias,
        resolve_workspace_import,
    )
    from .language_outlines import SUPPORTED_LANGUAGES, javascript_exports, javascript_outline, mask_javascript, outline as _language_outline, split_lines
    from .safe_open import open_regular_nofollow, open_regular_files_nofollow
    from .language_imports import extract_language_metadata, build_local_import_index, resolve_go_import, resolve_rust_import, rust_module_dependencies, _sanitize_metadata
    # map_server and the lookup scripts also read inventory names through this module.
    from .map_inventory import (
        CONFIG_NAMES, GIT_TIMEOUT, INVENTORY_CAP_NOTE, LANGUAGES, MAX_COCHANGE_RESULTS, UNTRACKED_INVENTORY_NOTE,
        _bounded_git_output, _candidate, _cochanges, _exclusion_reason, _fingerprint, _git_context, _git_inventory,
        _git_inventory_parts, _git_root, _git_state, _git_status_snapshot, _has_symlink_ancestor, _language,
        _name_and_suffix, _parse_git_state, _private, _safe_relative, _skip_dir, repository_name,
    )
except ImportError:  # direct script execution
    from onboarding import _reject_symlink, _state_paths
    from workspace_imports import (
        MAX_PACKAGE_FILES,
        load_workspace_aliases,
        load_workspace_packages,
        resolve_workspace_alias,
        resolve_workspace_import,
    )
    from language_outlines import SUPPORTED_LANGUAGES, javascript_exports, javascript_outline, mask_javascript, outline as _language_outline, split_lines
    from safe_open import open_regular_nofollow, open_regular_files_nofollow
    from language_imports import extract_language_metadata, build_local_import_index, resolve_go_import, resolve_rust_import, rust_module_dependencies, _sanitize_metadata
    from map_inventory import (
        CONFIG_NAMES, GIT_TIMEOUT, INVENTORY_CAP_NOTE, LANGUAGES, MAX_COCHANGE_RESULTS, UNTRACKED_INVENTORY_NOTE,
        _bounded_git_output, _candidate, _cochanges, _exclusion_reason, _fingerprint, _git_context, _git_inventory,
        _git_inventory_parts, _git_root, _git_state, _git_status_snapshot, _has_symlink_ancestor, _language,
        _name_and_suffix, _parse_git_state, _private, _safe_relative, _skip_dir, repository_name,
    )

DEFAULT_MAX_CHARS = 2500
MAX_CHARS = 12000
TOPIC_DETAIL_ROWS = 4
DEFAULT_MAX_FILES = 2000
MAX_FILES = 20000
MAX_FILE_BYTES = 1024 * 1024
MAX_READ_BYTES = 64 * 1024 * 1024
MAX_SYMBOLS = 512
MAX_QUALIFIED_NAME_CHARS = 128
MAX_DEPS = 256
MAX_IMPORTS = MAX_DEPS * 2
MAX_PARSE_NOTE_CHARS = 160
CACHE_VERSION = 16
ANALYSIS_KINDS = {"python-ast", "javascript-outline", "heuristic-outline", "metadata"}
MAX_CACHE_BYTES = 8 * 1024 * 1024
STDLIB_MODULES = frozenset(sys.stdlib_module_names)
PYTHON_VERSION = f"{sys.version_info[0]}.{sys.version_info[1]}"
OUTLINED_LANGUAGES = {"python", "javascript", "typescript", *SUPPORTED_LANGUAGES}
# Query words that name no file: English function words and verbs that describe any change.
QUERY_STOP_WORDS = frozenset("""
a about after again all also am an and any are as at be because been before being both but by can could did do does doing
during each for from further had has have having here how if in into is it its itself just more most no nor not now of off
on once only or other our out over own same should so some such than that the their them then there these they this those
through to too under until up very was we were what when where which while who why will with would you your
fix fixes fixed add adds added update updates updated remove removes removed use uses used using support supports allow allows
make makes change changes changed improve improves feat chore refactor perf wip revert bump typo typos minor
""".split())
QUERY_TEST_WORDS = frozenset({"test", "tests", "testing", "spec", "specs"})
TEST_DIRS = frozenset({"test", "tests", "__tests__", "spec", "specs", "e2e"})
TEST_FILE = re.compile(r"^test_.*\.py$|^conftest\.py$|_test\.[a-z0-9]+$|\.(?:test|spec)\.[a-z0-9]+$")
IDENTIFIER = re.compile(r"[A-Za-z0-9_]+")
IDENTIFIER_BYTE_TABLE = bytes(value if IDENTIFIER.fullmatch(chr(value)) else 32 for value in range(256))
UNICODE_IDENTIFIER = re.compile(r"[A-Za-z0-9_\u0080-\U0010FFFF]+")
WORD_PART = re.compile(r"[A-Z]+(?![a-z])|[A-Z]?[a-z]+|[0-9]+")
# Focus weights were tuned on recent Flask, click and Hono commits; the README reports other commits.
CONTENT_WEIGHT = 0.5
SIZE_WEIGHT = 0.3
IMPORTER_WEIGHT = 0.3
TEST_FACTOR = 0.45
CONTENT_RANK_FILES = 50
CONTENT_FALLBACK_FILES = 200
CONTENT_RANK_BYTES = 8 * 1024 * 1024
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


@functools.lru_cache(maxsize=MAX_FILES)
def _entry_config(rel: str) -> bool:
    name = PurePosixPath(rel).name.lower()
    return name in CONFIG_NAMES or name == "dockerfile" or name.startswith("dockerfile.")


def _python_outline(text: str) -> tuple[list[dict[str, Any]], list[list[Any]], list[str], str | None]:
    try:
        tree = ast.parse(text)
    except (SyntaxError, ValueError, TypeError, RecursionError, MemoryError):
        # Valid but deeply nested generated code can exhaust the parser's recursion or stack limits.
        return [], [], [], "Python file could not be parsed"
    symbols: list[dict[str, Any]] = []
    imports: list[list[Any]] = []
    extra_names: list[list[Any]] = []
    scopes: list[tuple[int, str | None]] = []
    for node in sorted(ast.walk(tree), key=lambda item: getattr(item, "lineno", 0)):
        line = int(getattr(node, "lineno", 1))
        if isinstance(node, (ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
            while scopes and line > scopes[-1][0]:
                scopes.pop()
            owner = scopes[-1][1] if scopes else ""
            qualified = f"{owner}.{node.name}" if owner else node.name
            if owner is None or len(qualified) > MAX_QUALIFIED_NAME_CHARS:
                qualified = None
            is_class = isinstance(node, ast.ClassDef)
            symbol = {"name": node.name, "kind": "class" if is_class else "function", "line": line}
            if qualified and owner:
                symbol["qualified_name"] = qualified
            # Functions end the dotted class namespace, including any classes local to them.
            scopes.append((node.end_lineno or line, qualified if is_class else None))
            if not isinstance(node, ast.ClassDef):
                args = list(node.args.posonlyargs) + list(node.args.args) + list(node.args.kwonlyargs)
                names = [arg.arg for arg in args]
                if node.args.vararg:
                    names.append("*" + node.args.vararg.arg)
                if node.args.kwarg:
                    names.append("**" + node.args.kwarg.arg)
                symbol["signature"] = f"{node.name}({', '.join(names)})"[:128]
            symbols.append(symbol)
        elif isinstance(node, ast.Import):
            imports.extend([[alias.name, 0, None] for alias in node.names])
        elif isinstance(node, ast.ImportFrom):
            # The first name of each statement comes first, so one long name list cannot crowd out later modules.
            names = [[node.module or "", int(node.level), alias.name] for alias in node.names]
            imports.append(names[0])
            extra_names.extend(names[1:])
    imports += extra_names
    notes = [f"Python symbol outline capped at {MAX_SYMBOLS} entries" if len(symbols) > MAX_SYMBOLS else "",
             f"local import links capped at {MAX_IMPORTS} import entries" if len(imports) > MAX_IMPORTS else ""]
    return symbols[:MAX_SYMBOLS], imports[:MAX_IMPORTS], _python_exports(tree), "; ".join(filter(None, notes)) or None


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
    """Symbols and imports of raw JS/TS text, in the shape Y Harness's vendored tests call."""
    return javascript_outline(mask_javascript(text), MAX_IMPORTS)[:2]


def _open_source(root: Path, relative: str) -> int:
    """Return a read-only descriptor for an indexed file without following symlinks."""
    if os.name == "posix" and hasattr(os, "O_NOFOLLOW") and os.open in getattr(os, "supports_dir_fd", ()):
        return open_regular_nofollow(root, relative)
    return os.open(root / relative, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))


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
        root = Path(info["absolute"])
        for _ in PurePosixPath(info["path"]).parts:
            root = root.parent
        with os.fdopen(_open_source(root, info["path"]), "rb") as source:
            opened = os.fstat(source.fileno())
            if not stat.S_ISREG(opened.st_mode) or any(
                getattr(opened, attr) != fp[key]
                for key, attr in (("size", "st_size"), ("inode", "st_ino"), ("mtime_ns", "st_mtime_ns"), ("ctime_ns", "st_ctime_ns"))
            ):
                return None, 0, "changing files were skipped after re-stat"
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
        # utf-8-sig drops a byte-order mark, which would otherwise hide line-1 declarations.
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError:
        return None, consumed, "binary or non-UTF-8 files were skipped"
    if _fingerprint(info["absolute"]) != fp:
        return None, consumed, "changing files were skipped after re-stat"
    symbols: list[dict[str, Any]] = []
    imports: list[Any] = []
    note = None
    analysis = "metadata"
    exports: list[str] = []
    try:
        if info["language"] == "python":
            analysis = "python-ast"
            symbols, imports, exports, note = _python_outline(text)
        elif info["language"] in {"javascript", "typescript"}:
            analysis = "javascript-outline"
            code = mask_javascript(text)
            symbols, imports, note = javascript_outline(code, MAX_IMPORTS)
            exports = javascript_exports(code)
        elif info["language"] in SUPPORTED_LANGUAGES:
            analysis = "heuristic-outline"
            symbols, note = _language_outline(text, info["language"], MAX_SYMBOLS)
    except Exception:  # One unusual file must not fail the whole map.
        symbols, imports, exports, note = [], [], [], "file analysis failed; file metadata retained"
    entry = {
        "fingerprint": fp,
        "language": info["language"],
        "symbols": symbols,
        "imports": imports,
        "lines": len(split_lines(text)),
        "analysis": analysis,
        "exports": exports,
    }
    if info["language"] in {"go", "rust"} or PurePosixPath(info["path"]).name == "go.mod":
        entry["native_imports"] = extract_language_metadata(info["path"], text)
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
    candidates: list[str] = []
    dotted: list[str] = []  # candidates whose module path has at least two segments
    if imported and (module or level):
        candidates += [PurePosixPath(str(base / imported) + ext).as_posix() for ext in (".py", ".pyw", "/__init__.py")]
        dotted += candidates
    if str(base) not in {"", "."}:
        names = [PurePosixPath(str(base) + ext).as_posix() for ext in (".py", ".pyw", "/__init__.py")]
        candidates += names
        dotted += names if "." in module else []
    for candidate in candidates:
        if candidate in known:
            return candidate
    if level == 0:
        for candidate in candidates:
            if "src/" + candidate in known:
                return "src/" + candidate
        # Unanchored matches would tie stdlib or third-party names such as json or celery to unrelated local files.
        if module.split(".")[0] in STDLIB_MODULES:
            return None
        directory = source.parent
        while directory != directory.parent:
            # Scripts and nested projects import from non-package folders above them (and their src/).
            if (directory / "__init__.py").as_posix() not in known:
                for prefix in (directory, directory / "src"):
                    for candidate in candidates:
                        if (prefix / candidate).as_posix() in known:
                            return (prefix / candidate).as_posix()
            directory = directory.parent
        lookup = _python_modules(known) if modules is None else modules
        for candidate in dotted:
            match = lookup.get(candidate)
            if match:
                return match
    return None


def _load_alias_configs(root: Path, candidates: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    return load_workspace_aliases(root, candidates, _fingerprint)


def _javascript_candidates(base: str, known: set[str]) -> str | None:
    base = posixpath.normpath(base)
    if base == ".." or base.startswith("../") or base.startswith("/"):
        return None
    if base in known:
        return base
    suffix = PurePosixPath(base).suffix.lower()
    extensions = (".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs", ".json")
    candidates: list[str] = []
    if suffix in {".js", ".jsx", ".mjs", ".cjs"}:
        candidates += [base[:-len(suffix)] + ext for ext in extensions if ext != suffix]
    if suffix not in extensions:
        # Resolvers append extensions to dotted names such as ./app.module or ./vite.config.
        candidates += [base + ext for ext in extensions]
    candidates += [f"{base}/index{ext}" for ext in extensions]
    for candidate in candidates:
        normalized = PurePosixPath(candidate).as_posix()
        if normalized in known:
            return normalized
    return None


def _javascript_dep(path: str, spec: str, known: set[str], configs: list[dict[str, Any]] | None = None) -> str | None:
    if not spec.startswith("."):
        if configs:
            return resolve_workspace_alias(path, spec, known, configs, _javascript_candidates)
        return None
    spec = spec.split("?", 1)[0].split("#", 1)[0]
    base = posixpath.normpath(posixpath.join(PurePosixPath(path).parent.as_posix(), spec))
    return _javascript_candidates(base, known)


def _python_import_spec(module: str, level: int, imported: str | None) -> str:
    if level:
        return "." * level + (module or "")
    return module or imported or ""


def _record(path: str, entry: dict[str, Any], known: set[str], aliases: list[dict[str, Any]] | None = None, changes: dict[str, str] | None = None, cochanges: dict[str, list[dict[str, Any]]] | None = None, modules: dict[str, str | None] | None = None, packages: dict[str, Any] | None = None, native_index: dict[str, Any] | None = None) -> dict[str, Any]:
    dependencies: list[str] = []
    unresolved: list[str] = []
    native_capped = False
    if entry["language"] == "python":
        for module, level, imported in entry["imports"]:
            dep = _python_dep(path, module, level, imported, known, modules)
            if dep and dep != path and dep not in dependencies:
                dependencies.append(dep)
            elif not dep or dep == path and not level:  # an absolute import of itself names another package
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
    elif entry["language"] in {"go", "rust"} and native_index:
        metadata = entry.get("native_imports", {})
        specs = metadata.get("go_imports", []) if entry["language"] == "go" else metadata.get("rust_uses", [])
        if entry["language"] == "rust":
            dependencies.extend(rust_module_dependencies(path, native_index))
        seen_dependencies = set(dependencies)
        for spec in specs:
            targets = resolve_go_import(spec, path, native_index) if entry["language"] == "go" else resolve_rust_import(spec, path, native_index)
            if targets:
                for dep in targets:
                    if dep in seen_dependencies:
                        continue
                    if len(dependencies) >= MAX_DEPS:
                        native_capped = True
                        break
                    seen_dependencies.add(dep)
                    dependencies.append(dep)
                if native_capped:
                    break
            elif spec not in unresolved:
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
    if native_capped or len(dependencies) > MAX_DEPS:
        record["outline_note"] = "; ".join(filter(None, (record.get("outline_note"), f"local import links capped at {MAX_DEPS}")))
    if "source_limit" in entry.get("native_imports", {}).get("diagnostics", ()):
        record["outline_note"] = "; ".join(filter(None, (record.get("outline_note"), "local import links read from the first 256 KiB")))
    return record
def _identifier_tokens(text: str) -> list[str]:
    if text.isascii():
        return IDENTIFIER.findall(text)
    # Python symbols are NFKC-normalized. Keep identifier continuation marks
    # that a regex using Unicode word characters would split off.
    text = unicodedata.normalize("NFKC", text)
    separators = {ord(char): " " for char in set(text) if not char.isascii() and not ("_" + char).isidentifier()}
    return UNICODE_IDENTIFIER.findall(text.translate(separators))


def _identifier_words(tokens: list[str]) -> Iterator[str]:
    for token in tokens:
        for chunk in token.split("_"):
            if chunk.isascii():
                yield from (part.lower() for part in WORD_PART.findall(chunk))
            else:
                yield chunk.casefold()


def _word_parts(text: str) -> set[str]:
    """Keep ASCII navigation terms and add whole normalized Unicode identifier parts."""
    parts = {part.lower() for token in set(IDENTIFIER.findall(text)) for chunk in token.split("_")
             for part in WORD_PART.findall(chunk)}
    if not text.isascii():
        parts.update(_identifier_words(_identifier_tokens(text)))
    return parts


@functools.lru_cache(maxsize=1 << 16)
def _stem(word: str) -> str:
    """Fold common English endings so handler, handles and handling, or cookie and cookies, compare equal."""
    if len(word) <= 3 or not word.isascii():
        return word
    if word.endswith("ies") and len(word) > 4:
        word = word[:-3] + "i"
    elif word.endswith("sses"):
        word = word[:-2]
    elif word.endswith("s") and not word.endswith(("ss", "us", "is")):
        word = word[:-1]
    if word.endswith("ing") and len(word) > 5:
        word = word[:-3]
    elif word.endswith("ed") and len(word) > 4:
        word = word[:-2]
    if word.endswith("er") and len(word) > 4:
        word = word[:-2]
    if word.endswith("y") and len(word) > 3:
        word = word[:-1] + "i"
    if word.endswith("e") and len(word) > 3:
        word = word[:-1]
    return word


@functools.lru_cache(maxsize=1 << 16)
def _name_terms(name: str) -> frozenset[str]:
    parts = _word_parts(name)
    if name.isascii() and name.isalnum():
        parts.add(name.lower())
    return frozenset(_stem(part) for part in parts)


@functools.lru_cache(maxsize=MAX_FILES)
def _symbol_name_terms(names: tuple[str, ...]) -> frozenset[str]:
    """Reuse a bounded symbol vocabulary while its names are unchanged."""
    return frozenset().union(*(_name_terms(name) for name in names))



def _path_terms(path: str) -> frozenset[str]:
    terms = _name_terms(path)
    return terms | {"context"} if "ctx" in terms else terms


def _query_terms(query: str) -> tuple[list[str], bool]:
    """Return the distinct folded query words that can name a file, and whether the query is about tests."""
    tokens = _identifier_tokens(query)
    words = list(_identifier_words(tokens))
    terms = [_stem(word) for word in words if (len(word) > 1 or not word.isascii()) and word not in QUERY_STOP_WORDS]
    about_tests = any(part in QUERY_TEST_WORDS for token in tokens for part in token.casefold().split("_"))
    return list(dict.fromkeys(terms)), about_tests


@functools.lru_cache(maxsize=256)
def _literal_query_names(query: str) -> frozenset[str]:
    """Recognize written code identifiers without boosting production files in explicit test searches."""
    tokens = _identifier_tokens(query)
    if any(token.casefold() in QUERY_TEST_WORDS for token in tokens):
        return frozenset()
    return frozenset(
        token.casefold() for token in tokens
        if token.isascii() and token.isidentifier()
        and ("_" in token.strip("_") or len(WORD_PART.findall(token)) > 1)
    )


@functools.lru_cache(maxsize=MAX_FILES)
def _is_test(path: str) -> bool:
    parts = path.lower().split("/")
    return any(part in TEST_DIRS or part.endswith(("-tests", "_tests")) for part in parts[:-1]) or bool(TEST_FILE.search(parts[-1]))


def _content_terms(root: Path, relative: str, limit: int, finder: re.Pattern[str], terms: set[str], opener: Callable[[str], int] | None = None, unicode_query: bool = False) -> tuple[set[str], int]:
    """Return which ``terms`` occur in the first ``limit`` bytes of an indexed file, and the bytes read.

    ``finder`` narrows the ASCII scan. Unicode queries also compare normalized words in Unicode source.
    """
    try:
        with os.fdopen(opener(relative) if opener else _open_source(root, relative), "rb") as source:
            if not stat.S_ISREG(os.fstat(source.fileno()).st_mode):
                return set(), 0
            data = source.read(limit)
    except OSError:
        return set(), 0
    if b"\0" in data:
        return set(), len(data)
    if unicode_query and not data.isascii():
        decoded = data.decode("utf-8", "replace")
        return terms.intersection(map(_stem, _word_parts(decoded))), len(data)
    tokens = map(bytes.decode, set(data.translate(IDENTIFIER_BYTE_TABLE).split()))
    candidates = filter(finder.search, tokens)
    return {term for term in map(_stem, _word_parts(" ".join(candidates))) if term in terms}, len(data)


def _rank_unfocused(records: list[dict[str, Any]], by_path: dict[str, dict[str, Any]], reverse: dict[str, set[str]]) -> list[dict[str, Any]]:
    """Without a query, entry configs, their neighbors, and connected or changed files come first."""
    scores: dict[str, int] = {}
    for path, record in by_path.items():
        degree = len(record.get("dependencies", ())) + len(reverse[path])
        scores[path] = 6 * _entry_config(path) + min(2, (degree + 3) // 4) + (record.get("changed") in {"added", "modified", "untracked", "renamed"})
    for path in [path for path in by_path if _entry_config(path)]:
        for neighbor in set(by_path[path]["dependencies"]) | reverse[path]:
            if neighbor in scores:
                scores[neighbor] = max(scores[neighbor], 2)
        for cochange in by_path[path].get("cochanges", ()):
            neighbor = cochange.get("path") if isinstance(cochange, dict) else None
            if neighbor in scores:
                scores[neighbor] = max(scores[neighbor], 1)
    return sorted(records, key=lambda record: (-scores[record["path"]], not _entry_config(record["path"]), record["path"]))


def _rank(records: list[dict[str, Any]], query: str, root: Path | None = None, *, query_matches: set[str] | None = None) -> list[dict[str, Any]]:
    """Rank paths and symbols, then read bounded source content when a root is supplied.

    When the first candidates and metadata give no lexical evidence, use the
    remaining read budget to look deeper. For a query with exactly one missing
    keyword, give the first additional hit one focus slot. Rarer words
    weigh more. Larger code
    files, widely imported ones, current changes and recent co-changes of
    matches rank higher; tests rank lower unless the query is about tests.
    A supplied query_matches set receives the paths with query evidence.
    """
    if query_matches is not None:
        query_matches.clear()
    by_path = {record["path"]: record for record in records}
    reverse: dict[str, set[str]] = {path: set() for path in by_path}
    for record in records:
        for dependency in record["dependencies"]:
            if dependency in reverse:
                reverse[dependency].add(record["path"])
    terms, about_tests = _query_terms(query)
    if not terms and not IDENTIFIER.search(query):
        return _rank_unfocused(records, by_path, reverse)
    exact_path = query.removeprefix("./")
    wanted = set(terms)
    occurrences = dict.fromkeys(terms, 0)
    term_matches = {}
    for path, record in by_path.items():
        path_matches = wanted & _path_terms(path)
        names = tuple(symbol["name"] for symbol in record["symbols"])
        symbol_matches = wanted & _symbol_name_terms(names)
        if path_matches or symbol_matches:
            term_matches[path] = (path_matches, symbol_matches)
            for term in path_matches | symbol_matches:
                occurrences[term] += 1
    weights = {term: math.log(1 + len(records) / (1 + count)) for term, count in occurrences.items()}
    matched = dict.fromkeys(by_path, 0.0)
    for path, (path_matches, symbol_matches) in term_matches.items():
        matched[path] = sum(
            weight * ((term in path_matches) + (term in symbol_matches)) for term, weight in weights.items()
        )
    literal_names = _literal_query_names(query) if exact_path not in by_path else frozenset()
    literal_paths = {
        path for path, record in by_path.items()
        if any(symbol["name"].casefold() in literal_names for symbol in record["symbols"])
    } if literal_names else set()
    matching_paths = literal_paths | {path for path, value in matched.items() if value > 0 or path == exact_path}
    if query_matches is not None:
        query_matches.update(matching_paths)
    bonus = dict.fromkeys(by_path, 0.0)
    for path, record in by_path.items():
        bonus[path] += IMPORTER_WEIGHT * math.log1p(len(reverse[path])) + (record.get("changed") in {"added", "modified", "untracked", "renamed"})
        if record.get("analysis", "metadata") != "metadata":
            bonus[path] += SIZE_WEIGHT * math.log1p(max(0, record.get("lines", 0)))
    cochanged = {
        cochange.get("path") for path, score in matched.items() if score
        for cochange in by_path[path].get("cochanges", ()) if isinstance(cochange, dict)
    }
    for path in cochanged & bonus.keys():
        bonus[path] += 1

    def score(path: str, word_score: float) -> float:
        if path == exact_path:
            return math.inf
        value = word_score + bonus[path]
        return value * TEST_FACTOR if not about_tests and _is_test(path) else value

    first = {path: score(path, matched[path]) for path in by_path}

    def rank_key(record: dict[str, Any], scores: dict[str, float]) -> tuple[bool, float, bool, str]:
        path = record["path"]
        return path not in literal_paths, -scores[path], not _entry_config(path), path

    order = sorted(records, key=lambda record: rank_key(record, first))
    signature_matches = {
        record["path"] for record in order[:CONTENT_RANK_FILES]
        if any(term in _name_terms(symbol.get("signature") or "")
               for symbol in record["symbols"] for term in terms)
    }
    if query_matches is not None:
        query_matches.update(signature_matches)
    has_evidence = bool(matching_paths or signature_matches)
    if root is None or not terms:
        return order
    # Folding only removes endings or turns a final y into i, so a word that folds to a term contains the term
    # without its final i's.
    finder = re.compile("|".join(sorted({re.escape(term.rstrip("i") or term) for term in terms})), re.IGNORECASE)
    head = order[:CONTENT_RANK_FILES]
    budget = CONTENT_RANK_BYTES
    unicode_query = not query.isascii() and any(not char.isascii() and ("_" + char).isidentifier() for char in query)
    unseen = set()
    if len(terms) > 1 and exact_path not in by_path:
        unseen = {term for term, count in occurrences.items() if not count}
    rescored = {}
    rescued = []
    with contextlib.ExitStack() as stack:
        opener = None
        if os.name == "posix" and hasattr(os, "O_NOFOLLOW") and os.open in getattr(os, "supports_dir_fd", ()):
            try:
                opener = stack.enter_context(open_regular_files_nofollow(root))
            except OSError:
                return order

        def scan(path: str) -> set[str]:
            nonlocal budget
            if budget <= 0:
                return set()
            found, used = _content_terms(root, path, min(MAX_FILE_BYTES, budget), finder, wanted, opener, unicode_query)
            budget -= used
            if found and query_matches is not None:
                query_matches.add(path)
            return found

        for record in head:
            path = record["path"]
            found = scan(path)
            has_evidence = has_evidence or bool(found)
            unseen.difference_update(found)
            content = sum(weights[term] for term in terms if term in found)
            rescored[path] = score(path, matched[path] + CONTENT_WEIGHT * content)
        missing = next(iter(unseen)) if has_evidence and len(unseen) == 1 else None
        if missing and any(
            missing in _name_terms(symbol.get("signature") or "") for record in head for symbol in record["symbols"]
        ):
            missing = None
        if not has_evidence or missing:
            # Search one extra window for a missing keyword. Queries with no evidence use the full fallback.
            end = CONTENT_RANK_FILES * 2 if missing else CONTENT_FALLBACK_FILES
            for record in order[CONTENT_RANK_FILES:end]:
                if budget <= 0:
                    break
                path = record["path"]
                found = scan(path)
                if missing and missing in found:
                    rescued.append(record)
                    break
                if found and not missing:
                    content = sum(weights[term] for term in terms if term in found)
                    rescored[path] = score(path, CONTENT_WEIGHT * content)
                    rescued.append(record)

    def content_rank(record: dict[str, Any]) -> tuple[bool, float, bool, str]:
        return rank_key(record, rescored)

    head.sort(key=content_rank)
    if not rescued:
        return head + order[CONTENT_RANK_FILES:]
    rescued_paths = {record["path"] for record in rescued}
    # Keep the leading results while giving the missing keyword one visible path.
    leading = head[:3] + rescued + head[3:] if missing else sorted(rescued, key=content_rank) + head
    return leading + [record for record in order[CONTENT_RANK_FILES:] if record["path"] not in rescued_paths]
def _note(notes: list[str], value: str) -> None:
    if value and value not in notes:
        notes.append(value)
def _valid_fp(value: Any) -> bool:
    return isinstance(value, dict) and all(isinstance(value.get(key), int) and value[key] >= 0 for key in ("ctime_ns", "inode", "size", "mtime_ns"))


def _valid_entry(value: Any, relative: str = "") -> bool:
    if not isinstance(value, dict) or set(value) - {"fingerprint", "language", "symbols", "imports", "parse_note", "lines", "analysis", "exports", "native_imports"}:
        return False
    if not _valid_fp(value.get("fingerprint")) or not isinstance(value.get("language"), str):
        return False
    if not isinstance(value.get("lines"), int) or value["lines"] < 0:
        return False
    native_required = bool(relative) and (value["language"] in {"go", "rust"} or PurePosixPath(relative).name == "go.mod")
    native = value.get("native_imports")
    if native_required and (_sanitize_metadata(relative, native) != native or not isinstance(native, dict)):
        return False
    if not native_required and native is not None:
        return False
    if value.get("analysis") not in ANALYSIS_KINDS:
        return False
    expected_analysis = {
        "python": "python-ast",
        "javascript": "javascript-outline",
        "typescript": "javascript-outline",
    }.get(value["language"], "heuristic-outline" if value["language"] in SUPPORTED_LANGUAGES else "metadata")
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
        if not isinstance(symbol, dict) or set(symbol) - {"name", "kind", "line", "signature", "qualified_name"}:
            return False
        if not isinstance(symbol.get("name"), str) or not isinstance(symbol.get("kind"), str) or not isinstance(symbol.get("line"), int):
            return False
        if "signature" in symbol and not isinstance(symbol["signature"], str):
            return False
        if "qualified_name" in symbol and (
            not isinstance(symbol["qualified_name"], str) or len(symbol["qualified_name"]) > MAX_QUALIFIED_NAME_CHARS
        ):
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
        _reject_symlink(state, "state directory")
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
        # Undecodable path bytes arrive as surrogate escapes, which strict UTF-8 cannot encode.
        path = directory / (hashlib.sha256(str(root).encode("utf-8", "surrogateescape")).hexdigest() + ".json")
        if write:
            state.mkdir(parents=True, exist_ok=True)
            _reject_symlink(state, "state directory")
            directory.mkdir(exist_ok=True)
            _reject_symlink(directory, "code-map cache directory")
        elif not directory.exists():
            return directory, path
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
        if path.stat().st_size > MAX_CACHE_BYTES:
            return {}, "code-map cache is too large"
        with path.open("rb") as handle:
            data = handle.read(MAX_CACHE_BYTES + 1)
        if len(data) > MAX_CACHE_BYTES:
            return {}, "code-map cache is too large"
        payload = json.loads(data.decode("utf-8"))
    except (OSError, ValueError, RecursionError) as exc:
        return {}, f"code-map cache is invalid: {exc}"
    if not isinstance(payload, dict):
        return {}, "code-map cache has an unsupported shape"
    version = payload.get("version")
    # Python outlines depend on the interpreter that parsed them, so another version re-parses them.
    same_python = payload.get("python") == PYTHON_VERSION
    # Reuse older entries whose language outline format is still current.
    if version not in (14, 15, CACHE_VERSION):
        if isinstance(version, int) and 0 <= version < CACHE_VERSION:
            return {}, "code-map cache requires migration"
        return {}, "code-map cache has an unsupported shape"
    raw = payload.get("entries")
    if not isinstance(raw, dict):
        return {}, "code-map cache entries are invalid"
    reusable: dict[str, Any] = {}
    for path_name, entry in raw.items():
        current = candidates.get(path_name)
        if current and ((version == 14 and current["language"] == "php")
                        or (version != CACHE_VERSION and current["language"] == "python")):
            continue
        if isinstance(path_name, str) and current and _valid_entry(entry, path_name) and entry["fingerprint"] == current["fingerprint"] and entry["language"] == current["language"] and (same_python or entry["language"] != "python"):
            reusable[path_name] = entry
    return reusable, None
def _write_json(root: Path, entries: dict[str, Any]) -> None:
    directory, path = _cache_location(root, True)
    if path.exists() and path.is_symlink():
        raise CodeMapError(f"refusing symlink code-map cache: {path}")
    # Store the entries that fit, so a large repository keeps most of its cache instead of none.
    parts: list[str] = []
    prefix = f'{{"version":{CACHE_VERSION},"python":"{PYTHON_VERSION}","entries":{{'
    size = len(prefix) + 2
    for name, entry in entries.items():
        part = json.dumps(name, ensure_ascii=True) + ":" + json.dumps(entry, ensure_ascii=True, separators=(",", ":"))
        if size + len(part) + 1 <= MAX_CACHE_BYTES:
            parts.append(part)
            size += len(part) + 1
    encoded = prefix + ",".join(parts) + "}}"
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
def _summary_target(
    records: list[dict[str, Any]], query: str, *, allow_symbol: bool,
) -> tuple[dict[str, Any] | None, str | None]:
    """Select a named file or one indexed defining file for an exact symbol."""
    target = query.removeprefix("./")
    if target:
        exact = next((record for record in records if record["path"] == target), None)
        if exact is not None:
            return exact, None

    token = query.strip()
    parts = token.split(".")
    if not allow_symbol or not all(part.isidentifier() for part in parts):
        return None, None
    if len(parts) == 1 and not _literal_query_names(token):
        return None, None
    name = token.casefold()
    key = "qualified_name" if len(parts) > 1 else "name"
    defining_file = None
    for record in records:
        if any(symbol.get(key, "").casefold() == name for symbol in record["symbols"]):
            if defining_file is not None:
                return None, None
            defining_file = record
    return defining_file, name if defining_file is not None else None


def _build(root: Path, head: str, inventory: list[str], notes: list[str], query: str, max_files: int, use_cache: bool, refresh: bool, write_cache: bool = True, *, exact_summary: bool = False, rank_focus: bool = True,
           git_state: tuple[str, dict[str, str], str | None] | None = None) -> dict[str, Any]:
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
    terms, about_tests = _query_terms(query)
    exact_path = query.removeprefix("./")
    order = sorted(candidates, key=lambda path: (
        path != exact_path, -sum(term in _path_terms(path) for term in terms),
        not _entry_config(path), not about_tests and _is_test(path), path,
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
            bounded = entry is None and bool(parse_note) and ("read budget" in parse_note or "file limit" in parse_note)
            metadata_only = bounded and info["language"] not in OUTLINED_LANGUAGES
            if metadata_only:
                # A size limit costs a metadata-only file nothing but its line count, so only that file says which limit.
                parse_note = "line count not read: " + ("64 MiB total read budget reached" if "read budget" in parse_note else "file exceeds the 1 MiB limit")
            elif bounded:
                pending += int("read budget" in parse_note)
                limited += 1
            if parse_note and not metadata_only:
                _note(notes, parse_note)
            if entry is None:
                if not bounded:
                    skipped += 1
                    continue
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
    inventory_incomplete = UNTRACKED_INVENTORY_NOTE in notes
    budget_hit = bool(limited) or inventory_capped or INVENTORY_CAP_NOTE in notes or inventory_incomplete
    known = set(entries)
    aliases = _load_alias_configs(root, candidates)
    if any(config.get("unloaded") for config in aliases):
        _note(notes, f"tsconfig/jsconfig alias limits reached; imports under {sum(bool(config.get('unloaded')) for config in aliases)} configs stay unresolved")
    packages = load_workspace_packages(root, candidates)
    if sum(PurePosixPath(rel).name == "package.json" and "node_modules" not in rel.split("/") for rel in candidates) > MAX_PACKAGE_FILES:
        _note(notes, f"workspace package limit reached at {MAX_PACKAGE_FILES} manifests; some package imports stay unresolved")
    branch, changes, git_state_note = _git_state(root) if git_state is None else git_state
    if git_state_note:
        _note(notes, git_state_note)
    cochanges = _cochanges(root, head, known)
    modules = _python_modules(known)
    native_metadata = {path: entry["native_imports"] for path, entry in entries.items() if "native_imports" in entry}
    native_index = build_local_import_index(root, native_metadata, known) if native_metadata else None
    if native_index and native_index.get("partial"):
        _note(notes, "Go/Rust local import resolution is partial; inspect unresolved imports")
    records = [_record(path, entry, known, aliases, changes, cochanges, modules, packages, native_index) for path, entry in entries.items()]
    if any("local import links capped" in record.get("outline_note", "") for record in records):
        _note(notes, "local import link cap reached; some importers may be missing")
    query_matches: set[str] = set()
    exact, exact_symbol = (
        _summary_target(records, query, allow_symbol=not budget_hit) if exact_summary else (None, None)
    )
    if exact is not None:
        selected = [exact]
        focus = [exact["path"]]
        query_matches.add(exact["path"])
    elif not rank_focus and len(records) <= max_files:
        # Ranking cannot change the path-sorted selection when all records fit.
        selected = sorted(records, key=lambda record: record["path"])
        focus = []
    else:
        ranked = _rank(records, query, root, query_matches=query_matches)
        selected = sorted(ranked[:max_files], key=lambda record: record["path"])
        focus = [record["path"] for record in ranked[:min(12, max_files)]]
    # Coverage counts indexed files even when an exact summary displays one row.
    indexed = min(len(records), max_files)
    file_cap = len(records) > max_files
    truncated = file_cap or budget_hit
    if file_cap:
        skipped += len(records) - max_files
        _note(notes, f"file cap reached at {max_files} files")
    if any(info["language"] in {"python", "javascript", "typescript"} for info in candidates.values()):
        _note(notes, "Python and JavaScript/TypeScript import links are heuristic and incomplete; aliases, dynamic imports, and unresolved modules need native search")
    if any(info["language"] in SUPPORTED_LANGUAGES for info in candidates.values()):
        _note(notes, "Other language symbol outlines and Go/Rust import links are heuristic; verify with native search")
    model = {
        "root_name": repository_name(root),
        "generated_at": _now(),
        "head": head,
        "coverage": {
            "inventory": len(inventory), "indexed": indexed, "truncated": truncated,
            "skipped": skipped, "excluded": excluded, "excluded_reasons": excluded_reasons,
            "pending": pending, "limited": limited,
            "notes": notes[:24],
        },
        "files": selected,
        "focus": focus,
    }
    if _query_terms(query)[0] or _literal_query_names(query):
        model["query_matches"] = [path for path in model["focus"] if path in query_matches]
    if exact_symbol is not None:
        model["exact_symbol"] = exact_symbol
    if branch:
        model["branch"] = branch
    if use_cache and write_cache and not inventory_incomplete:
        try:
            _write_json(root, {path: reusable[path] for path in sorted(reusable)})
        except CodeMapError as exc:
            _note(model["coverage"]["notes"], f"cache unavailable: {exc}")
    return model


def _text(model: dict[str, Any], limit: int, query: str = "") -> str:
    coverage = model["coverage"]
    notes = coverage.get("notes", [])
    if not isinstance(notes, list):
        notes = []
    partial = bool(coverage.get("truncated")) or bool(coverage.get("skipped")) or any(
        "import links are heuristic" not in note for note in notes if isinstance(note, str)
    )
    terms = _query_terms(query)[0]
    term_set = set(terms)
    exact_path = query.removeprefix("./")
    literal_names = _literal_query_names(query)
    by_path = {file["path"]: file for file in model["files"]}
    exact_symbol = model.get("exact_symbol")
    exact_file = exact_symbol is None and exact_path in by_path
    confirmation = "metadata only; inspect listed files before changing behavior."
    if exact_file:
        confirmation = "indexed outline; inspect source before edits."
    elif terms or literal_names:
        confirmation = "metadata only. Read symbol lines first. Search other paths."
    lines = [
        f"Code map: {json.dumps(model['root_name'], ensure_ascii=True)}",
        f"Head: {model['head'] or '(unavailable)' }",
        f"Coverage: {coverage.get('indexed', 0)}/{coverage.get('inventory', 0)} files indexed; "
        f"{coverage.get('excluded', 0)} excluded; {coverage.get('skipped', 0)} skipped; "
        f"{'partial' if partial else 'complete'}",
        f"Source confirmation: {confirmation}",
    ]
    excluded_reasons = coverage.get("excluded_reasons", {})
    if isinstance(excluded_reasons, dict) and excluded_reasons:
        summary = ", ".join(f"{count} {reason}" for reason, count in sorted(excluded_reasons.items()))
        lines.insert(3, "Excluded: " + summary)
    focused_query = bool(terms or literal_names) and "query_matches" in model
    topic_query = exact_symbol is None and not exact_file
    compact_topic = focused_query and topic_query and limit <= DEFAULT_MAX_CHARS
    if exact_symbol is not None:
        lines.append("Focus (exact indexed symbol):")
        focus = model["focus"]
    elif exact_file:
        literal_names = frozenset()
        lines.append("Focus (exact indexed path):")
        focus = [exact_path]
    else:
        lines.append("Focus (query matches; follow only task-relevant links):" if focused_query else "Focus:")
        focus = model["query_matches"] if focused_query else model["focus"]
        if focused_query and not focus:
            lines.append("No query matches in scanned candidates; use native search or refine the query.")
    header_count = len(lines)
    header = "\n".join(lines)
    compact: list[tuple[str, list[str]]] = []
    shorter_rows: dict[str, str] = {}
    for index, path in enumerate(focus):
        file = by_path.get(path)
        if not file:
            continue
        if exact_symbol is not None:
            key = "qualified_name" if "." in exact_symbol else "name"
            symbol_values = [symbol for symbol in file["symbols"] if symbol.get(key, "").casefold() == exact_symbol][:8]
        elif terms or literal_names:
            term_counts = Counter(
                term for symbol in file["symbols"] for term in _name_terms(symbol["name"]) & term_set
            ) if compact_topic else Counter()

            def relevance(symbol: dict[str, Any]) -> tuple[int, int]:
                if literal_names and symbol["name"].casefold() in literal_names:
                    return 3 * len(terms) + 1, 0
                name = _name_terms(symbol["name"])
                signature = _name_terms(symbol.get("signature", ""))
                score = sum(2 * (term in name) + (term in signature) for term in terms)
                rarest = min((term_counts[term] for term in name & term_counts.keys()), default=MAX_SYMBOLS + 1)
                return score, -rarest

            ranked = sorted(((relevance(symbol), symbol) for symbol in file["symbols"]),
                            key=lambda item: item[0], reverse=True)
            symbol_values = [symbol for (score, _), symbol in ranked if exact_file or score > 0][:8]
        else:
            symbol_values = file["symbols"][:8]
        declarations = []
        for symbol in symbol_values:
            signature = symbol.get("signature") or symbol["name"]
            qualified = symbol.get("qualified_name")
            if qualified and (focused_query or exact_file):
                signature = qualified + signature.removeprefix(symbol["name"])
            declarations.append(f"{signature} ({symbol['kind']}:{symbol['line']})")
        symbols = ", ".join(declarations)
        if symbols and len(file["symbols"]) > len(symbol_values):
            symbols += f" (+{len(file['symbols']) - len(symbol_values)} more symbols)"
        line = f"- {json.dumps(path, ensure_ascii=True)} [{file['language']}]"
        if focused_query:
            hints = [f"{symbol.get('qualified_name', symbol['name'])} ({symbol['kind']}:{symbol['line']})" for symbol in symbol_values[:2]]
            compact.append((line, hints))
        if symbols:
            line += " symbols: " + symbols
        if file["dependencies"]:
            dependency_values = file["dependencies"][:12]
            dependencies = ", ".join(json.dumps(dep, ensure_ascii=True) for dep in dependency_values)
            if len(file["dependencies"]) > len(dependency_values):
                dependencies += f" (+{len(file['dependencies']) - len(dependency_values)} more deps)"
            detailed = line + " deps: " + dependencies
            if compact_topic and index >= TOPIC_DETAIL_ROWS:
                # Keep the budget selection stable before eliding import hints.
                shorter_rows[detailed] = line
            line = detailed
        lines.append(line)
    if notes:
        lines.append("Notes: " + "; ".join(notes))
    value = "\n".join(lines)
    if len(value) <= limit:
        return "\n".join(shorter_rows.get(line, line) for line in lines) if shorter_rows else value
    suffix = "\n[output truncated; inspect JSON or the live viewer for the bounded full map]"
    usable = limit - len(suffix)
    if compact and len(header) <= usable and (topic_query or len(header) + 1 + len(compact[0][0]) > usable):
        # Fit complete ranked paths first, then attach source line hints.
        remaining = usable - len(header)
        visible = []
        for path_line, _ in compact:
            size = 1 + len(path_line)
            if size > remaining:
                break
            visible.append(path_line)
            remaining -= size
        for index, (_, hints) in enumerate(compact[:len(visible)]):
            if not hints:
                continue
            hint = " symbols: " + hints[0]
            if topic_query and index < TOPIC_DETAIL_ROWS and len(hints) > 1:
                second = ", " + hints[1]
                if len(hint) + len(second) <= remaining:
                    hint += second
            if len(hint) <= remaining:
                visible[index] += hint
                remaining -= len(hint)
        if topic_query:
            for index, rendered in enumerate(lines[header_count:header_count + len(visible)]):
                extra = len(rendered) - len(visible[index])
                if extra <= remaining:
                    visible[index] = rendered
                    remaining -= extra
        return "\n".join([header, *(shorter_rows.get(line, line) for line in visible)]) + suffix
    return (value[: max(0, limit - len(suffix))] + suffix)[-limit:]
def _build_model(
    repo: str | os.PathLike[str], *, query: str, max_files: int, no_cache: bool = False,
    cache_read_only: bool = False, refresh: bool = False, exact_summary: bool = False,
    inventory_result: tuple[bytes | None, list[str]] | None = None,
    git_state: tuple[str, dict[str, str], str | None] | None = None,
) -> dict[str, Any]:
    root_input = _repo_path(repo)
    root, head, inventory, notes = _git_context(root_input, inventory_result)
    model = _build(root, head, inventory or [], notes, query, _clamp(int(max_files), 1, MAX_FILES),
                   not no_cache and inventory is not None, refresh,
                   write_cache=not cache_read_only, exact_summary=exact_summary,
                   git_state=git_state if root == root_input else None)
    if inventory is None:
        model["coverage"]["inventory_available"] = False
    return model


def build_map(
    repo: str | os.PathLike[str], *, query: str = "", max_chars: int = DEFAULT_MAX_CHARS,
    max_files: int = DEFAULT_MAX_FILES, no_cache: bool = False, cache_read_only: bool = False,
    refresh: bool = False, output_format: str = "text",
) -> tuple[dict[str, Any], str]:
    if no_cache and cache_read_only:
        raise CodeMapError("--no-cache and --cache-read-only are mutually exclusive")
    if output_format not in {"text", "json"}:
        raise CodeMapError(f"unsupported output format: {output_format}")
    model = _build_model(repo, query=query, max_files=max_files, no_cache=no_cache,
                         cache_read_only=cache_read_only, refresh=refresh)
    max_chars = _clamp(int(max_chars), 500, MAX_CHARS)
    if output_format == "text":
        return model, _text(model, max_chars, query)
    if output_format == "json":
        return model, json.dumps(model, ensure_ascii=True, separators=(",", ":"))
    raise CodeMapError("unsupported output format")
def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Create a bounded repository code map")
    parser.add_argument("--repo", required=True, metavar="PATH")
    parser.add_argument("--query", default="", metavar="TEXT")
    parser.add_argument("--format", choices=("text", "json", "html"), default="text")
    cache_options = parser.add_mutually_exclusive_group()
    cache_options.add_argument("--no-cache", action="store_true")
    cache_options.add_argument("--cache-read-only", action="store_true")
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


def _in_process_text(args: argparse.Namespace) -> str:
    model = _build_model(args.repo, query=args.query, max_files=args.max_files, no_cache=args.no_cache,
                         cache_read_only=args.cache_read_only, refresh=args.refresh, exact_summary=True)
    return _text(model, _clamp(args.max_chars, 500, MAX_CHARS), args.query)


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    if args.format == "html" and args.no_cache:
        print("the live viewer requires a local service and cannot be combined with --no-cache", file=sys.stderr)
        return 2
    if args.format == "html" and args.cache_read_only:
        print("the live viewer requires a local service and cannot be combined with --cache-read-only", file=sys.stderr)
        return 2
    try:
        if args.format == "html":
            url = _server_api().open_map(args.repo, query=args.query, open_browser=args.open_html,
                                         private_link=not args.open_html)
            sys.stdout.write(url + "\n")
            return 0
        if args.no_cache or args.cache_read_only:
            if args.format == "text":
                rendered = _in_process_text(args)
            else:
                _, rendered = build_map(
                    args.repo, query=args.query, max_chars=args.max_chars, max_files=args.max_files,
                    no_cache=args.no_cache, cache_read_only=args.cache_read_only, refresh=args.refresh,
                    output_format=args.format,
                )
        elif args.format == "text":
            try:
                service = _server_api()
                try:
                    rendered = service.get_text(
                        args.repo, query=args.query, max_files=_clamp(args.max_files, 1, MAX_FILES),
                        max_chars=_clamp(args.max_chars, 500, MAX_CHARS), refresh=args.refresh,
                    )
                except AttributeError:
                    # Older local viewers may not expose the summary endpoint yet.
                    model = service.get_model(args.repo, query=args.query, max_files=_clamp(args.max_files, 1, MAX_FILES), refresh=args.refresh)
                    rendered = _text(model, _clamp(args.max_chars, 500, MAX_CHARS), args.query)
                else:
                    if not isinstance(rendered, str):
                        model = service.get_model(args.repo, query=args.query, max_files=_clamp(args.max_files, 1, MAX_FILES), refresh=args.refresh)
                        rendered = _text(model, _clamp(args.max_chars, 500, MAX_CHARS), args.query)
            except (OSError, ValueError, ImportError) as exc:
                print(f"local viewer unavailable; using an in-process map: {exc}", file=sys.stderr)
                rendered = _in_process_text(args)
        else:
            try:
                model = _server_api().get_model(args.repo, query=args.query, max_files=_clamp(args.max_files, 1, MAX_FILES), refresh=args.refresh)
            except (OSError, ValueError, ImportError) as exc:
                print(f"local viewer unavailable; using an in-process map: {exc}", file=sys.stderr)
                model, _ = build_map(args.repo, query=args.query, max_files=args.max_files, refresh=args.refresh)
            rendered = json.dumps(model, ensure_ascii=True, separators=(",", ":"))
        sys.stdout.write(rendered)
        return 0
    except (CodeMapError, OSError, ValueError, ImportError) as exc:
        print(f"code-map error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
