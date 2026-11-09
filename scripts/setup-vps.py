#!/usr/bin/env python3
"""Install the Y Harness Web profile as a private, persistent Linux user service."""

import argparse
import fcntl
import json
import os
import pwd
import re
import shutil
import stat
import subprocess
import sys
import tempfile
from pathlib import Path

REPOSITORY = 'https://github.com/tobenwarrior/y-harness.git'
SERVICE = 'yharness-vps.service'
CLI = Path('apps/cli/lib/bin.js')
NATIVE_PACKAGES = Path('native/system/packages')
SANDBOX_SCRIPT = 'sandbox-setup.py'
SANDBOX_PROBE = """
import { Context } from '@yharness/cordis';
import { launcherPath } from '@yharness/node-addon-system/landlock-run';
import { LocalSandboxProvider } from '@yharness/sandbox-local';
const ctx = new Context();
await ctx.plugin(LocalSandboxProvider, {});
let available = true;
try {
  await ctx.sandbox.confine(['/bin/true'], { mode: 'read-only', workspaceRoot: '/' });
} catch (error) {
  if (error.code !== 'SANDBOX_UNAVAILABLE') throw error;
  available = false;
} finally {
  await ctx.fiber.dispose();
}
console.log(JSON.stringify({ available, launcher: launcherPath() }));
"""
PORT = 3080
LAUNCH_LINE = re.compile(rf'^yharness web: (http://127\.0\.0\.1:{PORT}/\?token=[A-Za-z0-9_-]{{43}})(?:\s|$)')


class SetupError(Exception):
    """A setup failure safe to report without subprocess output or credentials."""


def run(args, **kwargs):
    """Run one command and raise on failure."""
    return subprocess.run(args, check=True, text=True, **kwargs)


def require_outside_git(path):
    """Refuse storage paths inside Git working trees, including symlink targets."""
    parent = path.resolve()
    while not parent.is_dir():
        parent = parent.parent
    git_env = {key: value for key, value in os.environ.items() if not key.startswith('GIT_')}
    git_env['LC_ALL'] = 'C'
    result = subprocess.run(
        ['git', '-C', str(parent), 'rev-parse', '--is-inside-work-tree'],
        env=git_env, capture_output=True, text=True,
    )
    if result.returncode != 128 or 'not a git repository' not in result.stderr:
        raise SetupError('Choose a home and systemd config directory outside a Git checkout.')


def private_directory(path):
    """Create or validate an owner-only directory without following a symlink."""
    path.mkdir(mode=0o700, exist_ok=True)
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise SetupError('The installation needs an owner-only private directory. Check its permissions and retry.')


def private_file(path, flags):
    """Open an owner-only regular file and reject symlinks or shared permissions."""
    try:
        descriptor = os.open(path, flags | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    except OSError as error:
        raise SetupError('Could not open the private Y Harness file.') from error
    info = os.fstat(descriptor)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_nlink != 1:
        os.close(descriptor)
        raise SetupError('Expected an owner-only private Y Harness file.')
    return descriptor


def require_linux_user():
    """Check the installer has a regular Linux account and the service tools."""
    if sys.platform != 'linux' or os.geteuid() == 0:
        raise SetupError('Run setup on a Linux server as your regular SSH user.')
    for name in ('git', 'loginctl', 'systemctl'):
        if shutil.which(name) is None:
            raise SetupError(f'Setup needs {name}. Install it on the server and retry.')


def node_executable():
    """Find a Node runtime compatible with the source build and systemd unit."""
    executable = shutil.which('node')
    if executable is None:
        raise SetupError('Install Node.js 24 LTS with development headers on the VPS and run setup again.')
    path = Path(executable).resolve()
    version = run([str(path), '--version'], capture_output=True).stdout.strip()
    match = re.fullmatch(r'v(\d+)\.(\d+)\.\d+', version)
    if match is None or (int(match[1]) < 24 and (int(match[1]) != 22 or int(match[2]) < 19)):
        raise SetupError('Install Node.js 24 LTS with development headers on the VPS and run setup again.')
    return path


def service_unit(node):
    """Render the private Web service using a literal Node executable path."""
    if not re.fullmatch(r'/[A-Za-z0-9_./-]+', str(node)):
        raise SetupError('Install Node.js in an absolute path without spaces or special characters.')
    return f"""[Unit]
Description=Y Harness VPS

[Service]
Type=exec
WorkingDirectory=%h/.yharness-vps/workspace
Environment="YH_HOME=%h/.yharness-vps/state"
Environment="PATH={node.parent}:/usr/local/bin:/usr/bin:/bin"
UMask=0077
ExecStart="{node}" "%h/.yharness-vps/source/{CLI}" --profile web --no-open --host 127.0.0.1 --port {PORT}
StandardOutput=truncate:%h/.yharness-vps/host.log
StandardError=inherit
Restart=on-failure
RestartSec=5s

[Install]
WantedBy=default.target
"""


def build_environment():
    """Pass build commands only the environment needed for public source and tools."""
    environment = {key: value for key, value in os.environ.items()
                   if key in ('HOME', 'PATH', 'LANG', 'LC_ALL', 'SSL_CERT_FILE', 'SSL_CERT_DIR')}
    environment.update({
        'GIT_CONFIG_GLOBAL': '/dev/null',
        'GIT_CONFIG_NOSYSTEM': '1',
        'GIT_TERMINAL_PROMPT': '0',
        'NPM_CONFIG_USERCONFIG': '/dev/null',
    })
    return environment


def sandbox_probe(source, node, environment):
    """Query the checkout's sandbox provider under the service's executable search path."""
    try:
        result = run(
            [str(node), '--input-type=module', '-e', SANDBOX_PROBE],
            cwd=source / 'packages/sandbox/sandbox-local', env=environment, capture_output=True, timeout=20,
        )
        status = json.loads(result.stdout)
        return status['available'] is True, Path(status['launcher'])
    except (OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
        raise SetupError('Could not check the Linux sandbox in the Y Harness build.') from error


def ensure_sandbox(root, source, node):
    """Publish a probed local Landlock runner if the checkout has no usable sandbox."""
    environment = build_environment()
    environment['PATH'] = f'{node.parent}:/usr/local/bin:/usr/bin:/bin'
    with os.fdopen(private_file(root / 'sandbox.lock', os.O_RDWR | os.O_CREAT), 'r+') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        ready, launcher = sandbox_probe(source, node, environment)
        if ready:
            return
        native = source.resolve() / NATIVE_PACKAGES
        allowed = {native / arch / 'bin/landlock-run' for arch in ('linux-x64', 'linux-arm64')}
        if launcher.parent.resolve() / launcher.name not in allowed or launcher.is_symlink():
            raise SetupError('The Linux sandbox package is missing. Install a working Bubblewrap or repair the Y Harness build.')
        c_source = native / 'entry/src/main.c'
        if not c_source.is_file():
            raise SetupError('The Landlock source is missing from the Y Harness build.')
        launcher.parent.mkdir(parents=True, exist_ok=True)
        with (
            tempfile.TemporaryDirectory(dir=launcher.parent) as stage,
            os.fdopen(private_file(root / 'sandbox.log', os.O_WRONLY | os.O_CREAT), 'w') as log,
        ):
            log.truncate()
            candidate = Path(stage) / 'landlock-run'
            try:
                run(
                    ['cc', '-std=c11', '-Os', '-Wall', '-Wextra', '-Werror', '-o', str(candidate), str(c_source)],
                    cwd=stage, env=environment, stdout=log, stderr=subprocess.STDOUT, timeout=40,
                )
                candidate.chmod(0o700)
                run([str(candidate), '--probe'], env=environment, stdout=log, stderr=subprocess.STDOUT, timeout=10)
            except (OSError, subprocess.SubprocessError) as error:
                raise SetupError(
                    'Could not build or run the Linux sandbox. Check the C compiler and Landlock support '
                    'or install a working Bubblewrap. See the private sandbox.log.'
                ) from error
            os.replace(candidate, launcher)
        if not sandbox_probe(source, node, environment)[0]:
            raise SetupError('Y Harness could not use the installed Linux sandbox.')


def write_private_copy(path, content):
    """Replace a managed file atomically, checking ownership when it already exists."""
    if path.exists() or path.is_symlink():
        with os.fdopen(private_file(path, os.O_RDONLY), 'rb') as existing:
            if existing.read() == content:
                return
    with tempfile.TemporaryDirectory(dir=path.parent) as stage:
        pending = Path(stage) / path.name
        pending.write_bytes(content)
        pending.chmod(0o600)
        os.replace(pending, path)


def install_sandbox_start_check(root, unit_dir):
    """Install a private startup check that survives replacement of the source checkout."""
    python = Path(sys.executable).resolve()
    if not re.fullmatch(r'/[A-Za-z0-9_./-]+', str(python)):
        raise SetupError('Install Python in an absolute path without spaces or special characters.')
    write_private_copy(root / SANDBOX_SCRIPT, Path(__file__).read_bytes())
    dropin_dir = unit_dir / (SERVICE + '.d')
    private_directory(dropin_dir)
    check = f'[Service]\nExecStartPre={python} "%h/.yharness-vps/{SANDBOX_SCRIPT}" sandbox\n'
    write_private_copy(dropin_dir / 'sandbox.conf', check.encode())


def build_source(root, node):
    """Build and check a staged public checkout before making it the installed source."""
    for name in ('npm', 'cc'):
        if shutil.which(name) is None:
            raise SetupError(f'Setup needs {name}. Install npm and a C compiler, then retry.')
    environment = build_environment()
    descriptor = private_file(root / 'build.log', os.O_WRONLY | os.O_CREAT)
    with os.fdopen(descriptor, 'w') as log, tempfile.TemporaryDirectory(dir=root) as staging:
        log.truncate()
        source = Path(staging) / 'source'
        try:
            run(
                ['git', 'clone', '--depth=1', '--branch', 'master', REPOSITORY, str(source)],
                cwd=staging, env=environment, stdout=log, stderr=subprocess.STDOUT,
            )
            package_manager = json.loads((source / 'package.json').read_text())['packageManager']
            if not isinstance(package_manager, str) or not re.fullmatch(r'pnpm@\d+\.\d+\.\d+', package_manager):
                raise SetupError('This Y Harness revision does not declare an exact pnpm version.')
            pnpm = ['npm', 'exec', '--yes', '--package', package_manager, '--', 'pnpm']
            for arguments in (['install', '--frozen-lockfile'], ['run', 'build']):
                run(pnpm + arguments, cwd=source, env=environment, stdout=log, stderr=subprocess.STDOUT)
        except subprocess.CalledProcessError as error:
            raise SetupError('The source build failed. Review ~/.yharness-vps/build.log on the VPS.') from error
        if not (source / CLI).is_file():
            raise SetupError('The build did not produce the Y Harness CLI.')
        ensure_sandbox(root, source, node)
        source.rename(root / 'source')


def setup(root, unit_dir):
    """Install or reuse the checkout, then enable its service without restarting it."""
    require_linux_user()
    require_outside_git(root)
    require_outside_git(unit_dir)
    node = node_executable()
    unit = service_unit(node)
    try:
        run(['systemctl', '--user', 'show-environment'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        linger = run(['loginctl', 'show-user', str(os.getuid()), '--property=Linger', '--value'], capture_output=True)
        if linger.stdout.strip() != 'yes':
            run(['loginctl', 'enable-linger'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except subprocess.CalledProcessError as error:
        raise SetupError('Log in over SSH and make sure user services and lingering are enabled. See the VPS guide.') from error

    private_directory(root)
    with os.fdopen(private_file(root / 'setup.lock', os.O_RDWR | os.O_CREAT), 'r+') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        private_directory(root / 'state')
        private_directory(root / 'workspace')
        os.close(private_file(root / 'host.log', os.O_WRONLY | os.O_CREAT))
        source = root / 'source'
        if source.is_symlink() or (source.exists() and not (source / CLI).is_file()):
            raise SetupError('The existing Y Harness installation is incomplete. Check the private installation directory.')
        if not source.exists():
            print('Downloading and building Y Harness. This can take several minutes.', flush=True)
            build_source(root, node)
        else:
            ensure_sandbox(root, source, node)
        unit_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        unit_path = unit_dir / SERVICE
        if unit_path.exists() or unit_path.is_symlink():
            with os.fdopen(private_file(unit_path, os.O_RDONLY)) as existing:
                if existing.read() != unit:
                    raise SetupError('The existing Y Harness service file differs. Review it before running setup again.')
        else:
            with tempfile.NamedTemporaryFile(mode='w', dir=unit_dir) as output:
                output.write(unit)
                output.flush()
                os.link(output.name, unit_path)
        install_sandbox_start_check(root, unit_dir)
        try:
            for arguments in (['daemon-reload'], ['enable', '--now', SERVICE]):
                run(['systemctl', '--user', *arguments], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except subprocess.CalledProcessError as error:
            raise SetupError('Could not start the service. Review ~/.yharness-vps/host.log privately.') from error
    print('Y Harness service enabled. Use the VPS guide to open your private connection.')


def launch_url(path):
    """Read the current loopback sign-in link from an owner-only startup log."""
    with os.fdopen(private_file(path, os.O_RDONLY), errors='replace') as log:
        for line in log:
            match = LAUNCH_LINE.match(line)
            if match is not None:
                return match[1]
    raise SetupError('The Web profile is still starting or could not start. Check the private host log.')


def main():
    """Run the server-side setup, status or explicit private-link command."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', nargs='?', choices=('setup', 'status', 'url', 'sandbox'), default='setup')
    action = parser.parse_args().action
    os.umask(0o077)
    account_home = Path(pwd.getpwuid(os.getuid()).pw_dir)
    root = account_home / '.yharness-vps'
    try:
        if action == 'setup':
            config_home = Path(os.environ.get('XDG_CONFIG_HOME') or account_home / '.config')
            if not config_home.is_absolute():
                raise SetupError('XDG_CONFIG_HOME must be an absolute path.')
            setup(root, config_home / 'systemd/user')
        elif action == 'sandbox':
            require_linux_user()
            private_directory(root)
            source = root / 'source'
            if source.is_symlink() or not (source / CLI).is_file():
                raise SetupError('The Y Harness installation is incomplete. Check the private installation directory.')
            ensure_sandbox(root, source, node_executable())
        else:
            require_linux_user()
            result = subprocess.run(['systemctl', '--user', 'is-active', SERVICE], capture_output=True, text=True)
            if result.returncode != 0:
                raise SetupError('Y Harness is not running. Run setup or check the private host log.')
            print(launch_url(root / 'host.log') if action == 'url' else 'Y Harness is running.')
    except SetupError as error:
        parser.exit(1, f'{error}\n')
    except (OSError, ValueError, KeyError, subprocess.CalledProcessError):
        parser.exit(1, 'Y Harness setup could not finish. Check your server prerequisites and the private build log.\n')


if __name__ == '__main__':
    main()
