"""Bounded in-memory lexical identifier postings for a long-lived daemon.

The cache stores token-to-line postings only, never source text. Callers remain
responsible for opening files safely and validating *fingerprint* before the
loader returns text. ``lookup`` returns ``None`` when the file is too large to
index, so the caller can use its regular uncached scan. Only simple identifiers
matching Python ``[\\w$]+`` are supported; punctuation raises
:class:`UnsupportedSymbolError` for the caller to handle via its normal path.
"""

from __future__ import annotations

import os
import posixpath
import re
import sys
import threading
import time
from collections import OrderedDict
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Callable

try:
    from .language_outlines import split_lines
except ImportError:  # direct script execution
    from language_outlines import split_lines


_TOKEN_RE = re.compile(r"[\w$]+")
_MAX_FILE_TOKENS = 32_768
_MAX_FILE_IDENTIFIERS = 8_192
_MAX_IDENTIFIER_CHARS = 256


class UnsupportedSymbolError(ValueError):
    """Raised when a query is not a simple ``[\\w$]+`` identifier."""


@dataclass
class _Entry:
    fingerprint: object
    postings: dict[str, tuple[int, ...]]
    size: int


@dataclass
class _Flight:
    fingerprint: object
    done: threading.Event


def _freeze(value: object) -> object:
    """Make ordinary caller fingerprints stable and comparable as cache keys."""
    if isinstance(value, Mapping):
        pairs = [(_freeze(key), _freeze(item)) for key, item in value.items()]
        return ("mapping", tuple(sorted(pairs, key=repr)))
    if isinstance(value, (tuple, list)):
        return (type(value).__name__, tuple(_freeze(item) for item in value))
    if isinstance(value, (set, frozenset)):
        return (type(value).__name__, tuple(sorted((_freeze(item) for item in value), key=repr)))
    if value is None or isinstance(value, (bool, int, float, str, bytes)):
        return (type(value).__name__, value)
    raise TypeError("fingerprint must contain only scalar values and containers")


def _deep_size(value: object, seen: set[int] | None = None) -> int:
    """Approximate retained Python object size, including nested fingerprint data."""
    if seen is None:
        seen = set()
    identity = id(value)
    if identity in seen:
        return 0
    seen.add(identity)
    size = sys.getsizeof(value)
    if isinstance(value, dict):
        size += sum(_deep_size(key, seen) + _deep_size(item, seen) for key, item in value.items())
    elif isinstance(value, (tuple, list, set, frozenset)):
        size += sum(_deep_size(item, seen) for item in value)
    return size


def _canonical_key(root: os.PathLike[str] | str, relative: str) -> tuple[str, str]:
    try:
        canonical_root = os.path.abspath(os.fspath(root))
    except (TypeError, ValueError, OSError) as error:
        raise ValueError("root must be a filesystem path") from error
    if not isinstance(relative, str) or not relative or "\x00" in relative:
        raise ValueError("relative must be a non-empty path")
    # Paths supplied by repository scanners use POSIX separators. Reject dot
    # components instead of silently aliasing them to a different cache key.
    if relative.startswith("/") or any(part in {"", ".", ".."} for part in relative.split("/")):
        raise ValueError("relative must be a normalized root-relative path")
    return canonical_root, posixpath.normpath(relative)


def _build_postings(text: str, deadline: float | None = None, sigils: bool = False) -> dict[str, tuple[int, ...]] | None:
    """Build deduplicated line postings, returning None past conservative caps."""
    accumulated: dict[str, list[int]] = {}
    token_count = 0
    for line_number, line in enumerate(split_lines(text), 1):
        if deadline is not None and time.monotonic() >= deadline:
            return None
        seen_on_line: set[str] = set()
        for match in _TOKEN_RE.finditer(line):
            token = match.group(0)
            if len(token) > _MAX_IDENTIFIER_CHARS:
                return None
            names = (token,)
            if sigils and "$" in token:
                # The scan's sigil boundary lets a name start after any `$`, as in `backup_$NAME` or `$$NAME`.
                names += tuple(token[index + 1:] for index, char in enumerate(token) if char == "$")
            # Count names, not words, so a word dense with `$` cannot multiply the work and memory the cap bounds.
            token_count += len(names)
            if token_count > _MAX_FILE_TOKENS:
                return None
            for name in names:
                if not name or name in seen_on_line:
                    continue
                seen_on_line.add(name)
                lines = accumulated.get(name)
                if lines is None:
                    if len(accumulated) >= _MAX_FILE_IDENTIFIERS:
                        return None
                    accumulated[name] = [line_number]
                else:
                    lines.append(line_number)
    return {token: tuple(lines) for token, lines in accumulated.items()}


class IdentifierPostingsCache:
    """Thread-safe, bounded cache of per-file lexical identifier line postings.

    ``lookup(root, relative, fingerprint, text_or_loader, symbol)`` returns a
    tuple of one-based line numbers, or ``None`` when caching/scanning should
    fall back (currently only for a file beyond the configured size or index
    limits). ``text_or_loader`` may be source text or a zero-argument callable;
    it is invoked only on a cache miss. With ``sigils=True`` a name may also
    start after any ``$`` in a word. Fingerprint or ``sigils`` changes evict the
    prior postings for that path. Call :meth:`invalidate` when a path is deleted.
    """

    def __init__(
        self,
        *,
        max_bytes: int = 8 * 1024 * 1024,
        max_file_bytes: int = 256 * 1024,
        max_entries: int = 512,
    ) -> None:
        if max_bytes < 1 or max_file_bytes < 1 or max_entries < 1:
            raise ValueError("cache limits must be positive")
        self.max_bytes = int(max_bytes)
        self.max_file_bytes = int(max_file_bytes)
        self.max_entries = int(max_entries)
        self._entries: OrderedDict[tuple[str, str], _Entry] = OrderedDict()
        self._inflight: dict[tuple[str, str], _Flight] = {}
        self._memory_bytes = 0
        self._closed = False
        self._lock = threading.RLock()

    @property
    def memory_bytes(self) -> int:
        """Estimated retained bytes in cached entries."""
        with self._lock:
            return self._memory_bytes

    @property
    def cached_file_count(self) -> int:
        with self._lock:
            return len(self._entries)

    def lookup(
        self,
        root: os.PathLike[str] | str,
        relative: str,
        fingerprint: object,
        text_or_loader: str | Callable[[], str],
        symbol: str,
        *,
        deadline: float | None = None,
        sigils: bool = False,
    ) -> tuple[int, ...] | None:
        """Return exact lexical match lines, loading text only on a cache miss."""
        if not isinstance(symbol, str) or not _TOKEN_RE.fullmatch(symbol):
            raise UnsupportedSymbolError("symbol must match the simple identifier pattern [\\w$]+")
        if not isinstance(text_or_loader, str) and not callable(text_or_loader):
            raise TypeError("text_or_loader must be text or a zero-argument callable")
        key = _canonical_key(root, relative)
        frozen_fingerprint = _freeze((fingerprint, sigils))

        while True:
            with self._lock:
                if self._closed:
                    return None
                entry = self._entries.get(key)
                if entry is not None:
                    if entry.fingerprint == frozen_fingerprint:
                        self._entries.move_to_end(key)
                        return entry.postings.get(symbol, ())
                    self._memory_bytes -= entry.size
                    del self._entries[key]

                flight = self._inflight.get(key)
                if flight is not None and flight.fingerprint == frozen_fingerprint:
                    wait_for = flight.done
                    leader = False
                else:
                    if flight is not None:
                        self._inflight.pop(key, None)
                        flight.done.set()
                    flight = _Flight(frozen_fingerprint, threading.Event())
                    self._inflight[key] = flight
                    wait_for = flight.done
                    leader = True
            if not leader:
                remaining = None if deadline is None else max(0.0, deadline - time.monotonic())
                if not wait_for.wait(timeout=remaining):
                    return None
                continue
            break

        try:
            text = text_or_loader() if callable(text_or_loader) else text_or_loader
            if not isinstance(text, str):
                raise TypeError("text loader must return str")
            if len(text) > self.max_file_bytes:
                postings = None
            else:
                encoded_size = len(text.encode("utf-8", errors="surrogatepass"))
                postings = (
                    None
                    if encoded_size > self.max_file_bytes
                    else _build_postings(text, deadline, sigils)
                )
            result = None if postings is None else postings.get(symbol, ())
            entry_size = 0
            if postings is not None:
                entry_size = (
                    sys.getsizeof(postings)
                    + sys.getsizeof(key)
                    + sys.getsizeof(key[0])
                    + sys.getsizeof(key[1])
                    + sys.getsizeof(frozen_fingerprint)
                    + _deep_size(frozen_fingerprint)
                    + sum(_deep_size(token) + _deep_size(lines) for token, lines in postings.items())
                    + 256  # Entry object and amortized OrderedDict table overhead.
                )
                if entry_size > self.max_bytes:
                    postings = None
                    result = None
        except BaseException:
            with self._lock:
                if self._inflight.get(key) is flight:
                    del self._inflight[key]
                flight.done.set()
            raise

        with self._lock:
            if self._inflight.get(key) is flight:
                del self._inflight[key]
                if postings is not None and not self._closed:
                    while self._entries and (
                        self._memory_bytes + entry_size > self.max_bytes
                        or len(self._entries) >= self.max_entries
                    ):
                        _, evicted = self._entries.popitem(last=False)
                        self._memory_bytes -= evicted.size
                    self._entries[key] = _Entry(frozen_fingerprint, postings, entry_size)
                    self._memory_bytes += entry_size
            flight.done.set()
        return result

    def invalidate(self, root: os.PathLike[str] | str, relative: str) -> None:
        """Forget one path after deletion or any caller-detected invalidation."""
        key = _canonical_key(root, relative)
        with self._lock:
            entry = self._entries.pop(key, None)
            if entry is not None:
                self._memory_bytes -= entry.size
            flight = self._inflight.pop(key, None)
            if flight is not None:
                flight.done.set()

    def invalidate_root(self, root: os.PathLike[str] | str) -> None:
        """Drop postings for a repository after its in-memory model is evicted."""
        canonical_root = _canonical_key(root, "placeholder")[0]
        with self._lock:
            for key in [key for key in self._entries if key[0] == canonical_root]:
                self._memory_bytes -= self._entries.pop(key).size
            for key in [key for key in self._inflight if key[0] == canonical_root]:
                self._inflight.pop(key).done.set()

    def clear(self) -> None:
        """Drop all cached postings and detach active loads without closing."""
        with self._lock:
            self._entries.clear()
            self._memory_bytes = 0
            flights = tuple(self._inflight.values())
            self._inflight.clear()
            for flight in flights:
                flight.done.set()

    def close(self) -> None:
        """Clear the cache and disable future lookups."""
        with self._lock:
            self.clear()
            self._closed = True

    def __enter__(self) -> IdentifierPostingsCache:
        return self

    def __exit__(self, exc_type: object, exc: object, traceback: object) -> None:
        self.close()


__all__ = ["IdentifierPostingsCache", "UnsupportedSymbolError"]
