#!/usr/bin/env python3
"""Preview or import one Grok Bot export into an existing VPS Bot."""

import argparse
from contextlib import contextmanager
import hashlib
import http.client
import json
import math
import os
import re
import stat
import subprocess
import sys
import uuid
from pathlib import Path
from urllib.parse import urlsplit

try:
    import fcntl
except ImportError:  # pragma: no cover - the importer is supported on Unix VPS hosts.
    fcntl = None

MAX_DOCUMENT_BYTES = 512 * 1024
MAX_MANIFEST_BYTES = 2 * 1024 * 1024
MAX_ATTACHMENT_BYTES = 24 * 1024 * 1024
MAX_SAFE_INTEGER = 9_007_199_254_740_991
BOT_ID_PATTERN = re.compile(r'^bot-[A-Za-z0-9][A-Za-z0-9-]*$')
SHA256_PATTERN = re.compile(r'^[0-9a-f]{64}$')
MANIFEST_FIELDS = {'version', 'entries'}
ENTRY_FIELDS = {'botId', 'sourceId', 'sourceSequence', 'filename', 'timestampMs', 'sha256'}
JS_LINE_TERMINATORS = {'\u000a', '\u000d', '\u2028', '\u2029'}


class ImportErrorDetail(Exception):
    """Error safe to print without printing the export or sign-in link."""


def _invalid_manifest(source: bool = False):
    """Return the stable operator-facing error for one malformed vault manifest."""
    location = 'source' if source else 'destination'
    raise ImportErrorDetail(f'Invalid Grok history attachment {location} manifest.')


def _lstat(path: Path):
    """Read one path without following its final symlink."""
    try:
        return path.lstat()
    except FileNotFoundError:
        return None
    except OSError:
        raise ImportErrorDetail('Could not inspect the private attachment vault.')


def _regular_directory(path: Path, label: str) -> None:
    """Require an absolute, non-symlink directory for a vault root."""
    if not path.is_absolute():
        raise ImportErrorDetail(f'The {label} attachment vault must use an absolute directory path.')
    info = _lstat(path)
    if info is None or not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode):
        raise ImportErrorDetail(f'The {label} attachment vault must be a regular directory.')


def _utf16_length(value: str) -> int:
    """Count string units as JavaScript's UTF-16-backed length does."""
    return len(value.encode('utf-16-le')) // 2


def _is_js_whitespace(value: str) -> bool:
    """Match ECMAScript WhiteSpace for source-id edge validation."""
    code = ord(value)
    return (
        code in {0x0009, 0x000B, 0x000C, 0x0020, 0x00A0, 0x1680, 0x202F, 0x205F, 0x3000, 0xFEFF}
        or 0x2000 <= code <= 0x200A
    )


def _json_integer(value, maximum: int, source: bool) -> int:
    """Normalize a JSON number accepted by Zod's integer validator."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        _invalid_manifest(source)
    if isinstance(value, float) and (not math.isfinite(value) or not value.is_integer()):
        _invalid_manifest(source)
    normalized = int(value)
    if normalized < 0 or normalized > maximum or normalized > MAX_SAFE_INTEGER:
        _invalid_manifest(source)
    return normalized


@contextmanager
def _destination_lock(destination_root: Path, exclusive: bool):
    """Serialize importer operations under the existing destination parent."""
    if fcntl is None:
        raise ImportErrorDetail('Attachment staging requires a Unix file-locking host.')
    lock_directory = destination_root.parent
    _regular_directory(lock_directory, 'destination parent')
    flags = os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0) | getattr(os, 'O_NOFOLLOW', 0)
    try:
        descriptor = os.open(lock_directory, flags)
    except OSError:
        raise ImportErrorDetail('Could not lock the private attachment vault.')
    try:
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH)
        except OSError:
            raise ImportErrorDetail('Could not lock the private attachment vault.')
        yield
    finally:
        try:
            fcntl.flock(descriptor, fcntl.LOCK_UN)
        finally:
            os.close(descriptor)


def _sync_directory(root: Path) -> None:
    """Flush a directory after publishing a vault entry or manifest."""
    flags = os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0) | getattr(os, 'O_NOFOLLOW', 0)
    try:
        descriptor = os.open(root, flags)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    except OSError as error:
        raise ImportErrorDetail('Could not make the private attachment vault durable.') from error


def _validate_entry(value, seen, source):
    """Validate one manifest entry and return its normalized dictionary."""
    if not isinstance(value, dict) or set(value) != ENTRY_FIELDS:
        _invalid_manifest(source)
    bot_id = value.get('botId')
    source_id = value.get('sourceId')
    source_sequence = value.get('sourceSequence')
    filename = value.get('filename')
    timestamp_ms = value.get('timestampMs')
    sha256 = value.get('sha256')
    if not isinstance(bot_id, str) or not BOT_ID_PATTERN.fullmatch(bot_id):
        _invalid_manifest(source)
    if not isinstance(source_id, str) or not source_id:
        _invalid_manifest(source)
    try:
        source_id_length = _utf16_length(source_id)
    except UnicodeEncodeError:
        _invalid_manifest(source)
    if (
        source_id_length > 128 or _is_js_whitespace(source_id[0]) or _is_js_whitespace(source_id[-1])
        or any(char in JS_LINE_TERMINATORS for char in source_id)
    ):
        _invalid_manifest(source)
    source_sequence = _json_integer(source_sequence, MAX_SAFE_INTEGER, source)
    if not isinstance(filename, str) or not filename:
        _invalid_manifest(source)
    try:
        filename_length = _utf16_length(filename)
    except UnicodeEncodeError:
        _invalid_manifest(source)
    if filename_length > 255:
        _invalid_manifest(source)
    if any(char in '/\\' or ord(char) < 0x20 or ord(char) == 0x7F for char in filename):
        _invalid_manifest(source)
    timestamp_ms = (
        None if timestamp_ms is None else _json_integer(timestamp_ms, 8_640_000_000_000_000, source)
    )
    if not isinstance(sha256, str) or not SHA256_PATTERN.fullmatch(sha256):
        _invalid_manifest(source)
    position = (bot_id, source_id, source_sequence)
    if position in seen:
        _invalid_manifest(source)
    seen.add(position)
    return {
        'botId': bot_id,
        'sourceId': source_id,
        'sourceSequence': source_sequence,
        'filename': filename,
        'timestampMs': timestamp_ms,
        'sha256': sha256,
    }


def _reject_json_constant(value: str):
    """Reject non-JSON numeric constants that Python otherwise accepts."""
    raise ValueError(f'unsupported JSON constant: {value}')


def _read_manifest(root: Path, source: bool) -> list[dict]:
    """Read and validate a manifest without disclosing its private path."""
    manifest = root / 'manifest.json'
    info = _lstat(manifest)
    if info is None or not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode):
        _invalid_manifest(source)
    flags = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_NONBLOCK', 0)
    try:
        descriptor = os.open(manifest, flags)
    except OSError:
        _invalid_manifest(source)
    try:
        opened = os.fstat(descriptor)
        if (
            not stat.S_ISREG(opened.st_mode) or opened.st_dev != info.st_dev or opened.st_ino != info.st_ino
            or opened.st_size > MAX_MANIFEST_BYTES
        ):
            _invalid_manifest(source)
        raw = b''
        while len(raw) <= MAX_MANIFEST_BYTES:
            chunk = os.read(descriptor, MAX_MANIFEST_BYTES + 1 - len(raw))
            if not chunk:
                break
            raw += chunk
        current = os.fstat(descriptor)
        if (
            current.st_size != opened.st_size or current.st_mtime_ns != opened.st_mtime_ns
            or current.st_ctime_ns != opened.st_ctime_ns or len(raw) > MAX_MANIFEST_BYTES
        ):
            _invalid_manifest(source)
        document = json.loads(raw.decode('utf-8'), parse_constant=_reject_json_constant)
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        _invalid_manifest(source)
    finally:
        os.close(descriptor)
    if len(raw) > MAX_MANIFEST_BYTES or not isinstance(document, dict) or set(document) != MANIFEST_FIELDS:
        _invalid_manifest(source)
    if (
        isinstance(document.get('version'), bool) or document.get('version') != 1
        or not isinstance(document.get('entries'), list)
    ):
        _invalid_manifest(source)
    entries = []
    seen = set()
    for value in document['entries']:
        entries.append(_validate_entry(value, seen, source))
    return entries


def _verify_object(root: Path, entry: dict, read: bool = False):
    """Verify one hash-named regular file and optionally return its bytes."""
    path = root / entry['sha256']
    info = _lstat(path)
    if info is None or not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode):
        raise ImportErrorDetail('A referenced Grok attachment object is not verified.')
    flags = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_NONBLOCK', 0)
    try:
        descriptor = os.open(path, flags)
    except OSError:
        raise ImportErrorDetail('A referenced Grok attachment object is not verified.')
    try:
        opened = os.fstat(descriptor)
        if (
            not stat.S_ISREG(opened.st_mode) or opened.st_dev != info.st_dev or opened.st_ino != info.st_ino
            or opened.st_size > MAX_ATTACHMENT_BYTES
        ):
            raise ImportErrorDetail('A referenced Grok attachment object is not verified.')
        digest = hashlib.sha256()
        chunks = []
        read_bytes = 0
        while read_bytes <= MAX_ATTACHMENT_BYTES:
            chunk = os.read(descriptor, min(1024 * 1024, MAX_ATTACHMENT_BYTES + 1 - read_bytes))
            if not chunk:
                break
            read_bytes += len(chunk)
            digest.update(chunk)
            if read:
                chunks.append(chunk)
        current = os.fstat(descriptor)
        if (
            current.st_size != opened.st_size or current.st_mtime_ns != opened.st_mtime_ns
            or current.st_ctime_ns != opened.st_ctime_ns or digest.hexdigest() != entry['sha256']
        ):
            raise ImportErrorDetail('A referenced Grok attachment object is not verified.')
        return opened.st_size, b''.join(chunks) if read else None
    except OSError:
        raise ImportErrorDetail('A referenced Grok attachment object is not verified.')
    finally:
        os.close(descriptor)


def _verify_objects(root: Path, entries: list[dict]) -> dict[str, int]:
    """Verify each distinct hash named by one manifest."""
    sizes = {}
    for entry in entries:
        if entry['sha256'] not in sizes:
            sizes[entry['sha256']] = _verify_object(root, entry)[0]
    return sizes


def _position(entry: dict):
    """Return the archive position key used to merge manifest records."""
    return entry['botId'], entry['sourceId'], entry['sourceSequence']


def _same_entry(left: dict, right: dict) -> bool:
    """Compare the full attestation for one archive position."""
    return left == right


def _manifest_bytes(entries: list[dict]) -> bytes:
    """Serialize a manifest and enforce the Host's byte limit before staging."""
    raw = (json.dumps({'version': 1, 'entries': entries}, separators=(',', ':')) + '\n').encode('utf-8')
    if len(raw) > MAX_MANIFEST_BYTES:
        raise ImportErrorDetail('The combined attachment manifest exceeds the size limit.')
    return raw


def _write_manifest(root: Path, entries: list[dict], raw: bytes) -> None:
    """Atomically replace the destination manifest."""
    temporary = root / f'.manifest.{uuid.uuid4()}.tmp'
    try:
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
        descriptor = os.open(temporary, flags, 0o600)
        try:
            data = raw
            offset = 0
            while offset < len(data):
                written = os.write(descriptor, data[offset:])
                if written <= 0:
                    raise ImportErrorDetail('Could not stage the private attachment vault.')
                offset += written
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        os.replace(temporary, root / 'manifest.json')
        _sync_directory(root)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def _publish_object(root: Path, entry: dict, data: bytes) -> None:
    """Publish one verified object without overwriting an existing object."""
    temporary = root / f'.{entry["sha256"]}.{uuid.uuid4()}.tmp'
    target = root / entry['sha256']
    try:
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
        descriptor = os.open(temporary, flags, 0o600)
        try:
            offset = 0
            while offset < len(data):
                written = os.write(descriptor, data[offset:])
                if written <= 0:
                    raise ImportErrorDetail('Could not stage the private attachment vault.')
                offset += written
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        os.chmod(temporary, stat.S_IRUSR, follow_symlinks=False)
        try:
            os.link(temporary, target)
            _sync_directory(root)
        except FileExistsError:
            _verify_object(root, entry)
    except OSError as error:
        if not isinstance(error, FileExistsError):
            raise ImportErrorDetail('Could not stage the private attachment vault.')
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def _stage_attachments_locked(
    source_root: Path,
    destination_root: Path,
    dry_run: bool,
    bot_id: str | None,
) -> dict:
    """Validate or stage a local manifest-backed attachment vault under its lock."""
    _regular_directory(source_root, 'source')
    all_source_entries = _read_manifest(source_root, True)
    source_entries = [entry for entry in all_source_entries if bot_id is None or entry['botId'] == bot_id]
    source_sizes = _verify_objects(source_root, source_entries)
    destination_info = _lstat(destination_root)
    destination_exists = destination_info is not None
    destination_entries = []
    if destination_exists:
        _regular_directory(destination_root, 'destination')
        manifest_info = _lstat(destination_root / 'manifest.json')
        if manifest_info is not None:
            destination_entries = _read_manifest(destination_root, False)
    merged_entries = list(destination_entries)
    by_position = {_position(entry): entry for entry in destination_entries}
    for entry in source_entries:
        existing = by_position.get(_position(entry))
        if existing is not None:
            if not _same_entry(existing, entry):
                raise ImportErrorDetail('Conflicting Grok history attachment position.')
            continue
        by_position[_position(entry)] = entry
        merged_entries.append(entry)
    wrote_manifest = bool(source_entries) and (not destination_exists or len(merged_entries) != len(destination_entries))
    manifest_raw = _manifest_bytes(merged_entries) if wrote_manifest else b''
    source_by_hash = {}
    for entry in source_entries:
        source_by_hash.setdefault(entry['sha256'], entry)
    copied = 0
    reused = 0
    for sha256, entry in source_by_hash.items():
        target = destination_root / sha256
        target_info = _lstat(target) if destination_exists else None
        if target_info is None:
            copied += 1
        else:
            if not stat.S_ISREG(target_info.st_mode) or stat.S_ISLNK(target_info.st_mode):
                raise ImportErrorDetail('A destination Grok attachment object is invalid.')
            _verify_object(destination_root, entry)
            reused += 1
    result = {
        'dryRun': dry_run,
        'entries': len(merged_entries),
        'bytes': sum(source_sizes.values()),
        'copiedBlobs': copied,
        'reusedBlobs': reused,
        'wroteManifest': wrote_manifest,
    }
    if dry_run or (not source_entries and not destination_exists):
        return result
    if not destination_exists:
        try:
            destination_root.mkdir(mode=0o700)
        except FileExistsError:
            pass
        _regular_directory(destination_root, 'destination')
        _sync_directory(destination_root.parent)
    for entry in source_by_hash.values():
        target_info = _lstat(destination_root / entry['sha256'])
        if target_info is not None:
            _verify_object(destination_root, entry)
            continue
        data = _verify_object(source_root, entry, read=True)[1]
        _publish_object(destination_root, entry, data)
    if wrote_manifest:
        _write_manifest(destination_root, merged_entries, manifest_raw)
    return result


def stage_attachments(
    source_root: Path,
    destination_root: Path,
    dry_run: bool,
    bot_id: str | None = None,
) -> dict:
    """Validate or stage a local manifest-backed attachment vault."""
    if not source_root.is_absolute() or not destination_root.is_absolute():
        raise ImportErrorDetail('Attachment vault paths must be absolute.')
    source_root = Path(os.path.abspath(source_root))
    destination_root = Path(os.path.abspath(destination_root))
    if source_root == destination_root:
        raise ImportErrorDetail('Attachment source and destination must differ.')
    with _destination_lock(destination_root, exclusive=not dry_run):
        return _stage_attachments_locked(source_root, destination_root, dry_run, bot_id)


def connect():
    """Authenticate to the VPS service's private loopback listener."""
    helper = Path.home() / '.local/bin/yharness-vps'
    result = subprocess.run(
        [sys.executable, str(helper), 'url'], check=True, capture_output=True, text=True, timeout=10,
    )
    origin = urlsplit(result.stdout.strip())
    if origin.scheme != 'http' or origin.netloc != '127.0.0.1:3080' or origin.path != '/':
        raise ImportErrorDetail('The VPS setup helper returned an unexpected sign-in address.')
    connection = http.client.HTTPConnection('127.0.0.1', 3080, timeout=120)
    connection.request('GET', '/?' + origin.query)
    response = connection.getresponse()
    cookie = (response.getheader('Set-Cookie') or '').partition(';')[0]
    response.read()
    if response.status != 303 or not re.fullmatch(r'dsh-auth-[\w-]{43}=v1\.[\w-]+\.[\w-]+', cookie):
        connection.close()
        raise ImportErrorDetail('Could not sign in to the private Y Harness service.')
    return connection, cookie


def invoke(connection, cookie, endpoint, **args):
    """Send a trusted operator request and return the decoded success value."""
    rpc_id = str(uuid.uuid4())
    envelope = {'type': 'client-request', 'rpcId': rpc_id, 'method': endpoint, 'payload': {'args': args}}
    connection.request('POST', '/api/' + endpoint, body=json.dumps(envelope), headers={
        'Cookie': cookie, 'Content-Type': 'application/json',
    })
    response = connection.getresponse()
    body = response.read()
    if response.status != 200:
        raise ImportErrorDetail(f'{endpoint} returned HTTP {response.status}.')
    decoded = json.loads(body)
    if decoded.get('type') != 'server-response' or decoded.get('rpcId') != rpc_id:
        raise ImportErrorDetail(f'{endpoint} returned an unexpected response.')
    result = decoded['result']
    if result['ok'] is not True:
        error = result['error']
        message = error.get('message') if error.get('code') == 'gateway/bad-request' else None
        raise ImportErrorDetail(message or f"{endpoint} failed with {error.get('code', 'unknown error')}.")
    return result['value']


def main():
    """Resolve one operator-owned destination and preview or apply the export."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('export', nargs='?', type=Path)
    parser.add_argument('--bot', help='Exact destination Bot name or id')
    parser.add_argument('--source-name', help='Source Bot name for exports containing several Bots')
    parser.add_argument(
        '--attachments', type=Path,
        help='Absolute local manifest-backed attachment vault to validate or stage on the VPS',
    )
    parser.add_argument(
        '--attachments-only', action='store_true',
        help='Validate or stage attachments without importing a Bot export or contacting Y Harness',
    )
    parser.add_argument('--apply', action='store_true', help='Write entries. By default, preview only.')
    options = parser.parse_args()
    try:
        if options.attachments_only:
            if options.attachments is None:
                raise ImportErrorDetail('--attachments-only requires --attachments.')
            if options.export is not None or options.bot is not None or options.source_name is not None:
                raise ImportErrorDetail('--attachments-only cannot be combined with an export, --bot, or --source-name.')
            if not options.attachments.is_absolute() or not options.attachments.is_dir():
                raise ImportErrorDetail('The attachment source must be an existing absolute directory.')
            destination = os.environ.get('DSH_GROK_HISTORY_ATTACHMENT_VAULT')
            if destination is None or not Path(destination).is_absolute():
                raise ImportErrorDetail('Set DSH_GROK_HISTORY_ATTACHMENT_VAULT before staging attachments.')
            attachments = stage_attachments(options.attachments, Path(destination), dry_run=not options.apply)
            print(json.dumps({'mode': 'attachments-only', 'attachments': attachments}, ensure_ascii=False))
            return
        if options.export is None or options.bot is None:
            raise ImportErrorDetail('An export and --bot are required unless --attachments-only is used.')
        if options.attachments is not None:
            if not options.attachments.is_absolute() or not options.attachments.is_dir():
                raise ImportErrorDetail('The attachment source must be an existing absolute directory.')
            destination = os.environ.get('DSH_GROK_HISTORY_ATTACHMENT_VAULT')
            if destination is None or not Path(destination).is_absolute():
                raise ImportErrorDetail('Set DSH_GROK_HISTORY_ATTACHMENT_VAULT before staging attachments.')
        else:
            destination = None
        with options.export.open('rb') as file:
            raw = file.read(MAX_DOCUMENT_BYTES + 1)
        if len(raw) > MAX_DOCUMENT_BYTES:
            raise ImportErrorDetail('Choose a Grok Bot export of at most 512 KiB.')
        document = raw.decode('utf-8-sig')
        connection, cookie = connect()
        try:
            bots = invoke(connection, cookie, 'bots/list', request={'includeHidden': True})['bots']
            matches = [bot for bot in bots if options.bot in (bot['id'], bot['name'])]
            if len(matches) != 1:
                raise ImportErrorDetail('Choose exactly one existing destination Bot by name or id.')
            attachment_preview = None
            if options.attachments is not None and destination is not None:
                attachment_preview = stage_attachments(
                    options.attachments, Path(destination), dry_run=True, bot_id=matches[0]['id'],
                )
            request = {'botId': matches[0]['id'], 'document': document, 'preview': not options.apply}
            if options.source_name is not None:
                request['sourceName'] = options.source_name
            result = invoke(connection, cookie, 'bots/importGrokBot', request=request)
            attachments = attachment_preview
            if options.apply and options.attachments is not None and destination is not None:
                attachments = stage_attachments(
                    options.attachments, Path(destination), dry_run=False, bot_id=matches[0]['id'],
                )
            output = {'mode': 'import' if options.apply else 'preview', **result}
            if attachments is not None:
                output['attachments'] = attachments
            print(json.dumps(output, ensure_ascii=False))
        finally:
            connection.close()
    except ImportErrorDetail as error:
        parser.exit(1, f'{error}\n')
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError, http.client.HTTPException):
        parser.exit(1, 'Could not read the export or communicate with the private Y Harness service.\n')


if __name__ == '__main__':
    main()
