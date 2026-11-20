"""Perform one bounded filesystem request inside the Bot computer."""

import base64
import fcntl
import json
import os
import stat
import sys
import tempfile
from pathlib import Path

TEXT_LIMIT = 8 * 1024 * 1024
DIFF_LIMIT = 512 * 1024


class Failure(Exception):
    """Filesystem rejection safe to send back to the calling tool."""

    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def path_in(root, value, follow=True):
    """Resolve one path with the computer's own filesystem semantics."""
    path = root / value
    target = path.resolve() if follow else path.parent.resolve() / path.name
    if not target.is_relative_to(root):
        raise Failure('FS_SANDBOX_DENIED', 'Use a path inside this Bot’s workspace.')
    return target


def info(path, follow=True):
    """Read a version and file kind without opening its contents."""
    try:
        entry = path.stat(follow_symlinks=follow)
    except FileNotFoundError:
        return None
    mode = entry.st_mode
    kind = ('file' if stat.S_ISREG(mode) else 'directory' if stat.S_ISDIR(mode)
            else 'symlink' if stat.S_ISLNK(mode) else 'other')
    version = f'{entry.st_dev}:{entry.st_ino}:{entry.st_mtime_ns}:{entry.st_ctime_ns}:{entry.st_size}'
    return {'type': kind, 'version': version, 'size': entry.st_size}


def read(path, offset, limit, whole=False):
    """Read regular-file bytes with a bounded allocation."""
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), 'rb') as stream:
        entry = os.fstat(stream.fileno())
        if not stat.S_ISREG(entry.st_mode):
            raise Failure('FS_NOT_REGULAR_FILE', 'Expected a regular file.')
        if whole and entry.st_size > limit:
            raise Failure('FS_TOO_LARGE', 'The file exceeds the requested byte limit.')
        stream.seek(offset)
        value = stream.read(limit + int(whole))
        if whole and len(value) > limit:
            raise Failure('FS_TOO_LARGE', 'The file exceeds the requested byte limit.')
        return value


def basis(path, entry):
    """Return an optional bounded UTF-8 diff basis."""
    if entry is None or entry['size'] > DIFF_LIMIT:
        return None
    try:
        data = read(path, 0, DIFF_LIMIT, whole=True)
        return data.decode('utf-8') if b'\0' not in data else None
    except (Failure, UnicodeError):
        return None


def require_current(entry, expected):
    """Reject stale metadata and non-files before mutation."""
    if entry is not None and entry['type'] != 'file':
        raise Failure('FS_NOT_REGULAR_FILE', 'Expected a regular file.')
    if expected is None:
        return
    if expected.get('kind') == 'createIfAbsent':
        if entry is not None:
            raise Failure('FS_NOT_OBSERVED', 'A file already exists at this path.')
    elif entry is None or entry['version'] != expected.get('version'):
        raise Failure('FS_STALE_VERSION', 'Read the file again before modifying it.')


def write(path, content, expected, current):
    """Publish a guarded replacement or an exclusive new file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(dir=path.parent)
    try:
        with os.fdopen(descriptor, 'wb') as output:
            if current is not None:
                os.fchmod(output.fileno(), stat.S_IMODE(path.stat().st_mode))
            output.write(content)
            output.flush()
            os.fsync(output.fileno())
        require_current(info(path, follow=False), expected)
        if expected is not None and expected.get('kind') == 'createIfAbsent':
            os.link(temporary, path)
        else:
            os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def request(root, args):
    """Dispatch only the built-in filesystem operations."""
    operation = args['operation']
    path = path_in(root, args['path'], follow=operation != 'lstat')
    if operation == 'resolve':
        return str(path)
    entry = info(path, follow=operation != 'lstat')
    if operation in ('stat', 'lstat'):
        return entry
    if operation == 'read':
        limit = args['limit']
        if limit < 0 or limit > TEXT_LIMIT:
            raise Failure('FS_TOO_LARGE', 'The requested transfer exceeds the file tool limit.')
        return base64.b64encode(read(path, args['offset'], limit, args['whole'])).decode('ascii')
    if operation == 'list':
        entries = []
        with os.scandir(path) as children:
            for child in children:
                if len(entries) >= 4096:
                    raise Failure('FS_TOO_LARGE', 'This directory exceeds the listing limit. Search a subdirectory.')
                target = Path(child.path).resolve()
                if target.is_relative_to(root):
                    child_entry = info(target)
                    if child_entry is not None:
                        entries.append({'name': child.name, 'path': str(target), **child_entry})
        return sorted(entries, key=lambda item: item['name'])
    if operation not in ('write', 'delete', 'move'):
        raise Failure('FS_IO_ERROR', 'Unknown VPS file operation.')

    lock_path = Path(tempfile.gettempdir()) / 'yharness-file.lock'
    descriptor = os.open(lock_path, os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    with os.fdopen(descriptor, 'wb') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        path = path_in(root, args['path'])
        entry = info(path, follow=False)
        expected = args.get('expected')
        require_current(entry, expected)
        before = basis(path, entry)
        if operation == 'delete':
            if entry is None:
                raise Failure('FS_STALE_VERSION', 'The file no longer exists.')
            path.unlink()
            return {'before': before}
        if operation == 'move':
            if entry is None:
                raise Failure('FS_STALE_VERSION', 'The source file no longer exists.')
            destination = path_in(root, args['destination'])
            if destination == path:
                raise Failure('FS_SAME_TARGET', 'Source and destination are the same file.')
            destination_entry = info(destination, follow=False)
            destination_guard = args.get('destinationExpected')
            require_current(destination_entry, destination_guard)
            destination_before = basis(destination, destination_entry)
            destination.parent.mkdir(parents=True, exist_ok=True)
            if 'content' in args:
                write(destination, args['content'].encode('utf-8'), destination_guard, destination_entry)
            elif destination_guard is not None and destination_guard.get('kind') == 'createIfAbsent':
                os.link(path, destination)
            else:
                os.replace(path, destination)
                return {'sourceBefore': before, 'before': destination_before, 'entry': info(destination),
                        'created': destination_entry is None, 'sourceDeleted': True}
            try:
                path.unlink()
                removed = True
            except OSError:
                removed = False
            return {'sourceBefore': before, 'before': destination_before, 'entry': info(destination),
                    'created': destination_entry is None, 'sourceDeleted': removed}
        write(path, args['content'].encode('utf-8'), expected, entry)
        return {'before': before, 'entry': info(path), 'created': entry is None}


def main():
    """Read one request from stdin and emit a single response."""
    root = Path(sys.argv[1]).resolve(strict=True)
    try:
        data = sys.stdin.buffer.read(TEXT_LIMIT * 6 + 4096)
        value = request(root, json.loads(data))
        response = {'value': value}
    except Failure as error:
        response = {'error': error.code, 'message': str(error)}
    except FileNotFoundError:
        response = {'error': 'FS_NOT_FOUND', 'message': 'File does not exist in the Bot workspace.'}
    except NotADirectoryError:
        response = {'error': 'FS_NOT_DIRECTORY', 'message': 'Expected a directory.'}
    except FileExistsError:
        response = {'error': 'FS_NOT_OBSERVED', 'message': 'A file already exists at this path.'}
    except PermissionError:
        response = {'error': 'FS_PERMISSION_DENIED', 'message': 'Permission denied in the Bot workspace.'}
    except (OSError, ValueError, RuntimeError):
        response = {'error': 'FS_IO_ERROR', 'message': 'The Bot workspace could not complete the file operation.'}
    print(json.dumps(response, ensure_ascii=True))


if __name__ == '__main__':
    main()
