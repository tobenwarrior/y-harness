#!/usr/bin/env python3
"""Bounded, read-only code-map symbol and Python location lookup.

Definitions use existing code-map symbol metadata. Lexical occurrences match
identifier boundaries in source, including declarations, comments, and strings.
Python line and literal lookups include source lines only when --excerpt is supplied.
"""

from __future__ import annotations

import argparse
import ast
import json
import math
import os
import re
import stat
import sys
import time
from bisect import bisect_right
from collections import Counter
from itertools import islice
from pathlib import Path
from typing import Any, Sequence

try:
    from . import code_map
    from .safe_open import open_regular_nofollow as _open_regular_nofollow
    from .reference_cache import IdentifierPostingsCache, UnsupportedSymbolError
    from .language_outlines import split_lines
except ImportError:  # direct script execution
    import code_map
    from language_outlines import split_lines
    from safe_open import open_regular_nofollow as _open_regular_nofollow
    from reference_cache import IdentifierPostingsCache, UnsupportedSymbolError

DEFAULT_MAX_FILES = 1000
MAX_FILES = 5000
DEFAULT_MAX_RESULTS = 100
MAX_RESULTS = 1000
DEFAULT_TIMEOUT = 3.0
MAX_TIMEOUT = 15.0
DEFAULT_MAX_FILE_BYTES = 256 * 1024
MAX_FILE_BYTES = 1024 * 1024
DEFAULT_MAX_TOTAL_BYTES = 8 * 1024 * 1024
MAX_TOTAL_BYTES = 32 * 1024 * 1024
DEFAULT_MAX_OUTPUT_BYTES = 12 * 1024
MIN_OUTPUT_BYTES = 4 * 1024
MAX_OUTPUT_BYTES = 64 * 1024
MAX_LOCATIONS = 12
MAX_GREP_INPUT_BYTES = 64 * 1024
MAX_MATCH_LINES = 3
MAX_EXCERPT_RADIUS = 8
READ_CHUNK_BYTES = 64 * 1024
_FILE_BYTE_CAP = "file byte cap reached"
_TOTAL_BYTE_CAP = "total reference byte cap reached"
_PYTHON_SYNTAX_ERROR = "Python syntax errors"

# These are data/config formats, not source languages for the lexical scan.
_NON_SOURCE_LANGUAGES = {"config", "json", "yaml", "toml", "xml", "ini", "properties"}
# These languages and formats write `$` before a name, not inside it (shell and PHP variables, Kotlin, Groovy
# and Scala string templates), so `$NAME` also counts as NAME there.
_SIGIL_LANGUAGES = _NON_SOURCE_LANGUAGES | {"shell", "php", "kotlin", "groovy", "scala"}


class SymbolLookupError(ValueError):
    """Invalid symbol lookup request or unavailable repository."""


def _bounded_int(value: int, low: int, high: int) -> int:
    return max(low, min(high, int(value)))


def _bounded_timeout(value: float) -> float:
    timeout = float(value)
    if not math.isfinite(timeout):
        raise SymbolLookupError("timeout must be a finite number")
    return max(0.05, min(timeout, MAX_TIMEOUT))


def _valid_symbol(value: str) -> str:
    if not isinstance(value, str) or not value or len(value) > 256:
        raise SymbolLookupError("symbol must be a non-empty name of at most 256 characters")
    if any(ord(character) < 32 or ord(character) == 127 for character in value):
        raise SymbolLookupError("symbol must not contain control characters")
    return value


def _identifier_pattern(symbol: str, sigils: bool = False) -> re.Pattern[str]:
    # `$` is a valid identifier character in JS/TS but a sigil before shell and PHP
    # names; `\w` covers Unicode letters and underscores. Boundaries avoid
    # reporting `needle` inside `needle_more`.
    return re.compile((r"(?<!\w)" if sigils else r"(?<![\w$])") + re.escape(symbol) + r"(?![\w$])")





def _read_reference_text(
    root: Path,
    relative: str,
    fingerprint: dict[str, int],
    *,
    max_file_bytes: int,
    remaining_bytes: int,
    deadline: float,
) -> tuple[str | None, int, str | None]:
    """Read one checked source file, returning text only to the scanner."""
    path = root / relative
    if fingerprint["size"] > max_file_bytes:
        return None, 0, _FILE_BYTE_CAP
    if fingerprint["size"] > remaining_bytes:
        return None, 0, _TOTAL_BYTE_CAP
    try:
        file_fd = _open_regular_nofollow(root, relative)
        with os.fdopen(file_fd, "rb") as source:
            opened = os.fstat(source.fileno())
            if not stat.S_ISREG(opened.st_mode) or (
                opened.st_size, opened.st_ino, opened.st_mtime_ns, opened.st_ctime_ns
              ) != (
                fingerprint["size"], fingerprint["inode"],
                fingerprint["mtime_ns"], fingerprint["ctime_ns"],
              ):
                return None, 0, "file changed before reference scan"
            chunks: list[bytes] = []
            total = 0
            while total < opened.st_size:
                if time.monotonic() >= deadline:
                    return None, total, "reference scan timed out"
                block = source.read(min(READ_CHUNK_BYTES, opened.st_size - total))
                if not block:
                    return None, total, "file changed during reference scan"
                chunks.append(block)
                total += len(block)
            after_open = os.fstat(source.fileno())
            if (
                after_open.st_size, after_open.st_ino,
                  after_open.st_mtime_ns, after_open.st_ctime_ns,
            ) != (
                opened.st_size, opened.st_ino,
                opened.st_mtime_ns, opened.st_ctime_ns,
            ) or code_map._fingerprint(path) != fingerprint:
                return None, total, "file changed during reference scan"
    except (OSError, ValueError):
        return None, 0, "unsafe or unreadable files were skipped"

    data = b"".join(chunks)
    if b"\0" in data:
        return None, total, "binary files were skipped"
    try:
        return data.decode("utf-8-sig"), total, None
    except UnicodeDecodeError:
        return None, total, "non-UTF-8 files were skipped"


def _budget_exempt(git_root: Path, path: str) -> bool:
    """Whether _build excludes this inventory path, so it needs no file-budget slot."""
    # _candidate's first rule, checked without its filesystem calls: vendored folders can be most of the inventory.
    if code_map._private(path) or code_map._skip_dir(path, git_inventory=True):
        return True
    candidate, reason = code_map._candidate(git_root, path, git_inventory=True)
    return candidate is None and code_map._exclusion_reason(path, reason) is not None


def _grep_locations(
    data: bytes, *, unmatched: set[bytes] | None = None, match_limit: int | None = MAX_LOCATIONS,
    allow_partial: bool = False, excluded_paths: set[str] | None = None,
) -> list[tuple[str, str]]:
    """Decode Git grep matches and remove literals found in their raw text from unmatched."""
    if len(data) > MAX_GREP_INPUT_BYTES:
        raise SymbolLookupError("grep input exceeds 64 KiB")
    queries: list[tuple[str, str]] = []
    while data:
        if match_limit is not None and len(queries) == match_limit:
            raise SymbolLookupError(f"grep input exceeds {match_limit} matches")
        relative, _, rest = data.partition(b"\0")
        line, _, rest = rest.partition(b"\0")
        matched, newline, data = rest.partition(b"\n")
        if allow_partial and not newline:
            break
        if not relative or not newline or not re.fullmatch(rb"[1-9][0-9]{0,8}", line):
            raise SymbolLookupError("grep input requires git grep -n -z output")
        if b"\0" in matched:
            column, _, matched = matched.partition(b"\0")
            if not re.fullmatch(rb"[1-9][0-9]{0,8}", column) or b"\0" in matched:
                raise SymbolLookupError("grep input has an invalid column field")
        relative_path = os.fsdecode(relative)
        if excluded_paths is not None and (
            code_map._private(relative_path) or code_map._skip_dir(relative_path, git_inventory=True)
        ):
            excluded_paths.add(relative_path)
            continue
        if unmatched:
            unmatched.difference_update([literal for literal in unmatched if literal in matched])
        encoding = "utf-8-sig" if line == b"1" else "utf-8"
        matched_text = matched.removesuffix(b"\r").decode(encoding)
        queries.append((f"{relative_path}:{line.decode('ascii')}", matched_text))
    return queries


def _find_grep_matches(
    root: Path, literals: list[str], scopes: Sequence[str], *,
    excluded_paths: set[str],
    byte_limit: int = MAX_GREP_INPUT_BYTES, timeout: float = code_map.GIT_TIMEOUT,
    unmatched: set[bytes] | None = None,
) -> tuple[list[tuple[str, str]], int, bool]:
    """Search tracked Python files and return the same evidence as --grep-input."""
    if len(literals) > MAX_LOCATIONS or any(
        not literal.strip() or len(literal) > 256 or any(char in literal for char in "\x00\r\n")
        for literal in literals
    ):
        raise SymbolLookupError("provide up to 12 nonempty literals of at most 256 characters")
    patterns = [argument for literal in literals for argument in ("-e", literal)]
    env = os.environ.copy()
    for key in ("GIT_LITERAL_PATHSPECS", "GIT_GLOB_PATHSPECS", "GIT_NOGLOB_PATHSPECS", "GIT_ICASE_PATHSPECS"):
        env.pop(key, None)
    data = code_map._bounded_git_output(
        root, ["-c", "grep.fallbackToNoIndex=false", "grep", "-n", "-z", "-I", "-F",
               "--no-color", "--full-name", *patterns, "--", *scopes],
        byte_limit, keep_prefix=True, env=env, ok_statuses=(0, 1), timeout=timeout,
    )
    if data is None:
        raise SymbolLookupError("Git search failed or timed out")
    truncated = len(data) > byte_limit
    prefix = data[:byte_limit]
    matches = _grep_locations(prefix, unmatched=unmatched, match_limit=None, allow_partial=truncated,
                              excluded_paths=excluded_paths)
    return matches, len(prefix), truncated


def _search_literals(
    root: Path, literals: list[str], scopes: Sequence[str], byte_limit: int, timeout: float,
    excluded_paths: set[str],
) -> tuple[list[tuple[str, str]], set[bytes], int, bool]:
    """Reserve room for literals that a capped combined search did not reach."""
    deadline = time.monotonic() + timeout
    unmatched = {os.fsencode(literal) for literal in literals}
    reserve = byte_limit // 4 if len(unmatched) > 1 else 0
    matches, used, truncated = _find_grep_matches(
        root, literals, scopes, byte_limit=byte_limit - reserve, timeout=timeout, unmatched=unmatched,
        excluded_paths=excluded_paths,
    )
    if not truncated:
        return matches, unmatched, used, False

    pending = [literal for literal in dict.fromkeys(literals) if os.fsencode(literal) in unmatched]
    missing = set()
    for count, literal in enumerate(pending):
        remaining_time = deadline - time.monotonic()
        share = (byte_limit - used) // (len(pending) - count)
        if remaining_time <= 0 or share <= 0:
            break
        found, consumed, partial = _find_grep_matches(
            root, [literal], scopes, byte_limit=share, timeout=remaining_time,
            excluded_paths=excluded_paths,
        )
        matches.extend(found)
        used += consumed
        if not partial and not found:
            missing.add(os.fsencode(literal))
    return matches, missing, used, True


def _first_search_hits(matches: list[tuple[str, str]], literals: list[str]) -> list[tuple[str, str]]:
    """Keep the first line for each literal, sharing a line across terms."""
    remaining = set(literals)
    first = []
    for location, line in matches:
        found = {literal for literal in remaining if literal in line}
        if found:
            first.append((location, line))
            remaining.difference_update(found)
        if not remaining:
            break
    return first


def _limit_search_matches(
    matches: list[tuple[str, str]], first: list[tuple[str, str]],
) -> list[tuple[str, str]]:
    """Fill the location limit after reserving the first matches."""
    selected = dict(first)
    for location, line in matches:
        if len(selected) == MAX_LOCATIONS:
            break
        selected.setdefault(location, line)
    return list(selected.items())


def _python_glob_scopes(prefix: str = "") -> tuple[str, ...]:
    return (f":(top,glob){prefix}**/*.[pP][yY]", f":(top,glob){prefix}**/*.[pP][yY][wW]")


def _grep_scopes(raw: str, *, directory_root: Path | None = None) -> tuple[str, ...]:
    path = raw.removeprefix("./")
    allow_directory = directory_root is not None
    is_file = code_map._language(path) == "python"
    if allow_directory and not is_file:
        path = path.removesuffix("/")
    if ("\x00" in path or any(part in {"", ".", ".."} for part in path.split("/"))
            or (not allow_directory and not is_file)):
        label = "--find-in" if allow_directory else "--path"
        kind = "Python file or directory" if allow_directory else "Python file"
        hint = "" if allow_directory else ". Use --find-in for a directory."
        raise SymbolLookupError(f"{label} requires a repository-relative {kind}{hint}")
    if is_file and directory_root is not None:
        try:
            is_file = not stat.S_ISDIR((directory_root / path).lstat().st_mode)
        except (FileNotFoundError, NotADirectoryError):
            pass  # Git can report no matches for a missing scope.
    if is_file:
        return (f":(top,literal){path}",)
    escaped = re.sub(r"([\\*?\[\]])", r"\\\1", path)
    return _python_glob_scopes(f"{escaped}/")


def _scoped_grep_matches(
    root: Path, pairs: list[list[str]], excluded_paths: set[str],
) -> tuple[list[tuple[str, str]], list[int], Path, bool]:
    """Search scoped statements and report when the citation list is limited."""
    if len(pairs) > MAX_LOCATIONS:
        raise SymbolLookupError(f"--find-in accepts up to {MAX_LOCATIONS} pairs")
    git_root, note = code_map._git_root(root)
    if note is not None:
        raise SymbolLookupError("Git inventory is unavailable")
    groups: dict[tuple[str, ...], list[tuple[int, str]]] = {}
    for index, (path, literal) in enumerate(pairs, start=1):
        groups.setdefault(_grep_scopes(path, directory_root=git_root), []).append((index, literal))
    matches: dict[str, str] = {}
    first: list[tuple[str, str]] = []
    missing_pairs: list[int] = []
    remaining_bytes = MAX_GREP_INPUT_BYTES
    deadline = time.monotonic() + code_map.GIT_TIMEOUT
    truncated = False
    for count, (scopes, queries) in enumerate(groups.items()):
        remaining_time = deadline - time.monotonic()
        if remaining_time <= 0:
            raise SymbolLookupError("Git search timed out")
        literals = [literal for _, literal in queries]
        share = remaining_bytes // (len(groups) - count)
        found, unmatched, used_bytes, partial = _search_literals(
            git_root, literals, scopes, share, remaining_time, excluded_paths,
        )
        truncated |= partial
        missing_pairs.extend(index for index, literal in queries if os.fsencode(literal) in unmatched)
        first.extend(_first_search_hits(found, literals))
        remaining_bytes -= used_bytes
        for location, line in found:
            if matches.setdefault(location, line) != line:
                raise SymbolLookupError("source changed between scoped searches")
    selected = list(matches.items())
    if len(selected) > MAX_LOCATIONS:
        selected = _limit_search_matches(selected, first)
        truncated = True
    return selected, sorted(missing_pairs), git_root, truncated


def _lookup_locations(
    repo: str | os.PathLike[str],
    locations: Sequence[str | Sequence[str]],
    *,
    max_file_bytes: int = DEFAULT_MAX_FILE_BYTES,
    max_total_bytes: int = DEFAULT_MAX_TOTAL_BYTES,
    max_seconds: float = DEFAULT_TIMEOUT,
    excerpt_radius: int | None = None,
    grep_lines: Sequence[str] | None = None,
    git_root: Path | None = None,
    definitions: bool = False,
    skipped_paths: dict[str, str] | None = None,
) -> list[dict[str, Any]]:
    """Resolve an ordered batch of file:line strings and file/literal pairs."""
    queries = []
    for location in locations:
        if not isinstance(location, str):
            relative, literal = location
            queries.append((relative, literal))
            continue
        relative, _, raw_line = location.rpartition(":")
        if not re.fullmatch(r"[1-9][0-9]{0,8}", raw_line):
            raise SymbolLookupError("location must be a repository-relative Python path and positive line")
        queries.append((relative, int(raw_line)))
    return _lookup_python(
        repo, queries, max_file_bytes=max_file_bytes, max_total_bytes=max_total_bytes,
        max_seconds=max_seconds, excerpt_radius=excerpt_radius, grep_lines=grep_lines, git_root=git_root,
        definitions=definitions, skipped_paths=skipped_paths,
    )


def _lookup_python(
    repo: str | os.PathLike[str],
    queries: list[tuple[str, int | str]],
    *,
    max_file_bytes: int,
    max_total_bytes: int,
    max_seconds: float,
    excerpt_radius: int | None,
    grep_lines: Sequence[str] | None,
    git_root: Path | None,
    definitions: bool = False,
    skipped_paths: dict[str, str] | None = None,
) -> list[dict[str, Any]]:
    """Resolve names, exact lines or literal matches from a bounded source read."""
    if not 1 <= len(queries) <= MAX_LOCATIONS:
        raise SymbolLookupError(f"provide between one and {MAX_LOCATIONS} source queries")
    if excerpt_radius is not None and not 0 <= excerpt_radius <= MAX_EXCERPT_RADIUS:
        raise SymbolLookupError(f"--excerpt must be between 0 and {MAX_EXCERPT_RADIUS}")
    queries = [(relative.removeprefix("./"), selector) for relative, selector in queries]
    for relative, selector in queries:
        if any(part in {"", ".", ".."} for part in relative.split("/")):
            raise SymbolLookupError("lookup requires a repository-relative Python path")
        if isinstance(selector, str):
            _valid_symbol(selector)
            if definitions and not all(part.isidentifier() for part in selector.split(".")):
                raise SymbolLookupError("definition requires an exact dotted Python name")
    retain_lines = (excerpt_radius is not None or grep_lines is not None
                    or any(isinstance(selector, str) for _, selector in queries))
    if git_root is None:
        try:
            git_root, note = code_map._git_root(code_map._repo_path(repo))
        except code_map.CodeMapError as exc:
            raise SymbolLookupError(str(exc)) from exc
        if note is not None:
            raise SymbolLookupError("Git inventory is unavailable")
    root = git_root
    requested = sorted({relative for relative, _ in queries})
    raw_paths, _ = code_map._git_inventory(root, paths=requested)
    if raw_paths is None:
        raise SymbolLookupError("Git inventory is unavailable")
    limit = _bounded_int(max_file_bytes, 1, MAX_FILE_BYTES)
    remaining = _bounded_int(max_total_bytes, 1, MAX_TOTAL_BYTES)
    deadline = time.monotonic() + _bounded_timeout(max_seconds)
    inventory = {os.fsdecode(path) for path in raw_paths.split(b"\0") if path}

    def span_start(node, decorator_lines):
        decorators = getattr(node, "decorator_list", ())
        if not decorators:
            return getattr(node, "lineno", None)
        first = decorators[0].lineno
        # A parenthesized decorator expression can start after its @ line.
        index = bisect_right(decorator_lines, first)
        return decorator_lines[index - 1] if index else first

    def enclosing(node, line, decorator_lines):
        for child in ast.iter_child_nodes(node):
            start = span_start(child, decorator_lines)
            end = getattr(child, "end_lineno", None)
            if start is not None and end is not None and not start <= line <= end:
                continue
            inner = enclosing(child, line, decorator_lines)
            if isinstance(child, (ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
                return child, *inner
            if inner:
                return inner
        return ()

    def location(
        line: int, count: int, tree: ast.Module, lines: list[str], decorator_lines: list[int],
    ) -> dict[str, Any]:
        if time.monotonic() >= deadline:
            raise SymbolLookupError("Python source lookup timed out")
        try:
            scopes = enclosing(tree, line, decorator_lines)
        except RecursionError as exc:
            raise SymbolLookupError("Python scope nesting exceeds the lookup limit") from exc
        scope = scopes[-1] if scopes else None
        entry = {
            "line": line, "symbol": ".".join(node.name for node in scopes) or None,
            "start_line": span_start(scope, decorator_lines) if scope else None, "end_line": scope.end_lineno if scope else None,
        }
        if excerpt_radius is not None:
            first = max(1, line - excerpt_radius)
            last = min(count, line + excerpt_radius)
            entry["excerpt"] = [{"line": n, "text": lines[n - 1]} for n in range(first, last + 1)]
        return entry

    parsed: dict[str, tuple[int, ast.Module, list[str], list[int]]] = {}
    result = []
    for index, (relative, selector) in enumerate(queries):
        if skipped_paths is not None and relative in skipped_paths:
            continue
        if relative not in parsed:
            if relative not in inventory:
                raise SymbolLookupError("path is outside the available Git inventory")
            candidate, _ = code_map._candidate(root, relative, git_inventory=True)
            if candidate is None or candidate["language"] != "python":
                raise SymbolLookupError("lookup must name an available Python source file")
            source, consumed, note = _read_reference_text(
                root, relative, candidate["fingerprint"], max_file_bytes=limit,
                remaining_bytes=remaining, deadline=deadline,
            )
            if source is None:
                if skipped_paths is not None and note in (_FILE_BYTE_CAP, _TOTAL_BYTE_CAP):
                    skipped_paths[relative] = note
                    continue
                raise SymbolLookupError(note or "source file could not be read")
            remaining -= consumed
            try:
                lines = split_lines(source)
                decorator_lines = [number for number, text in enumerate(lines, 1)
                                   if text.lstrip().startswith("@")] if "@" in source else []
                parsed[relative] = len(lines), ast.parse(source), lines if retain_lines else [], decorator_lines
            except SyntaxError as exc:
                if skipped_paths is None:
                    raise SymbolLookupError("Python file could not be parsed") from exc
                skipped_paths[relative] = _PYTHON_SYNTAX_ERROR
                continue
            except (ValueError, RecursionError, MemoryError) as exc:
                raise SymbolLookupError("Python file could not be parsed") from exc
        count, tree, lines, decorator_lines = parsed[relative]
        if isinstance(selector, int):
            if selector > count:
                raise SymbolLookupError("line is outside the source file")
            if grep_lines is not None and lines[selector - 1] != grep_lines[index]:
                raise SymbolLookupError("source line changed since grep; rerun the search and lookup")
            result.append({"path": relative, **location(selector, count, tree, lines, decorator_lines)})
            continue
        if definitions:
            bare_name = selector.rsplit(".", 1)[-1]
            candidates = sorted(node.lineno for node in ast.walk(tree)
                                if isinstance(node, (ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef))
                                and node.name == bare_name)
            found = []
            for line in candidates:
                entry = location(line, count, tree, lines, decorator_lines)
                if entry["symbol"] == selector:
                    found.append(entry)
                    if len(found) > MAX_MATCH_LINES:
                        break
            result.append({"path": relative, "definition": selector, "locations": found[:MAX_MATCH_LINES],
                           "truncated": len(found) > MAX_MATCH_LINES})
        else:
            matches = (number for number, text in enumerate(lines, 1) if selector in text)
            matching_lines = list(islice(matches, MAX_MATCH_LINES + 1))
            result.append({
                "path": relative, "literal": selector,
                "locations": [location(line, count, tree, lines, decorator_lines) for line in matching_lines[:MAX_MATCH_LINES]],
                "truncated": len(matching_lines) > MAX_MATCH_LINES,
            })
        if time.monotonic() >= deadline:
            raise SymbolLookupError("Python source lookup timed out")
    return result


def _coverage_partial(model_coverage: dict[str, Any]) -> bool:
    return bool(
        model_coverage.get("truncated")
        or model_coverage.get("skipped")
        or model_coverage.get("limited")
        or model_coverage.get("pending")
        or model_coverage.get("excluded_source")
        or not model_coverage.get("inventory")
    )


def _fit_search_output(matches: list[dict[str, Any]], byte_limit: int) -> tuple[str, int]:
    """Prioritize complete verified locations over surrounding source text."""
    exact_lines = [
        {**match, "excerpt": [line for line in match["excerpt"] if line["line"] == match["line"]]}
        for match in matches
    ]
    encoded = json.dumps(exact_lines, ensure_ascii=True, separators=(",", ":"))
    if len(encoded) <= byte_limit:
        return encoded, len(matches)

    rows = []
    remaining = byte_limit - 2  # JSON array brackets.
    for match in matches:
        location = {key: value for key, value in match.items() if key != "excerpt"}
        row = json.dumps(location, ensure_ascii=True, separators=(",", ":"))
        size = len(row) + bool(rows)  # Include the comma between rows.
        if size <= remaining:
            rows.append(row)
            remaining -= size
    return "[" + ",".join(rows) + "]", len(rows)


def _serialized_size(result: dict[str, Any]) -> int:
    """Measure JSON including a stable, exact coverage byte count."""
    output = result["coverage"]["output"]
    output["bytes"] = 0
    for _ in range(4):
        size = len(json.dumps(result, ensure_ascii=True, separators=(",", ":")).encode("utf-8"))
        if output["bytes"] == size:
            return size
        output["bytes"] = size
    return len(json.dumps(result, ensure_ascii=True, separators=(",", ":")).encode("utf-8"))


def _fit_output(result: dict[str, Any], byte_limit: int) -> dict[str, Any]:
    """Fit JSON by binary-searching whole result prefixes; never alter paths."""
    coverage = result["coverage"]
    output = {"max_bytes": byte_limit, "bytes": 0, "truncated": False}
    coverage["output"] = output
    if _serialized_size(result) <= byte_limit:
        return result

    original_references = list(result["references"])
    original_definitions = list(result["definitions"])
    output["truncated"] = True
    coverage["partial"] = True

    def candidate(ref_count: int, def_count: int, *, trim_refs: bool, trim_defs: bool) -> dict[str, Any]:
        value = dict(result)
        value["references"] = original_references[:ref_count]
        value["definitions"] = original_definitions[:def_count]
        value_coverage = dict(coverage)
        value["coverage"] = value_coverage
        value_coverage["output"] = dict(output)
        value_coverage["references"] = dict(coverage["references"])
        value_coverage["definitions"] = dict(coverage["definitions"])
        value_coverage["partial"] = True
        if trim_refs:
            value_coverage["references"]["complete"] = False
            value_coverage["references"]["results_truncated"] = True
        if trim_defs:
            value_coverage["definitions"]["model_complete"] = False
            value_coverage["definitions"]["results_truncated"] = True
        _serialized_size(value)
        return value

    def largest_prefix(
        upper: int, *, trim_refs: bool, trim_defs: bool, ref_count: int, def_count: int
    ) -> tuple[int, dict[str, Any] | None]:
        low, high, best = 0, upper, -1
        best_value = None
        while low <= high:
            middle = (low + high) // 2
            candidate_ref_count = middle if trim_refs else ref_count
            candidate_def_count = middle if trim_defs else def_count
            value = candidate(
                candidate_ref_count,
                candidate_def_count,
                trim_refs=trim_refs,
                trim_defs=trim_defs,
            )
            if value["coverage"]["output"]["bytes"] <= byte_limit:
                best = middle
                best_value = value
                low = middle + 1
            else:
                high = middle - 1
        return best, best_value

    current: dict[str, Any]
    if original_references:
        # Search only prefixes shorter than the full list, keeping the truncation
        # flags constant throughout the binary search.
        _, current = largest_prefix(
            len(original_references) - 1,
            trim_refs=True,
            trim_defs=False,
            ref_count=len(original_references),
            def_count=len(original_definitions),
        )
        if current is not None:
            return current
        current = candidate(0, len(original_definitions), trim_refs=True, trim_defs=False)
    else:
        current = candidate(0, len(original_definitions), trim_refs=False, trim_defs=False)

    if current["coverage"]["output"]["bytes"] > byte_limit and original_definitions:
        _, definitions_value = largest_prefix(
            len(original_definitions) - 1,
            trim_refs=bool(original_references),
            trim_defs=True,
            ref_count=0,
            def_count=len(original_definitions),
        )
        if definitions_value is not None:
            return definitions_value
        current = candidate(0, 0, trim_refs=bool(original_references), trim_defs=True)

    while current["coverage"]["output"]["bytes"] > byte_limit:
        ref_notes = current["coverage"]["references"].get("notes", [])
        model_notes = current["coverage"]["definitions"]["model"].get("notes", [])
        if ref_notes:
            current["coverage"]["references"]["notes"] = ref_notes[:-1]
        elif model_notes:
            current["coverage"]["definitions"]["model"]["notes"] = model_notes[:-1]
        else:
            break
        _serialized_size(current)
    if current["coverage"]["output"]["bytes"] > byte_limit:
        compact_coverage = current["coverage"]
        compact_coverage["definitions"].pop("limitations", None)
        compact_coverage["definitions"].pop("analysis_counts", None)
        compact_coverage["definitions"]["model"].pop("notes", None)
        compact_coverage["references"].pop("notes", None)
        compact_coverage["semantics"] = {
            "definitions": "exact code-map name matches; recall is partial",
            "references": "lexical occurrences, not semantic",
        }
        compact_coverage["limits"]["model_timeout"] = "outside reference timeout"
        _serialized_size(current)
    if current["coverage"]["output"]["bytes"] > byte_limit:
        raise SymbolLookupError("fixed lookup metadata exceeds the output byte cap")
    return current


def lookup_symbols(
    repo: str | os.PathLike[str],
    symbol: str,
    *,
    max_files: int = DEFAULT_MAX_FILES,
    max_results: int = DEFAULT_MAX_RESULTS,
    max_seconds: float = DEFAULT_TIMEOUT,
    max_file_bytes: int = DEFAULT_MAX_FILE_BYTES,
    max_total_bytes: int = DEFAULT_MAX_TOTAL_BYTES,
    max_output_bytes: int = DEFAULT_MAX_OUTPUT_BYTES,
    no_cache: bool = False,
    reference_cache: IdentifierPostingsCache | None = None,
) -> dict[str, Any]:
    """Return exact code-map definitions and bounded lexical occurrence locations.

    The default reads, but never writes, the existing code-map cache. Set
    ``no_cache=True`` to bypass it entirely. ``max_seconds`` is a deadline for
    the reference scan only; code-map model/cache initialization happens before
    that phase and follows code_map's own bounded Git/file/read limits.
    """
    name = _valid_symbol(symbol)
    file_limit = _bounded_int(max_files, 1, MAX_FILES)
    result_limit = _bounded_int(max_results, 1, MAX_RESULTS)
    file_byte_limit = _bounded_int(max_file_bytes, 1, MAX_FILE_BYTES)
    total_byte_limit = _bounded_int(max_total_bytes, 1, MAX_TOTAL_BYTES)
    output_byte_limit = _bounded_int(max_output_bytes, MIN_OUTPUT_BYTES, MAX_OUTPUT_BYTES)
    timeout = _bounded_timeout(max_seconds)
    patterns = (_identifier_pattern(name), _identifier_pattern(name, sigils=True))

    try:
        root = code_map._repo_path(repo)
        # Reuse the existing, Git-ignore-aware inventory to locate the canonical
        # worktree root. No non-Git filesystem walk is attempted.
        git_root, head, paths, inventory_notes = code_map._git_context(root)
        inventory = paths or []
        excluded = dropped = 0
        # _build never reads source files with private names or in vendored folders.
        unscanned_source = sum(
            1 for path in inventory
            if code_map._language(path) not in _NON_SOURCE_LANGUAGES | {None}
            and (code_map._private(path) or code_map._skip_dir(path, git_inventory=True))
        )
        if len(inventory) > file_limit:
            normalized_name = "".join(character for character in name.casefold() if character.isalnum())
            preferred: list[str] = []
            remaining: list[str] = []
            for path in inventory:
                normalized_path = "".join(character for character in path.casefold() if character.isalnum())
                group = preferred if normalized_name and normalized_name in normalized_path else remaining
                full = len(group) >= file_limit
                # Classify a path only while it could take a budget slot or prove truncation;
                # once a file is dropped, later overflow counts as skipped without a check.
                if (not full or not dropped) and _budget_exempt(git_root, path):
                    excluded += 1
                elif full:
                    dropped += 1
                else:
                    group.append(path)
            bounded_inventory = (preferred + remaining)[:file_limit]
            dropped += len(preferred) + len(remaining) - len(bounded_inventory)
        else:
            bounded_inventory = inventory
        model_notes = list(inventory_notes)
        if dropped:
            model_notes.append(f"symbol lookup inventory capped at {file_limit} files")
        if unscanned_source:
            model_notes.append(f"{unscanned_source} source files with private names or in vendored folders were not scanned")
        # Lookup needs every outline in the bounded inventory, without a ranked focus.
        model = code_map._build(
            git_root, head, bounded_inventory, model_notes, name, file_limit,
            use_cache=not no_cache, refresh=False, write_cache=False, rank_focus=False,
        )
        model["coverage"]["inventory"] = len(inventory)
        model["coverage"]["excluded"] += excluded
        model["coverage"]["excluded_source"] = unscanned_source
        if dropped:
            model["coverage"]["skipped"] += dropped
            model["coverage"]["truncated"] = True
    except (code_map.CodeMapError, OSError, ValueError, ImportError) as exc:
        raise SymbolLookupError(str(exc)) from exc

    model_coverage = model.get("coverage", {})
    model_files = model.get("files", [])
    analysis_counts: dict[str, int] = {}
    metadata_only_files = 0
    heuristic_outline_files = 0
    incomplete_outline_files = 0
    for record in model_files:
        if record.get("language") in _NON_SOURCE_LANGUAGES:
            continue
        analysis = record.get("analysis", "metadata")
        analysis_counts[analysis] = analysis_counts.get(analysis, 0) + 1
        if analysis == "metadata":
            metadata_only_files += 1
        elif analysis != "python-ast":
            heuristic_outline_files += 1
        elif any(note and not note.startswith("local import links capped") for note in record.get("outline_note", "").split("; ")):
            # A failed or capped syntax-tree outline can miss definitions.
            incomplete_outline_files += 1
    definitions: list[dict[str, Any]] = []
    definitions_truncated = False
    for record in model_files:
        path = record.get("path")
        if not isinstance(path, str):
            continue
        symbols = record.get("symbols", [])
        if not isinstance(symbols, list):
            continue
        for item in symbols:
            if not isinstance(item, dict):
                continue
            qualified_name = item.get("qualified_name")
            if item.get("name") != name and qualified_name != name:
                continue
            definition: dict[str, Any] = {
                "path": path,
                "line": item.get("line"),
                "kind": item.get("kind"),
            }
            if isinstance(item.get("signature"), str):
                definition["signature"] = item["signature"]
            if isinstance(qualified_name, str):
                definition["qualified_name"] = qualified_name
            if len(definitions) == result_limit:
                definitions_truncated = True
                break
            definitions.append(definition)
        if definitions_truncated:
            break
    definitions.sort(key=lambda item: (item["path"], item["line"], item["kind"]))

    deadline = time.monotonic() + timeout
    references: list[dict[str, Any]] = []
    scanned_files = 0
    cached_files = 0
    reference_bytes = 0
    reference_considered = 0
    reference_notes: list[str] = []
    references_truncated = False
    reference_timed_out = False
    # Data and config files can name a symbol too (entry points, manifests), so they are scanned after source.
    for record in sorted(model_files[:file_limit], key=lambda item: item.get("language") in _NON_SOURCE_LANGUAGES):
        if time.monotonic() >= deadline:
            reference_timed_out = True
            reference_notes.append("reference scan timed out")
            break
        relative = record.get("path")
        if not isinstance(relative, str):
            continue
        candidate, reason = code_map._candidate(git_root, relative, git_inventory=True)
        if candidate is None:
            if "changed, private, symlink, or unsupported paths were skipped" not in reference_notes:
                reference_notes.append("changed, private, symlink, or unsupported paths were skipped")
            continue
        remaining = total_byte_limit - reference_considered
        fingerprint = candidate["fingerprint"]
        sigils = candidate["language"] in _SIGIL_LANGUAGES
        loaded: dict[str, Any] = {}
        lines = None
        if reference_cache is not None and not no_cache and fingerprint["size"] <= file_byte_limit and fingerprint["size"] <= remaining:
            def load_text() -> str:
                text, consumed, note = _read_reference_text(
                    git_root, relative, fingerprint, max_file_bytes=file_byte_limit,
                    remaining_bytes=remaining, deadline=deadline,
                )
                loaded.update(text=text, consumed=consumed, note=note)
                if text is None:
                    raise OSError(note or "source unavailable")
                return text
            try:
                lines = reference_cache.lookup(git_root, relative, fingerprint, load_text, name, deadline=deadline, sigils=sigils)
            except (UnsupportedSymbolError, OSError):
                pass
        if time.monotonic() >= deadline:
            if loaded:
                reference_bytes += loaded.get("consumed", 0)
                reference_considered += loaded.get("consumed", 0)
            reference_timed_out = True
            reference_notes.append("reference scan timed out")
            break
        if lines is not None:
            consumed = loaded.get("consumed", 0)
            reference_bytes += consumed
            reference_considered += consumed if loaded else fingerprint["size"]
            if code_map._fingerprint(git_root / relative) != fingerprint:
                if "file changed during reference scan" not in reference_notes:
                    reference_notes.append("file changed during reference scan")
                continue
            if not loaded:
                cached_files += 1
            scanned_files += 1
            for line_number in lines:
                if len(references) == result_limit:
                    references_truncated = True
                    break
                references.append({"path": relative, "line": line_number})
            if references_truncated:
                break
            continue
        if time.monotonic() >= deadline:
            reference_timed_out = True
            reference_notes.append("reference scan timed out")
            break
        if loaded:
            text, consumed, note = loaded["text"], loaded["consumed"], loaded["note"]
        else:
            text, consumed, note = _read_reference_text(
                git_root, relative, fingerprint, max_file_bytes=file_byte_limit,
                remaining_bytes=remaining, deadline=deadline,
            )
        reference_bytes += consumed
        reference_considered += consumed
        if note:
            if note == "reference scan timed out":
                reference_timed_out = True
            if note not in reference_notes:
                reference_notes.append(note)
            if reference_timed_out:
                break
            continue
        scanned_files += 1
        assert text is not None
        # An exact occurrence needs the literal text before identifier boundaries matter.
        if name not in text and time.monotonic() < deadline:
            continue
        pattern = patterns[sigils]
        for line_number, line in enumerate(split_lines(text), 1):
            if time.monotonic() >= deadline:
                reference_timed_out = True
                if "reference scan timed out" not in reference_notes:
                    reference_notes.append("reference scan timed out")
                break
            if pattern.search(line):
                if len(references) == result_limit:
                    references_truncated = True
                    break
                references.append({"path": relative, "line": line_number})
        if reference_timed_out or references_truncated:
            break

    model_coverage_partial = (
        _coverage_partial(model_coverage)
        or len(model_files) < model_coverage.get("indexed", len(model_files))
    )
    definitions_partial = (
        model_coverage_partial
        or definitions_truncated
        or metadata_only_files > 0
        or heuristic_outline_files > 0
        or incomplete_outline_files > 0
    )
    references_partial = (
        model_coverage_partial
        or references_truncated
        or reference_timed_out
        or bool(reference_notes)
    )
    result = {
        "query": name,
        "definitions": definitions,
        "references": references,
        "coverage": {
            "partial": definitions_partial or references_partial,
            "definitions": {
                "model_complete": not model_coverage_partial and not definitions_truncated,
                "semantic_recall_complete": False,
                "files_indexed": len(model_files),
                "metadata_only_files": metadata_only_files,
                "heuristic_outline_files": heuristic_outline_files,
                "incomplete_outline_files": incomplete_outline_files,
                "analysis_counts": analysis_counts,
                "results_truncated": definitions_truncated,
                "limitations": [
                    "Definitions are exact-name matches only against available code-map symbols.",
                    "Metadata-only files contribute no definitions; heuristic, failed or capped outlines can miss declarations.",
                    "No semantic/LSP definition-recall guarantee is made.",
                ],
                "model": {
                    "inventory": model_coverage.get("inventory", 0),
                    "indexed": model_coverage.get("indexed", len(model_files)),
                    "skipped": model_coverage.get("skipped", 0),
                    "excluded": model_coverage.get("excluded", 0),
                    "excluded_source": model_coverage.get("excluded_source", 0),
                    "pending": model_coverage.get("pending", 0),
                    "limited": model_coverage.get("limited", 0),
                    "truncated": bool(model_coverage.get("truncated")),
                    "notes": model_coverage.get("notes", []),
                },
            },
            "references": {
                "complete": not references_partial,
                "files_scanned": scanned_files,
                "files_considered": len(model_files),
                "bytes_read": reference_bytes,
                "bytes_considered": reference_considered,
                "cached_files": cached_files,
                "results_truncated": references_truncated,
                "timed_out": reference_timed_out,
                "notes": reference_notes,
            },
            "limits": {
                "max_files": file_limit,
                "max_results_per_kind": result_limit,
                "reference_timeout_seconds": timeout,
                "max_file_bytes": file_byte_limit,
                "max_total_reference_bytes": total_byte_limit,
                "max_output_bytes": output_byte_limit,
                "model_timeout": "code_map's own bounded initialization; not included in reference timeout",
            },
            "semantics": {
                "definitions": "exact bare or qualified name matches from code-map metadata; availability depends on indexed language outlines",
                "references": "lexical identifier-boundary occurrences, not semantic references; declarations, comments, and strings may match",
            },
        },
    }
    return _fit_output(result, output_byte_limit)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Look up definitions, lexical occurrences and Python source locations. Use --excerpt to include source lines."
    )
    parser.add_argument("--repo", required=True, metavar="PATH")
    parser.add_argument("--symbol", metavar="NAME", help="look up a symbol by name")
    parser.add_argument("--location", dest="source_queries", action="append", metavar="FILE:LINE",
                        help="find the enclosing Python class or function (repeatable)")
    parser.add_argument("--match", dest="source_queries", action="append", nargs=2, metavar=("FILE", "LITERAL"),
                        help="find literal text and its enclosing Python symbol (can be mixed with --location)")
    parser.add_argument("--definition", action="append", nargs=2, metavar=("FILE", "NAME"),
                        help="find an exact qualified Python definition in a named file (repeatable)")
    parser.add_argument("--grep-input", action="store_true",
                        help="read up to 12 Git grep -n -z matches from standard input")
    parser.add_argument("--find", action="append", metavar="LITERAL",
                        help="find exact text in tracked Python files and verify its enclosing symbol (repeatable)")
    parser.add_argument("--find-in", action="append", nargs=2, metavar=("PATH", "LITERAL"),
                        help="search one Python file or directory for a literal (repeatable)")
    parser.add_argument("--path", action="append", default=[], metavar="FILE",
                        help="restrict --find to an exact repository-relative Python file (repeatable)")
    parser.add_argument("--excerpt", type=int, metavar="LINES",
                        help="include the selected line and up to 8 lines on each side of a Python location")
    parser.add_argument("--max-files", type=int, default=DEFAULT_MAX_FILES)
    parser.add_argument("--max-results", type=int, default=DEFAULT_MAX_RESULTS)
    parser.add_argument(
        "--timeout", type=float, default=DEFAULT_TIMEOUT,
        help="seconds for the reference scan only; model/cache initialization is separate",
    )
    parser.add_argument("--max-file-bytes", type=int, default=DEFAULT_MAX_FILE_BYTES)
    parser.add_argument("--max-total-bytes", type=int, default=DEFAULT_MAX_TOTAL_BYTES)
    parser.add_argument("--max-output-bytes", type=int, default=DEFAULT_MAX_OUTPUT_BYTES)
    cache_options = parser.add_mutually_exclusive_group()
    cache_options.add_argument(
        "--no-cache", action="store_true",
        help="bypass the code-map cache (default is to use it read-only)",
    )
    cache_options.add_argument(
        "--service", action="store_true",
        help="start or reuse the authorized local service and its memory-only postings cache",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = _parser()
    args = parser.parse_args(argv)
    search = args.find is not None or args.find_in is not None
    if sum((args.symbol is not None, args.source_queries is not None, args.definition is not None, args.grep_input,
            args.find is not None, args.find_in is not None)) != 1:
        parser.error("use --symbol, --definition, --find, --find-in, --grep-input, or a batch of --location and --match queries")
    if args.path and args.find is None:
        parser.error("--path requires --find")
    python_lookup = args.symbol is None
    missing = []
    search_truncated = False
    limited_excerpts = False
    excluded_paths: set[str] = set()
    skipped_paths: dict[str, str] = {}
    try:
        if args.excerpt is not None and not python_lookup:
            raise SymbolLookupError("--excerpt requires a Python source lookup")
        if args.excerpt is not None and not 0 <= args.excerpt <= MAX_EXCERPT_RADIUS:
            raise SymbolLookupError(f"--excerpt must be between 0 and {MAX_EXCERPT_RADIUS}")
        if args.service and python_lookup:
            raise SymbolLookupError("--service requires --symbol")
        options = {
            "max_files": args.max_files, "max_results": args.max_results,
            "max_seconds": args.timeout, "max_file_bytes": args.max_file_bytes,
            "max_total_bytes": args.max_total_bytes, "max_output_bytes": args.max_output_bytes,
        }
        if python_lookup:
            queries = args.definition or args.source_queries
            grep_lines = None
            git_root = None
            excerpt = args.excerpt
            if search or args.grep_input:
                if search:
                    root = code_map._repo_path(args.repo)
                    if args.find_in is not None:
                        matches, missing, git_root, search_truncated = _scoped_grep_matches(
                            root, args.find_in, excluded_paths,
                        )
                    else:
                        if len(args.path) > MAX_LOCATIONS:
                            raise SymbolLookupError(f"--path accepts up to {MAX_LOCATIONS} files")
                        scopes = [scope for path in args.path for scope in _grep_scopes(path)]
                        scopes = scopes or _python_glob_scopes()
                        literals = [os.fsencode(literal) for literal in args.find]
                        matches, unmatched, _, search_truncated = _search_literals(
                            root, args.find, scopes, MAX_GREP_INPUT_BYTES, code_map.GIT_TIMEOUT, excluded_paths,
                        )
                        if len(literals) > 1 and unmatched:
                            missing = [index for index, literal in enumerate(literals, start=1) if literal in unmatched]
                        if len(matches) > MAX_LOCATIONS:
                            matches = _limit_search_matches(matches, _first_search_hits(matches, args.find))
                            search_truncated = True
                    if excerpt is None:
                        excerpt = 0
                else:
                    matches = _grep_locations(sys.stdin.buffer.read(MAX_GREP_INPUT_BYTES + 1))
                queries = [location for location, _ in matches]
                grep_lines = [line for _, line in matches]
            result = [] if search and not queries else _lookup_locations(
                args.repo, queries,
                max_file_bytes=args.max_file_bytes, max_total_bytes=args.max_total_bytes, max_seconds=args.timeout,
                excerpt_radius=excerpt, grep_lines=grep_lines, git_root=git_root, definitions=args.definition is not None,
                skipped_paths=skipped_paths if search else None,
            )
            if skipped_paths and not result:
                reasons = dict.fromkeys(
                    "matching Python files could not be parsed" if reason == _PYTHON_SYNTAX_ERROR else reason
                    for reason in skipped_paths.values()
                )
                raise SymbolLookupError("; ".join(reasons))
        elif args.service:
            try:
                try:
                    from . import map_server
                except ImportError:
                    import map_server
                result = map_server.get_lookup(args.repo, args.symbol, **options)
            except (OSError, ValueError, ImportError) as exc:
                print(f"local lookup service unavailable; using a read-only scan: {exc}", file=sys.stderr)
                result = lookup_symbols(args.repo, args.symbol, **options)
        else:
            result = lookup_symbols(args.repo, args.symbol, no_cache=args.no_cache, **options)
        encoded = json.dumps(result, ensure_ascii=True, separators=(",", ":"))
        visible_matches = len(result)
        byte_limit = _bounded_int(args.max_output_bytes, MIN_OUTPUT_BYTES, MAX_OUTPUT_BYTES)
        if python_lookup and len(encoded) > byte_limit:
            if search:
                encoded, visible_matches = _fit_search_output(result, byte_limit)
                limited_excerpts = True
                search_truncated |= visible_matches < len(result)
            if not search or not visible_matches:
                raise SymbolLookupError("Python source lookup exceeds the output byte cap")
    except (SymbolLookupError, OSError, ValueError) as exc:
        print(f"symbol-lookup error: {exc}", file=sys.stderr)
        return 2
    if search_truncated:
        print(f"symbol-lookup: showing {visible_matches} matches. Narrow the literals or scopes for more specific results.",
              file=sys.stderr)
    if limited_excerpts:
        print("symbol-lookup: limited source excerpts to fit the output byte cap.", file=sys.stderr)
    if excluded_paths:
        print(f"symbol-lookup: skipped {len(excluded_paths)} excluded source paths.", file=sys.stderr)
    skipped_counts = Counter(skipped_paths.values())
    syntax_errors = skipped_counts.pop(_PYTHON_SYNTAX_ERROR, 0)
    if syntax_errors:
        print(f"symbol-lookup: skipped source files with Python syntax errors ({syntax_errors}).", file=sys.stderr)
    for reason, count in skipped_counts.items():
        print(f"symbol-lookup: skipped {count} source file(s): {reason}.", file=sys.stderr)
    if missing:
        label = "--find-in pairs" if args.find_in else "--find terms"
        indices = ", ".join(map(str, missing))
        print(f"symbol-lookup: no matches for {label} {indices}", file=sys.stderr)
    sys.stdout.write(encoded + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
