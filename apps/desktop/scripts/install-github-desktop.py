#!/usr/bin/env python3
"""Install the separate GitHub launcher; never modifies an existing installation."""
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
from pathlib import Path


def applescript_string(value):
    # AppleScript string literals escape backslashes and double quotes.
    if any(ord(c) < 32 or ord(c) == 127 for c in value):
        raise ValueError("control characters in launcher paths are not supported")
    return '"' + value.replace('\\', '\\\\').replace('"', '\\"') + '"'


def launcher_source(updater):
    path = applescript_string(str(updater))
    return '''use framework "Foundation"
use scripting additions
on run
    set task to current application's NSTask's alloc()'s init()
    task's setLaunchPath:"/usr/bin/python3"
    task's setArguments:{%s, "--start"}
    task's |launch|()
end run
''' % path


def directory(path):
    """Create missing ancestors, but never follow a symlink in the path."""
    for part in reversed((path, *path.parents)):
        try:
            mode = part.lstat().st_mode
        except FileNotFoundError:
            part.mkdir(mode=0o700)
            mode = part.lstat().st_mode
        if not stat.S_ISDIR(mode):
            raise ValueError(f"not a real directory: {part}")


def install(home, source, run=subprocess.run, *, resolve_tool=shutil.which):
    home = Path(home).absolute()
    source = Path(source)
    app = home / "Applications" / "Y Harness GitHub.app"
    support = home / "Library" / "Application Support" / "Y Harness GitHub"
    # Check both destinations before creating anything. lexists includes dangling links.
    for dest in (app, support):
        if os.path.lexists(dest):
            raise FileExistsError(f"destination already exists: {dest}")
    supervisor_source = source.with_name("github-desktop-supervisor.py")
    bootstrap_source = source.with_name("github-desktop-bootstrap.py")
    owner_source = source.with_name("development_owner.py")
    for path in (source, supervisor_source, bootstrap_source, owner_source):
        if not stat.S_ISREG(path.lstat().st_mode):
            raise ValueError(f"bootstrap source must be a regular file: {path}")
    tools = {}
    for name in ("node", "pnpm"):
        value = resolve_tool(name)
        if not value or not Path(value).is_absolute() or not Path(value).is_file() or not os.access(value, os.X_OK):
            raise ValueError(f"{name} executable is required to build updates")
        tools[name] = value
    directory(app.parent)
    directory(support.parent)
    # Exclusive creation makes a concurrent collision fail rather than overwrite it.
    support.mkdir(mode=0o700)
    bootstrap = support / "bootstrap"
    bootstrap.mkdir(mode=0o700)
    updater = bootstrap / "github-source-updater.py"
    with source.open("rb") as src, updater.open("xb") as dst:
        os.fchmod(dst.fileno(), 0o600)
        shutil.copyfileobj(src, dst)
    supervisor = bootstrap / "github-desktop-supervisor.py"
    with supervisor_source.open("rb") as src, supervisor.open("xb") as dst:
        os.fchmod(dst.fileno(), 0o600)
        shutil.copyfileobj(src, dst)
    with (bootstrap / "runtime.json").open("x", encoding="utf-8") as config:
        os.fchmod(config.fileno(), 0o600)
        json.dump({"schemaVersion": 1, **tools}, config)
    entry = bootstrap / "github-desktop-bootstrap.py"
    with bootstrap_source.open("rb") as src, entry.open("xb") as dst:
        os.fchmod(dst.fileno(), 0o600)
        shutil.copyfileobj(src, dst)
    owner = bootstrap / "development_owner.py"
    with owner_source.open("rb") as src, owner.open("xb") as dst:
        os.fchmod(dst.fileno(), 0o600)
        shutil.copyfileobj(src, dst)
    script = launcher_source(entry)
    # Compile outside the final destination. A failed install leaves its private
    # data in place for explicit inspection/removal, never deletes user data.
    with tempfile.TemporaryDirectory(prefix="launcher-", dir=support) as tmp:
        compiled = Path(tmp) / "launcher.app"
        run(["/usr/bin/osacompile", "-o", str(compiled), "-e", script], check=True)
        app.mkdir(mode=0o700)
        for child in compiled.iterdir():
            target = app / child.name
            if child.is_symlink():
                raise ValueError(f"unexpected symlink in compiled app: {child}")
            if child.is_dir():
                shutil.copytree(child, target, symlinks=True)
            else:
                shutil.copy2(child, target, follow_symlinks=False)
    return app


def main():
    if sys.platform != "darwin":
        print("This installer requires macOS.", file=sys.stderr)
        return 1
    try:
        app = install(Path.home(), Path(__file__).with_name("github-source-updater.py"))
    except (OSError, ValueError, subprocess.CalledProcessError) as exc:
        print(f"Installation failed: {exc}. Existing data was not removed; inspect any partial installation before retrying.", file=sys.stderr)
        return 1
    print(f"Installed {app}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
