"""Fail-closed, descriptor-based opening for repository-relative source files.

Only the POSIX implementation is enabled. Windows path-based opens cannot
provide the required component-by-component no-reparse guarantee with the
stdlib APIs used here; do not replace the Windows rejection without validating
handle-relative Win32 opens and final-path containment on real Windows.
"""

from __future__ import annotations

import os
from contextlib import contextmanager
from collections.abc import Callable, Iterator
import stat
from pathlib import Path


def _open_windows_nofollow(root: os.PathLike[str] | str, relative: str) -> int:
    """Reject Windows until a tested handle-relative implementation exists."""
    del root, relative
    raise OSError("safe no-reparse file access is unavailable on Windows")


def _relative_parts(relative: str) -> list[str]:
    if not isinstance(relative, str) or not relative or "\x00" in relative:
        raise OSError("unsafe relative path")
    parts = relative.split("/")
    if any(part in {"", ".", ".."} for part in parts):
        raise OSError("unsafe relative path")
    return parts


@contextmanager
def open_regular_files_nofollow(root: os.PathLike[str] | str) -> Iterator[Callable[[str], int]]:
    """Pin one canonical root for a batch of fresh, no-follow regular-file opens.

    The context owns the root descriptor; callers own each returned file descriptor.
    Root ancestors are checked once, and relative components on every open. No
    source bytes or directory descriptors survive the context. Renaming the root
    during a batch keeps reads anchored to the originally opened directory.
    """
    if os.name == "nt":
        _open_windows_nofollow(root, "")
    if os.name != "posix":
        raise OSError("safe no-follow file access is unavailable")
    if os.open not in getattr(os, "supports_dir_fd", set()) or not hasattr(os, "O_NOFOLLOW"):
        raise OSError("safe no-follow file access is unavailable")
    try:
        canonical_root = Path(root)
        if not canonical_root.is_absolute() or ".." in canonical_root.parts:
            raise OSError("root must be a canonical absolute path")
    except (TypeError, ValueError) as error:
        raise OSError("canonical root is unavailable") from error
    # O_PATH permits traversable but unlistable ancestors.
    common_flags = getattr(os, "O_PATH", os.O_RDONLY) | getattr(os, "O_DIRECTORY", 0) | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0)
    root_fd = os.open(canonical_root.anchor, common_flags)
    try:
        if not stat.S_ISDIR(os.fstat(root_fd).st_mode):
            raise OSError("root is not a directory")
        for part in canonical_root.parts[1:]:
            child_fd = os.open(part, common_flags, dir_fd=root_fd)
            try:
                if not stat.S_ISDIR(os.fstat(child_fd).st_mode):
                    raise OSError("path component is not a directory")
            except BaseException:
                os.close(child_fd)
                raise
            os.close(root_fd)
            root_fd = child_fd

        def open_file(relative: str) -> int:
            parts = _relative_parts(relative)
            if root_fd < 0:
                raise OSError("source root is closed")
            directory_fd = root_fd
            try:
                for part in parts[:-1]:
                    child_fd = os.open(part, common_flags, dir_fd=directory_fd)
                    try:
                        if not stat.S_ISDIR(os.fstat(child_fd).st_mode):
                            raise OSError("path component is not a directory")
                    except BaseException:
                        os.close(child_fd)
                        raise
                    if directory_fd != root_fd:
                        os.close(directory_fd)
                    directory_fd = child_fd
                file_flags = os.O_RDONLY | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NONBLOCK", 0)
                file_fd = os.open(parts[-1], file_flags, dir_fd=directory_fd)
                try:
                    if not stat.S_ISREG(os.fstat(file_fd).st_mode):
                        raise OSError("not a regular file")
                    return file_fd
                except BaseException:
                    os.close(file_fd)
                    raise
            finally:
                if directory_fd != root_fd:
                    os.close(directory_fd)
        yield open_file
    finally:
        os.close(root_fd)
        root_fd = -1


def open_regular_nofollow(root: os.PathLike[str] | str, relative: str) -> int:
    """Return a caller-owned, read-only regular-file fd below a canonical root.

    POSIX root and relative components are opened through pinned directory
    descriptors with O_NOFOLLOW. Unsupported platforms fail closed.
    """
    _relative_parts(relative)
    with open_regular_files_nofollow(root) as open_file:
        return open_file(relative)


__all__ = ["open_regular_nofollow", "open_regular_files_nofollow"]
