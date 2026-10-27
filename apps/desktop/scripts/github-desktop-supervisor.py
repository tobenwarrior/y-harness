#!/usr/bin/env python3
"""User-local source supervisor. No signing or source authenticity is implied."""
import argparse
from contextlib import contextmanager, ExitStack
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import threading

_spec = importlib.util.spec_from_file_location('github_source_updater', Path(__file__).with_name('github-source-updater.py'))
_engine = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_engine)

SUPPORT = Path.home() / 'Library/Application Support/Y Harness GitHub'
COMMIT = re.compile(r'[0-9a-f]{40}\Z')
ACTIVATE_SCRIPT = '''use framework "AppKit"
on run argv
    set appPid to (item 1 of argv) as integer
    set targetApp to current application's NSRunningApplication's runningApplicationWithProcessIdentifier:appPid
    if targetApp is not missing value then targetApp's activateWithOptions:2
end run'''

def private_dir(path):
    path = Path(path).absolute()
    for part in reversed((path, *path.parents)):
        if part.is_symlink():
            raise ValueError('symlink in support path')
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = path.stat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError('support directory must be private')
    return path


def load_config(support):
    directory = private_dir(Path(support) / 'bootstrap')
    path = directory / 'runtime.json'
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_size > 16384:
            raise ValueError('runtime config must be a private regular file')
        with os.fdopen(fd, encoding='utf-8') as stream:
            fd = -1
            config = json.load(stream)
    finally:
        if fd != -1:
            os.close(fd)
    if (not isinstance(config, dict) or set(config) != {'schemaVersion', 'node', 'pnpm'}
            or type(config['schemaVersion']) is not int or config['schemaVersion'] != 1):
        raise ValueError('invalid runtime config schema')
    for value in (config['node'], config['pnpm']):
        if not isinstance(value, str) or not os.path.isabs(value) or not os.path.isfile(value) or not os.access(value, os.X_OK):
            raise ValueError('runtime executables must be absolute executable files')
    return config


@contextmanager
def supervisor_lock(support):
    path = Path(support) / '.supervisor.lock'
    fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_nlink != 1:
            raise ValueError('invalid supervisor lock')
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield
    finally:
        os.close(fd)


def current_commit(root):
    current = Path(root) / 'current'
    if not current.is_symlink():
        if current.exists():
            raise ValueError('invalid current')
        return None
    target = os.readlink(current)
    if not re.fullmatch(r'versions/[0-9a-f]{40}', target):
        raise ValueError('invalid current link')
    return target.split('/')[1]


def ready_commit(root):
    path = Path(root) / 'update-status.json'
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        return None
    except OSError as exc:
        raise ValueError('invalid status file') from exc
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size > 4096:
            raise ValueError('invalid status file')
        with os.fdopen(fd, encoding='utf-8') as stream:
            fd = -1
            try:
                status = json.load(stream)
            except (ValueError, UnicodeError):
                return None
    finally:
        if fd != -1:
            os.close(fd)
    if (isinstance(status, dict) and status.get('phase') == 'ready'
            and isinstance(status.get('commit'), str) and COMMIT.fullmatch(status['commit'])):
        return status['commit']
    return None


def log_error(label):
    # Never include exception text: command output and config can contain secrets.
    print(label, file=sys.stderr, flush=True)


def runtime_environment(config, *, for_build=False):
    if for_build:
        allowed = ("HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "PATH", "SSL_CERT_FILE", "SSL_CERT_DIR")
        environment = {key: os.environ[key] for key in allowed if key in os.environ}
        environment["NPM_CONFIG_USERCONFIG"] = os.devnull
        environment["NPM_CONFIG_GLOBALCONFIG"] = os.devnull
    else:
        environment = os.environ.copy()
    directories = [str(Path(config['node']).parent), str(Path(config['pnpm']).parent)]
    environment['PATH'] = os.pathsep.join(directories + [environment.get('PATH', ''), '/usr/bin', '/bin', '/usr/sbin', '/sbin'])
    environment['COREPACK_ENABLE_DOWNLOAD_PROMPT'] = '0'
    return environment


class Supervisor:
    def __init__(self, updater, support, config, *, popen=subprocess.Popen, interval=600, cancel=None):
        self.updater, self.support, self.config = updater, Path(support), config
        self.popen, self.interval = popen, interval
        self.stop = threading.Event()
        self.cancel = cancel if cancel is not None else threading.Event()
        self.operation = threading.Lock()

    def poll_once(self):
        try:
            with self.operation:
                commit = self.updater.check()
                current = self.updater.current()
                ready = ready_commit(self.updater.root)
                if ready is not None and ready != commit and current is not None:
                    self.updater.mark_current()
                    ready = None
                if commit != current and commit != ready:
                    self.updater.stage(commit)
        except InterruptedError:
            if not self.cancel.is_set():
                log_error('update check or stage failed')
        except Exception:
            log_error('update check or stage failed')

    def poll_loop(self):
        while not self.stop.is_set():
            self.poll_once()
            if self.stop.wait(self.interval):
                break

    def prepare(self):
        with self.operation:
            current = self.updater.current()
            ready = ready_commit(self.updater.root)
            if ready and ready != current:
                try:
                    if self.updater.check() == ready:
                        self.updater.activate(ready, between_runs=True)
                        current = ready
                    elif current is not None:
                        self.updater.mark_current()
                except Exception:
                    log_error('staged update activation failed')
                    if current is not None:
                        try:
                            self.updater.mark_current()
                        except Exception:
                            log_error('stale update status could not be cleared')
            if current is None:
                commit = self.updater.check()
                self.updater.stage(commit)
                self.updater.activate(commit, between_runs=True)
                current = commit
            return current

    def run_once(self, on_started=None):
        commit = self.prepare()
        home = private_dir(self.support / 'data/home')
        user_data = private_dir(self.support / 'data/electron-user-data')
        env = runtime_environment(self.config)
        env.update({'DSH_HOME': str(home),
                    'DSH_DESKTOP_USER_DATA_DIR': str(user_data),
                    'DSH_DESKTOP_GITHUB_STATUS': str(self.updater.root / 'update-status.json'),
                    'DSH_DESKTOP_GITHUB_BUILD_COMMIT': commit,
                    'DSH_DESKTOP_GITHUB_MANAGED': '1', 'DSH_DESKTOP_DISABLE_INSPECTORS': '1', 'DSH_DESKTOP_OPEN_DEVTOOLS': '0'})
        with self.updater.run_guard():
            child = self.popen([self.config['node'], self.config['pnpm'], 'run', 'start:desktop'],
                               cwd=str(self.updater.root / 'versions' / commit), env=env,
                               stdin=subprocess.DEVNULL, close_fds=True)
            if on_started is not None:
                on_started()
            return child.wait()

    def serve(self):
        # Initial bootstrap must complete before the poller can use the updater.
        self.prepare()
        worker = threading.Thread(target=self.poll_loop, daemon=True)
        started = False

        def start_worker():
            nonlocal started
            try:
                worker.start()
                started = True
            except RuntimeError:
                log_error('update polling could not start')

        try:
            result = self.run_once(start_worker)
        finally:
            self.stop.set()
            self.cancel.set()
            if started:
                worker.join()
            self.cancel.clear()
        self.prepare()
        return result


def focus_existing(support, *, owner_finder=None):
    root = Path(support) / 'managed'
    commit = current_commit(root)
    if commit is None:
        return
    version = root / 'versions' / commit
    app_root = version / 'apps/desktop'
    app = app_root / '.desktop-build/development/Y harness.app'
    for parent in (app, *app.parents):
        if parent == root:
            break
        if parent.is_symlink():
            raise ValueError('symlink in managed application path')
    if not app.is_dir():
        return
    if owner_finder is None:
        source = Path(__file__).with_name('development_owner.py')
        if source.is_symlink() or not source.is_file():
            raise ValueError('managed owner inspection is unavailable')
        spec = importlib.util.spec_from_file_location('github_desktop_owner', source)
        owner = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(owner)
        owner_finder = owner.find_development_owner
    executable = app / 'Contents/MacOS/Electron'
    user_data = Path(support) / 'data/electron-user-data'
    pid = owner_finder(str(executable), str(app_root), str(user_data))
    if isinstance(pid, int) and not isinstance(pid, bool) and pid > 0:
        subprocess.run(['/usr/bin/osascript', '-e', ACTIVATE_SCRIPT, str(pid)], stdin=subprocess.DEVNULL,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10, check=False)


def main(argv=None):
    parser = argparse.ArgumentParser()
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument('--start', action='store_true')
    group.add_argument('--serve', action='store_true')
    args = parser.parse_args(argv)
    try:
        support = private_dir(SUPPORT)
        if args.start:
            # The child acquires the lock; no shell or inherited terminal is needed.
            fd = os.open(support / 'supervisor.log', os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_NOFOLLOW, 0o600)
            try:
                info = os.fstat(fd)
                if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_nlink != 1:
                    raise ValueError('invalid log file')
                subprocess.Popen([sys.executable, str(Path(__file__).absolute()), '--serve'],
                                 stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                 stderr=fd, start_new_session=True, close_fds=True)
            finally:
                os.close(fd)
            return 0
        stack = ExitStack()
        try:
            stack.enter_context(supervisor_lock(support))
        except BlockingIOError:
            focus_existing(support)
            return 0
        with stack:
            config = load_config(support)
            private_dir(support / 'data')
            pnpm = config['pnpm']
            cancel = threading.Event()
            updater = _engine.SourceUpdater(support / 'managed',
                install=[[pnpm, 'install', '--frozen-lockfile'], [pnpm, '--filter', '@deepseek-ai/dsh-desktop', 'exec', 'install-electron']],
                build=[[pnpm, 'run', 'build'], [pnpm, '--filter', '@deepseek-ai/dsh-desktop', 'run', 'build'],
                         [pnpm, '--filter', '@deepseek-ai/dsh-desktop', 'run', 'prepare:primary-runtime']],
                runner=lambda argv, cwd, timeout: runtime_run(argv, cwd, timeout, config, cancel))
            updater.bootstrap()
            return Supervisor(updater, support, config, cancel=cancel).serve()
    except Exception:
        log_error('supervisor failed')
        return 1


def runtime_run(argv, cwd, timeout, config, cancel=None):
    # Run pnpm through the configured node regardless of its shebang or PATH.
    if argv[0] == config['pnpm']:
        argv = [config['node']] + argv
    return _engine._run(argv, cwd, timeout, runtime_environment(config, for_build=True), cancel_event=cancel)


if __name__ == '__main__':
    sys.exit(main())
