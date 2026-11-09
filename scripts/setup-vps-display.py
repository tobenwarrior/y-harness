#!/usr/bin/env python3
"""Install a private Xvfb desktop for the Y Harness VPS Computer panel."""

import argparse
import errno
import fcntl
import os
import pwd
import re
import shutil
import stat
import subprocess
import sys
import tempfile
from pathlib import Path

DISPLAY_SERVICE = 'yharness-vps-display.service'
WEB_SERVICE = 'yharness-vps.service'
WEB_SERVICE_DROPIN = Path('yharness-vps.service.d/display.conf')
DISPLAY_ROOT = Path('display')
AUTHORITY = DISPLAY_ROOT / 'Xauthority'
SUPERVISOR = DISPLAY_ROOT / 'supervisor.py'
DISPLAY = ':99'
SCREEN = '1280x800x24'
# Ubuntu 24.04 names the virtual framebuffer package `xvfb`; no broad X server is installed.
REQUIRED_PACKAGES = ('xvfb', 'xauth', 'openbox', 'xdotool', 'scrot')
OPTIONAL_TERMINAL_PACKAGE = 'xterm'
PACKAGE_COMMAND = ('/usr/bin/sudo', '/usr/bin/apt-get')


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
        env=git_env,
        capture_output=True,
        text=True,
    )
    if result.returncode != 128 or 'not a git repository' not in result.stderr:
        raise SetupError('Choose a home and systemd config directory outside a Git checkout.')


def private_directory(path):
    """Create or validate an owner-only directory without accepting a symlink."""
    try:
        info = path.lstat()
        created = False
    except FileNotFoundError:
        try:
            path.mkdir(mode=0o700, parents=True)
        except OSError as error:
            raise SetupError('The installation needs an owner-only private directory.') from error
        info = path.lstat()
        created = True
    if (
        not stat.S_ISDIR(info.st_mode)
        or info.st_uid != os.getuid()
        or info.st_mode & 0o077
    ):
        raise SetupError('The installation needs an owner-only private directory. Check its permissions and retry.')
    return created


def private_file(path, flags):
    """Open an owner-only regular file and reject symlinks or shared permissions."""
    try:
        descriptor = os.open(path, flags | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    except OSError as error:
        raise SetupError('Could not open the private Y Harness file.') from error
    info = os.fstat(descriptor)
    if (
        not stat.S_ISREG(info.st_mode)
        or info.st_uid != os.getuid()
        or info.st_mode & 0o077
        or info.st_nlink != 1
    ):
        os.close(descriptor)
        raise SetupError('Expected an owner-only private Y Harness file.')
    return descriptor


def safe_unlink(path):
    """Unlink a file or symlink without recursively following it."""
    try:
        info = path.lstat()
    except FileNotFoundError:
        return
    if stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode):
        path.unlink()


def cleanup_partial(files, directories):
    """Remove only files and empty directories created by one failed install."""
    for path in reversed(files):
        safe_unlink(path)
    for path in reversed(directories):
        try:
            path.rmdir()
        except OSError as cleanup_error:
            if cleanup_error.errno not in (errno.ENOENT, errno.ENOTEMPTY):
                # Keep the original setup error; an unrelated entry owns this directory now.
                continue


def write_private_text(path, content, created):
    """Install immutable text atomically, reusing only an identical private file."""
    if path.exists() or path.is_symlink():
        with os.fdopen(private_file(path, os.O_RDONLY), encoding='utf-8') as existing:
            if existing.read() != content:
                raise SetupError(f'The existing private file {path.name} differs. Review it before retrying.')
        return False
    temporary_name = None
    try:
        descriptor, temporary_name = tempfile.mkstemp(prefix=f'.{path.name}.', dir=path.parent)
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, 'w', encoding='utf-8') as output:
            output.write(content)
            output.flush()
            os.fsync(output.fileno())
        try:
            os.link(temporary_name, path)
        except FileExistsError:
            with os.fdopen(private_file(path, os.O_RDONLY), encoding='utf-8') as existing:
                if existing.read() != content:
                    raise SetupError(f'The existing private file {path.name} differs. Review it before retrying.')
            return False
        created.append(path)
        return True
    except OSError as error:
        raise SetupError('Could not install a private Y Harness display file.') from error
    finally:
        if temporary_name is not None:
            safe_unlink(Path(temporary_name))


def require_linux_user():
    """Check the installer has a regular Linux account and service tools."""
    if sys.platform != 'linux' or os.geteuid() == 0:
        raise SetupError('Run display setup on a Linux server as your regular SSH user.')
    for name in ('git', 'sudo', 'systemctl'):
        if shutil.which(name) is None:
            raise SetupError(f'Setup needs {name}. Install it on the server and retry.')


def install_packages(with_terminal=True):
    """Install only the Ubuntu virtual-display prerequisites, never a system upgrade."""
    packages = list(REQUIRED_PACKAGES)
    if with_terminal:
        packages.append(OPTIONAL_TERMINAL_PACKAGE)
    run([*PACKAGE_COMMAND, 'update'])
    run([
        *PACKAGE_COMMAND,
        'install',
        '--no-install-recommends',
        '--no-upgrade',
        '--no-remove',
        '--yes',
        *packages,
    ])


def display_unit(with_terminal=True):
    """Render the independent user service that supervises the private desktop."""
    terminal = '1' if with_terminal else '0'
    return f"""[Unit]
Description=Y Harness VPS private virtual display
Before={WEB_SERVICE}

[Service]
Type=simple
WorkingDirectory=%h/.yharness-vps/display
Environment="YH_VPS_DISPLAY={DISPLAY}"
Environment="YH_VPS_XAUTHORITY=%h/.yharness-vps/display/Xauthority"
Environment="YH_VPS_LAUNCH_XTERM={terminal}"
Environment="PATH=/usr/local/bin:/usr/bin:/bin"
UMask=0077
ExecStart=/usr/bin/python3 "%h/.yharness-vps/display/supervisor.py"
Restart=on-failure
RestartSec=2s
TimeoutStopSec=15s

[Install]
WantedBy=default.target
"""


def web_dropin():
    """Render the Web service drop-in that supplies private display settings."""
    return f"""[Unit]
Wants={DISPLAY_SERVICE}
After={DISPLAY_SERVICE}

[Service]
Environment="YH_VPS_DISPLAY={DISPLAY}"
Environment="YH_VPS_XAUTHORITY=%h/.yharness-vps/display/Xauthority"
"""


def supervisor_source():
    """Read the reviewed supervisor shipped beside this installer."""
    source_path = Path(__file__).with_name('vps-display-supervisor.py')
    try:
        source = source_path.read_text(encoding='utf-8')
    except OSError as error:
        raise SetupError('Download vps-display-supervisor.py beside the display installer and retry.') from error
    if not source.startswith('#!/usr/bin/env python3\n'):
        raise SetupError('The private display supervisor is not the expected file.')
    return source


def install(root, unit_dir, with_terminal=True):
    """Install display files without activating or restarting the existing Web service."""
    require_linux_user()
    require_outside_git(root)
    require_outside_git(unit_dir)
    supervisor = supervisor_source()
    unit = display_unit(with_terminal)
    dropin = web_dropin()
    install_packages(with_terminal)
    created_files = []
    created_directories = []
    try:
        for directory in (root, root / 'display', unit_dir, unit_dir / WEB_SERVICE_DROPIN.parent):
            if private_directory(directory):
                created_directories.append(directory)
        lock_path = root / 'display' / 'setup.lock'
        with os.fdopen(private_file(lock_path, os.O_RDWR | os.O_CREAT), 'r+') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            write_private_text(root / SUPERVISOR, supervisor, created_files)
            write_private_text(unit_dir / DISPLAY_SERVICE, unit, created_files)
            write_private_text(unit_dir / WEB_SERVICE_DROPIN, dropin, created_files)
    except (SetupError, OSError, ValueError, subprocess.CalledProcessError):
        cleanup_partial(created_files, created_directories)
        raise
    print('Y Harness private display installed. Run the activate action to start it.')


def activate():
    """Explicitly start the display and restart the existing Web service once."""
    for arguments in (
        ['daemon-reload'],
        ['enable', '--now', DISPLAY_SERVICE],
        ['restart', WEB_SERVICE],
    ):
        run(['systemctl', '--user', *arguments])


def restart():
    """Explicitly restart the display and then the existing Web service."""
    for arguments in (
        ['daemon-reload'],
        ['restart', DISPLAY_SERVICE],
        ['restart', WEB_SERVICE],
    ):
        run(['systemctl', '--user', *arguments])


def status():
    """Report both user services without changing their state."""
    for service in (DISPLAY_SERVICE, WEB_SERVICE):
        result = subprocess.run(
            ['systemctl', '--user', 'is-active', service],
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            raise SetupError(f'{service} is not running.')
    print('Y Harness private display and Web service are running.')


def main():
    """Run installation, explicit activation/restart, or status reporting."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        'action',
        nargs='?',
        choices=('install', 'activate', 'restart', 'status'),
        default='install',
    )
    parser.add_argument(
        '--no-terminal',
        dest='with_terminal',
        action='store_false',
        help='Do not install or start the optional xterm action surface.',
    )
    args = parser.parse_args()
    os.umask(0o077)
    account_home = Path(pwd.getpwuid(os.getuid()).pw_dir)
    root = account_home / '.yharness-vps'
    try:
        if args.action == 'install':
            config_home = Path(os.environ.get('XDG_CONFIG_HOME') or account_home / '.config')
            if not config_home.is_absolute():
                raise SetupError('XDG_CONFIG_HOME must be an absolute path.')
            install(root, config_home / 'systemd/user', args.with_terminal)
        elif args.action == 'activate':
            activate()
        elif args.action == 'restart':
            restart()
        else:
            require_linux_user()
            status()
    except SetupError as error:
        parser.exit(1, f'{error}\n')
    except (OSError, ValueError, subprocess.CalledProcessError):
        parser.exit(1, 'Y Harness display setup could not finish. Check the private service status.\n')


if __name__ == '__main__':
    main()
