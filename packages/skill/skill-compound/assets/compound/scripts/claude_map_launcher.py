#!/usr/bin/env python3
"""Install or run Claude Code's version-independent, query-only map launcher."""
from __future__ import annotations

import json
import os
from pathlib import Path
import re
import shlex
import stat
import sys
import tempfile

PLUGIN_ID = "compound-skills@compound-skills"
CACHE = Path("plugins/cache/compound-skills/compound-skills")
DATA = Path("plugins/data/compound-skills-compound-skills")
LAUNCHER = DATA / "claude_map_launcher.py"
SCRIPT = Path("skills/compound/scripts/claude_map_launcher.py")
MAX_STATE_BYTES = 1024 * 1024
VERSION = re.compile(r"[0-9A-Za-z][0-9A-Za-z._+-]{0,127}")


def config_home() -> Path:
    configured = os.environ.get("CLAUDE_CONFIG_DIR")
    base = Path(configured) if configured is not None else Path.home() / ".claude"
    if not base.is_absolute():
        raise ValueError("Claude configuration directory must be absolute")
    return base.parent.resolve() / base.name


def _owned(path: Path, kind) -> None:
    metadata = path.lstat()
    if not kind(metadata.st_mode) or metadata.st_uid != os.getuid() or metadata.st_mode & 0o022:
        raise ValueError(f"unsafe Claude plugin path: {path}")


def _owned_directory(base: Path, relative: Path, *, create: bool = False) -> Path:
    directory = base
    _owned(directory, stat.S_ISDIR)
    for part in relative.parts:
        directory /= part
        if create:
            directory.mkdir(mode=0o700, exist_ok=True)
        _owned(directory, stat.S_ISDIR)
    return directory


def _read_owned(base: Path, relative: Path) -> bytes:
    path = _owned_directory(base, relative.parent) / relative.name
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), "rb") as stream:
        metadata = os.fstat(stream.fileno())
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.getuid() or metadata.st_mode & 0o022:
            raise ValueError(f"unsafe Claude plugin file: {path}")
        data = stream.read(MAX_STATE_BYTES + 1)
    if len(data) > MAX_STATE_BYTES:
        raise ValueError(f"Claude plugin file exceeds the size limit: {path}")
    return data


def current_install(base: Path) -> Path:
    """Resolve only the enabled user install in Claude's own Compound cache."""
    settings = json.loads(_read_owned(base, Path("settings.json")))
    registry = json.loads(_read_owned(base, Path("plugins/installed_plugins.json")))
    enabled = settings.get("enabledPlugins", {})
    if not isinstance(enabled, dict) or enabled.get(PLUGIN_ID) is not True:
        raise ValueError("the user-scope Compound plugin is disabled")
    if registry.get("version") != 2:
        raise ValueError("unsupported Claude plugin registry version")
    rows = registry.get("plugins", {}).get(PLUGIN_ID, [])
    user = [row for row in rows if row.get("scope") == "user"]
    if len(user) != 1:
        raise ValueError("expected one registered user-scope Compound install")
    version, installed = user[0].get("version"), user[0].get("installPath")
    if not isinstance(version, str) or not VERSION.fullmatch(version) or not isinstance(installed, str):
        raise ValueError("invalid registered Compound install")
    candidate = _owned_directory(base, CACHE / version)
    if not Path(installed).is_absolute() or Path(installed).resolve() != candidate:
        raise ValueError("registered Compound install is outside its expected cache path")
    return candidate


def query_command(base: Path) -> str:
    path = str(base / LAUNCHER)
    if not re.fullmatch(r'[^\x00-\x1f\x7f"\\`$*?\[\]]+', path):
        raise ValueError("Claude launcher path contains characters unsafe in an allow rule")
    return f"python3 -IB {shlex.quote(path)} query"


def permission_rules(base: Path) -> list[str]:
    cache = re.sub(r"([\\*?\[\]])", r"\\\1", str(base / CACHE))
    return [f"Bash({query_command(base)}:*)", f"Read(/{cache}/*/skills/compound/**)"]


def install(base: Path) -> dict:
    source = Path(__file__).resolve()
    active = current_install(base)
    if source != active / SCRIPT:
        raise ValueError("install the launcher from Claude's active Compound plugin")
    rules = permission_rules(base)
    destination = _owned_directory(base, DATA, create=True) / LAUNCHER.name
    contents = _read_owned(base, source.relative_to(base))
    fd, temporary = tempfile.mkstemp(prefix=".map-query-", dir=destination.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(contents)
            stream.flush()
            os.fsync(stream.fileno())
        try:
            os.link(temporary, destination)
        except FileExistsError:
            if _read_owned(base, LAUNCHER) != contents:
                raise ValueError("existing Claude map launcher differs from the packaged launcher") from None
    finally:
        Path(temporary).unlink()
    return {"launcher": str(destination), "command": query_command(base), "permission_rules": rules}


def run_query(argv: list[str]) -> int:
    source = Path(__file__).resolve()
    base = source.parents[len(LAUNCHER.parts) - 1]
    if not sys.flags.isolated or source != base / LAUNCHER:
        raise ValueError("run the installed Claude launcher with python3 -IB")
    directory = current_install(base) / "skills/compound/scripts"
    _owned_directory(base, directory.relative_to(base))
    _owned(directory / "code_map.py", stat.S_ISREG)
    # The map can start a child Python process. Keep ignored Python env out of it too.
    for name in tuple(os.environ):
        if name.startswith("PYTHON"):
            os.environ.pop(name)
    sys.path.insert(0, str(directory))
    import code_map

    parser = code_map._parser()
    parser.allow_abbrev = False
    args = parser.parse_args(argv)
    if args.open_html or args.format == "html":
        raise ValueError("the Claude launcher allows map queries only")
    return code_map.main(argv)


def main(argv: list[str]) -> int:
    try:
        if os.name != "posix":
            raise ValueError("stable Claude map permissions require POSIX file ownership")
        if argv == ["install"]:
            print(json.dumps(install(config_home())))
            return 0
        if argv[:1] == ["query"]:
            return run_query(argv[1:])
        raise ValueError("use install or query")
    except (ImportError, OSError, ValueError, TypeError, AttributeError, RuntimeError) as error:
        print(f"Claude map launcher: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
