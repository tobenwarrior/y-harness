#!/usr/bin/env python3
"""Select the active managed supervisor without depending on a developer checkout."""
import fcntl
import importlib.util
import os
from pathlib import Path
import re
import runpy
import stat


_CURRENT = re.compile(r'versions/[0-9a-f]{40}\Z')


def supervisor_running(support):
    try:
        fd = os.open(support / '.supervisor.lock', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        return False
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_nlink != 1:
            raise ValueError('invalid supervisor lock')
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return True
        fcntl.flock(fd, fcntl.LOCK_UN)
        return False
    finally:
        os.close(fd)


def verify_active(managed, commit):
    """Use the installed verifier before executing any newly checked-out code."""
    path = managed.parent / 'bootstrap/github-source-updater.py'
    if path.is_symlink() or not path.is_file():
        raise ValueError('installed updater verifier is unavailable')
    spec = importlib.util.spec_from_file_location('github_installed_updater', path)
    engine = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(engine)
    if engine.SourceUpdater(managed).current() != commit:
        raise ValueError('active update changed during verification')


def select_supervisor(support, *, validate=None):
    """Select the installed bootstrap initially, then the active version's code."""
    support = Path(support).absolute()
    for parent in (support, *support.parents):
        if parent.is_symlink():
            raise ValueError('symlink in support path')
    current = support / 'managed/current'
    commit = None
    if supervisor_running(support):
        directory = support / 'bootstrap'
    elif current.is_symlink():
        target = os.readlink(current)
        if not _CURRENT.fullmatch(target):
            raise ValueError('invalid current version link')
        commit = target.split('/')[1]
        directory = support / 'managed' / target / 'apps/desktop/scripts'
    elif current.exists():
        raise ValueError('invalid current version')
    else:
        directory = support / 'bootstrap'
    for parent in (directory, *directory.parents):
        if parent == support.parent:
            break
        if parent.is_symlink():
            raise ValueError('symlink in supervisor path')
    supervisor = directory / 'github-desktop-supervisor.py'
    engine = directory / 'github-source-updater.py'
    for path in (supervisor, engine):
        if path.is_symlink() or not path.is_file():
            raise ValueError('managed updater component is unavailable')
    if commit is not None:
        (validate or verify_active)(support / 'managed', commit)
    return supervisor


def main():
    support = Path.home() / 'Library/Application Support/Y Harness GitHub'
    runpy.run_path(str(select_supervisor(support)), run_name='__main__')


if __name__ == '__main__':
    main()
