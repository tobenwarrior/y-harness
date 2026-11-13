#!/usr/bin/python3 -I
"""Install an opt-in, isolated Chromium worker for a Y Harness VPS."""

import argparse
import errno
import grp
import json
import os
import pwd
import re
import stat
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path


ACCOUNT = 'yharness-browser'
STATE_ROOT = Path('/var/lib') / ACCOUNT
INSTALL_ROOT = Path('/usr/local/lib') / ACCOUNT
CONFIG_ROOT = Path('/etc') / ACCOUNT
GRANTS_PATH = CONFIG_ROOT / 'grants.json'
UNIT_ROOT = Path('/etc/systemd/system')
RUNTIME_ROOT = Path('/run') / ACCOUNT
CONTROL_SOCKET = RUNTIME_ROOT / 'control.sock'
VAULT_SOCKET = RUNTIME_ROOT / 'vault.sock'
SERVICE_UNIT = f'{ACCOUNT}.service'
CONTROL_SOCKET_UNIT = f'{ACCOUNT}-control.socket'
VAULT_SOCKET_UNIT = f'{ACCOUNT}-vault.socket'
SERVICE_SOURCE = INSTALL_ROOT / 'service.mjs'
NOLOGIN = '/usr/sbin/nologin'
SYSTEMCTL = ('/usr/bin/systemctl', '--system', '--no-pager', '--no-ask-password')
SYSTEM_ENV = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LC_ALL': 'C'}
SAFE_PATH = re.compile(r'/[A-Za-z0-9_./-]+\Z')
SAFE_USER = re.compile(r'[A-Za-z_][A-Za-z0-9_-]{0,30}\Z')
SAFE_BOT = re.compile(r'bot-[A-Za-z0-9][A-Za-z0-9-]{0,245}\Z')
BOT_SESSION = re.compile(
    r'bot-session-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\Z'
)
MANAGED_MARKER = b'# Managed by Y Harness isolated browser installer.\n'
ARTIFACT_MARKER = b'// Managed by Y Harness isolated browser installer.\n'
ERRNO_NO_CAPABILITY = (errno.ENODATA, errno.ENOTSUP, errno.EOPNOTSUPP)


@dataclass(frozen=True)
class InstallPaths:
    """Filesystem destinations used by an installation.

    The optional roots make the installer testable without changing a host.
    Production callers use the defaults, which are all administrator-owned.
    """

    install_root: Path = INSTALL_ROOT
    state_root: Path = STATE_ROOT
    config_root: Path = CONFIG_ROOT
    unit_root: Path = UNIT_ROOT
    runtime_root: Path = RUNTIME_ROOT


class BrowserError(Exception):
    """Setup failure safe to print without exposing credentials or paths."""


def command(args, error, *, timeout=30):
    """Run one fixed administrator operation without forwarding diagnostics."""
    try:
        result = subprocess.run(
            args,
            env=SYSTEM_ENV,
            capture_output=True,
            text=True,
            check=True,
            timeout=timeout,
        )
    except (OSError, subprocess.SubprocessError):
        raise BrowserError(error) from None
    return result.stdout


def require_linux_root():
    """Require the administrator account before changing VPS-owned files."""
    if sys.platform != 'linux' or os.geteuid() != 0:
        raise BrowserError('Run the isolated browser installer as the Linux administrator.')


def _uid_is_trusted(info, uid):
    """Allow fixture-owned files in unprivileged tests, but enforce root installs."""
    if os.geteuid() == 0:
        return info.st_uid == uid
    return info.st_uid in (uid, os.geteuid())


def _gid_is_trusted(info, gid):
    """Apply the same root-only ownership check to fixture group ids."""
    if os.geteuid() == 0:
        return info.st_gid == gid
    return info.st_gid in (gid, os.getegid())


def _directory(path, uid, gid, mode, *, create=False):
    """Create or validate one exact, non-symlink directory."""
    try:
        info = path.lstat()
    except FileNotFoundError:
        if not create:
            return False
        try:
            path.mkdir(mode=mode, parents=True, exist_ok=False)
        except OSError as error:
            raise BrowserError('The isolated browser directory could not be created.') from error
        if os.geteuid() == 0:
            try:
                os.chown(path, uid, gid)
            except OSError as error:
                raise BrowserError('The isolated browser directory could not be owned safely.') from error
        try:
            os.chmod(path, mode)
        except OSError as error:
            raise BrowserError('The isolated browser directory could not be made private.') from error
        info = path.lstat()
    if (
        not stat.S_ISDIR(info.st_mode)
        or not _uid_is_trusted(info, uid)
        or not _gid_is_trusted(info, gid)
        or stat.S_IMODE(info.st_mode) != mode
    ):
        raise BrowserError('The isolated browser directory has unexpected ownership or permissions.')
    return True


def _file_info(path, uid, gid, mode):
    """Validate one root-managed regular file without following links."""
    try:
        info = path.lstat()
    except FileNotFoundError:
        return None
    if (
        not stat.S_ISREG(info.st_mode)
        or info.st_nlink != 1
        or not _uid_is_trusted(info, uid)
        or not _gid_is_trusted(info, gid)
        or stat.S_IMODE(info.st_mode) != mode
    ):
        raise BrowserError('An isolated browser file has unexpected ownership or permissions.')
    return info


def check_executable(path):
    """Require a regular, executable file without set-id bits or capabilities."""
    try:
        info = path.stat()
    except OSError as error:
        raise BrowserError('The trusted browser runtime executable is unavailable.') from error
    if not stat.S_ISREG(info.st_mode) or not info.st_mode & 0o111 or info.st_mode & (stat.S_ISUID | stat.S_ISGID):
        raise BrowserError('The browser runtime requires a regular executable without elevated bits.')
    getxattr = getattr(os, 'getxattr', None)
    if getxattr is None:
        return
    try:
        getxattr(path, 'security.capability')
    except OSError as error:
        if error.errno in ERRNO_NO_CAPABILITY:
            return
        raise BrowserError('Could not verify capabilities on the browser runtime executable.') from None
    raise BrowserError('The browser runtime executable has file capabilities.')


def trusted_executable(value):
    """Resolve a preinstalled root-controlled executable for a systemd unit."""
    candidate = Path(value)
    if not candidate.is_absolute() or SAFE_PATH.fullmatch(str(candidate)) is None:
        raise BrowserError('Use an absolute trusted path for Node and Chromium.')
    try:
        path = candidate.resolve(strict=True)
    except OSError as error:
        raise BrowserError('The trusted browser runtime executable is unavailable.') from error
    if SAFE_PATH.fullmatch(str(path)) is None:
        raise BrowserError('The trusted browser runtime path contains unsupported characters.')
    for current in (path, *path.parents):
        try:
            info = current.stat()
        except OSError as error:
            raise BrowserError('The trusted browser runtime path is unavailable.') from error
        if info.st_uid != 0 or info.st_mode & 0o022:
            raise BrowserError('Node and Chromium must be under administrator-owned non-writable paths.')
    check_executable(path)
    return path


def _positive_uid(value):
    """Validate one non-root Linux account id for a socket owner."""
    if type(value) is not int or value <= 0:
        raise BrowserError('The Cloud account must have a positive non-root uid.')
    return value


def user_uid(name):
    """Resolve a regular, non-root Linux account without changing it."""
    if type(name) is not str or SAFE_USER.fullmatch(name) is None:
        raise BrowserError('The Cloud account name is invalid.')
    try:
        account = pwd.getpwnam(name)
    except KeyError:
        raise BrowserError('The Cloud account does not exist.') from None
    if account.pw_uid <= 0 or account.pw_gid <= 0 or name == ACCOUNT:
        raise BrowserError('The Cloud account must be a separate non-root Linux account.')
    return account.pw_uid


def ensure_account():
    """Create or validate the locked static browser account and private group."""
    created = False
    try:
        account = pwd.getpwnam(ACCOUNT)
    except KeyError:
        command(
            [
                '/usr/sbin/useradd',
                '--system',
                '--user-group',
                '--home-dir',
                str(STATE_ROOT),
                '--create-home',
                '--shell',
                NOLOGIN,
                '--password',
                '*',
                ACCOUNT,
            ],
            'Could not create the isolated browser account.',
        )
        try:
            account = pwd.getpwnam(ACCOUNT)
        except KeyError:
            raise BrowserError('The isolated browser account was not created.') from None
        created = True
    try:
        group = grp.getgrnam(ACCOUNT)
    except KeyError:
        raise BrowserError('The isolated browser account is missing its private group.') from None
    if (
        account.pw_uid <= 0
        or account.pw_gid <= 0
        or account.pw_gid != group.gr_gid
        or account.pw_dir != str(STATE_ROOT)
        or account.pw_shell != NOLOGIN
        or set(os.getgrouplist(ACCOUNT, account.pw_gid)) != {account.pw_gid}
        or getattr(group, 'gr_mem', ())
    ):
        raise BrowserError('The isolated browser account must have a private locked group and home.')
    status = command(['/usr/bin/passwd', '-S', ACCOUNT], 'Could not verify the isolated browser password status.').split()
    if status[:2] != [ACCOUNT, 'L']:
        raise BrowserError('Lock the isolated browser account password before setup.')
    if created:
        # useradd may inherit a permissive CREATE_HOME mode; only the newly
        # created home is tightened here. Existing homes fail closed below.
        try:
            info = STATE_ROOT.lstat()
            if info.st_uid != account.pw_uid or info.st_gid != account.pw_gid:
                raise BrowserError('The isolated browser home has unexpected ownership.')
            os.chmod(STATE_ROOT, 0o700)
        except OSError as error:
            raise BrowserError('The isolated browser home could not be made private.') from error
    return account


def _validate_uid_for_unit(cloud_uid):
    """Validate the Cloud uid embedded in generated systemd files."""
    return _positive_uid(cloud_uid)


def service_unit(cloud_uid, node, chromium):
    """Render the private browser worker and its two socket-activation fds."""
    cloud_uid = _validate_uid_for_unit(cloud_uid)
    node_path = trusted_unit_path(node)
    chromium_path = trusted_unit_path(chromium)
    return f"""{MANAGED_MARKER.decode()}[Unit]
Description=Y Harness isolated browser worker
Requires={CONTROL_SOCKET_UNIT} {VAULT_SOCKET_UNIT}
After={CONTROL_SOCKET_UNIT} {VAULT_SOCKET_UNIT}

[Service]
Type=exec
User={ACCOUNT}
Group={ACCOUNT}
WorkingDirectory={STATE_ROOT}
Environment=HOME={STATE_ROOT}
Environment=PATH=/usr/local/bin:/usr/bin:/bin
Environment=LANG=C
Environment=LC_ALL=C
Environment=XDG_CONFIG_HOME={STATE_ROOT}/config
Environment=XDG_CACHE_HOME={STATE_ROOT}/cache
Environment=XDG_DATA_HOME={STATE_ROOT}/data
Environment=XDG_STATE_HOME={STATE_ROOT}/state
UMask=0077
Sockets={CONTROL_SOCKET_UNIT} {VAULT_SOCKET_UNIT}
ExecStart={node_path} {SERVICE_SOURCE} --chromium {chromium_path} --root {STATE_ROOT} --cloud-uid {cloud_uid} --grants {GRANTS_PATH}
StandardOutput=journal
StandardError=journal
Restart=on-failure
RestartSec=5s
LimitCORE=0
NoNewPrivileges=yes
CapabilityBoundingSet=
AmbientCapabilities=
ProtectSystem=strict
ProtectHome=tmpfs
PrivateTmp=yes
IPAddressAllow=127.0.0.53/32
IPAddressDeny=127.0.0.0/8 169.254.0.0/16 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 ::1/128 fe80::/10 fc00::/7
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
LockPersonality=yes
RestrictSUIDSGID=yes
RestrictRealtime=yes
RestrictNamespaces=no
PrivateUsers=no
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
ReadOnlyPaths={INSTALL_ROOT} {CONFIG_ROOT}
ReadWritePaths={STATE_ROOT}
InaccessiblePaths=/root /home /etc/ssh -/etc/ssl/private -/etc/NetworkManager/system-connections -/var/lib/yharness-cloud -/var/lib/yharness-vault

[Install]
WantedBy=multi-user.target
""".encode()


def trusted_unit_path(value):
    """Validate a path before interpolating it into shell-free systemd argv."""
    path = Path(value)
    if not path.is_absolute() or SAFE_PATH.fullmatch(str(path)) is None:
        raise BrowserError('Use absolute paths containing only safe unit characters.')
    return path


def control_socket_unit(cloud_uid):
    """Render the Cloud-owner control socket with a root-owned parent."""
    cloud_uid = _validate_uid_for_unit(cloud_uid)
    return f"""{MANAGED_MARKER.decode()}[Unit]
Description=Y Harness isolated browser Cloud control socket
Before={SERVICE_UNIT}

[Socket]
ListenStream={CONTROL_SOCKET}
FileDescriptorName=control
SocketUser={cloud_uid}
SocketGroup=root
SocketMode=0600
DirectoryMode=0755
Accept=no
RemoveOnStop=yes
Service={SERVICE_UNIT}

[Install]
WantedBy=sockets.target
""".encode()


def vault_socket_unit():
    """Render the separate root-only Vault socket."""
    return f"""{MANAGED_MARKER.decode()}[Unit]
Description=Y Harness isolated browser root Vault socket
Before={SERVICE_UNIT}

[Socket]
ListenStream={VAULT_SOCKET}
FileDescriptorName=vault
SocketUser=root
SocketGroup=root
SocketMode=0600
DirectoryMode=0755
Accept=no
RemoveOnStop=yes
Service={SERVICE_UNIT}

[Install]
WantedBy=sockets.target
""".encode()


SOURCE_ROOT = Path(__file__).resolve().with_name('vps-browser')
SERVICE_ARTIFACTS = ('service.mjs', 'page.mjs', 'pipe.mjs')


def service_source():
    """Read the dependency-free browser worker shipped beside this installer."""
    return artifact_payload('service.mjs')


def artifact_source(name):
    """Read one browser worker module from the release's trusted source tree."""
    if name not in SERVICE_ARTIFACTS:
        raise BrowserError('The browser service artifact name is invalid.')
    source = SOURCE_ROOT / name
    try:
        source_info = source.lstat()
        if not stat.S_ISREG(source_info.st_mode) or source_info.st_nlink != 1:
            raise BrowserError('The browser service artifact is not a regular file.')
        path = source.resolve(strict=True)
        info = path.stat()
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise BrowserError('The browser service artifact is not a regular file.')
        for current in (path, *path.parents):
            owner = current.stat()
            if (os.geteuid() == 0 and owner.st_uid != 0) or owner.st_mode & 0o022:
                raise BrowserError('The browser service artifacts must be administrator-owned and non-writable.')
        return path.read_bytes()
    except BrowserError:
        raise
    except OSError as error:
        raise BrowserError('The browser service artifacts are missing from the release.') from error


def artifact_payload(name):
    """Prefix one JavaScript module with the marker used for safe updates."""
    source = artifact_source(name)
    return source if source.startswith(ARTIFACT_MARKER) else ARTIFACT_MARKER + source


def grant_records(grants):
    """Validate and canonically sort Bot roster/session grant pairs."""
    if type(grants) is not list or len(grants) == 0 or len(grants) > 64:
        raise BrowserError('Select 1 to 64 isolated browser grants.')
    records = []
    seen_bots = set()
    seen_sessions = set()
    for grant in grants:
        if type(grant) is not tuple or len(grant) != 2:
            raise BrowserError('Each browser grant must contain a Bot id and Bot Session ID.')
        bot, session = grant
        if type(bot) is not str or SAFE_BOT.fullmatch(bot) is None or type(session) is not str or BOT_SESSION.fullmatch(session) is None:
            raise BrowserError('Each browser grant must name a valid Bot and canonical Bot Session ID.')
        if bot in seen_bots or session in seen_sessions:
            raise BrowserError('Browser grants must not contain duplicate Bot or Session ids.')
        seen_bots.add(bot)
        seen_sessions.add(session)
        records.append({'bot': bot, 'session': session})
    return sorted(records, key=lambda record: (record['bot'], record['session']))


def grants_payload(records):
    """Encode the immutable grant list without executable or comment fields."""
    return (json.dumps(records, ensure_ascii=True, separators=(',', ':'), sort_keys=True) + '\n').encode()


def parse_grant(value):
    """Parse one CLI grant written as BOT=CANONICAL_BOT_SESSION_ID."""
    if type(value) is not str or value.count('=') != 1:
        raise argparse.ArgumentTypeError('Use BOT=CANONICAL_BOT_SESSION_ID for each browser grant.')
    bot, session = value.split('=', 1)
    try:
        grant_records([(bot, session)])
    except BrowserError as error:
        raise argparse.ArgumentTypeError(str(error)) from None
    return bot, session


def _file_needs_change(path, payload, uid, gid, mode):
    """Check a managed file and report whether the requested bytes differ."""
    info = _file_info(path, uid, gid, mode)
    if info is None:
        return True
    if path.read_bytes() == payload:
        return False
    return True


def _write_file(path, payload, uid, gid, mode):
    """Atomically install one regular root-managed file without following links."""
    path.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
    temporary_name = None
    try:
        descriptor, temporary_name = tempfile.mkstemp(prefix='.yharness-browser-', dir=path.parent)
        with os.fdopen(descriptor, 'wb') as output:
            os.fchmod(output.fileno(), mode)
            if os.geteuid() == 0:
                os.fchown(output.fileno(), uid, gid)
            output.write(payload)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary_name, path)
        temporary_name = None
    except OSError as error:
        raise BrowserError(f'The isolated browser file could not be installed at {path}.') from error
    finally:
        if temporary_name is not None:
            try:
                os.unlink(temporary_name)
            except FileNotFoundError:
                pass


def _prepare_directories(paths, account):
    """Create only the installer-owned roots and reject unrelated permissions."""
    _directory(paths.install_root, 0, 0, 0o755, create=True)
    _directory(paths.state_root, account.pw_uid, account.pw_gid, 0o700, create=True)
    # The directory stays root-owned while its private group lets only the
    # browser worker traverse it to read grants.json.
    _directory(paths.config_root, 0, account.pw_gid, 0o750, create=True)
    _directory(paths.unit_root, 0, 0, 0o755, create=True)
    # Keep the socket parent root-owned before systemd creates either endpoint.
    _directory(paths.runtime_root, 0, 0, 0o755, create=True)


def ensure_units_inactive():
    """Require all browser units to be inactive before replacing settings."""
    for unit in (SERVICE_UNIT, CONTROL_SOCKET_UNIT, VAULT_SOCKET_UNIT):
        try:
            raw = command(
                [*SYSTEMCTL, 'show', '--property=ActiveState,LoadState', '--', unit],
                'Could not inspect the isolated browser systemd units.',
            )
        except BrowserError:
            raise BrowserError('Could not inspect the isolated browser systemd units.') from None
        fields = dict(line.split('=', 1) for line in raw.splitlines() if '=' in line)
        active = fields.get('ActiveState')
        loaded = fields.get('LoadState')
        if active not in ('inactive', 'failed') or loaded not in ('loaded', 'not-found', 'masked'):
            raise BrowserError('Stop the isolated browser service before changing its settings.')


def install(chromium, node, cloud_uid, grants, *, paths=InstallPaths()):
    """Install the browser worker, sockets, private state, and root grant list."""
    chromium_path = trusted_executable(chromium)
    node_path = trusted_executable(node)
    cloud_uid = _validate_uid_for_unit(cloud_uid)
    account = ensure_account()
    if cloud_uid == account.pw_uid:
        raise BrowserError('The Cloud account must not be the isolated browser account.')
    records = grant_records(grants)
    _prepare_directories(paths, account)
    artifacts = tuple(
        (paths.install_root / name, artifact_payload(name), 0, 0, 0o644, True)
        for name in SERVICE_ARTIFACTS
    ) + (
        (paths.config_root / 'grants.json', grants_payload(records), 0, account.pw_gid, 0o640, False),
        (paths.unit_root / SERVICE_UNIT, service_unit(cloud_uid, node_path, chromium_path), 0, 0, 0o644, True),
        (paths.unit_root / CONTROL_SOCKET_UNIT, control_socket_unit(cloud_uid), 0, 0, 0o644, True),
        (paths.unit_root / VAULT_SOCKET_UNIT, vault_socket_unit(), 0, 0, 0o644, True),
    )
    changes = []
    for path, payload, uid, gid, mode, managed in artifacts:
        if _file_needs_change(path, payload, uid, gid, mode):
            changes.append((path, payload, uid, gid, mode, managed))
    if changes:
        ensure_units_inactive()
        for path, payload, uid, gid, mode, managed in changes:
            if managed and path.exists() and not path.read_bytes().startswith(MANAGED_MARKER):
                raise BrowserError(f'A different file already exists at {path}. Review it before changing the deployment.')
            _write_file(path, payload, uid, gid, mode)


def activate():
    """Opt in by enabling only the browser sockets; Cloud is never restarted."""
    require_linux_root()
    command([*SYSTEMCTL, 'daemon-reload'], 'Could not reload the browser systemd units.')
    command([*SYSTEMCTL, 'enable', '--now', '--', CONTROL_SOCKET_UNIT], 'Could not enable the browser control socket.')
    command([*SYSTEMCTL, 'enable', '--now', '--', VAULT_SOCKET_UNIT], 'Could not enable the browser Vault socket.')


def main(argv=None):
    """Parse administrator commands and report safe setup errors."""
    parser = argparse.ArgumentParser(description=__doc__)
    actions = parser.add_subparsers(dest='action', required=True)
    install_parser = actions.add_parser('install', help='install the inactive browser worker and its sockets')
    install_parser.add_argument('--chromium', required=True, help='absolute preinstalled Chromium executable')
    install_parser.add_argument('--node', required=True, help='absolute preinstalled Node executable')
    cloud = install_parser.add_mutually_exclusive_group()
    cloud.add_argument('--cloud-user', default='yharness-cloud', help='Cloud Linux account owning control.sock')
    cloud.add_argument('--cloud-uid', type=int, help='Cloud uid owning control.sock')
    install_parser.add_argument(
        '--grant', action='append', type=parse_grant, default=[], metavar='BOT=BOT_SESSION_ID',
        help='root-approved Bot roster/session pair; repeat for each pair',
    )
    actions.add_parser('activate', help='enable only the browser sockets without restarting Cloud')
    args = parser.parse_args(argv)
    try:
        require_linux_root()
        os.umask(0o077)
        if args.action == 'install':
            cloud_uid = args.cloud_uid if args.cloud_uid is not None else user_uid(args.cloud_user)
            install(args.chromium, args.node, cloud_uid, args.grant)
            print('Isolated browser installed; run activate to enable its sockets.')
        else:
            activate()
    except BrowserError as error:
        parser.exit(1, f'Isolated browser: {error}\n')
    except (OSError, ValueError):
        parser.exit(1, 'Isolated browser: could not access its private setup.\n')
    except KeyboardInterrupt:
        parser.exit(130, '\nIsolated browser: cancelled.\n')


if __name__ == '__main__':
    main()
