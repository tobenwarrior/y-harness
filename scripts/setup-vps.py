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


def build_source(root):
    """Build a public source checkout in isolation and publish it only on success."""
    for name in ('npm', 'cc'):
        if shutil.which(name) is None:
            raise SetupError(f'Setup needs {name}. Install npm and a C compiler, then retry.')
    # Build tools receive no provider credentials, SSH agent or user Git/npm config.
    environment = {key: value for key, value in os.environ.items()
                   if key in ('HOME', 'PATH', 'LANG', 'LC_ALL', 'SSL_CERT_FILE', 'SSL_CERT_DIR')}
    environment.update({
        'GIT_CONFIG_GLOBAL': '/dev/null',
        'GIT_CONFIG_NOSYSTEM': '1',
        'GIT_TERMINAL_PROMPT': '0',
        'NPM_CONFIG_USERCONFIG': '/dev/null',
    })
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
        source.rename(root / 'source')


def setup(root, unit_dir):
    """Install or reuse the checkout, then enable its service without restarting it."""
    require_linux_user()
    require_outside_git(root)
    require_outside_git(unit_dir)
    unit = service_unit(node_executable())
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
            build_source(root)
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
    parser.add_argument('action', nargs='?', choices=('setup', 'status', 'url'), default='setup')
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
