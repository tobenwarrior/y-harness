/** Descriptor-relative I/O for a project that several Bot containers can change. */

/** Python worker executed inside a participating container with the project mount as its only root. */
export const vpsProjectWorker = String.raw`
import base64
import errno
import fcntl
import json
import os
import re
import stat
import sys
from contextlib import contextmanager
from uuid import uuid4

LIMIT = 8 * 1024 * 1024
DIRECTORY = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW


class Failure(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def parts_of(root, path):
    if path == root:
        return []
    if not path.startswith(root + '/'):
        raise Failure('FS_SANDBOX_DENIED', 'Use a path inside the shared project.')
    parts = path[len(root) + 1:].split('/')
    if any(p in ('', '.', '..') or '\0' in p for p in parts):
        raise Failure('FS_SANDBOX_DENIED', 'Use a path inside the shared project.')
    return parts


@contextmanager
def folder(root_fd, parts, create=False):
    fd = os.dup(root_fd)
    try:
        for name in parts:
            try:
                child = os.open(name, DIRECTORY, dir_fd=fd)
            except FileNotFoundError:
                if not create:
                    raise
                try:
                    os.mkdir(name, mode=0o700, dir_fd=fd)
                except FileExistsError:
                    pass
                child = os.open(name, DIRECTORY, dir_fd=fd)
            os.close(fd)
            fd = child
        yield fd
    finally:
        os.close(fd)


def facts(entry):
    mode = entry.st_mode
    kind = ('file' if stat.S_ISREG(mode) else 'directory' if stat.S_ISDIR(mode)
            else 'symlink' if stat.S_ISLNK(mode) else 'other')
    version = f'{entry.st_dev}:{entry.st_ino}:{entry.st_mtime_ns}:{entry.st_ctime_ns}:{entry.st_size}'
    return {'type': kind, 'version': version, 'size': entry.st_size}


def at(fd, name):
    try:
        return facts(os.stat(name, dir_fd=fd, follow_symlinks=False))
    except FileNotFoundError:
        return None


def read(fd, name, offset, limit, whole):
    if limit < 0 or limit > LIMIT:
        raise Failure('FS_TOO_LARGE', 'The requested project read exceeds the file size limit.')
    descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
    with os.fdopen(descriptor, 'rb') as stream:
        entry = os.fstat(stream.fileno())
        if not stat.S_ISREG(entry.st_mode):
            raise Failure('FS_NOT_REGULAR_FILE', 'Expected a regular project file.')
        if whole and entry.st_size > limit:
            raise Failure('FS_TOO_LARGE', 'The project file exceeds the requested byte limit.')
        stream.seek(offset)
        value = stream.read(limit + int(whole))
        if whole and len(value) > limit:
            raise Failure('FS_TOO_LARGE', 'The project file exceeds the requested byte limit.')
        return base64.b64encode(value).decode('ascii')


def read_text(fd, name):
    descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
    with os.fdopen(descriptor, 'rb') as stream:
        entry = os.fstat(stream.fileno())
        if not stat.S_ISREG(entry.st_mode):
            raise Failure('FS_NOT_REGULAR_FILE', 'Expected a regular project file.')
        value = stream.read(LIMIT + 1)
        if len(value) > LIMIT:
            raise Failure('FS_TOO_LARGE', 'The project file exceeds the file size limit.')
        try:
            return value.decode('utf-8')
        except UnicodeDecodeError:
            raise Failure('FS_NOT_TEXT', 'The project file is not UTF-8 text.')


def read_text_identity(fd, name):
    descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
    with os.fdopen(descriptor, 'rb') as stream:
        entry = os.fstat(stream.fileno())
        if not stat.S_ISREG(entry.st_mode):
            raise Failure('FS_NOT_REGULAR_FILE', 'Expected a regular project file.')
        value = stream.read(LIMIT + 1)
        if len(value) > LIMIT:
            raise Failure('FS_TOO_LARGE', 'The project file exceeds the file size limit.')
        try:
            return (entry.st_dev, entry.st_ino), value.decode('utf-8')
        except UnicodeDecodeError:
            raise Failure('FS_NOT_TEXT', 'The project file is not UTF-8 text.')


def skill_parts(path):
    if not isinstance(path, str):
        raise Failure('FS_SANDBOX_DENIED', 'The imported skill destination is invalid.')
    parts = path.split('/')
    if (len(parts) != 4 or parts[0] != '.agents' or parts[1] != 'skills'
            or parts[3] != 'SKILL.md' or len(parts[2]) > 128
            or re.fullmatch(r'[a-z0-9]+(?:-[a-z0-9]+)*', parts[2]) is None):
        raise Failure('FS_SANDBOX_DENIED', 'The imported skill destination is not canonical.')
    return parts


@contextmanager
def private_folder(root_fd, parts, create):
    try:
        with folder(root_fd, parts, create=create) as fd:
            yield fd
    except OSError as error:
        if error.errno in (errno.ELOOP, errno.ENOTDIR):
            raise Failure('FS_SANDBOX_DENIED', 'Grok skill import refuses a symbolic link directory.')
        raise


def verify_skill(root_fd, parts, published, content):
    try:
        with private_folder(root_fd, parts[:-1], create=False) as lexical_fd:
            identity_value, value = read_text_identity(lexical_fd, parts[-1])
            return identity_value == published and value == content
    except (Failure, OSError):
        return False


def install_skill(root_fd, path, content, preview):
    if not isinstance(content, str) or not isinstance(preview, bool):
        raise Failure('FS_IO_ERROR', 'The imported skill request is invalid.')
    data = content.encode('utf-8')
    if len(data) > LIMIT:
        raise Failure('FS_TOO_LARGE', 'The imported skill exceeds the file size limit.')
    parts = skill_parts(path)
    fcntl.flock(root_fd, fcntl.LOCK_EX)
    try:
        try:
            parent = private_folder(root_fd, parts[:-1], create=not preview)
            with parent as fd:
                current = at(fd, parts[-1])
                if current is not None:
                    if current['type'] == 'symlink':
                        raise Failure('FS_SANDBOX_DENIED', 'Grok skill import refuses a symbolic link file.')
                    if current['type'] != 'file' or read_text(fd, parts[-1]) != content:
                        raise Failure('FS_NOT_OBSERVED', 'A Grok skill file already exists with different content.')
                    return {'created': False}
                if preview:
                    return {'created': True}
                temporary = '.yharness-' + uuid4().hex
                descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600, dir_fd=fd)
                try:
                    with os.fdopen(descriptor, 'wb') as stream:
                        stream.write(data)
                        stream.flush()
                        os.fsync(stream.fileno())
                        entry = os.fstat(stream.fileno())
                        published = (entry.st_dev, entry.st_ino)
                    try:
                        os.link(temporary, parts[-1], src_dir_fd=fd, dst_dir_fd=fd, follow_symlinks=False)
                    except FileExistsError:
                        raise Failure('FS_NOT_OBSERVED', 'A Grok skill file already exists with different content.')
                finally:
                    try:
                        os.unlink(temporary, dir_fd=fd)
                    except FileNotFoundError:
                        pass
                if not verify_skill(root_fd, parts, published, content):
                    raise Failure('FS_SANDBOX_DENIED', 'The imported Grok skill could not be verified in the Bot workspace.')
                return {'created': True}
        except FileNotFoundError:
            if preview:
                return {'created': True}
            raise Failure('FS_NOT_FOUND', 'The Bot workspace is unavailable.')
    finally:
        fcntl.flock(root_fd, fcntl.LOCK_UN)


def read_skill(root_fd, path):
    parts = skill_parts(path)
    try:
        with private_folder(root_fd, parts[:-1], create=False) as fd:
            current = at(fd, parts[-1])
            if current is None:
                return {'content': None}
            if current['type'] == 'symlink':
                raise Failure('FS_SANDBOX_DENIED', 'Grok skill read refuses a symbolic link file.')
            if current['type'] != 'file':
                raise Failure('FS_NOT_REGULAR_FILE', 'Expected a regular skill file.')
            return {'content': read_text(fd, parts[-1])}
    except FileNotFoundError:
        return {'content': None}


def guard(current, expected):
    if current is not None and current['type'] != 'file':
        raise Failure('FS_NOT_REGULAR_FILE', 'Expected a regular project file.')
    if expected.get('kind') == 'createIfAbsent':
        if current is not None:
            raise Failure('FS_NOT_OBSERVED', 'This project file already exists. Read it to get its version.')
    elif expected.get('kind') != 'replaceIfVersion' or current is None or current['version'] != expected.get('version'):
        raise Failure('FS_STALE_VERSION', 'The project file changed. Read its current version before saving.')


def write(root_fd, parts, request):
    if not parts:
        raise Failure('FS_NOT_REGULAR_FILE', 'Choose a file inside the shared project.')
    expected = request['expected']
    create = expected.get('kind') == 'createIfAbsent'
    fcntl.flock(root_fd, fcntl.LOCK_EX)
    with folder(root_fd, parts[:-1], create=create) as fd:
        name = parts[-1]
        guard(at(fd, name), expected)
        data = request['content'].encode('utf-8')
        if len(data) > LIMIT:
            raise Failure('FS_TOO_LARGE', 'The project write exceeds the file size limit.')
        temporary = '.yharness-' + uuid4().hex
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600, dir_fd=fd)
        try:
            with os.fdopen(descriptor, 'wb') as stream:
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            guard(at(fd, name), expected)
            if create:
                os.link(temporary, name, src_dir_fd=fd, dst_dir_fd=fd, follow_symlinks=False)
            else:
                os.replace(temporary, name, src_dir_fd=fd, dst_dir_fd=fd)
        finally:
            try:
                os.unlink(temporary, dir_fd=fd)
            except FileNotFoundError:
                pass
        return {'entry': at(fd, name), 'created': create, 'before': None}


def handle(root_fd, root, request):
    path = request['path']
    operation = request['operation']
    if operation == 'install-skill':
        return install_skill(root_fd, path, request['content'], request['preview'])
    if operation == 'read-skill':
        return read_skill(root_fd, path)
    parts = parts_of(root, path)
    if operation == 'resolve':
        return path
    if operation == 'list':
        entries = []
        with folder(root_fd, parts) as fd, os.scandir(fd) as children:
            for item in children:
                if len(entries) >= 4096:
                    raise Failure('FS_TOO_LARGE', 'This folder exceeds the listing limit. Open a subfolder.')
                entry = at(fd, item.name)
                if entry is not None:
                    entries.append({'name': item.name, 'path': path + '/' + item.name, **entry})
        return sorted(entries, key=lambda entry: entry['name'])
    if operation == 'write':
        return write(root_fd, parts, request)
    with folder(root_fd, parts[:-1]) as fd:
        leaf = parts[-1] if parts else '.'
        if operation in ('stat', 'lstat'):
            return at(fd, leaf)
        if operation == 'read':
            return read(fd, leaf, request['offset'], request['limit'], request['whole'])
    raise Failure('FS_IO_ERROR', 'This operation is unavailable for project files.')


try:
    root = sys.argv[1]
    descriptor = os.open(root, DIRECTORY)
    try:
        request = json.loads(sys.stdin.buffer.read(LIMIT * 6 + 4096))
        result = {'value': handle(descriptor, root, request)}
    finally:
        os.close(descriptor)
except Failure as error:
    result = {'error': error.code, 'message': str(error)}
except FileNotFoundError:
    result = {'error': 'FS_NOT_FOUND', 'message': 'This project path is unavailable.'}
except (NotADirectoryError, PermissionError):
    result = {'error': 'FS_SANDBOX_DENIED', 'message': 'Use a regular path inside the shared project.'}
except FileExistsError:
    result = {'error': 'FS_NOT_OBSERVED', 'message': 'This project file already exists. Read it to get its version.'}
except OSError as error:
    if error.errno == errno.ELOOP:
        result = {'error': 'FS_SANDBOX_DENIED', 'message': 'Use a regular path inside the shared project.'}
    else:
        result = {'error': 'FS_IO_ERROR', 'message': 'The shared project operation could not complete.'}
print(json.dumps(result, ensure_ascii=True))
`
