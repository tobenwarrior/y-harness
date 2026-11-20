"""Resolve indexed workspace package and JS/TS alias imports.

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
MAX_ALIAS_CONFIGS = 64
MAX_ALIAS_CONFIG_BYTES = 64 * 1024
MAX_ALIAS_RULES = 2048
MAX_ALIAS_EXTENDS_DEPTH = 16
MAX_ALIAS_READS = 128
MAX_ALIAS_TARGETS = 8
_NAME = re.compile(r"^(?:@[a-zA-Z0-9._~-]+/)?[a-zA-Z0-9._~-]+$")


def _safe_relative(value):
    if not isinstance(value, str) or not value or '\\' in value or '\x00' in value:
        return False
    return not value.startswith('/') and all(part not in ('', '.', '..', 'node_modules') for part in value.split('/'))


def _config_relative(config_dir, value):
    if not isinstance(value, str) or not value or len(value) > 512:
        return None
    candidate = posixpath.normpath(posixpath.join(config_dir.as_posix(), value))
    if candidate == '..' or candidate.startswith('../') or candidate.startswith('/'):
        return None
    return PurePosixPath(candidate).as_posix()


def _strip_jsonc(text):
    """Remove JSONC comments without interpreting config code."""
    output = []
    index = 0
    in_string = False
    escaped = False
    while index < len(text):
        character = text[index]
        following = text[index + 1] if index + 1 < len(text) else ''
        if in_string:
            output.append(character)
            if escaped:
                escaped = False
            elif character == '\\':
                escaped = True
            elif character == '"':
                in_string = False
            index += 1
            continue
        if character == '"':
            in_string = True
            output.append(character)
            index += 1
        elif character == '/' and following == '/':
            index += 2
            while index < len(text) and text[index] not in '\r\n':
                index += 1
        elif character == '/' and following == '*':
            index += 2
            while index + 1 < len(text) and text[index:index + 2] != '*/':
                if text[index] in '\r\n':
                    output.append(text[index])
                index += 1
            index = min(len(text), index + 2)
        else:
            output.append(character)
            index += 1
    return re.sub(r',(\s*[}\]])', r'\1', ''.join(output))


def load_workspace_aliases(root, candidates, fingerprint):
    """Index bounded tsconfig/jsconfig aliases for the repository."""
    configs = []
    cache = {}
    reads = 0

    def load(rel, active):
        nonlocal reads
        if rel in active or len(active) >= MAX_ALIAS_EXTENDS_DEPTH:
            return None
        if rel in cache:
            return cache[rel]
        if rel not in candidates or reads >= MAX_ALIAS_READS:
            return None
        reads += 1
        info = candidates[rel]
        try:
            absolute = info['absolute']
            if (absolute.resolve() != (root / rel).resolve() or not absolute.resolve().is_relative_to(root.resolve())
                    or info['fingerprint']['size'] > MAX_ALIAS_CONFIG_BYTES):
                return None
            with absolute.open('rb') as source:
                data = source.read(MAX_ALIAS_CONFIG_BYTES + 1)
            if len(data) > MAX_ALIAS_CONFIG_BYTES or fingerprint(absolute) != info['fingerprint']:
                return None
            text = data.decode('utf-8-sig')
            payload = json.loads(_strip_jsonc(text))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError, RecursionError, KeyError):
            return None
        if not isinstance(payload, dict):
            return None
        directory = PurePosixPath(rel).parent
        parent = None
        extends = payload.get('extends')
        if isinstance(extends, str) and (extends.startswith('./') or extends.startswith('../')):
            target = _config_relative(directory, extends)
            if target is not None:
                options = [target, target + '.json', posixpath.join(target, 'tsconfig.json')]
                for option in options:
                    if option in candidates:
                        parent = load(option, active | {rel})
                        break
        compiler = payload.get('compilerOptions')
        if not isinstance(compiler, dict):
            compiler = {}
        base_url = parent['base_url'] if parent else None
        if 'baseUrl' in compiler:
            base_url = _config_relative(directory, compiler['baseUrl'])
        paths = parent['paths'] if parent else []
        if isinstance(compiler.get('paths'), dict):
            paths = []
            paths_base = PurePosixPath(base_url) if base_url is not None else directory
            for pattern, targets in list(compiler['paths'].items())[:MAX_ALIAS_RULES]:
                if not isinstance(pattern, str) or not pattern or len(pattern) > 512 or pattern.count('*') > 1 or not isinstance(targets, list):
                    continue
                normalized = [target for target in (_config_relative(paths_base, value) for value in targets[:MAX_ALIAS_TARGETS]) if target is not None]
                if normalized:
                    paths.append((pattern, normalized))
        result = {'directory': directory.as_posix(), 'base_url': base_url, 'paths': paths}
        cache[rel] = result
        return result

    names = {'tsconfig.json', 'jsconfig.json'}
    ordered = sorted(candidates, key=lambda rel: (len(PurePosixPath(rel).parts), rel))
    unloaded = []
    for rel in ordered:
        if PurePosixPath(rel).name.lower() not in names:
            continue
        if len(configs) >= MAX_ALIAS_CONFIGS or reads >= MAX_ALIAS_READS and rel not in cache:
            # Past the caps, leave imports under this config unresolved rather than apply an ancestor's aliases.
            unloaded.append({'directory': PurePosixPath(rel).parent.as_posix(), 'base_url': None, 'paths': [], 'unloaded': True})
            continue
        config = load(rel, set())
        if config and (config['base_url'] or config['paths']):
            configs.append(config)
    return configs + unloaded


def _alias_match(spec, pattern):
    if '*' not in pattern:
        return '' if spec == pattern else None
    prefix, suffix = pattern.split('*', 1)
    if not spec.startswith(prefix) or (suffix and not spec.endswith(suffix)):
        return None
    end = len(spec) - len(suffix) if suffix else len(spec)
    value = spec[len(prefix):end]
    return value if value else None


def _config_applies(config, path):
    directory = config['directory']
    parent = PurePosixPath(path).parent.as_posix()
    return directory in {'', '.'} or parent == directory or parent.startswith(directory + '/')


def resolve_workspace_alias(path, spec, known, configs, javascript_candidates):
    """Resolve a JS/TS import through the most specific indexed config."""
    applicable = sorted(
        (config for config in configs if _config_applies(config, path)),
        key=lambda config: (len(config['directory'].split('/')), config['directory']),
        reverse=True,
    )
    for config in applicable[:1]:
        if config.get('unloaded'):
            return None
        rules = sorted(config['paths'], key=lambda item: ('*' not in item[0], len(item[0])), reverse=True)
        for pattern, targets in rules:
            wildcard = _alias_match(spec, pattern)
            if wildcard is None:
                continue
            for target in targets:
                candidate = target.replace('*', wildcard)
                dependency = javascript_candidates(candidate, known)
                if dependency:
                    return dependency
        if config['base_url']:
            dependency = javascript_candidates(posixpath.join(config['base_url'], spec), known)
            if dependency:
                return dependency
    return None


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
