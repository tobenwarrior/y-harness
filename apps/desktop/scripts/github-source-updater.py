"""Isolated, opt-in source updater; this module does not launch or install an app.

Example (caller supplies vetted install/build argv, appropriate for its checkout):
    u = SourceUpdater(Path.home() / 'Library/Application Support/YHarness/source-updater')
    u.bootstrap()                  # empty/new updater-owned directory only
    commit = u.check()             # exact current branch tip
    u.stage(commit)                # clone, install, build; no switch on failure
    u.activate(commit, between_runs=True)

A launcher must hold u.run_guard() for the *entire* app lifetime and activate only
before acquiring it, after all old app processes exit. Advisory locks coordinate
only cooperating callers. No signing/notarization or binary release is provided;
GitHub source and build scripts are executable code, not a trust guarantee. The
root must be private to the user and never shared with a working checkout. Keep
app user data outside the version directories. Failed stages and old versions are
intentionally retained; no cleanup is performed. update-status.json is atomically
published after successful staging as {"phase":"ready","commit":"<40 hex>"};
a successful activation publishes phase "active" with the same commit.
All operations raise on failure. Runner injection uses runner(argv, cwd, timeout)
and returns stdout text, raising on error; production calls have bounded time/output.
"""
from contextlib import contextmanager
import fcntl
import json
import os
import platform
from pathlib import Path
import re
import signal
import subprocess
import sys
import tempfile
import time
import uuid

DEFAULT_REPO = 'https://github.com/tobenwarrior/y-harness.git'
DEFAULT_BRANCH = 'master'
_COMMIT = re.compile(r'[0-9a-f]{40}\Z')
_REPO = re.compile(r'https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(?:\.git)?\Z')
_BRANCH = re.compile(r'[A-Za-z0-9][A-Za-z0-9._/-]{0,199}\Z')
_MARKER = 'github-source-updater-v1\n'


def _run(argv, cwd, timeout, environment=None, cancel_event=None):
    if cancel_event is not None and cancel_event.is_set():
        raise InterruptedError('update cancelled')
    # Temporary files bound memory consumption even for noisy builds.
    with tempfile.TemporaryFile() as out, tempfile.TemporaryFile() as err:
        result = subprocess.Popen(argv, cwd=cwd, stdin=subprocess.DEVNULL, stdout=out, stderr=err,
                                  start_new_session=True,
                                  env={**(os.environ if environment is None else environment), 'GIT_TERMINAL_PROMPT': '0',
                                       'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': os.devnull})
        try:
            if cancel_event is None:
                result.wait(timeout=timeout)
            else:
                deadline = time.monotonic() + timeout
                while True:
                    if cancel_event.is_set():
                        raise InterruptedError('update cancelled')
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise subprocess.TimeoutExpired(argv, timeout)
                    try:
                        result.wait(timeout=min(remaining, .2))
                        break
                    except subprocess.TimeoutExpired:
                        continue
        except (subprocess.TimeoutExpired, InterruptedError):
            try:
                os.killpg(result.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            result.wait()
            raise
        out.seek(0)
        data = out.read(65537)
        err.seek(0)
        error = err.read(4096).decode('utf-8', 'replace')
        if result.returncode:
            raise RuntimeError(f'command failed ({result.returncode}): {argv[0]}: {error}')
        if len(data) > 65536 and Path(argv[0]).name == 'git':
            raise RuntimeError('git output exceeds limit')
        return data[:65536].decode('utf-8', 'replace')


def _validate_build(path):
    root = path.resolve()
    required = [
        'apps/desktop/lib/main.js', 'apps/desktop-host/lib/index.js',
        'node_modules/.bin/tsx', 'apps/desktop/node_modules/pnpm/package.json',
        'apps/desktop/node_modules/electron/package.json',
    ]
    if sys.platform == 'darwin':
        machine = platform.machine().lower()
        if machine not in ('arm64', 'aarch64', 'x86_64', 'amd64'):
            raise RuntimeError('unsupported macOS architecture')
        target = 'mac-arm64' if machine in ('arm64', 'aarch64') else 'mac-x64'
        required.extend([
            f'apps/desktop/.desktop-build/targets/{target}/runtime/primary-runtime/runtime.json',
            'apps/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
        ])
    for relative in required:
        artifact = path / relative
        if not artifact.is_file() or not artifact.resolve().is_relative_to(root):
            raise RuntimeError(f'missing or invalid build artifact: {relative}')


class SourceUpdater:
    def __init__(self, root, repo=DEFAULT_REPO, branch=DEFAULT_BRANCH, *,
                 install=None, build=None, runner=_run, timeout=900):
        if not _REPO.fullmatch(repo) or any(x in repo for x in ('..',)):
            raise ValueError('expected an HTTPS github.com owner/repository URL')
        if (not _BRANCH.fullmatch(branch) or '..' in branch or '//' in branch or
                '@{' in branch or branch.endswith(('.', '/', '.lock')) or
                any(p.startswith('.') or p.endswith('.lock') for p in branch.split('/'))):
            raise ValueError('invalid branch')
        if not 0 < timeout <= 3600:
            raise ValueError('timeout must be in (0, 3600]')
        install = install if install is not None else [['pnpm', 'install', '--frozen-lockfile'],
            ['pnpm', '--filter', '@deepseek-ai/dsh-desktop', 'exec', 'install-electron']]
        build = build if build is not None else [['pnpm', 'run', 'build'],
            ['pnpm', '--filter', '@deepseek-ai/dsh-desktop', 'run', 'build'],
            ['pnpm', '--filter', '@deepseek-ai/dsh-desktop', 'run', 'prepare:primary-runtime']]
        def commands(value):
            if isinstance(value, (list, tuple)) and value and isinstance(value[0], str):
                value = [value]
            if not isinstance(value, (list, tuple)) or not value or any(
                not isinstance(cmd, (list, tuple)) or not cmd or
                not all(isinstance(a, str) and a for a in cmd) for cmd in value):
                raise ValueError('install and build must be nonempty argv lists')
            return [list(cmd) for cmd in value]
        self.root = Path(root).absolute()
        self.repo, self.branch = repo, branch
        self.install, self.build = commands(install), commands(build)
        self.runner, self.timeout = runner, timeout

    def _call(self, argv, cwd=None, timeout=None):
        return self.runner(argv, cwd, self.timeout if timeout is None else timeout)

    def bootstrap(self):
        # Never adopt a nonempty directory or traverse symlinks / a Git checkout.
        for part in (self.root, *self.root.parents):
            if part.is_symlink() or (part / '.git').exists():
                raise ValueError('root must not be in a checkout or traverse symlinks')
        if self.root.exists():
            if not self.root.is_dir():
                raise ValueError('root is not a directory')
            marker = self.root / '.updater-owner'
            if marker.is_file() and not marker.is_symlink() and marker.read_text() == _MARKER:
                self._layout()
                return
            if any(self.root.iterdir()):
                raise ValueError('refusing to adopt nonempty root')
        else:
            self.root.mkdir(parents=True, mode=0o700)
        (self.root / '.updater-owner').write_text(_MARKER)
        (self.root / 'versions').mkdir(mode=0o700)
        (self.root / 'staging').mkdir(mode=0o700)
        (self.root / '.lock').touch(mode=0o600, exist_ok=False)
        (self.root / '.runlock').touch(mode=0o600, exist_ok=False)

    def _layout(self):
        if (self.root.is_symlink() or not (self.root / '.updater-owner').is_file() or
                (self.root / '.updater-owner').is_symlink() or
                (self.root / '.updater-owner').read_text() != _MARKER):
            raise ValueError('unowned root')
        for name in ('versions', 'staging'):
            p = self.root / name
            if p.is_symlink() or not p.is_dir():
                raise ValueError('invalid updater layout')
        for name in ('.lock', '.runlock'):
            if (self.root / name).is_symlink() or not (self.root / name).is_file():
                raise ValueError('invalid lock')

    @contextmanager
    def _locked(self, shared=False, name='.lock'):
        self._layout()
        with open(self.root / name, 'rb') as lock:
            try:
                fcntl.flock(lock, (fcntl.LOCK_SH if shared else fcntl.LOCK_EX) | fcntl.LOCK_NB)
            except BlockingIOError as exc:
                raise RuntimeError('updater or app is already running') from exc
            try:
                yield
            finally:
                fcntl.flock(lock, fcntl.LOCK_UN)

    def run_guard(self):
        """Shared nonblocking lifetime lease for each cooperating app process."""
        return self._locked(shared=True, name='.runlock')

    def check(self):
        with self._locked():
            text = self._call(['git', 'ls-remote', '--exit-code', '--heads', self.repo,
                               'refs/heads/' + self.branch], timeout=min(self.timeout, 20))
            lines = text.splitlines()
            if len(lines) != 1:
                raise RuntimeError('branch did not resolve uniquely')
            fields = lines[0].split('\t')
            if len(fields) != 2 or fields[1] != 'refs/heads/' + self.branch or not _COMMIT.fullmatch(fields[0]):
                raise RuntimeError('invalid remote branch response')
            return fields[0]

    @staticmethod
    def _commit(commit):
        if not isinstance(commit, str) or not _COMMIT.fullmatch(commit):
            raise ValueError('expected exact lowercase 40-character commit')

    def _validate(self, path, commit):
        if path.is_symlink() or not path.is_dir() or (path / '.git').is_symlink() or not (path / '.git').is_dir():
            raise RuntimeError('invalid version checkout')
        marker = path / '.updater-ready'
        if marker.is_symlink() or not marker.is_file() or marker.read_text() != self.repo + '\n' + self.branch + '\n' + commit + '\n':
            raise RuntimeError('incomplete or mismatched version')
        if self._call(['git', 'rev-parse', '--verify', 'HEAD'], path).strip() != commit:
            raise RuntimeError('version commit mismatch')
        if self._call(['git', 'status', '--porcelain', '--untracked-files=no'], path).strip():
            raise RuntimeError('version has modified tracked files')
        _validate_build(path)

    def _status(self, phase, commit):
        data = json.dumps({'phase': phase, 'commit': commit}, separators=(',', ':')) + '\n'
        path = self.root / ('.status-' + uuid.uuid4().hex)
        with open(path, 'x', encoding='utf-8') as output:
            output.write(data)
        os.replace(path, self.root / 'update-status.json')

    def _current_unlocked(self):
        current = self.root / 'current'
        if not current.is_symlink():
            if os.path.lexists(current):
                raise RuntimeError('invalid current version')
            return None
        target = os.readlink(current)
        if not re.fullmatch(r'versions/[0-9a-f]{40}', target):
            raise RuntimeError('invalid current symlink')
        commit = target.split('/')[1]
        self._validate(self.root / target, commit)
        return commit

    def current(self):
        """Return the verified active commit, or None before first activation."""
        with self._locked():
            return self._current_unlocked()

    def mark_current(self):
        """Clear a stale prepared status without removing its version files."""
        with self._locked():
            commit = self._current_unlocked()
            if commit is None:
                raise RuntimeError('no active version')
            self._status('active', commit)

    def _require_successor(self, path, current, commit):
        if current is not None and current != commit:
            try:
                self._call(['git', 'merge-base', '--is-ancestor', current, commit], path)
            except (RuntimeError, OSError, subprocess.TimeoutExpired) as exc:
                raise RuntimeError('refusing non-fast-forward update') from exc

    def stage(self, commit):
        self._commit(commit)
        with self._locked():
            dest = self.root / 'versions' / commit
            active = self._current_unlocked()
            if dest.exists() or dest.is_symlink():
                self._validate(dest, commit)
                self._require_successor(dest, active, commit)
                self._status('ready', commit)
                return dest
            work = self.root / 'staging' / uuid.uuid4().hex
            self._call(['git', 'clone', '--no-checkout', '--single-branch', '--branch', self.branch,
                        '--', self.repo, str(work)])
            tip = self._call(['git', 'rev-parse', '--verify', 'refs/remotes/origin/' + self.branch], work).strip()
            if tip != commit:
                raise RuntimeError('branch moved since check; check again')
            self._require_successor(work, active, commit)
            self._call(['git', 'checkout', '--detach', commit], work)
            if self._call(['git', 'rev-parse', '--verify', 'HEAD'], work).strip() != commit:
                raise RuntimeError('checkout commit mismatch')
            for command in self.install + self.build:
                self._call(command, work)
            if self._call(['git', 'status', '--porcelain', '--untracked-files=no'], work).strip():
                raise RuntimeError('build modified tracked files')
            _validate_build(work)
            (work / '.updater-ready').write_text(self.repo + '\n' + self.branch + '\n' + commit + '\n')
            os.rename(work, dest)
            try:
                self._validate(dest, commit)
                self._status('ready', commit)
            except Exception:
                os.rename(dest, self.root / 'staging' / uuid.uuid4().hex)
                raise
            return dest

    def activate(self, commit, *, between_runs=False):
        self._commit(commit)
        if between_runs is not True:
            raise ValueError('caller must confirm activation is between app runs')
        with self._locked(), self._locked(name='.runlock'):
            dest = self.root / 'versions' / commit
            self._validate(dest, commit)
            self._require_successor(dest, self._current_unlocked(), commit)
            current = self.root / 'current'
            if current.exists() and not current.is_symlink():
                raise RuntimeError('refusing to replace non-symlink current')
            if current.is_symlink():
                old = os.readlink(current)
                if not re.fullmatch(r'versions/[0-9a-f]{40}', old):
                    raise RuntimeError('invalid current symlink')
            temporary = self.root / ('.current-' + uuid.uuid4().hex)
            os.symlink('versions/' + commit, temporary)
            os.replace(temporary, current)
            self._status('active', commit)
            return dest
