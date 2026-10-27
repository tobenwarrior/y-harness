"""Resolve indexed workspace package imports without consulting node_modules.

Call ``load_workspace_packages(root, candidates)`` once, then pass its result to
``resolve_workspace_import(spec, known, packages, javascript_candidates)``.
Candidates use code_map's relative-path -> {absolute, fingerprint} shape.
"""

import json

import posixpath
import re
from pathlib import Path, PurePosixPath

MAX_PACKAGE_FILES = 2048
MAX_PACKAGE_BYTES = 256 * 1024
MAX_EXPORT_RULES = 1024
MAX_EXPORT_DEPTH = 16
_NAME = re.compile(r"^(?:@[a-zA-Z0-9._~-]+/)?[a-zA-Z0-9._~-]+$")


def _safe_relative(value):
    if not isinstance(value, str) or not value or '\\' in value or '\x00' in value:
        return False
    return not value.startswith('/') and all(part not in ('', '.', '..', 'node_modules') for part in value.split('/'))


def load_workspace_packages(root, candidates):
    """Index valid manifests; duplicate names are deliberately unresolvable."""
    root = Path(root).resolve()
    packages = {}
    count = 0
    for rel, info in sorted(candidates.items()):
        if PurePosixPath(rel).name != 'package.json' or not _safe_relative(rel):
            continue
        if 'node_modules' in rel.split('/'):
            continue
        # Bound attempted reads, not just successfully parsed manifests.
        if count >= MAX_PACKAGE_FILES:
            break
        count += 1
        try:
            path = root / rel
            if Path(info['absolute']).resolve() != path.resolve() or any((root.joinpath(*PurePosixPath(rel).parts[:i])).is_symlink() for i in range(1, len(PurePosixPath(rel).parts) + 1)):
                continue
            before = path.lstat()
            expected = info.get("fingerprint")
            if expected and any(int(getattr(before, attr)) != expected.get(key) for key, attr in (("ctime_ns", "st_ctime_ns"), ("inode", "st_ino"), ("size", "st_size"), ("mtime_ns", "st_mtime_ns"))):
                continue
            if before.st_size > MAX_PACKAGE_BYTES:
                continue
            with path.open('rb') as stream:
                data = stream.read(MAX_PACKAGE_BYTES + 1)
            after = path.lstat()
            if len(data) > MAX_PACKAGE_BYTES or (before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns):
                continue
            payload = json.loads(data)
        except (OSError, ValueError, KeyError, TypeError, RecursionError):
            continue
        if not isinstance(payload, dict):
            continue
        name = payload.get('name')
        if not isinstance(name, str) or not _NAME.fullmatch(name) or not _safe_relative(name):
            continue
        package = (PurePosixPath(rel).parent.as_posix(), payload)
        packages[name] = package if name not in packages else None
    return packages


def _targets(value, depth=0):
    if depth >= MAX_EXPORT_DEPTH:
        return
    if isinstance(value, str):
        yield value
    elif isinstance(value, list):
        for item in value[:MAX_EXPORT_RULES]:
            yield from _targets(item, depth + 1)
    elif isinstance(value, dict):
        # Prefer source/types, then normal Node conditions; unknown conditions
        # are not active and must not leak private or platform-specific paths.
        for key in ('source', 'types', 'import', 'require', 'node', 'default'):
            if key in value:
                yield from _targets(value[key], depth + 1)


def _export_value(exports, subpath):
    if not isinstance(exports, dict) or not any(isinstance(k, str) and k.startswith('.') for k in exports):
        return (exports, '') if subpath == '.' else (None, '')
    if subpath in exports:
        return exports[subpath], ''
    matches = []
    for key, value in list(exports.items())[:MAX_EXPORT_RULES]:
        if not isinstance(key, str) or key.count('*') != 1:
            continue
        prefix, suffix = key.split('*')
        if subpath.startswith(prefix) and subpath.endswith(suffix) and len(subpath) >= len(prefix) + len(suffix):
            replacement = subpath[len(prefix):len(subpath) - len(suffix) if suffix else None]
            matches.append((len(prefix), len(suffix), key, value, replacement))
    if not matches:
        return None, ''
    _, _, _, value, replacement = max(matches, key=lambda match: match[:3])
    return value, replacement


def resolve_workspace_import(spec, known, packages, javascript_candidates):
    """Resolve a bare package specifier to an indexed file, or return None."""
    if not isinstance(spec, str) or not _safe_relative(spec):
        return None
    parts = spec.split('/')
    name_length = 2 if spec.startswith('@') else 1
    if len(parts) < name_length:
        return None
    name = '/'.join(parts[:name_length])
    package = packages.get(name)
    if not package:
        return None
    directory, manifest = package
    remainder = '/'.join(parts[name_length:])
    subpath = './' + remainder if remainder else '.'
    if 'exports' in manifest:
        value, replacement = _export_value(manifest['exports'], subpath)
        targets = (target.replace('*', replacement) for target in _targets(value))
    elif remainder:
        targets = iter(('./' + remainder,))
    else:
        targets = iter([manifest.get(key) for key in ('source', 'types', 'module', 'main')] + ['./index'])
    for target in targets:
        if not isinstance(target, str):
            continue
        # Export targets are package-relative; legacy entry points may omit './'.
        if 'exports' in manifest and not target.startswith('./'):
            continue
        target = target[2:] if target.startswith('./') else target
        if not _safe_relative(target):
            continue
        base = posixpath.join(directory, target)
        result = javascript_candidates(base, known)
        if result in known and (directory == '.' or result.startswith(directory + '/')):
            return result
    return None
