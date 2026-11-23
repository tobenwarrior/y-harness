#!/usr/bin/env python3
"""Install or explicitly upgrade the separate GitHub launcher."""
import argparse
import ctypes
import errno
import fcntl
import json
import os
import plistlib
import shutil
import stat
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path


LSREGISTER = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
CODESIGN = "/usr/bin/codesign"
RENAME_SWAP = 0x2
BOOTSTRAP_FILES = (
    "github-source-updater.py",
    "github-desktop-supervisor.py",
    "github-desktop-bootstrap.py",
    "development_owner.py",
)


def applescript_string(value):
    # AppleScript string literals escape backslashes and double quotes.
    if any(ord(c) < 32 or ord(c) == 127 for c in value):
        raise ValueError("control characters in launcher paths are not supported")
    return '"' + value.replace('\\', '\\\\').replace('"', '\\"') + '"'


def launcher_source(updater):
    path = applescript_string(str(updater))
    return '''use framework "Foundation"
use scripting additions
on run argv
    my startSupervisor(argv)
end run
-- GURLGURL is the macOS open-location Apple event.
on «event GURLGURL» openedURL
    my startSupervisor({openedURL as text})
end «event GURLGURL»
on startSupervisor(opened)
    set taskArguments to {%s, "--start"}
    repeat with value in opened
        set valueText to value as text
        if valueText starts with "dsh://" then
            set end of taskArguments to "--open-url"
            set end of taskArguments to valueText
        end if
    end repeat
    set task to current application's NSTask's alloc()'s init()
    task's setLaunchPath:"/usr/bin/python3"
    task's setArguments:taskArguments
    task's |launch|()
end startSupervisor
''' % path


def register_dsh_scheme(bundle):
    """Add the stable wrapper's URL type without changing its signed carrier."""
    plist = Path(bundle) / "Contents" / "Info.plist"
    if plist.is_symlink() or not plist.is_file():
        raise ValueError("compiled launcher is missing a regular Info.plist")
    try:
        values = plistlib.loads(plist.read_bytes())
    except (OSError, plistlib.InvalidFileException, ValueError) as exc:
        raise ValueError("compiled launcher has an invalid Info.plist") from exc
    if not isinstance(values, dict):
        raise ValueError("compiled launcher has an invalid Info.plist")
    url_types = values.get("CFBundleURLTypes", [])
    if not isinstance(url_types, list):
        raise ValueError("compiled launcher has invalid URL types")
    for entry in url_types:
        schemes = entry.get("CFBundleURLSchemes") if isinstance(entry, dict) else None
        if isinstance(schemes, list) and "dsh" in schemes:
            return
    url_types.append({
        "CFBundleURLName": "Y Harness",
        "CFBundleURLSchemes": ["dsh"],
        "CFBundleTypeRole": "Viewer",
    })
    values["CFBundleURLTypes"] = url_types
    plist.write_bytes(plistlib.dumps(values, fmt=plistlib.FMT_BINARY))


def sign_bundle(bundle, run=subprocess.run):
    """Ad-hoc sign and verify a staged launcher after editing its plist."""
    run([CODESIGN, "--force", "--deep", "--sign", "-", "--timestamp=none", str(bundle)],
        check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    run([CODESIGN, "--verify", "--deep", "--strict", str(bundle)],
        check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def _path_without_symlink(path, stop):
    current = Path(path).absolute()
    stop = Path(stop).absolute()
    for item in (current, *current.parents):
        if item == stop:
            break
        if item.is_symlink():
            raise ValueError(f"symlink in managed path: {item}")


def _owned_directory(path, label, *, private):
    path = Path(path)
    _path_without_symlink(path, path.anchor)
    try:
        info = path.lstat()
    except FileNotFoundError as exc:
        raise ValueError(f"{label} is missing") from exc
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid():
        raise ValueError(f"{label} must be an owned directory")
    if private and info.st_mode & 0o077:
        raise ValueError(f"{label} must be private")
    return path


def _owned_regular(path, label, *, private):
    path = Path(path)
    try:
        info = path.lstat()
    except FileNotFoundError as exc:
        raise ValueError(f"{label} is missing") from exc
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1:
        raise ValueError(f"{label} must be an owned regular file")
    if private and info.st_mode & 0o077:
        raise ValueError(f"{label} must be private")
    if not private and info.st_mode & 0o022:
        raise ValueError(f"{label} must not be writable by others")
    return path


def _acquire_supervisor_lock(support):
    """Hold the managed lock while replacing the wrapper and bootstrap."""
    path = Path(support) / ".supervisor.lock"
    try:
        fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    except OSError:
        raise
    try:
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                or info.st_mode & 0o077 or info.st_nlink != 1):
            raise ValueError("invalid supervisor lock")
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise RuntimeError("quit Y Harness before upgrading its managed launcher") from exc
    except Exception:
        os.close(fd)
        raise
    return fd


def _release_supervisor_lock(fd):
    try:
        fcntl.flock(fd, fcntl.LOCK_UN)
    finally:
        os.close(fd)


def _rename_swap(source, destination):
    """Atomically exchange two managed paths on a macOS volume."""
    if sys.platform != "darwin":
        raise OSError(errno.ENOTSUP, "atomic path exchange requires macOS", str(destination))
    libc = ctypes.CDLL(None, use_errno=True)
    renamex = libc.renamex_np
    renamex.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
    renamex.restype = ctypes.c_int
    result = renamex(os.fsencode(source), os.fsencode(destination), RENAME_SWAP)
    if result != 0:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error), str(destination))


def _validate_existing_install(home):
    home = Path(home).absolute()
    app = home / "Applications" / "Y Harness GitHub.app"
    support = home / "Library" / "Application Support" / "Y Harness GitHub"
    _owned_directory(app, "managed launcher", private=True)
    _owned_directory(support, "managed support", private=True)
    bootstrap = _owned_directory(support / "bootstrap", "managed bootstrap", private=True)
    for name in BOOTSTRAP_FILES:
        _owned_regular(bootstrap / name, f"managed bootstrap/{name}", private=True)
    _owned_regular(bootstrap / "runtime.json", "managed bootstrap/runtime.json", private=True)
    contents = _owned_directory(app / "Contents", "managed launcher Contents", private=False)
    _owned_regular(contents / "Info.plist", "managed launcher Info.plist", private=False)
    _owned_directory(contents / "MacOS", "managed launcher MacOS", private=False)
    executable = contents / "MacOS" / "applet"
    if not executable.exists():
        executable = contents / "MacOS" / "Electron"
    _owned_regular(executable, "managed launcher executable", private=False)
    return app, support, bootstrap


def _copy_regular(source, destination, *, mode=0o600):
    source = _owned_regular(source, "bootstrap source", private=False)
    destination = Path(destination)
    with source.open("rb") as src, destination.open("xb") as dst:
        os.fchmod(dst.fileno(), mode)
        shutil.copyfileobj(src, dst)


def _bootstrap_source(source, name):
    return Path(source) if name == "github-source-updater.py" else Path(source).with_name(name)


def _stage_bootstrap(support, source):
    staging = Path(support) / (".bootstrap-upgrade-" + uuid.uuid4().hex)
    staging.mkdir(mode=0o700)
    try:
        for name in BOOTSTRAP_FILES:
            _copy_regular(_bootstrap_source(source, name), staging / name)
        runtime = Path(support) / "bootstrap" / "runtime.json"
        _copy_regular(runtime, staging / "runtime.json")
    except Exception:
        shutil.rmtree(staging)
        raise
    return staging


def upgrade_existing(home, source, run=subprocess.run, *, register=subprocess.run, sign=None, exchange=None):
    """Upgrade an installed managed wrapper without replacing its profile or versions."""
    app, support, bootstrap = _validate_existing_install(home)
    lock_fd = _acquire_supervisor_lock(support)
    swap = _rename_swap if exchange is None else exchange
    try:
        source = Path(source)
        for name in BOOTSTRAP_FILES:
            _owned_regular(_bootstrap_source(source, name), f"bootstrap source/{name}", private=False)
        staged_bootstrap = _stage_bootstrap(support, source)
        staged_app = Path(support) / (".launcher-upgrade-" + uuid.uuid4().hex + ".app")
        old_app = Path(support) / (".launcher-backup-" + uuid.uuid4().hex + ".app")
        old_bootstrap = Path(support) / (".bootstrap-backup-" + uuid.uuid4().hex)
        bootstrap_swapped = False
        app_swapped = False
        try:
            script = launcher_source(bootstrap / "github-desktop-bootstrap.py")
            run(["/usr/bin/osacompile", "-o", str(staged_app), "-e", script], check=True)
            register_dsh_scheme(staged_app)
            if sign is not None:
                sign(staged_app)
            elif run is subprocess.run:
                sign_bundle(staged_app)
            os.chmod(staged_app, 0o700)
            _owned_directory(staged_app, "staged managed launcher", private=False)
            _owned_regular(staged_app / "Contents" / "Info.plist", "staged launcher Info.plist", private=False)
            _owned_directory(staged_app / "Contents" / "MacOS", "staged launcher MacOS", private=False)
            executable = staged_app / "Contents" / "MacOS" / "applet"
            if not executable.exists():
                executable = staged_app / "Contents" / "MacOS" / "Electron"
            _owned_regular(executable, "staged launcher executable", private=False)
            swap(staged_bootstrap, bootstrap)
            bootstrap_swapped = True
            try:
                swap(staged_app, app)
                app_swapped = True
            except Exception:
                # The old wrapper and bootstrap remain available if the second
                # exchange fails. Restore the original pair when possible.
                try:
                    swap(staged_bootstrap, bootstrap)
                    bootstrap_swapped = False
                except Exception as rollback_error:
                    raise RuntimeError(
                        "managed launcher exchange failed; old and new paths were retained"
                    ) from rollback_error
                raise
            os.rename(staged_bootstrap, old_bootstrap)
            os.rename(staged_app, old_app)
            if sys.platform == "darwin" and (run is subprocess.run or register is not subprocess.run):
                register([LSREGISTER, "-f", str(app)], check=False,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            return app
        except Exception:
            if not bootstrap_swapped and staged_bootstrap.exists():
                shutil.rmtree(staged_bootstrap)
            if not app_swapped and staged_app.exists():
                shutil.rmtree(staged_app)
            raise
    finally:
        _release_supervisor_lock(lock_fd)


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


def install(home, source, run=subprocess.run, *, resolve_tool=shutil.which, register=subprocess.run):
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
        register_dsh_scheme(compiled)
        if run is subprocess.run:
            sign_bundle(compiled, run=run)
        app.mkdir(mode=0o700)
        for child in compiled.iterdir():
            target = app / child.name
            if child.is_symlink():
                raise ValueError(f"unexpected symlink in compiled app: {child}")
            if child.is_dir():
                shutil.copytree(child, target, symlinks=True)
            else:
                shutil.copy2(child, target, follow_symlinks=False)
    # Tests inject the compiler runner and do not have a real Launch Services
    # database. Registration is best-effort because a fresh macOS profile can
    # temporarily reject a scan; opening the wrapper registers it again.
    if sys.platform == "darwin" and (run is subprocess.run or register is not subprocess.run):
        register([LSREGISTER, "-f", str(app)], check=False,
                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return app


def main(argv=None):
    if sys.platform != "darwin":
        print("This installer requires macOS.", file=sys.stderr)
        return 1
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--upgrade-existing",
        action="store_true",
        help="upgrade the existing managed launcher without replacing its profile or versions",
    )
    args = parser.parse_args(argv)
    try:
        source = Path(__file__).with_name("github-source-updater.py")
        app = (upgrade_existing if args.upgrade_existing else install)(Path.home(), source)
    except (OSError, RuntimeError, ValueError, subprocess.CalledProcessError) as exc:
        print(f"Installation failed: {exc}. Existing data was not removed; inspect any partial installation before retrying.", file=sys.stderr)
        return 1
    print(f"Installed {app}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
