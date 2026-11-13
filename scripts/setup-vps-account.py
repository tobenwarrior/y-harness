#!/usr/bin/python3 -I
"""Run a private Y Harness Cloud instance under a dedicated Linux account."""

import argparse
import errno
import fcntl
import grp
import http.client
import importlib.util
import os
import pwd
import re
import socket
import stat
import subprocess
import sys
import tempfile
import time
from pathlib import Path


ACCOUNT = 'yharness-cloud'
HOME = Path('/var/lib') / ACCOUNT
DATA = HOME / '.yharness-vps'
UNIT = 'yharness-cloud.service'
UNIT_PATH = Path('/etc/systemd/user') / UNIT
SYSTEMCTL = ('/usr/bin/systemctl', '--system', '--no-pager', '--no-ask-password')
SYSTEM_ENV = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LC_ALL': 'C'}
CLI = Path('apps/cli/lib/bin.js')
BOT_IMAGE = 'localhost/yharness-vps-bot:24.04'
LOCK = Path('/run/lock/yharness-cloud-install.lock')
SAFE_PATH = re.compile(r'/[A-Za-z0-9_./-]+')
NOLOGIN = '/usr/sbin/nologin'


class AccountError(Exception):
    """Setup error that can be shown without exposing service credentials."""


def command(args, error, *, timeout=30):
    """Run a fixed operation without forwarding potentially private diagnostics."""
    try:
        result = subprocess.run(args, env=SYSTEM_ENV, capture_output=True, text=True, check=True, timeout=timeout)
    except (OSError, subprocess.SubprocessError):
        raise AccountError(error) from None
    return result.stdout


def validate_port(port):
    """Accept a fixed non-privileged loopback port."""
    if not 1024 <= port <= 65535:
        raise AccountError('Choose an available port from 1024 to 65535.')


def service_unit(uid, node, release, port):
    """Render the user unit for the dedicated account's rootless container cgroups."""
    if uid <= 0 or not all(SAFE_PATH.fullmatch(str(path)) for path in (node, release)):
        raise AccountError('Use absolute release and Node paths with letters, numbers, dots, underscores or hyphens.')
    validate_port(port)
    runtime = f'/run/user/{uid}'
    setup = Path(release) / 'scripts/setup-vps-account.py'
    return f"""[Unit]
Description=Y Harness Cloud
ConditionUser={ACCOUNT}

[Service]
Type=exec
WorkingDirectory={DATA}/workspace
Environment="HOME={HOME}"
Environment="YH_HOME={DATA}/state"
Environment="YH_VPS_BOT_ROOT={DATA}/bots"
Environment="YH_VPS_BOT_IMAGE={BOT_IMAGE}"
Environment="PATH={Path(node).parent}:/usr/local/bin:/usr/bin:/bin"
Environment="XDG_RUNTIME_DIR={runtime}"
Environment="DBUS_SESSION_BUS_ADDRESS=unix:path={runtime}/bus"
UMask=0077
ExecStartPre=/usr/bin/python3 -I "{setup}" check-runtime --node "{node}" --release "{release}"
ExecStart="{node}" "{Path(release) / CLI}" --profile web --no-open --host 127.0.0.1 --port {port}
StandardOutput=journal
StandardError=journal
Restart=on-failure
RestartSec=5s

[Install]
WantedBy=default.target
""".encode()


def ensure_account():
    """Create or verify a locked account with a private primary group."""
    try:
        account = pwd.getpwnam(ACCOUNT)
    except KeyError:
        command([
            '/usr/sbin/useradd', '--system', '--add-subids-for-system', '--user-group',
            '--home-dir', str(HOME), '--create-home', '--shell', NOLOGIN, ACCOUNT,
        ], 'Could not create the Cloud service account and subordinate IDs.')
        account = pwd.getpwnam(ACCOUNT)
    group = grp.getgrnam(ACCOUNT)
    if (account.pw_uid <= 0 or account.pw_gid <= 0 or account.pw_gid != group.gr_gid
            or account.pw_dir != str(HOME) or account.pw_shell != NOLOGIN
            or set(os.getgrouplist(ACCOUNT, account.pw_gid)) != {account.pw_gid}
            or getattr(group, 'gr_mem', ())):
        raise AccountError('The existing Cloud account must have the dedicated home, locked shell, and private group.')
    status = command(['/usr/bin/passwd', '-S', ACCOUNT], 'Could not verify the Cloud password status.').split()
    if status[:2] != [ACCOUNT, 'L']:
        raise AccountError('Lock the Cloud service account password before setup.')
    return account


def private_directory(path):
    """Require private directory ownership under the Cloud account."""
    path.mkdir(mode=0o700, exist_ok=True)
    info = path.lstat()
    if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_gid != os.getgid()
            or info.st_mode & 0o077):
        raise AccountError('Cloud data directories must be owned by its dedicated account and private.')


def ensure_home():
    """Prepare Cloud directories from the unprivileged account that owns them."""
    info = HOME.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_gid != os.getgid():
        raise AccountError('The Cloud service account home has unexpected ownership.')
    if info.st_mode & 0o022:
        raise AccountError('The Cloud service account home permits writes by other users.')
    HOME.chmod(0o700)
    private_directory(DATA)
    for name in ('state', 'workspace', 'bots'):
        private_directory(DATA / name)


def trusted_path(value):
    """Require a preinstalled artifact inside a root-controlled path."""
    candidate = Path(value)
    if not candidate.is_absolute():
        raise AccountError('Use absolute paths for the installed release and Node executable.')
    path = candidate.resolve(strict=True)
    if not SAFE_PATH.fullmatch(str(path)):
        raise AccountError('The installed path contains characters unsupported by the Cloud unit.')
    for current in (path, *path.parents):
        info = current.stat()
        if info.st_uid != 0 or info.st_mode & 0o022:
            raise AccountError('Install the release and Node under administrator-owned directories before setup.')
    return path


def check_executable(path):
    """Require an executable that cannot add privileges when Cloud runs it."""
    mode = path.stat().st_mode
    if not stat.S_ISREG(mode) or not mode & 0o111 or mode & (stat.S_ISUID | stat.S_ISGID):
        raise AccountError('Cloud requires regular Node and Podman executables without elevated privileges.')
    try:
        os.getxattr(path, 'security.capability')
    except OSError as error:
        if error.errno in (errno.ENODATA, errno.ENOTSUP):
            return
        raise AccountError('Could not verify file capabilities for Node or Podman.') from None
    raise AccountError('Cloud requires Node and Podman executables without file capabilities.')


def cloud_command(uid, *args):
    """Enter the dedicated account with only the environment needed by Cloud."""
    runtime = f'/run/user/{uid}'
    return [
        '/usr/sbin/runuser', '-u', ACCOUNT, '--', '/usr/bin/env', '-i',
        'HOME=' + str(HOME), 'PATH=/usr/local/bin:/usr/bin:/bin', 'LC_ALL=C',
        'XDG_RUNTIME_DIR=' + runtime, 'DBUS_SESSION_BUS_ADDRESS=unix:path=' + runtime + '/bus', *args,
    ]


def cloud_systemctl(uid, *args):
    """Address the Cloud account's local systemd user manager."""
    return cloud_command(uid, '/usr/bin/systemctl', '--user', '--no-pager', '--no-ask-password', *args)


def install_unit(path, content):
    """Create the root-managed user unit without replacing administrator changes."""
    with tempfile.NamedTemporaryFile(dir=path.parent, prefix='.yharness-cloud-') as pending:
        pending.write(content)
        pending.flush()
        os.fsync(pending.fileno())
        os.fchmod(pending.fileno(), 0o644)
        try:
            os.link(pending.name, path)
        except FileExistsError:
            info = path.lstat()
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o022
                    or info.st_nlink != 1 or path.read_bytes() != content):
                raise AccountError('A different Cloud unit already exists. Review it before changing the deployment.') from None


def process_uid(pid):
    """Get the kernel-reported owner of a running Cloud process."""
    try:
        return Path('/proc', pid).stat().st_uid
    except OSError:
        raise AccountError('The dedicated Cloud process ended before it could be checked.') from None


def installed_fragment(value):
    """Compare the installed unit and the manager's possibly aliased fragment path."""
    path = Path(value)
    return path.is_absolute() and path.resolve() == UNIT_PATH.resolve()


def live_invocation(uid):
    """Get the exact active service invocation and process identity."""
    raw = command(cloud_systemctl(
        uid, 'show', '--property=Id,FragmentPath,ActiveState,InvocationID,MainPID', '--', UNIT,
    ), 'Could not check the dedicated Cloud service.')
    fields = dict(line.split('=', 1) for line in raw.splitlines() if '=' in line)
    invocation = fields.get('InvocationID', '')
    pid = fields.get('MainPID', '')
    if (fields.get('Id') != UNIT or fields.get('ActiveState') != 'active'
            or not installed_fragment(fields.get('FragmentPath', ''))
            or not re.fullmatch(r'[a-f0-9]{32}', invocation) or invocation == '0' * 32
            or not re.fullmatch(r'[1-9][0-9]{0,9}', pid) or uid <= 0 or process_uid(pid) != uid):
        raise AccountError('The dedicated Cloud service is not running.')
    return invocation, pid


def launch_url(uid, port):
    """Read the private sign-in URL for the current Cloud process only."""
    validate_port(port)
    invocation, pid = live_invocation(uid)
    log = command([
        '/usr/bin/journalctl', '--no-pager', '--output=cat', '--lines=200',
        '_SYSTEMD_USER_UNIT=' + UNIT, '_SYSTEMD_INVOCATION_ID=' + invocation, f'_UID={uid}', '_PID=' + pid,
    ], 'The Cloud sign-in link could not be read from the system journal.')
    pattern = re.compile(rf'^yharness web: (http://127\.0\.0\.1:{port}/\?token=[A-Za-z0-9_-]{{43}})(?:\s|$)')
    for line in reversed(log.splitlines()):
        match = pattern.match(line)
        if match is not None:
            if live_invocation(uid) != (invocation, pid):
                break
            return match[1]
    raise AccountError('The dedicated Cloud sign-in link is unavailable. Try again after startup.')


def runtime_prerequisites(node, release, prepare):
    """Check the real Web build, full Ubuntu sandbox, and rootless desktop prerequisites."""
    if os.geteuid() == 0 or pwd.getpwuid(os.getuid()).pw_name != ACCOUNT:
        raise AccountError('The Cloud runtime check must run as its dedicated account.')
    if prepare:
        ensure_home()
    if not (release / CLI).is_file() or not (release / 'apps/web/dist/index.html').is_file():
        raise AccountError('Provide a built Y Harness Web release.')
    sibling = release / 'scripts/setup-vps.py'
    spec = importlib.util.spec_from_file_location('yharness_setup_vps', sibling)
    if spec is None or spec.loader is None:
        raise AccountError('The release is missing its VPS installer.')
    vps = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(vps)
    env = vps.build_environment()
    env['PATH'] = f'{node.parent}:/usr/local/bin:/usr/bin:/bin'
    try:
        backend, _launcher = vps.sandbox_probe(release, node, env)
        if backend is None or (vps.ubuntu_2404() and backend != 'bubblewrap'):
            raise AccountError('Prepare the Linux sandbox on the VPS before running Cloud.')
        if prepare:
            vps.ensure_bot_image(DATA, release)
        else:
            vps.ensure_rootless_podman(Path('/usr/bin/podman'))
            vps.run(['/usr/bin/podman', 'image', 'exists', BOT_IMAGE], env=vps.podman_environment(), timeout=20)
    except vps.SetupError as error:
        raise AccountError(str(error)) from None


def assert_port_free(port):
    """Reject a conflicting listener before starting a new Cloud instance."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        try:
            listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            listener.bind(('127.0.0.1', port))
        except OSError:
            raise AccountError('The Cloud loopback port is already in use.') from None


def wait_for_web(uid, port):
    """Wait until the current service authenticates its own printed launch link."""
    deadline = time.monotonic() + 50
    while time.monotonic() < deadline:
        client = http.client.HTTPConnection('127.0.0.1', port, timeout=2)
        try:
            url = launch_url(uid, port)
            client.request('GET', url.partition(f':{port}')[2])
            response = client.getresponse()
            if response.status == 303 and (response.getheader('Set-Cookie') or '').startswith('dsh-auth-'):
                return
        except (AccountError, OSError, http.client.HTTPException):
            # A new process may still be binding or printing its sign-in link.
            pass
        finally:
            client.close()
        time.sleep(.5)
    raise AccountError('Dedicated Cloud could not sign in after starting. Check its private journal.')


def start_cloud(uid, port):
    """Enable boot startup after Web is ready and stop a failed first start."""
    state = command(cloud_systemctl(
        uid, 'show', '--property=ActiveState', '--value', '--', UNIT,
    ), 'Could not read the dedicated Cloud service state.').strip()
    if state not in ('active', 'inactive', 'failed'):
        raise AccountError('Wait until the dedicated Cloud service finishes its current transition.')
    running = state == 'active'
    if not running:
        assert_port_free(port)
    try:
        if not running:
            command(cloud_systemctl(uid, 'start', '--', UNIT), 'Could not start dedicated Cloud. Check its private journal.')
        wait_for_web(uid, port)
        command(cloud_systemctl(uid, 'enable', '--', UNIT), 'Could not enable Cloud to start at boot.')
    except BaseException:
        if not running:
            try:
                command(cloud_systemctl(uid, 'stop', '--', UNIT), 'Could not stop the failed Cloud start.')
            except AccountError as cleanup_error:
                print(cleanup_error, file=sys.stderr)
        raise


def install(node, release, port):
    """Prepare the separate account and start its loopback Cloud service."""
    node = trusted_path(node)
    release = trusted_path(release)
    for executable in (node, trusted_path('/usr/bin/podman')):
        check_executable(executable)
    validate_port(port)
    for path in (release / CLI, release / 'scripts/setup-vps.py', release / 'scripts/setup-vps-account.py',
                 release / 'apps/web/dist/index.html'):
        if not trusted_path(path).is_file():
            raise AccountError('Install the built Web release, Node, and Podman first.')
    account = ensure_account()
    unit = service_unit(account.pw_uid, node, release, port)
    if UNIT_PATH.exists() or UNIT_PATH.is_symlink():
        install_unit(UNIT_PATH, unit)
    command(['/usr/bin/loginctl', 'enable-linger', ACCOUNT], 'Could not enable the Cloud account to run without a login.')
    command([*SYSTEMCTL, 'start', f'user@{account.pw_uid}.service'], 'Could not start the Cloud user manager.')
    # The administrator's working directory may be private.
    os.chdir('/')
    command(cloud_command(
        account.pw_uid, '/usr/bin/python3', '-I', str(release / 'scripts/setup-vps-account.py'),
        'check-runtime', '--node', str(node), '--release', str(release), '--prepare-image',
    ), 'The Cloud prerequisites could not be prepared. Check the private Podman build log.', timeout=900)
    install_unit(UNIT_PATH, unit)
    command(cloud_systemctl(account.pw_uid, 'daemon-reload'), 'Could not reload the Cloud user unit configuration.')
    start_cloud(account.pw_uid, port)


def main():
    """Install, verify, or print the owner-only link for a dedicated Cloud service."""
    parser = argparse.ArgumentParser(description=__doc__)
    actions = parser.add_subparsers(dest='action', required=True)
    for action in ('install', 'check-runtime'):
        choice = actions.add_parser(action)
        choice.add_argument('--node', type=Path, required=True)
        choice.add_argument('--release', type=Path, required=True)
        if action == 'install':
            choice.add_argument('--port', type=int, default=3080)
        else:
            choice.add_argument('--prepare-image', action='store_true')
    actions.add_parser('status')
    actions.add_parser('url').add_argument('--port', type=int, default=3080)
    options = parser.parse_args()
    os.umask(0o077)
    try:
        if sys.platform != 'linux':
            raise AccountError('Dedicated Cloud setup requires Linux and systemd.')
        if options.action == 'check-runtime':
            runtime_prerequisites(options.node, options.release, options.prepare_image)
        elif os.geteuid() != 0:
            raise AccountError('Run this Cloud administration command through sudo.')
        elif options.action == 'install':
            descriptor = os.open(LOCK, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
            with os.fdopen(descriptor, 'r+') as lock:
                info = os.fstat(lock.fileno())
                if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_nlink != 1 or info.st_mode & 0o077:
                    raise AccountError('The dedicated Cloud setup lock has unexpected ownership.')
                fcntl.flock(lock, fcntl.LOCK_EX)
                install(options.node, options.release, options.port)
            print('Dedicated Cloud service enabled.')
        elif options.action == 'url':
            os.chdir('/')
            print(launch_url(pwd.getpwnam(ACCOUNT).pw_uid, options.port))
        else:
            os.chdir('/')
            live_invocation(pwd.getpwnam(ACCOUNT).pw_uid)
            print('Dedicated Cloud service is running.')
    except AccountError as error:
        parser.exit(1, f'{error}\n')
    except KeyboardInterrupt:
        parser.exit(130, 'Dedicated Cloud setup interrupted.\n')
    except (OSError, ValueError, KeyError, subprocess.SubprocessError):
        parser.exit(1, 'Dedicated Cloud setup could not finish. Check the release and Linux prerequisites privately.\n')


if __name__ == '__main__':
    main()
