"""Bounded, conservative local import resolution for Go and Rust.

Parse each bounded source once with ``extract_language_metadata(rel, source)``
and call ``build_local_import_index(root, parsed_metadata, known)`` on warm
builds. ``load_local_import_index(root, candidates, known)`` remains available
as a legacy file-reading wrapper.
Candidates use code_map's relative-path -> {absolute, fingerprint} shape. The
returned index contains only repository-relative paths. Then call
``resolve_go_import(spec, source_path, index)`` or
``resolve_rust_import(spec, source_path, index)``; Rust module declarations
can also be added as edges with ``rust_module_dependencies(source_path,index)``.
No compiler, package manager, subprocess, or workspace code is executed.
"""

from __future__ import annotations

import ast
import bisect
import json
import os
import re
import stat
from pathlib import Path, PurePosixPath

try:
    from .safe_open import open_regular_nofollow
except ImportError:  # Script-style imports used by a few consumers.
    from safe_open import open_regular_nofollow

MAX_CANDIDATES = 20000
MAX_INDEX_FILES = 4096
MAX_FILE_BYTES = 256 * 1024
MAX_INDEX_BYTES = 16 * 1024 * 1024
MAX_RESULTS = 64
MAX_OUTPUT_BYTES = 16 * 1024
_METADATA_VERSION = 3

_GO_MODULE_PATH = re.compile(r"^[A-Za-z0-9._~+-]+(?:/[A-Za-z0-9._~+-]+)*$")
_GO_PACKAGE = re.compile(r"package\s+([A-Za-z_][A-Za-z0-9_]*)\b")
_GO_IDENTIFIER = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_RUST_IDENTIFIER = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_GO_RUNE = re.compile(r"'(?:[^'\\\n]|\\[^\n]{1,10}?)'")
_RUST_CHAR = re.compile(r"'(?:[^'\\\n]|\\u\{[0-9A-Fa-f_]{1,8}\}|\\.)'")
_RUST_MOD = re.compile(r"(?m)^[ \t]*(?:(?:pub(?:\([^)]*\))?)\s+)?mod\s+([A-Za-z_][A-Za-z0-9_]*)\s*;")
_RUST_INLINE_MOD = re.compile(r"(?m)^[ \t]*(?:(?:pub(?:\([^)]*\))?)\s+)?mod\s+[A-Za-z_][A-Za-z0-9_]*\s*\{")
_RUST_USE_START = re.compile(r"(?m)^[ \t]*(?:(?:pub(?:\([^)]*\))?)\s+)?use\s+")
_RUST_PATH_ATTR = re.compile(r"#\s*\[\s*path\s*=")
_RUST_IMPORT_PATH = re.compile(r"^(?:crate|self|super|[A-Za-z_][A-Za-z0-9_]*)(?:::[A-Za-z_][A-Za-z0-9_]*)*$")
_PRIVATE_PARTS = {".git", ".ssh", "credentials", "credential", "secrets", "secret", "keys", "vendor", "node_modules"}


def _go_package_name(source: str) -> str | None:
    """Read only the first Go package clause, after leading comments."""
    position = 0
    while position < len(source):
        while position < len(source) and source[position].isspace():
            position += 1
        if source.startswith("//", position):
            end = source.find("\n", position)
            position = len(source) if end < 0 else end + 1
        elif source.startswith("/*", position):
            end = source.find("*/", position + 2)
            if end < 0:
                return None
            position = end + 2
        else:
            break
    match = _GO_PACKAGE.match(source, position)
    return match.group(1) if match else None


def _safe_rel(value: object) -> bool:
    if not isinstance(value, str) or not value or len(value) > 2048 or "\\" in value or "\x00" in value:
        return False
    parts = value.split("/")
    if any(part in ("", ".", "..") for part in parts):
        return False
    return not any(
        part.lower() in _PRIVATE_PARTS
        or part.lower() == ".env"
        or part.lower().startswith(".env.")
        or part.lower().startswith(("id_rsa", "id_ed25519"))
        or "credential" in part.lower() or "secret" in part.lower()
        or part.lower().endswith((".pem", ".key", ".p12", ".pfx"))
        or re.search(r"(?:^|[-_.])key(?:[-_.]|$)", part.lower()) is not None
        for part in parts
    )


def _bounded_paths(paths) -> tuple[str, ...]:
    result = []
    used = 0
    for path in paths:
        if len(result) >= MAX_RESULTS or not _safe_rel(path):
            continue
        size = len(path.encode("utf-8")) + 1
        if used + size > MAX_OUTPUT_BYTES:
            break
        result.append(path)
        used += size
    return tuple(result)


def _read_candidate(root: Path, rel: str, info: dict, limit: int) -> tuple[str | None, int]:
    """Read one regular indexed file through the shared pinned no-follow opener."""
    if not _safe_rel(rel) or not isinstance(info, dict) or limit <= 0:
        return None, 0
    file_fd = None
    try:
        absolute = os.fspath(info.get("absolute"))
        expected_path = root.joinpath(*PurePosixPath(rel).parts)
        if not isinstance(absolute, str) or not Path(absolute).is_absolute():
            return None, 0
        # Compare normalized spellings without resolving (and following) links.
        if os.path.abspath(absolute) != os.path.abspath(expected_path):
            return None, 0
        file_fd = open_regular_nofollow(root, rel)
        before = os.fstat(file_fd)
        if not stat.S_ISREG(before.st_mode) or before.st_size > limit:
            return None, 0
        fingerprint = info.get("fingerprint")
        if isinstance(fingerprint, dict):
            for key, attr in (("ctime_ns", "st_ctime_ns"), ("inode", "st_ino"), ("size", "st_size"), ("mtime_ns", "st_mtime_ns")):
                if key in fingerprint and int(getattr(before, attr)) != fingerprint[key]:
                    return None, 0
        with os.fdopen(os.dup(file_fd), "rb") as stream:
            data = stream.read(limit + 1)
        after = os.fstat(file_fd)
        if len(data) > limit or (before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns):
            return None, len(data)
        try:
            return data.decode("utf-8-sig"), len(data)
        except UnicodeError:
            return None, len(data)
    except (OSError, ValueError, TypeError, KeyError, OverflowError):
        return None, 0
    finally:
        if file_fd is not None:
            try:
                os.close(file_fd)
            except OSError:
                pass


def _rust_mask(source: str) -> str:
    """Blank Rust comments and literals in a single linear pass."""
    chars = list(source)
    length = len(source)
    i = 0

    def blank(start: int, end: int) -> None:
        for pos in range(start, min(end, length)):
            if chars[pos] != "\n":
                chars[pos] = " "

    while i < length:
        if source.startswith("//", i):
            end = source.find("\n", i)
            if end < 0:
                end = length
            blank(i, end)
            i = end
            continue
        if source.startswith("/*", i):
            start, depth = i, 1
            i += 2
            while i < length and depth:
                if source.startswith("/*", i):
                    depth += 1
                    i += 2
                elif source.startswith("*/", i):
                    depth -= 1
                    i += 2
                else:
                    i += 1
            blank(start, i)
            continue
        raw_prefix = 2 if source.startswith(("br", "cr"), i) else 1 if source[i] == "r" else 0
        if raw_prefix:
            hashes_end = i + raw_prefix
            while hashes_end < length and source[hashes_end] == "#":
                hashes_end += 1
            if hashes_end < length and source[hashes_end] == '\"':
                start = i
                hashes = source[i + raw_prefix:hashes_end]
                terminator = '\"' + hashes
                end = source.find(terminator, hashes_end + 1)
                i = length if end < 0 else end + len(terminator)
                blank(start, i)
                continue
        prefix = 2 if source.startswith(("b\"", "c\""), i) else 1 if source[i] == '\"' else 0
        if prefix:
            start = i
            i += prefix
            while i < length:
                if source[i] == "\\":
                    i += 2
                elif source[i] == '\"':
                    i += 1
                    break
                else:
                    i += 1
            blank(start, i)
            continue
        if source[i] == "'":
            char = _RUST_CHAR.match(source, i)
            if char:
                blank(i, i + len(char.group(0)))
                i += len(char.group(0))
                continue
        i += 1
    return "".join(chars)


def _module_root_for(path: str, modules: list[dict]) -> dict | None:
    matches = [item for item in modules if path == item["root"] or path.startswith(item["root"] + "/") if item["root"]]
    if any(not item["root"] for item in modules) and path:
        matches.extend(item for item in modules if not item["root"])
    elif not path:
        matches.extend(item for item in modules if not item["root"])
    if not matches:
        return None
    deepest = max(len(item["root"].split("/")) if item["root"] else 0 for item in matches)
    nearest = [item for item in matches if (len(item["root"].split("/")) if item["root"] else 0) == deepest]
    return nearest[0] if len(nearest) == 1 else None


def _rust_root_candidate(rel: str) -> bool:
    parts = PurePosixPath(rel).parts
    if not parts or not rel.endswith(".rs"):
        return False
    name = parts[-1]
    if name in {"lib.rs", "main.rs"} and "src" in parts[:-1]:
        return True
    for directory in ("examples", "tests", "benches"):
        if directory in parts[:-1]:
            return True
    for offset in range(len(parts) - 1):
        if parts[offset:offset + 2] == ("src", "bin"):
            return True
    return False


def _go_tokens(source: str, imports_only: bool = False) -> tuple[list[tuple[str, str, int, int]], bool, bool]:
    """Tokenize the small Go subset needed here, skipping comments and bounding work.

    Returns the tokens, whether lexing was partial, and whether ``imports_only``
    stopped at the first top-level declaration, after which no import can follow.
    """
    tokens = []
    partial = False
    depth = 0
    length = len(source)
    i = 0
    while i < length:
        char = source[i]
        if char.isspace():
            i += 1
            continue
        if source.startswith("//", i):
            end = source.find("\n", i)
            i = length if end < 0 else end + 1
            continue
        if source.startswith("/*", i):
            end = source.find("*/", i + 2)
            if end < 0:
                partial = True
                break
            i = end + 2
            continue
        start = i
        rune = _GO_RUNE.match(source, i) if char == "'" else None
        if rune:
            i = rune.end()
            tokens.append(("rune", rune.group(), start, i))
        elif char in {'"', '`'}:
            quote = char
            i += 1
            while i < length:
                if quote == '"' and source[i] == "\\":
                    i += 2
                elif source[i] == quote:
                    i += 1
                    break
                elif quote == '"' and source[i] == "\n":
                    partial = True
                    break
                else:
                    i += 1
            else:
                partial = True
            if i <= length and source[i - 1:i] == quote:
                tokens.append(("string", source[start:i], start, i))
            else:
                break
        elif char == "_" or char.isalpha():
            i += 1
            while i < length and (source[i] == "_" or source[i].isalnum()):
                i += 1
            if imports_only and depth == 0 and source[start:i] in {"func", "type", "var", "const"}:
                return tokens, partial, True
            tokens.append(("ident", source[start:i], start, i))
        else:
            i += 1
            depth += 1 if char in "({[" else -1 if char in ")}]" else 0
            tokens.append(("punct", char, start, i))
        if len(tokens) >= 32768:
            partial = i < length
            break
    return tokens, partial, False


def _go_string_value(token: str) -> str | None:
    try:
        if token.startswith("`") and token.endswith("`"):
            return token[1:-1].replace("\r", "")
        value = ast.literal_eval(token)
        return value if isinstance(value, str) else None
    except (SyntaxError, ValueError):
        return None


def _go_module_declaration(source: str, tokens: list[tuple[str, str, int, int]]) -> str | None:
    for kind, text, start, _ in tokens:
        if kind != "ident" or text != "module":
            continue
        line_start = source.rfind("\n", 0, start) + 1
        if source[line_start:start].strip():
            continue
        line_end = source.find("\n", start)
        line = source[start:len(source) if line_end < 0 else line_end]
        match = re.match(r'^module\s+("(?:\\.|[^"\\])*"|[^\s]+)(?:\s*(?://.*)?)?$', line)
        if not match:
            continue
        token = match.group(1)
        value = _go_string_value(token) if token.startswith('"') else token
        if value and len(value) <= 2048 and _GO_MODULE_PATH.fullmatch(value):
            return value
    return None


def _go_file_metadata(source: str, truncated: bool = False) -> tuple[str | None, list[str], bool, list[str]]:
    tokens, partial, imports_ended = _go_tokens(source, imports_only=True)
    # A truncated file still has every import when the import section ended inside the part read.
    partial = partial or truncated and not imports_ended
    diagnostics = ["token_limit_or_lex_error"] if partial else []
    package = tokens[1][1] if len(tokens) > 1 and tokens[0][0:2] == ("ident", "package") and tokens[1][0] == "ident" and _GO_IDENTIFIER.fullmatch(tokens[1][1]) else None
    if package is None:
        diagnostics.append("package_missing")
    imports = []
    for position, token in enumerate(tokens):
        if token[0:2] != ("ident", "import") or position + 1 >= len(tokens):
            continue
        cursor = position + 1
        if tokens[cursor][0:2] == ("punct", "("):
            cursor += 1
            while cursor < len(tokens) and tokens[cursor][0:2] != ("punct", ")"):
                if tokens[cursor][0] == "string":
                    value = _go_string_value(tokens[cursor][1])
                    if value and len(value) <= 2048 and _GO_MODULE_PATH.fullmatch(value):
                        imports.append(value)
                    else:
                        diagnostics.append("invalid_go_import")
                cursor += 1
        else:
            if tokens[cursor][0] != "string" and cursor + 1 < len(tokens) and (tokens[cursor][0] == "ident" or tokens[cursor][1] == "."):
                cursor += 1
            if cursor < len(tokens) and tokens[cursor][0] == "string":
                value = _go_string_value(tokens[cursor][1])
                if value and len(value) <= 2048 and _GO_MODULE_PATH.fullmatch(value):
                    imports.append(value)
                else:
                    diagnostics.append("invalid_go_import")
        if len(imports) >= MAX_RESULTS:
            diagnostics.append("spec_limit")
            partial = True
            break
    if any(code == "invalid_go_import" for code in diagnostics):
        partial = True
    if package is not None and len(package) > 2048:
        package = None
        diagnostics.append("package_limit")
        partial = True
    return package, list(dict.fromkeys(imports[:MAX_RESULTS])), partial, diagnostics


def _split_rust_group(value: str) -> list[str]:
    pieces = []
    start = 0
    depth = 0
    for position, char in enumerate(value):
        if char == "{":
            depth += 1
        elif char == "}":
            depth = max(0, depth - 1)
        elif char == "," and depth == 0:
            pieces.append(value[start:position].strip())
            start = position + 1
    pieces.append(value[start:].strip())
    return [piece for piece in pieces if piece]


def _expand_rust_use(value: str, prefix: str = "", depth: int = 0) -> list[str]:
    if depth > 64:
        raise ValueError("Rust import nesting limit")
    output = []
    for piece in _split_rust_group(value):
        piece = re.split(r"\s+as\s+", piece, maxsplit=1)[0].strip()
        open_brace = piece.find("{")
        if open_brace >= 0:
            nesting = 0
            close_brace = -1
            for position in range(open_brace, len(piece)):
                if piece[position] == "{":
                    nesting += 1
                elif piece[position] == "}":
                    nesting -= 1
                    if nesting == 0:
                        close_brace = position
                        break
            if close_brace >= 0:
                head = piece[:open_brace].strip().rstrip(":")
                combined = "::".join(part for part in (prefix, head) if part)
                output.extend(_expand_rust_use(piece[open_brace + 1:close_brace], combined, depth + 1))
                continue
        leaf = piece.strip()
        if leaf.endswith("::*"):
            leaf = leaf[:-3]
        if leaf == "self" and prefix:
            path = prefix
        else:
            path = "::".join(part for part in (prefix, leaf) if part)
        if len(path) <= 2048 and _RUST_IMPORT_PATH.fullmatch(path):
            output.append(path)
    return output


def _rust_scopes(masked: str):
    """Return a lookup of (brace depth, enclosing inline-module count) at a source offset."""
    inline_opens = {match.end() - 1 for match in _RUST_INLINE_MOD.finditer(masked)}
    offsets, scopes, stack = [0], [(0, 0)], []
    for brace in re.finditer(r"[{}]", masked):
        if brace.group() == "{":
            stack.append(brace.start() in inline_opens)
        elif stack:
            stack.pop()
        offsets.append(brace.end())
        scopes.append((len(stack), sum(stack)))
    return lambda offset: scopes[bisect.bisect_right(offsets, offset) - 1]


def _rust_file_metadata(source: str) -> tuple[list[str], list[str], bool, bool, list[str]]:
    masked = _rust_mask(source)
    partial = False
    diagnostics = []
    scope = _rust_scopes(masked)
    # Only file-level `mod x;` names this file's children; ones inside an inline `mod m { }` belong to m.
    mods = [match.group(1) for match in _RUST_MOD.finditer(masked) if len(match.group(1)) <= 2048 and scope(match.start())[0] == 0]
    if len(mods) > MAX_RESULTS:
        mods = mods[:MAX_RESULTS]
        partial = True
        diagnostics.append("spec_limit")
    uses = []
    for match in _RUST_USE_START.finditer(masked):
        if scope(match.start())[1]:
            continue  # paths inside an inline module are relative to it
        end = masked.find(";", match.end())
        if end < 0:
            partial = True
            diagnostics.append("unterminated_use")
            continue
        statement = masked[match.end():end].strip()
        if len(statement) > 4096:
            partial = True
            diagnostics.append("use_statement_limit")
            continue
        try:
            uses.extend(_expand_rust_use(statement))
        except (RecursionError, ValueError):
            partial = True
            diagnostics.append("use_nesting_limit")
        if len(uses) >= MAX_RESULTS:
            uses = uses[:MAX_RESULTS]
            partial = True
            diagnostics.append("spec_limit")
            break
    uses = list(dict.fromkeys(uses))
    path_attr = bool(_RUST_PATH_ATTR.search(masked))
    return mods, uses, path_attr, partial, diagnostics


def _metadata_size(metadata: dict) -> int:
    return len(json.dumps(metadata, ensure_ascii=True, separators=(",", ":")).encode("utf-8"))


def _fit_language_metadata(metadata: dict) -> dict:
    """Keep each cached record JSON-safe and within the per-file output budget."""
    metadata["diagnostics"] = list(dict.fromkeys(metadata.get("diagnostics", [])))[:16]
    while _metadata_size(metadata) > MAX_OUTPUT_BYTES:
        trimmed = False
        for key in ("rust_uses", "go_imports", "rust_mods"):
            values = metadata.get(key)
            if values:
                values.pop()
                trimmed = True
                break
        metadata["partial"] = True
        if "metadata_limit" not in metadata["diagnostics"]:
            metadata["diagnostics"].append("metadata_limit")
        if not trimmed:
            break
    return metadata


def extract_language_metadata(rel: str, source: str) -> dict:
    """Extract bounded, JSON-safe import metadata from one already-read source.

    The returned object contains no source text. It is suitable for caching in
    code_map's parse record and later passing to ``build_local_import_index``.
    """
    safe_path = rel if _safe_rel(rel) else ""
    kind = "go_mod" if safe_path and PurePosixPath(safe_path).name == "go.mod" else "go" if safe_path.endswith(".go") else "rust" if safe_path.endswith(".rs") else "other"
    metadata = {
        "version": _METADATA_VERSION,
        "path": safe_path,
        "kind": kind,
        "go_package": None,
        "go_imports": [],
        "go_module": None,
        "rust_mods": [],
        "rust_uses": [],
        "rust_path_attr": False,
        "partial": False,
        "diagnostics": [],
    }
    if not safe_path:
        metadata["partial"] = True
        metadata["diagnostics"].append("invalid_path")
        return metadata
    if not isinstance(source, str):
        metadata["partial"] = True
        metadata["diagnostics"].append("invalid_source")
        return metadata
    try:
        encoded = source.encode("utf-8", "surrogatepass")
    except (UnicodeError, MemoryError):
        metadata["partial"] = True
        metadata["diagnostics"].append("source_limit")
        return metadata
    truncated = len(encoded) > MAX_FILE_BYTES
    if truncated:
        # Read imports from the first 256 KiB instead of dropping them all.
        source = encoded[:MAX_FILE_BYTES].decode("utf-8", "ignore")
    fallback = {**metadata, "partial": True, "diagnostics": ["analysis_failed"]}
    try:
        if kind == "go":
            package, imports, partial, diagnostics = _go_file_metadata(source, truncated)
            metadata["go_package"] = package
            metadata["go_imports"] = imports
            metadata["partial"] = partial
            metadata["diagnostics"].extend(diagnostics)
        elif kind == "go_mod":
            tokens, partial, _ = _go_tokens(source)
            metadata["go_module"] = _go_module_declaration(source, tokens)
            metadata["partial"] = partial
            if partial:
                metadata["diagnostics"].append("token_limit_or_lex_error")
            if metadata["go_module"] is None:
                metadata["diagnostics"].append("module_missing")
                metadata["partial"] = True
        elif kind == "rust":
            mods, uses, path_attr, partial, diagnostics = _rust_file_metadata(source)
            metadata["rust_mods"] = mods
            metadata["rust_uses"] = uses
            metadata["rust_path_attr"] = path_attr
            metadata["partial"] = partial
            metadata["diagnostics"].extend(diagnostics)
        if truncated:
            metadata["diagnostics"].append("source_limit")
            metadata["partial"] = metadata["partial"] or kind != "go"
    except Exception:  # One unusual file must not fail the whole map.
        metadata = fallback
    return _fit_language_metadata(metadata)


def _empty_index(diagnostics=()) -> dict:
    messages = list(diagnostics)[:64]
    return {
        "go_modules": [], "go_packages": {}, "rust_locations": {},
        "rust_children": {}, "known": set(), "partial": bool(messages),
        "diagnostics": messages,
    }


def _normalized_known(known) -> set[str] | None:
    if known is None:
        return None
    if isinstance(known, str):
        known = (known,)
    result = set()
    try:
        for position, rel in enumerate(known):
            if position >= MAX_CANDIDATES:
                break
            if _safe_rel(rel):
                result.add(rel)
    except TypeError:
        return set()
    return result


def _sanitize_metadata(rel: str, value) -> dict | None:
    if not isinstance(value, dict) or value.get("version") != _METADATA_VERSION or value.get("path") != rel:
        return None
    kind = "go_mod" if PurePosixPath(rel).name == "go.mod" else "go" if rel.endswith(".go") else "rust" if rel.endswith(".rs") else "other"
    if value.get("kind") != kind:
        return None
    result = {
        "version": _METADATA_VERSION, "path": rel, "kind": kind,
        "go_package": value.get("go_package") if isinstance(value.get("go_package"), str) and len(value["go_package"]) <= 2048 and _GO_IDENTIFIER.fullmatch(value["go_package"]) else None,
        "go_imports": [],
        "go_module": value.get("go_module") if isinstance(value.get("go_module"), str) and len(value["go_module"]) <= 2048 and _GO_MODULE_PATH.fullmatch(value["go_module"]) else None,
        "rust_mods": [], "rust_uses": [],
        "rust_path_attr": value.get("rust_path_attr") is True,
        "partial": value.get("partial") is True,
        "diagnostics": [],
    }
    for key, validator in (("go_imports", _GO_MODULE_PATH), ("rust_uses", _RUST_IMPORT_PATH), ("rust_mods", _RUST_IDENTIFIER)):
        raw = value.get(key, ())
        if not isinstance(raw, (list, tuple)):
            continue
        cleaned = []
        for item in raw[:MAX_RESULTS]:
            if isinstance(item, str) and len(item) <= 2048 and validator.fullmatch(item) and item not in cleaned:
                cleaned.append(item)
        result[key] = cleaned
    diagnostics = value.get("diagnostics", ())
    if isinstance(diagnostics, (list, tuple)):
        result["diagnostics"] = [item for item in diagnostics[:16] if isinstance(item, str) and re.fullmatch(r"[a-z_]{1,80}", item)]
    return _fit_language_metadata(result)


def _build_local_import_index(root, parsed_metadata: dict, known=None, inherited_diagnostics=()) -> dict:
    diagnostics = list(inherited_diagnostics)[:64]
    if not isinstance(parsed_metadata, dict):
        return _empty_index([*diagnostics, "invalid_metadata"])
    try:
        root_path = Path(root).resolve(strict=True)
        if not root_path.is_dir():
            return _empty_index([*diagnostics, "invalid_root"])
    except (OSError, TypeError, ValueError):
        return _empty_index([*diagnostics, "invalid_root"])
    known_filter = _normalized_known(known)
    candidates = []
    for position, rel in enumerate(parsed_metadata):
        if position >= MAX_CANDIDATES:
            diagnostics.append("candidate_limit")
            break
        if not _safe_rel(rel):
            continue
        manifest = PurePosixPath(rel).name == "go.mod"
        if manifest or ((known_filter is None or rel in known_filter) and rel.endswith((".go", ".rs"))):
            candidates.append(rel)
    candidates.sort()
    if len(candidates) > MAX_INDEX_FILES:
        candidates = candidates[:MAX_INDEX_FILES]
        diagnostics.append("file_limit")
    records = {}
    metadata_bytes = 0
    for rel in candidates:
        record = _sanitize_metadata(rel, parsed_metadata.get(rel))
        if record is None:
            diagnostics.append("invalid_metadata")
            continue
        size = _metadata_size(record)
        if size > MAX_OUTPUT_BYTES or metadata_bytes + size > MAX_INDEX_BYTES:
            diagnostics.append("metadata_byte_limit")
            break
        records[rel] = record
        metadata_bytes += size
        # A Go file read only in part still has complete imports when its metadata is not partial.
        if record["partial"] or set(record["diagnostics"]) - {"source_limit"}:
            diagnostics.append("partial_source_metadata")
    eligible_names = set(candidates)
    known_output = set(eligible_names)
    if known_filter is not None:
        known_output = {rel for rel in eligible_names if PurePosixPath(rel).name == "go.mod" or rel in known_filter}
        for rel in sorted(known_filter):
            if len(known_output) >= MAX_INDEX_FILES:
                break
            if rel.endswith((".go", ".rs")) and rel not in eligible_names:
                known_output.add(rel)
    go_modules = []
    manifests = sorted(rel for rel in records if records[rel]["kind"] == "go_mod")
    for rel in manifests:
        module_path = records[rel]["go_module"]
        if not module_path:
            continue
        module_root = PurePosixPath(rel).parent.as_posix()
        go_modules.append({"root": "" if module_root == "." else module_root, "path": module_path})
    go_modules.sort(key=lambda item: (item["root"], item["path"]))
    if not go_modules and any(record["go_imports"] for record in records.values() if record["kind"] == "go"):
        diagnostics.append("go_module_missing")

    go_packages: dict[tuple[str, str], list[str]] = {}
    files = sorted(rel for rel in records if rel.endswith((".go", ".rs")) and rel in known_output)
    for rel in files:
        if not rel.endswith(".go") or rel.endswith("_test.go"):
            continue
        package = records[rel]["go_package"]
        if package is None:
            continue
        module = _module_root_for(rel, go_modules)
        if module is None:
            continue
        parent = PurePosixPath(rel).parent.as_posix()
        if module["root"]:
            if parent != module["root"] and not parent.startswith(module["root"] + "/"):
                continue
            suffix = parent[len(module["root"]):].lstrip("/")
        else:
            suffix = "" if parent == "." else parent
        go_packages.setdefault((module["root"], suffix), []).append(rel)
    for package_files in go_packages.values():
        package_names = {records[path]["go_package"] for path in package_files}
        if len(package_names) != 1:
            diagnostics.append("ambiguous_go_package")
            package_files.clear()
        else:
            package_files.sort()

    rust_files = {rel for rel in files if rel.endswith(".rs")}
    declared_children: dict[str, dict[str, str]] = {}
    for rel in sorted(rust_files):
        metadata = records[rel]
        # `#[path]` changes Rust's directory rules; do not guess.
        if metadata["rust_path_attr"]:
            diagnostics.append("unsupported_rust_module_layout")
            continue
        by_name: dict[str, list[str]] = {}
        parent = PurePosixPath(rel)
        # mod.rs, crate roots and Cargo's tests/, examples/, benches/ and src/bin/ targets own their directory.
        target_root = parent.parent.name in {"tests", "examples", "benches"} and "src" not in parent.parts[:-2] or parent.parent.as_posix().endswith("src/bin")
        module_dir = parent.parent if parent.name in {"mod.rs", "lib.rs", "main.rs"} or target_root else parent.parent / parent.stem
        for name in metadata["rust_mods"]:
            options = (module_dir / (name + ".rs")).as_posix(), (module_dir / name / "mod.rs").as_posix()
            found = [candidate for candidate in options if candidate in rust_files and _safe_rel(candidate)]
            if len(found) == 1:
                by_name.setdefault(name, []).append(found[0])
            else:
                diagnostics.append("ambiguous_or_missing_rust_module")
        declared_children[rel] = {name: paths[0] for name, paths in by_name.items() if len(set(paths)) == 1}

    roots = sorted(rel for rel in rust_files if _rust_root_candidate(rel))
    child_files = {child for children in declared_children.values() for child in children.values()}
    roots = [rel for rel in roots if rel not in child_files]
    locations: dict[str, list[tuple[str, tuple[str, ...]]]] = {}
    rust_children: dict[tuple[str, tuple[str, ...]], dict[str, str]] = {}
    for crate_root in roots:
        stack = [(crate_root, ())]
        seen: set[str] = set()
        while stack:
            rel, module_path = stack.pop()
            if rel in seen:
                continue
            seen.add(rel)
            locations.setdefault(rel, []).append((crate_root, module_path))
            children = declared_children.get(rel, {})
            rust_children[(crate_root, module_path)] = dict(children)
            for name, child in sorted(children.items(), reverse=True):
                stack.append((child, module_path + (name,)))
    return {
        "go_modules": go_modules,
        "go_packages": {key: tuple(value) for key, value in go_packages.items()},
        "rust_locations": {path: tuple(value) for path, value in locations.items()},
        "rust_children": rust_children,
        "known": known_output,
        "partial": bool(diagnostics),
        "diagnostics": list(dict.fromkeys(diagnostics))[:64],
    }


def build_local_import_index(root, parsed_metadata: dict[str, dict], known=None) -> dict:
    """Build an index from ``{relative_path: extract_language_metadata(...)}``.

    This in-memory API performs no source reads and is intended for warm builds
    that already hold the bounded metadata in code_map's parse cache.
    """
    return _build_local_import_index(root, parsed_metadata, known)


def load_local_import_index(root, candidates: dict[str, dict], known=None) -> dict:
    """Legacy bounded file-reading wrapper; prefer metadata extraction + builder.

    ``known`` should be code_map's successfully indexed relative paths; passing
    it prevents links to ignored, excluded, capped, or unread source files.
    Manifest files are read only when present in ``candidates``. Incomplete
    reads are reported in ``diagnostics`` and merely produce missing edges.
    """
    try:
        root_path = Path(root).resolve(strict=True)
        if not root_path.is_dir() or not isinstance(candidates, dict):
            return _empty_index(("invalid_root_or_candidates",))
    except (OSError, TypeError, ValueError):
        return _empty_index(("invalid_root_or_candidates",))
    known_filter = _normalized_known(known)
    relevant = []
    diagnostics = []
    for position, rel in enumerate(candidates):
        if position >= MAX_CANDIDATES:
            diagnostics.append("candidate_limit")
            break
        if not _safe_rel(rel):
            continue
        is_manifest = PurePosixPath(rel).name == "go.mod"
        if is_manifest or ((known_filter is None or rel in known_filter) and rel.endswith((".go", ".rs"))):
            relevant.append(rel)
    relevant.sort()
    if len(relevant) > MAX_INDEX_FILES:
        relevant = relevant[:MAX_INDEX_FILES]
        diagnostics.append("file_limit")
    parsed = {}
    remaining = MAX_INDEX_BYTES
    for rel in relevant:
        if remaining <= 0:
            diagnostics.append("index_byte_limit")
            break
        info = candidates.get(rel)
        if not isinstance(info, dict):
            diagnostics.append("candidate_unread")
            continue
        source, consumed = _read_candidate(root_path, rel, info, min(MAX_FILE_BYTES, remaining))
        remaining = max(0, remaining - consumed)
        if source is None:
            diagnostics.append("candidate_unread")
            continue
        parsed[rel] = extract_language_metadata(rel, source)
    return _build_local_import_index(root_path, parsed, relevant, diagnostics)


def resolve_go_import(spec: str, source_path: str, index: dict) -> tuple[str, ...]:
    """Return indexed package files for an import path in the source's Go module."""
    if not isinstance(spec, str) or not isinstance(source_path, str) or not _safe_rel(source_path):
        return ()
    if source_path not in index.get("known", ()) or not source_path.endswith(".go"):
        return ()
    if not _GO_MODULE_PATH.fullmatch(spec):
        return ()
    modules = index.get("go_modules", ())
    source_module = _module_root_for(source_path, modules)
    if source_module is None:
        return ()
    suffix = "" if spec == source_module["path"] else spec[len(source_module["path"]) + 1:] if spec.startswith(source_module["path"] + "/") else None
    if suffix is None or (suffix and not _safe_rel(suffix)):
        return ()
    target_dir = source_module["root"]
    if suffix:
        target_dir = (PurePosixPath(target_dir) / suffix).as_posix() if target_dir else suffix
    target_module = _module_root_for(target_dir + "/_", modules)
    if target_module is None or target_module != source_module:
        return ()
    result = index.get("go_packages", {}).get((source_module["root"], suffix), ())
    # Every file of the package is returned; the caller's link cap reports a large package.
    return tuple(path for path in result if path in index.get("known", ()) and path != source_path and _safe_rel(path))


def resolve_rust_import(spec: str, source_path: str, index: dict) -> tuple[str, ...]:
    """Resolve a crate-local Rust module path to its owning indexed source file."""
    if not isinstance(spec, str) or not isinstance(source_path, str) or not _safe_rel(source_path):
        return ()
    if not _RUST_IMPORT_PATH.fullmatch(spec):
        return ()
    contexts = index.get("rust_locations", {}).get(source_path, ())
    if len(contexts) != 1:
        return ()
    crate_root, current = contexts[0]
    parts = spec.split("::")
    children = index.get("rust_children", {})

    def module_file(module_path: tuple[str, ...]) -> str | None:
        current_file = crate_root
        for depth, name in enumerate(module_path):
            child = children.get((crate_root, module_path[:depth]), {}).get(name)
            if child is None:
                return None
            current_file = child
        return current_file

    if parts[0] == "crate":
        module_path, offset = (), 1
        reached = crate_root
    elif parts[0] == "self":
        module_path, offset = current, 1
        reached = source_path
    elif parts[0] == "super":
        module_path, offset = current, 0
        while offset < len(parts) and parts[offset] == "super":
            if not module_path:
                return ()
            module_path = module_path[:-1]
            offset += 1
        reached = module_file(module_path)
    else:
        # Since Rust 2018 an unqualified first segment names a module declared in the
        # current module, or else an external crate, which stays unresolved.
        module_path, offset = current, 0
        reached = source_path

    if reached is None:
        return ()
    for position, name in enumerate(parts[offset:]):
        child = children.get((crate_root, module_path), {}).get(name)
        if child is None:
            if position == 0 and parts[0] not in {"crate", "self", "super"}:
                return ()
            break
        reached = child
        module_path += (name,)
    if reached == source_path or reached not in index.get("known", ()) or not _safe_rel(reached):
        return ()
    return _bounded_paths((reached,))


def rust_module_dependencies(source_path: str, index: dict) -> tuple[str, ...]:
    """Return direct files declared by ``mod name;`` in an indexed Rust file."""
    if not isinstance(source_path, str) or not _safe_rel(source_path):
        return ()
    contexts = index.get("rust_locations", {}).get(source_path, ())
    if len(contexts) != 1:
        return ()
    crate_root, module_path = contexts[0]
    children = index.get("rust_children", {}).get((crate_root, module_path), {})
    return _bounded_paths(sorted(path for path in set(children.values()) if path in index.get("known", ()) and path != source_path and _safe_rel(path)))
