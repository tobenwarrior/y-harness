#!/usr/bin/python3 -I
"""Manage write-only, encrypted credentials for dedicated Linux services."""

import argparse
import base64
import fcntl
import getpass
import hashlib
import ipaddress
import json
import math
import os
import pwd
import re
import secrets
import socket
import stat
import struct
import subprocess
import sys
import tempfile
import time
import warnings
from contextlib import contextmanager
from pathlib import Path
from urllib.parse import urlsplit


ROOT = Path('/var/lib/yharness-vault')
UNITS = Path('/etc/systemd/system')
DROPIN = '90-yharness-vault.conf'
PREFIX = 'yharness'
UNIT = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.:@-]{0,220}\.service')
NAME = re.compile(r'[A-Za-z_][A-Za-z0-9_]{0,63}')
REQUEST_ID = re.compile(r'[0-9a-f]{32}')
USER = re.compile(r'[A-Za-z_][A-Za-z0-9_-]{0,30}')
SECRET_LIMIT = 8192
DESKTOP_REQUEST_LIMIT = 64 * 1024
DESKTOP_SERVICE_LIMIT = 16
DESKTOP_NAME_LIMIT = 100
DESKTOP_RESPONSE_LIMIT = 160 * 1024
BROWSER_SOCKET = Path('/run/yharness-browser/vault.sock')
BROWSER_ACCOUNT = 'yharness-browser'
BROWSER_REQUEST_LIMIT = 16 * 1024
BROWSER_RESPONSE_LIMIT = 64 * 1024
BROWSER_TIMEOUT = 25
CLOUD_REQUEST_LIMIT = 4 * 1024
REQUEST_RECORD_LIMIT = 64
REQUEST_TTL = 10 * 60
REQUEST_LEASE = 20
DESKTOP_SOCKET = Path('/run/yharness-vault/desktop.sock')
DESKTOP_LISTENER = 'yharness-vault-desktop.socket'
DESKTOP_WORKER = 'yharness-vault-desktop@.service'
CLOUD_SOCKET = Path('/run/yharness-vault/cloud-requests.sock')
CLOUD_LISTENER = 'yharness-vault-cloud-requests.socket'
CLOUD_WORKER = 'yharness-vault-cloud-requests@.service'
CLOUD_REQUESTS_FILE = 'cloud-requests.json'
CLOUD_REQUESTS_ENABLED = 'cloud-requests-enabled'
INSTALLED_VAULT = Path('/usr/local/sbin/yharness-vault')
SYSTEMCTL = ['/usr/bin/systemctl', '--system', '--no-pager', '--no-ask-password']
COMMAND_ENV = {'PATH': '/usr/bin:/bin', 'LC_ALL': 'C'}
REQUEST_UNAVAILABLE = 'The Vault request is unavailable.'
BROWSER_UNAVAILABLE = 'The browser Vault is unavailable.'
WEBSITE_LOGIN_DIRECTORY = 'website-logins'
WEBSITE_LOGIN_LIMIT = 64
WEBSITE_LOGIN_FILE_LIMIT = 64 * 1024
WEBSITE_LOGIN_ID = re.compile(r'[0-9a-f]{32}')
WEBSITE_LOGIN_LABEL_LIMIT = 80
WEBSITE_LOGIN_USERNAME_LIMIT = 512
WEBSITE_LOGIN_PASSWORD_LIMIT = 8192
WEBSITE_LOGIN_UNAVAILABLE = 'The website login is unavailable.'
WEBSITE_LOGIN_GENERATION = re.compile(r'[0-9a-f]{64}')
WEBSITE_LOGIN_DESTINATION_LIMIT = 4096
WEBSITE_LOGIN_HOST_LABEL = r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?'
WEBSITE_LOGIN_LOCAL_SUFFIXES = ('localhost', 'local', 'localdomain')
WEBSITE_LOGIN_ORIGIN = re.compile(
    rf'https://(?P<host>{WEBSITE_LOGIN_HOST_LABEL}(?:\.{WEBSITE_LOGIN_HOST_LABEL})*)'
    r'(?::(?P<port>[1-9][0-9]{0,4}))?\Z'
)


class VaultError(Exception):
    """Vault failure that can be displayed to the owner without a value."""


def directory(path, create=False, private=True, uid=None):
    """Check an owner-controlled directory without following a symbolic link."""
    if create:
        path.mkdir(mode=0o700 if private else 0o755, exist_ok=True)
    try:
        info = path.lstat()
    except FileNotFoundError:
        return False
    expected = os.geteuid() if uid is None else uid
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != expected or info.st_mode & (0o077 if private else 0o022):
        raise VaultError('The Vault directory must be controlled by the administrator.')
    return True


def file_exists(path, private=True, uid=None):
    """Admit an owner-controlled regular file with exactly one directory entry."""
    try:
        info = path.lstat()
    except FileNotFoundError:
        return False
    expected = os.geteuid() if uid is None else uid
    if (not stat.S_ISREG(info.st_mode) or info.st_uid != expected or info.st_nlink != 1
            or info.st_mode & (0o077 if private else 0o022)):
        raise VaultError('The Vault found a file with unexpected ownership or permissions.')
    return True


def sync_directory(path):
    """Commit a renamed or removed entry in its parent directory."""
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def replace_file(path, payload, temporary_directory, mode):
    """Commit bytes atomically, staging outside the systemd credential loader's directory."""
    descriptor, name = tempfile.mkstemp(prefix='.vault-', dir=temporary_directory)
    temporary = Path(name)
    try:
        with os.fdopen(descriptor, 'wb') as output:
            os.fchmod(output.fileno(), mode)
            output.write(payload)
            output.flush()
            os.fsync(output.fileno())
        temporary.replace(path)
        sync_directory(path.parent)
    finally:
        temporary.unlink(missing_ok=True)


def credential_name(name):
    """Accept the name used for an API key in its dedicated service."""
    if not NAME.fullmatch(name):
        raise VaultError('Use a credential name such as EXAMPLE_API_KEY.')
    return name


def exact_object(pairs):
    """Reject duplicate fields at a JSON input boundary."""
    result = dict(pairs)
    if len(result) != len(pairs):
        raise VaultError('The Vault request contains duplicate fields.')
    return result


def desktop_body(stream):
    """Read only one bounded request from the caller's standard input."""
    payload = stream.read(DESKTOP_REQUEST_LIMIT + 1)
    if len(payload) > DESKTOP_REQUEST_LIMIT:
        raise VaultError('The Vault request is too large.')
    return payload


def cloud_body(stream):
    """Read one bounded metadata request from the Cloud service socket."""
    payload = stream.read(CLOUD_REQUEST_LIMIT + 1)
    if len(payload) > CLOUD_REQUEST_LIMIT:
        raise VaultError('The Vault request is too large.')
    return payload


def valid_unit(unit):
    """Accept an exact system service, including instances of templates."""
    return type(unit) is str and UNIT.fullmatch(unit) is not None and not unit.endswith('@.service')


def valid_request_id(value):
    """Accept the opaque identifier generated by the Cloud request owner."""
    return type(value) is str and REQUEST_ID.fullmatch(value) is not None


def valid_login_id(value):
    """Accept the opaque identifier generated for one website login."""
    return type(value) is str and WEBSITE_LOGIN_ID.fullmatch(value) is not None


def valid_login_generation(value):
    """Accept the opaque digest returned with one inspected website login."""
    return type(value) is str and WEBSITE_LOGIN_GENERATION.fullmatch(value) is not None


def website_login_generation(record):
    """Bind one owner selection to the current encrypted record bytes."""
    return hashlib.sha256(record['credential'].encode('ascii')).hexdigest()


def valid_login_origin(value):
    """Accept one canonical, lower-case HTTPS DNS origin without a path."""
    if type(value) is not str or not value.isascii():
        return False
    match = WEBSITE_LOGIN_ORIGIN.fullmatch(value)
    if match is None:
        return False
    host = match['host']
    labels = host.split('.')
    if len(labels) < 2 or len(host) > 253 or labels[-1].isdecimal():
        return False
    if any(host == suffix or host.endswith(f'.{suffix}') for suffix in WEBSITE_LOGIN_LOCAL_SUFFIXES):
        return False
    if all(label.isdecimal() for label in labels):
        return False
    try:
        ipaddress.ip_address(host)
    except ValueError:
        pass
    else:
        return False
    port = match['port']
    return port is None or int(port) <= 65535 and int(port) != 443


def valid_login_destination(origin, destination):
    """Accept one canonical HTTPS POST destination on the exact saved origin."""
    if (type(origin) is not str or type(destination) is not str or not valid_login_origin(origin)
            or not destination.isascii() or not 0 < len(destination.encode('ascii')) <= WEBSITE_LOGIN_DESTINATION_LIMIT
            or not destination.startswith(origin + '/') or '?' in destination or '#' in destination
            or any(ord(character) <= 0x20 or ord(character) == 0x7f or character == '\\' for character in destination)):
        return False
    try:
        parsed = urlsplit(destination)
    except ValueError:
        return False
    authority = origin.removeprefix('https://')
    return (parsed.scheme == 'https' and parsed.netloc == authority and parsed.path.startswith('/')
            and parsed.username is None and parsed.password is None and parsed.query == '' and parsed.fragment == '')


def login_text(value, limit, *, trim=False):
    """Validate one single-line website-login field and return its stored text."""
    if type(value) is not str or any(ord(character) < 0x20 or 0x7f <= ord(character) <= 0x9f
                                    for character in value) or any(character in value for character in '\u2028\u2029'):
        raise VaultError('Invalid website login request.')
    stored = value.strip() if trim else value
    try:
        size = len(stored.encode('utf-8'))
    except UnicodeError:
        raise VaultError('Invalid website login request.') from None
    if not 0 < size <= limit:
        raise VaultError('Invalid website login request.')
    return stored


def website_login_request(request):
    """Validate one exact Desktop website-login request and normalize its label."""
    action = request.get('action')
    if action == 'list-logins':
        if set(request) != {'action'}:
            raise VaultError('Invalid website login request.')
        return request
    if action == 'add-login':
        fields = {'action', 'origin', 'label', 'username', 'password'}
    elif action == 'replace-login':
        fields = {'action', 'id', 'label', 'username', 'password'}
    elif action == 'remove-login':
        if set(request) != {'action', 'id'} or not valid_login_id(request.get('id')):
            raise VaultError('Invalid website login request.')
        return request
    else:
        raise VaultError('Invalid website login request.')
    if set(request) != fields:
        raise VaultError('Invalid website login request.')
    if action == 'replace-login' and not valid_login_id(request.get('id')):
        raise VaultError('Invalid website login request.')
    if action == 'add-login' and not valid_login_origin(request.get('origin')):
        raise VaultError('Invalid website login request.')
    return {
        **request,
        'label': login_text(request.get('label'), WEBSITE_LOGIN_LABEL_LIMIT, trim=True),
        'username': login_text(request.get('username'), WEBSITE_LOGIN_USERNAME_LIMIT),
        'password': login_text(request.get('password'), WEBSITE_LOGIN_PASSWORD_LIMIT),
    }


def browser_login_inspection(payload, expected_id):
    """Decode one bounded browser inspection without returning browser diagnostics."""
    try:
        if len(payload) > BROWSER_RESPONSE_LIMIT:
            raise VaultError(BROWSER_UNAVAILABLE)
        reply = json.loads(payload.decode('utf-8'), object_pairs_hook=exact_object)
        if type(reply) is not dict:
            raise VaultError(BROWSER_UNAVAILABLE)
        if set(reply) == {'error'} and reply['error'] == 'unavailable':
            raise VaultError(BROWSER_UNAVAILABLE)
        if (set(reply) != {'id', 'origin', 'destination', 'state'}
                or reply.get('id') != expected_id or not valid_request_id(reply.get('id'))
                or reply.get('state') != 'pending' or not valid_login_origin(reply.get('origin'))
                or not valid_login_destination(reply['origin'], reply.get('destination'))):
            raise VaultError(BROWSER_UNAVAILABLE)
        return reply
    except VaultError:
        raise
    except (UnicodeError, ValueError, RecursionError, TypeError):
        raise VaultError(BROWSER_UNAVAILABLE) from None


def browser_login_state(payload):
    """Decode the browser's fixed login-delivery state without exposing its reply."""
    try:
        if len(payload) > BROWSER_RESPONSE_LIMIT:
            raise VaultError(BROWSER_UNAVAILABLE)
        reply = json.loads(payload.decode('utf-8'), object_pairs_hook=exact_object)
        if type(reply) is not dict or set(reply) != {'state'} or reply['state'] not in (
                'submitted', 'needs-owner', 'unavailable'):
            raise VaultError(BROWSER_UNAVAILABLE)
        return {'state': reply['state']}
    except VaultError:
        raise
    except (UnicodeError, ValueError, RecursionError, TypeError):
        raise VaultError(BROWSER_UNAVAILABLE) from None


def request_grant(value):
    """Decode an exact service and key from the administrator's grant argument."""
    unit, _, name = value.partition('=')
    if not valid_unit(unit) or not NAME.fullmatch(name):
        raise argparse.ArgumentTypeError('Use UNIT.service=KEY_NAME for each credential request grant.')
    return unit, name


def desktop_request(payload):
    """Decode one bounded management request with no secret read operation."""
    try:
        if len(payload) > DESKTOP_REQUEST_LIMIT:
            raise VaultError('The Vault request is too large.')
        request = json.loads(payload.decode('utf-8'), object_pairs_hook=exact_object)
        if type(request) is not dict:
            raise VaultError('Invalid Vault request.')
        action = request.get('action')
        if action == 'list' and set(request) == {'action'}:
            return request
        if action in ('list-logins', 'add-login', 'replace-login', 'remove-login'):
            return website_login_request(request)
        if action == 'inspect-login-use' or action == 'decline-login-use':
            if set(request) != {'action', 'id'} or not valid_request_id(request.get('id')):
                raise VaultError('Invalid Vault request.')
            return request
        if action == 'approve-login-use':
            if (set(request) != {'action', 'id', 'loginId', 'generation'}
                    or not valid_request_id(request.get('id'))
                    or not valid_login_id(request.get('loginId'))
                    or not valid_login_generation(request.get('generation'))):
                raise VaultError('Invalid Vault request.')
            return request
        if action in ('inspect-request', 'dismiss-request'):
            if set(request) != {'action', 'id'} or not valid_request_id(request.get('id')):
                raise VaultError('Invalid Vault request.')
            return request
        fields = {'action', 'unit', 'name'}
        if action == 'save-request':
            fields = {'action', 'id', 'value'}
            value = request.get('value')
            if (set(request) != fields or not valid_request_id(request.get('id')) or type(value) is not str
                    or not valid_secret(value.encode())):
                raise VaultError('Enter a non-empty credential of at most 8 KiB.')
        elif action in ('add', 'replace'):
            fields.add('value')
            value = request.get('value')
            if type(value) is not str or not valid_secret(value.encode()):
                raise VaultError('Enter a non-empty credential of at most 8 KiB.')
        elif action != 'revoke':
            raise VaultError('Invalid Vault request.')
        if action == 'save-request':
            return request
        if (set(request) != fields or not valid_unit(request['unit'])
                or type(request['name']) is not str or not NAME.fullmatch(request['name'])):
            raise VaultError('Invalid Vault request.')
        return request
    except (UnicodeError, ValueError, RecursionError):
        raise VaultError('Invalid Vault request.') from None


def cloud_request(payload):
    """Decode one bounded Cloud metadata request with no credential value."""
    try:
        if len(payload) > CLOUD_REQUEST_LIMIT:
            raise VaultError('The Vault request is too large.')
        request = json.loads(payload.decode('utf-8'), object_pairs_hook=exact_object)
        if type(request) is not dict:
            raise VaultError('Invalid Vault request.')
        action = request.get('action')
        if action == 'create':
            if (set(request) != {'action', 'id', 'unit', 'name'}
                    or not valid_request_id(request.get('id'))
                    or not valid_unit(request.get('unit'))
                    or type(request.get('name')) is not str
                    or not NAME.fullmatch(request['name'])):
                raise VaultError('Invalid Vault request.')
            return request
        if action in ('status', 'cancel'):
            if set(request) != {'action', 'id'} or not valid_request_id(request.get('id')):
                raise VaultError('Invalid Vault request.')
            return request
        raise VaultError('Invalid Vault request.')
    except (UnicodeError, ValueError, RecursionError):
        raise VaultError('Invalid Vault request.') from None


def valid_secret(value):
    """Accept the byte representation used by both entry paths."""
    return 0 < len(value) <= SECRET_LIMIT and b'\0' not in value


def desktop_socket_unit(owner_uid):
    """Bind the local Vault management socket to the authorized SSH account."""
    return f"""[Unit]
Description=Y Harness Vault management socket

[Socket]
ListenStream={DESKTOP_SOCKET}
SocketUser={owner_uid}
SocketGroup=root
SocketMode=0600
DirectoryMode=0755
Accept=yes
MaxConnections=4
RemoveOnStop=yes

[Install]
WantedBy=sockets.target
""".encode()


def desktop_worker_unit():
    """Run one short-lived root Vault operation on its accepted local socket."""
    return f"""[Unit]
Description=Y Harness Vault management request

[Service]
Type=exec
ExecStart=/usr/bin/python3 -I {INSTALLED_VAULT} desktop-worker
StandardInput=socket
StandardOutput=socket
StandardError=null
NoNewPrivileges=yes
PrivateNetwork=yes
PrivateTmp=yes
LimitCORE=0
UMask=0077
RuntimeMaxSec=25s
""".encode()


def cloud_socket_unit(cloud_uid):
    """Bind the root broker socket to the configured Cloud Linux account."""
    if type(cloud_uid) is not int or cloud_uid <= 0:
        raise VaultError('The Cloud account could not be resolved.')
    return f"""[Unit]
Description=Y Harness Cloud Vault request socket

[Socket]
ListenStream={CLOUD_SOCKET}
SocketUser={cloud_uid}
SocketGroup=root
SocketMode=0600
DirectoryMode=0755
Accept=yes
MaxConnections=4
RemoveOnStop=yes

[Install]
WantedBy=sockets.target
""".encode()


def cloud_worker_unit():
    """Run one short-lived root broker operation on its accepted socket."""
    return f"""[Unit]
Description=Y Harness Cloud Vault request
PartOf={CLOUD_LISTENER}

[Service]
Type=exec
User=root
ExecStart=/usr/bin/python3 -I {INSTALLED_VAULT} cloud-request-worker
StandardInput=socket
StandardOutput=socket
StandardError=null
NoNewPrivileges=yes
PrivateNetwork=yes
PrivateTmp=yes
LimitCORE=0
UMask=0077
RuntimeMaxSec=25s
""".encode()


def desktop_peer(connection):
    """Read the Linux account of the process that opened the socket."""
    size = struct.calcsize('iII')
    _pid, uid, _gid = struct.unpack('iII', connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, size))
    return uid


def trusted_file(path):
    """Verify the installed root-controlled executable and every directory leading to it."""
    for parent in path.parents:
        if not directory(parent, private=False, uid=0):
            raise VaultError('The Vault installation directory is unavailable.')
    if not file_exists(path, private=False, uid=0):
        raise VaultError('Install the Vault in /usr/local/sbin first.')


def desktop_client(payload, endpoint=DESKTOP_SOCKET):
    """Exchange one request with the owner-only socket without a privileged SSH command."""
    trusted_file(INSTALLED_VAULT)
    if not directory(endpoint.parent, private=False, uid=0):
        raise VaultError('Desktop Vault access is unavailable.')
    info = endpoint.lstat()
    if not stat.S_ISSOCK(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise VaultError('Desktop Vault access is unavailable for this SSH account.')
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        connection.settimeout(25)
        connection.connect(str(endpoint))
        if desktop_peer(connection) != 0:
            raise VaultError('Could not verify the Vault service.')
        connection.sendall(payload)
        connection.shutdown(socket.SHUT_WR)
        with connection.makefile('rb') as reply:
            result = reply.read(DESKTOP_RESPONSE_LIMIT + 1)
    if not result or len(result) > DESKTOP_RESPONSE_LIMIT:
        raise VaultError('Desktop Vault is unavailable.')
    return result


def browser_peer_uid():
    """Resolve the dedicated browser worker account used by the root-only socket."""
    try:
        uid = pwd.getpwnam(BROWSER_ACCOUNT).pw_uid
    except (AttributeError, KeyError, TypeError):
        raise VaultError(BROWSER_UNAVAILABLE) from None
    if type(uid) is not int or uid <= 0:
        raise VaultError(BROWSER_UNAVAILABLE)
    return uid


def browser_client(payload):
    """Send one bounded request to the fixed root-owned browser socket."""
    if type(payload) is not bytes or len(payload) > BROWSER_REQUEST_LIMIT or os.geteuid() != 0:
        raise VaultError(BROWSER_UNAVAILABLE)
    endpoint = BROWSER_SOCKET
    try:
        if not directory(endpoint.parent, private=False, uid=0):
            raise VaultError(BROWSER_UNAVAILABLE)
        info = endpoint.lstat()
        if (not stat.S_ISSOCK(info.st_mode) or info.st_uid != 0
                or stat.S_IMODE(info.st_mode) != 0o600):
            raise VaultError(BROWSER_UNAVAILABLE)
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
            connection.settimeout(BROWSER_TIMEOUT)
            connection.connect(str(endpoint))
            if desktop_peer(connection) != browser_peer_uid():
                raise VaultError(BROWSER_UNAVAILABLE)
            connection.sendall(payload)
            connection.shutdown(socket.SHUT_WR)
            with connection.makefile('rb') as reply:
                result = reply.read(BROWSER_RESPONSE_LIMIT + 1)
    except VaultError:
        raise
    except (OSError, ValueError):
        raise VaultError(BROWSER_UNAVAILABLE) from None
    if not result or len(result) > BROWSER_RESPONSE_LIMIT:
        raise VaultError(BROWSER_UNAVAILABLE)
    return result


def desktop_worker(vault, connection):
    """Check the peer and handle one request without logging or returning secret values."""
    uid = desktop_peer(connection)
    connection.settimeout(15)
    with connection.makefile('rb') as request:
        payload = desktop_body(request)
    answer = vault.desktop(desktop_request(payload), uid)
    connection.sendall((json.dumps(answer) + '\n').encode())


def cloud_worker(vault, connection):
    """Check the Cloud peer and handle one metadata-only broker request."""
    uid = desktop_peer(connection)
    connection.settimeout(15)
    with connection.makefile('rb') as request:
        payload = cloud_body(request)
    answer = vault.cloud(cloud_request(payload), uid)
    connection.sendall((json.dumps(answer) + '\n').encode())


def current_boot_id():
    """Return the kernel boot identifier used to scope persisted requests."""
    try:
        value = Path('/proc/sys/kernel/random/boot_id').read_text().strip()
    except (OSError, UnicodeError):
        value = ''
    return value or f'process:{os.getpid()}'


class Vault:
    """Owner-only encrypted storage for exact systemd service names."""

    def __init__(self, root=ROOT, units=UNITS, run=subprocess.run, clock=time.monotonic, boot_id=None):
        self.root = root
        self.units = units
        self.run = run
        self.clock = clock
        self.boot_id = current_boot_id() if boot_id is None else boot_id

    def paths(self, unit):
        """Resolve a service's credential directory and managed drop-in."""
        if not valid_unit(unit):
            raise VaultError('Use an exact system service name ending in .service.')
        return self.root / unit / 'credentials', self.units / (unit + '.d') / DROPIN

    @contextmanager
    def locked(self):
        """Serialize mutations across Vault invocations under a private directory."""
        path = self.root / '.lock'
        descriptor = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
        with os.fdopen(descriptor, 'rb') as lock:
            info = os.fstat(lock.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_nlink != 1 or info.st_mode & 0o077:
                raise VaultError('The Vault lock has unexpected ownership or permissions.')
            fcntl.flock(lock, fcntl.LOCK_EX)
            yield

    def command(self, args, failure, **kwargs):
        """Run a fixed systemd operation with private diagnostics."""
        try:
            result = self.run(args, timeout=20, stderr=subprocess.DEVNULL, env=COMMAND_ENV, **kwargs)
        except (OSError, subprocess.SubprocessError):
            raise VaultError(failure) from None
        if result.returncode != 0:
            raise VaultError(failure)
        return result.stdout

    def service(self, unit, cloud_uid):
        """Verify that the system manager resolves an exact, separately owned workload."""
        if cloud_uid <= 0:
            raise VaultError('Select the regular Linux user that runs Y Harness Cloud.')
        result = self.command(
            [*SYSTEMCTL, 'show', '--property=Id,LoadState,User,DynamicUser,DropInPaths', '--', unit],
            'The target system service could not be inspected.', stdout=subprocess.PIPE, text=True,
        )
        fields = dict(line.split('=', 1) for line in result.splitlines() if '=' in line)
        if fields.get('Id') != unit or fields.get('LoadState') != 'loaded':
            raise VaultError('The exact target system service must exist.')
        user = fields.get('User', '')
        if user.isascii() and user.isdecimal() and len(user) <= 10:
            uid = int(user)
        elif USER.fullmatch(user):
            try:
                uid = pwd.getpwnam(user).pw_uid
            except KeyError:
                if fields.get('DynamicUser') == 'yes':
                    return fields
                raise VaultError('The service account could not be resolved.') from None
        else:
            raise VaultError('The system service needs an explicit dedicated User= account.')
        if uid == 0 or uid == cloud_uid:
            raise VaultError('The service account must be separate from root and the Y Harness Cloud user.')
        return fields

    def binding(self, credentials):
        """Render the exact credential directory imported by one service."""
        return f'[Service]\nLoadCredentialEncrypted={PREFIX}:{credentials}\n'.encode()

    def enabled_credentials(self, unit, cloud_uid):
        """Find a service's loaded Vault directory under the management lock."""
        credentials, dropin = self.paths(unit)
        fields = self.service(unit, cloud_uid)
        if (not directory(self.units, private=False) or not directory(dropin.parent, private=False)
                or not file_exists(dropin, private=False) or dropin.read_bytes() != self.binding(credentials)
                or str(dropin) not in fields.get('DropInPaths', '').split()
                or not directory(credentials.parent) or not directory(credentials)):
            raise VaultError('Enable the Vault for this service first.')
        return credentials

    def enable(self, unit, cloud_uid):
        """Attach one private scope and reload the system manager configuration."""
        credentials, dropin = self.paths(unit)
        self.service(unit, cloud_uid)
        if not directory(self.units, private=False):
            raise VaultError('The system service configuration directory is unavailable.')
        directory(self.root, create=True)
        with self.locked():
            directory(dropin.parent, create=True, private=False)
            expected = self.binding(credentials)
            present = file_exists(dropin, private=False)
            if present and dropin.read_bytes() != expected:
                raise VaultError('The service already has a different Vault configuration.')
            directory(credentials.parent, create=True)
            directory(credentials, create=True)
            if not present:
                replace_file(dropin, expected, dropin.parent, 0o644)
            self.command([*SYSTEMCTL, 'daemon-reload'], 'The system manager could not reload. Retry enabling the Vault.', stdout=subprocess.DEVNULL)

    def save(self, unit, name, value, cloud_uid):
        """Store or rotate one credential after validating its bound service."""
        credential_name(name)
        if not valid_secret(value):
            raise VaultError('Enter a non-empty credential of at most 8 KiB.')
        if not directory(self.root):
            raise VaultError('Enable the Vault for this service first.')
        with self.locked():
            credentials = self.enabled_credentials(unit, cloud_uid)
            self.write_value(credentials, name, value)

    def write_value(self, credentials, name, value, action=None):
        """Seal one value atomically after checking for a stale desktop action."""
        target = credentials / name
        exists = file_exists(target)
        if (action == 'add' and exists) or (action == 'replace' and not exists):
            raise VaultError('The Vault entry changed. Refresh and try again.')
        encrypted = self.command(
            ['/usr/bin/systemd-creds', '--with-key=host', f'--name={PREFIX}_{name}', 'encrypt', '-', '-'],
            'Systemd could not encrypt the credential.', input=value, stdout=subprocess.PIPE,
        )
        try:
            cipher = base64.b64decode(b''.join(encrypted.split()), validate=True)
        except ValueError:
            raise VaultError('Systemd returned an invalid encrypted credential.') from None
        if not cipher:
            raise VaultError('Systemd returned an empty encrypted credential.')
        replace_file(target, encrypted, credentials.parent, 0o600)

    def credential_names(self, credentials):
        """List only file names within a verified credential directory."""
        return sorted(credential_name(path.name) for path in credentials.iterdir() if file_exists(path))

    def names(self, unit):
        """Return saved names for one scope without reading the encrypted files."""
        credentials, _dropin = self.paths(unit)
        if not directory(self.root):
            return []
        with self.locked():
            if not directory(credentials.parent) or not directory(credentials):
                return []
            return self.credential_names(credentials)

    def revoke(self, unit, name):
        """Remove the credential from future activations of its service."""
        credentials, _dropin = self.paths(unit)
        target = credentials / credential_name(name)
        if not directory(self.root):
            return False
        with self.locked():
            if not directory(credentials.parent) or not directory(credentials):
                return False
            return self.remove_value(target)

    def remove_value(self, target):
        """Remove one exact credential under the management lock."""
        if not file_exists(target):
            return False
        target.unlink()
        sync_directory(target.parent)
        return True

    def website_login_directory(self, *, create=False):
        """Resolve the private root-owned directory for website-login records."""
        if not directory(self.root):
            raise VaultError('The Vault storage is unavailable.')
        path = self.root / WEBSITE_LOGIN_DIRECTORY
        if create:
            directory(path, create=True)
        return path

    def read_website_login(self, path, expected_id=None):
        """Read one public website-login record without decrypting its credential."""
        try:
            if not directory(self.root) or not directory(path.parent):
                raise VaultError('The website login record is unavailable.')
            if not file_exists(path):
                raise VaultError('The website login record changed. Refresh and try again.')
            with path.open('rb') as source:
                payload = source.read(WEBSITE_LOGIN_FILE_LIMIT + 1)
            data = json.loads(payload.decode('utf-8'), object_pairs_hook=exact_object)
            credential = data.get('credential') if type(data) is dict else None
            if (len(payload) > WEBSITE_LOGIN_FILE_LIMIT or type(data) is not dict
                    or set(data) != {'id', 'origin', 'label', 'credential'}
                    or not valid_login_id(data.get('id'))
                    or (expected_id is not None and data['id'] != expected_id)
                    or not valid_login_origin(data.get('origin'))
                    or type(data.get('label')) is not str
                    or login_text(data['label'], WEBSITE_LOGIN_LABEL_LIMIT) != data['label']
                    or type(credential) is not str):
                raise VaultError('The website login record is invalid.')
            encoded = credential.encode('ascii')
            cipher = base64.b64decode(encoded, validate=True)
            if not cipher or base64.b64encode(cipher) != encoded:
                raise VaultError('The website login record is invalid.')
            return {
                'id': data['id'], 'origin': data['origin'], 'label': data['label'], 'credential': credential,
            }
        except VaultError:
            raise
        except (OSError, UnicodeError, ValueError, RecursionError):
            raise VaultError('The website login record is invalid.') from None

    def website_login_records(self):
        """List bounded public website-login metadata without exposing credentials."""
        path = self.website_login_directory()
        if not directory(path):
            return []
        entries = list(path.iterdir())
        if len(entries) > WEBSITE_LOGIN_LIMIT:
            raise VaultError('The Vault has too many website login records.')
        records = []
        for entry in entries:
            if not valid_login_id(entry.name):
                raise VaultError('The website login record is invalid.')
            records.append(self.read_website_login(entry, entry.name))
        return sorted(records, key=lambda record: record['id'])

    def website_login_cipher(self, login_id, username, password):
        """Encrypt exact website-login values under a credential name bound to its id."""
        try:
            value = json.dumps(
                {'username': username, 'password': password}, ensure_ascii=False, separators=(',', ':'),
            ).encode('utf-8')
        except (UnicodeError, TypeError, ValueError):
            raise VaultError('The website login could not be encrypted.') from None
        encrypted = self.command(
            [
                '/usr/bin/systemd-creds', '--with-key=host',
                f'--name={PREFIX}_website_login_{login_id}', 'encrypt', '-', '-',
            ],
            'The website login could not be encrypted.', input=value, stdout=subprocess.PIPE,
        )
        try:
            cipher = base64.b64decode(b''.join(encrypted.split()), validate=True)
        except (AttributeError, ValueError):
            raise VaultError('Systemd returned an invalid encrypted website login.') from None
        if not cipher:
            raise VaultError('Systemd returned an empty encrypted website login.')
        return base64.b64encode(cipher).decode('ascii')

    def _website_login_values(self, payload):
        """Validate decrypted v1 values for the synchronous browser callback."""
        if type(payload) is not bytes or len(payload) > WEBSITE_LOGIN_FILE_LIMIT:
            raise VaultError(WEBSITE_LOGIN_UNAVAILABLE)
        try:
            data = json.loads(payload.decode('utf-8'), object_pairs_hook=exact_object)
            if type(data) is not dict or set(data) != {'username', 'password'}:
                raise VaultError(WEBSITE_LOGIN_UNAVAILABLE)
            username = login_text(data.get('username'), WEBSITE_LOGIN_USERNAME_LIMIT)
            password = login_text(data.get('password'), WEBSITE_LOGIN_PASSWORD_LIMIT)
            return username, password
        except VaultError:
            raise VaultError(WEBSITE_LOGIN_UNAVAILABLE) from None
        except (UnicodeError, ValueError, RecursionError, TypeError):
            raise VaultError(WEBSITE_LOGIN_UNAVAILABLE) from None

    def _use_website_login_locked(self, login_id, origin, deliver):
        """Decrypt and deliver one login while the caller owns the Vault lock."""
        path = self.website_login_directory()
        record = self.read_website_login(path / login_id, login_id)
        if record['origin'] != origin:
            raise VaultError(WEBSITE_LOGIN_UNAVAILABLE)
        decrypted = self.command(
            [
                '/usr/bin/systemd-creds', '--with-key=host',
                f'--name={PREFIX}_website_login_{login_id}', 'decrypt', '-', '-',
            ],
            WEBSITE_LOGIN_UNAVAILABLE,
            input=record['credential'].encode('ascii'), stdout=subprocess.PIPE,
        )
        username, password = self._website_login_values(decrypted)
        try:
            return deliver(username, password)
        except Exception:
            raise VaultError(WEBSITE_LOGIN_UNAVAILABLE) from None

    def use_website_login(self, login_id, origin, deliver):
        """Deliver a v1 login to an authorized browser callback under the Vault lock.

        The caller authenticates the browser and approves its exact login action.
        The callback must finish within the caller's deadline.
        """
        if not valid_login_id(login_id) or not valid_login_origin(origin) or not callable(deliver):
            raise VaultError(WEBSITE_LOGIN_UNAVAILABLE)
        try:
            with self.locked():
                self._use_website_login_locked(login_id, origin, deliver)
        except VaultError:
            raise VaultError(WEBSITE_LOGIN_UNAVAILABLE) from None
        except (AttributeError, OSError, OverflowError, TypeError, ValueError, RecursionError):
            raise VaultError(WEBSITE_LOGIN_UNAVAILABLE) from None

    def new_website_login_id(self, path):
        """Allocate a lower-case opaque id that is absent from the login directory."""
        for _attempt in range(32):
            login_id = secrets.token_hex(16)
            if not valid_login_id(login_id):
                continue
            if not file_exists(path / login_id):
                return login_id
        raise VaultError('The Vault could not allocate a website login id.')

    def write_website_login(self, path, record, username, password, action=None):
        """Encrypt and atomically commit one website-login record after stale checks."""
        target = path / record['id']
        exists = file_exists(target)
        if (action == 'add' and exists) or (action == 'replace' and not exists):
            raise VaultError('The website login changed. Refresh and try again.')
        credential = self.website_login_cipher(record['id'], username, password)
        payload = (json.dumps(
            {**record, 'credential': credential}, ensure_ascii=False, separators=(',', ':')
        ) + '\n').encode('utf-8')
        replace_file(target, payload, path, 0o600)

    def add_website_login(self, request):
        """Encrypt and add one owner-authorized website-login record."""
        path = self.website_login_directory(create=True)
        if len(self.website_login_records()) >= WEBSITE_LOGIN_LIMIT:
            raise VaultError('The Vault has too many website login records.')
        login_id = self.new_website_login_id(path)
        self.write_website_login(
            path,
            {'id': login_id, 'origin': request['origin'], 'label': request['label']},
            request['username'], request['password'], 'add',
        )

    def replace_website_login(self, request):
        """Encrypt and replace one existing owner-authorized website-login record."""
        path = self.website_login_directory()
        record = self.read_website_login(path / request['id'], request['id'])
        self.write_website_login(
            path,
            {'id': record['id'], 'origin': record['origin'], 'label': request['label']},
            request['username'], request['password'], 'replace',
        )

    def remove_website_login(self, request):
        """Remove one existing website-login record without decrypting its credential."""
        path = self.website_login_directory()
        self.read_website_login(path / request['id'], request['id'])
        if not self.remove_value(path / request['id']):
            raise VaultError('The website login changed. Refresh and try again.')

    def allow_desktop(self, owner_uid, cloud_uid, units, *, start=False):
        """Authorize one SSH owner for an explicit list of enabled services."""
        if owner_uid <= 0 or cloud_uid <= 0 or owner_uid == cloud_uid:
            raise VaultError('Desktop Vault needs an SSH owner account separate from Cloud.')
        units = sorted(set(units))
        if len(units) > DESKTOP_SERVICE_LIMIT:
            raise VaultError('Select at most 16 services for Desktop Vault.')
        if not directory(self.root, create=not units):
            raise VaultError('Enable the Vault for each selected service first.')
        with self.locked():
            for unit in units:
                self.enabled_credentials(unit, cloud_uid)
            policy = self.root / 'desktop.json'
            previous = policy.read_bytes() if file_exists(policy) else None
            if previous is not None:
                self.desktop_policy(owner_uid)
            self.write_request_records([])
            prepared = self.prepare_desktop(owner_uid) if start else None
            data = {'owner': owner_uid, 'cloud': cloud_uid, 'services': units}
            try:
                replace_file(policy, (json.dumps(data) + '\n').encode(), self.root, 0o600)
                if prepared is not None:
                    self.activate_desktop(prepared)
            except (VaultError, OSError, KeyboardInterrupt):
                if previous is None:
                    self.remove_value(policy)
                    if prepared is not None:
                        self.stop_desktop()
                else:
                    replace_file(policy, previous, self.root, 0o600)
                raise

    def desktop_units(self, owner_uid):
        """Resolve the exact managed systemd files for a Desktop Vault listener."""
        return {
            self.units / DESKTOP_LISTENER: desktop_socket_unit(owner_uid),
            self.units / DESKTOP_WORKER: desktop_worker_unit(),
        }

    def cloud_units(self, cloud_uid):
        """Resolve the exact managed systemd files for the Cloud broker."""
        return {
            self.units / CLOUD_LISTENER: cloud_socket_unit(cloud_uid),
            self.units / CLOUD_WORKER: cloud_worker_unit(),
        }

    def prepare_desktop(self, owner_uid):
        """Check both unit destinations before changing the authorization policy."""
        trusted_file(INSTALLED_VAULT)
        if not directory(self.units, private=False):
            raise VaultError('The system service configuration directory is unavailable.')
        units = self.desktop_units(owner_uid)
        for path, expected in units.items():
            if file_exists(path, private=False) and path.read_bytes() != expected:
                raise VaultError('Different Vault management units already exist. Review them before setup.')
        return units

    def activate_desktop(self, units):
        """Install and start the listener after its owner policy is durable."""
        for path, expected in units.items():
            if not path.exists():
                replace_file(path, expected, self.units, 0o644)
        for args in (['daemon-reload'], ['enable', '--now', '--', DESKTOP_LISTENER]):
            self.command([*SYSTEMCTL, *args], 'Could not enable the Desktop Vault socket.', stdout=subprocess.DEVNULL)

    def prepare_cloud_requests(self, cloud_uid):
        """Check both broker unit destinations before enabling the root listener."""
        trusted_file(INSTALLED_VAULT)
        if not directory(self.units, private=False):
            raise VaultError('The system service configuration directory is unavailable.')
        units = self.cloud_units(cloud_uid)
        for path, expected in units.items():
            if file_exists(path, private=False) and path.read_bytes() != expected:
                raise VaultError('Different Cloud Vault request units already exist. Review them before setup.')
        return units

    def activate_cloud_requests(self, units):
        """Install and start the root broker after its policy is durable."""
        for path, expected in units.items():
            if not path.exists():
                replace_file(path, expected, self.units, 0o644)
        for args in (['daemon-reload'], ['enable', '--now', '--', CLOUD_LISTENER]):
            self.command([*SYSTEMCTL, *args], 'Could not enable the Cloud Vault request socket.', stdout=subprocess.DEVNULL)

    def enable_requests(self, grants, *, start=False):
        """Enable the root broker using the current Desktop policy's Cloud UID."""
        if not directory(self.root):
            raise VaultError('Enable Desktop Vault access before enabling Cloud requests.')
        with self.locked():
            policy = self.root_policy()
            marker = self.root / CLOUD_REQUESTS_ENABLED
            if not 0 < len(grants) <= REQUEST_RECORD_LIMIT:
                raise VaultError('Select 1 to 64 exact Cloud Vault request grants.')
            for unit, name in grants:
                if unit not in policy['services'] or not NAME.fullmatch(name):
                    raise VaultError('Every request grant needs a key name and a service enabled for Desktop Vault.')
                self.enabled_credentials(unit, policy['cloud'])
            configured = {'cloud': policy['cloud'], 'grants': sorted(set(grants))}
            payload = (json.dumps(configured, separators=(',', ':')) + '\n').encode()
            previous = marker.read_bytes() if file_exists(marker) else None
            prepared = self.prepare_cloud_requests(policy['cloud']) if start else None
            created = set() if prepared is None else {path for path in prepared if not path.exists()}
            try:
                if prepared is not None:
                    self.activate_cloud_requests(prepared)
                if previous != payload:
                    self.write_request_records([])
                    replace_file(marker, payload, self.root, 0o600)
            except (VaultError, OSError, KeyboardInterrupt):
                if any(path.exists() for path in created):
                    self.stop_cloud_requests()
                raise

    def stop_cloud_requests(self):
        """Stop and remove only Vault's exact generated Cloud broker units."""
        if not directory(self.units, private=False):
            raise VaultError('The system service configuration directory is unavailable.')
        listener = self.units / CLOUD_LISTENER
        worker = self.units / CLOUD_WORKER
        paths = []
        listener_present = file_exists(listener, private=False)
        worker_present = file_exists(worker, private=False)
        if listener_present:
            content = listener.read_bytes()
            cloud = re.search(rb'^SocketUser=([1-9][0-9]{0,9})$', content, re.MULTILINE)
            if cloud is None or content != cloud_socket_unit(int(cloud[1])):
                raise VaultError('A different Cloud Vault request socket exists. Review it before removal.')
            paths.append(listener)
        if worker_present:
            if worker.read_bytes() != cloud_worker_unit():
                raise VaultError('A different Cloud Vault request worker exists. Review it before removal.')
            paths.append(worker)
        if listener_present:
            self.command([*SYSTEMCTL, 'disable', '--now', '--', CLOUD_LISTENER],
                         'Could not stop the Cloud Vault request socket.', stdout=subprocess.DEVNULL)
        for path in paths:
            path.unlink()
        if paths:
            sync_directory(self.units)
            self.command([*SYSTEMCTL, 'daemon-reload'], 'Could not reload after disabling Cloud Vault requests.',
                         stdout=subprocess.DEVNULL)

    def disable_requests(self):
        """Disable and remove only the generated root broker units."""
        if directory(self.root):
            with self.locked():
                self.remove_value(self.root / CLOUD_REQUESTS_ENABLED)
                self.write_request_records([])
                self.stop_cloud_requests()

    def stop_desktop(self):
        """Stop and remove only Vault's generated systemd socket and worker."""
        if not directory(self.units, private=False):
            raise VaultError('The system service configuration directory is unavailable.')
        listener = self.units / DESKTOP_LISTENER
        worker = self.units / DESKTOP_WORKER
        paths = []
        if file_exists(listener, private=False):
            content = listener.read_bytes()
            owner = re.search(rb'^SocketUser=([1-9][0-9]{0,9})$', content, re.MULTILINE)
            if owner is None or content != desktop_socket_unit(int(owner[1])):
                raise VaultError('A different Vault management socket exists. Review it before removal.')
            self.command([*SYSTEMCTL, 'disable', '--now', '--', DESKTOP_LISTENER],
                         'Could not stop the Desktop Vault socket.', stdout=subprocess.DEVNULL)
            paths.append(listener)
        if file_exists(worker, private=False):
            if worker.read_bytes() != desktop_worker_unit():
                raise VaultError('A different Vault management worker exists. Review it before removal.')
            paths.append(worker)
        for path in paths:
            path.unlink()
        if paths:
            sync_directory(self.units)
            self.command([*SYSTEMCTL, 'daemon-reload'], 'Could not reload after disabling Desktop Vault.',
                         stdout=subprocess.DEVNULL)

    def deny_desktop(self):
        """Revoke the SSH owner's policy and disable the managed socket."""
        if directory(self.root):
            with self.locked():
                self.remove_value(self.root / 'desktop.json')
                self.remove_value(self.root / CLOUD_REQUESTS_ENABLED)
                self.write_request_records([])
                self.stop_cloud_requests()
                self.stop_desktop()

    def root_policy(self):
        """Resolve the current root-owned Desktop and Cloud authorization."""
        denied = 'Desktop Vault access is unavailable for this SSH account.'
        policy = self.root / 'desktop.json'
        if not file_exists(policy):
            raise VaultError(denied)
        try:
            with policy.open('rb') as source:
                payload = source.read(DESKTOP_REQUEST_LIMIT + 1)
            data = json.loads(payload.decode('utf-8'), object_pairs_hook=exact_object)
            services = data.get('services') if type(data) is dict else None
            if (len(payload) > DESKTOP_REQUEST_LIMIT or type(data) is not dict
                    or set(data) != {'owner', 'cloud', 'services'}
                    or type(data.get('owner')) is not int or data['owner'] <= 0
                    or type(data.get('cloud')) is not int or data['cloud'] <= 0
                    or data['owner'] == data['cloud']
                    or type(services) is not list or len(services) > DESKTOP_SERVICE_LIMIT
                    or any(not valid_unit(unit) for unit in services)
                    or len(set(services)) != len(services)):
                raise VaultError(denied)
            return data
        except (OSError, UnicodeError, ValueError, RecursionError):
            raise VaultError(denied) from None

    def desktop_policy(self, requester_uid):
        """Require the current root policy to authorize one Desktop owner."""
        data = self.root_policy()
        if data['owner'] != requester_uid:
            raise VaultError('Desktop Vault access is unavailable for this SSH account.')
        return data

    def request_file(self):
        """Resolve the root-owned metadata file for Cloud credential requests."""
        return self.root / CLOUD_REQUESTS_FILE

    def require_requests(self, policy):
        """Resolve the root-approved exact service and key grants for the current Cloud account."""
        marker = self.root / CLOUD_REQUESTS_ENABLED
        if not file_exists(marker):
            raise VaultError(REQUEST_UNAVAILABLE)
        try:
            with marker.open('rb') as source:
                payload = source.read(DESKTOP_REQUEST_LIMIT + 1)
            data = json.loads(payload.decode('utf-8'), object_pairs_hook=exact_object)
            if (len(payload) > DESKTOP_REQUEST_LIMIT or type(data) is not dict or set(data) != {'cloud', 'grants'}
                    or type(data['cloud']) is not int or data['cloud'] != policy['cloud']
                    or type(data['grants']) is not list or not 0 < len(data['grants']) <= REQUEST_RECORD_LIMIT
                    or any(type(grant) is not list or len(grant) != 2 or not valid_unit(grant[0])
                           or type(grant[1]) is not str or not NAME.fullmatch(grant[1]) for grant in data['grants'])):
                raise VaultError(REQUEST_UNAVAILABLE)
            return set(map(tuple, data['grants']))
        except (OSError, UnicodeError, ValueError, RecursionError):
            raise VaultError(REQUEST_UNAVAILABLE) from None

    def read_request_records(self):
        """Read and validate bounded, boot-scoped request metadata."""
        path = self.request_file()
        if not file_exists(path):
            return []
        try:
            payload = path.read_bytes()
            data = json.loads(payload.decode('utf-8'), object_pairs_hook=exact_object)
            records = data.get('requests') if type(data) is dict else None
            if (len(payload) > DESKTOP_REQUEST_LIMIT or type(data) is not dict
                    or set(data) != {'boot', 'requests'}):
                raise VaultError(REQUEST_UNAVAILABLE)
            if data.get('boot') != self.boot_id:
                return []
            if (type(records) is not list or len(records) > REQUEST_RECORD_LIMIT):
                raise VaultError(REQUEST_UNAVAILABLE)
            checked = []
            fields = {'id', 'unit', 'name', 'state', 'created', 'lease'}
            for record in records:
                if type(record) is not dict or set(record) != fields:
                    raise VaultError(REQUEST_UNAVAILABLE)
                created = record.get('created')
                lease = record.get('lease')
                if (not valid_request_id(record.get('id')) or not valid_unit(record.get('unit'))
                        or type(record.get('name')) is not str or not NAME.fullmatch(record['name'])
                        or record.get('state') not in ('pending', 'saved', 'cancelled')
                        or type(created) not in (int, float) or type(lease) not in (int, float)
                        or not math.isfinite(created) or not math.isfinite(lease)
                        or created < 0 or lease < created):
                    raise VaultError(REQUEST_UNAVAILABLE)
                checked.append(record)
            if len({record['id'] for record in checked}) != len(checked):
                raise VaultError(REQUEST_UNAVAILABLE)
            return checked
        except (OSError, OverflowError, UnicodeError, ValueError, RecursionError):
            raise VaultError(REQUEST_UNAVAILABLE) from None

    def write_request_records(self, records):
        """Persist only bounded request metadata, never credential values."""
        if not records:
            self.remove_value(self.request_file())
            return
        replace_file(
            self.request_file(),
            (json.dumps({'boot': self.boot_id, 'requests': records}, separators=(',', ':')) + '\n').encode(),
            self.root,
            0o600,
        )

    def clean_request_records(self, records):
        """Discard metadata older than the fixed request lifetime."""
        now = self.clock()
        changed = False
        kept = []
        for record in records:
            if now - record['created'] >= REQUEST_TTL:
                changed = True
                continue
            kept.append(record)
        return kept, changed

    def request_record(self, records, request_id):
        """Find one request by its opaque id without exposing unrelated metadata."""
        return next((record for record in records if record['id'] == request_id), None)

    def request_credentials(self, policy, grants, unit, name):
        """Revalidate one request against the live root service allowlist."""
        if unit not in policy['services'] or (unit, name) not in grants:
            raise VaultError(REQUEST_UNAVAILABLE)
        try:
            return self.enabled_credentials(unit, policy['cloud'])
        except VaultError:
            raise VaultError(REQUEST_UNAVAILABLE) from None

    def observe_request(self, record, credentials):
        """Count an existing encrypted key as a receipt without reading its value."""
        if record['state'] == 'pending' and file_exists(credentials / record['name']):
            record['state'] = 'saved'
            return True
        return False

    def request_reply(self, record):
        """Render the owner-visible request metadata without a secret value."""
        return {'request': {key: record[key] for key in ('id', 'unit', 'name', 'state')}}

    def _browser_login_metadata(self, request_id):
        """Reinspect one pending browser request over the fixed root-only socket."""
        payload = json.dumps({'action': 'inspect-login', 'id': request_id}, separators=(',', ':')).encode('ascii')
        return browser_login_inspection(browser_client(payload), request_id)

    def _browser_login_views(self, origin):
        """List saved login metadata and encrypted-record generations for one origin."""
        return [
            {'id': record['id'], 'label': record['label'], 'generation': website_login_generation(record)}
            for record in self.website_login_records() if record['origin'] == origin
        ]

    def _inspect_browser_login(self, request):
        """Return pending browser metadata and matching owner-visible login choices."""
        inspected = self._browser_login_metadata(request['id'])
        return {'request': {
            'id': inspected['id'], 'origin': inspected['origin'], 'destination': inspected['destination'],
            'logins': self._browser_login_views(inspected['origin']),
        }}

    def _approve_browser_login(self, request):
        """Deliver an owner-selected login while policy, generation, and delivery share one lock."""
        try:
            inspected = self._browser_login_metadata(request['id'])
            records = self.website_login_records()
            record = next((candidate for candidate in records
                           if candidate['id'] == request['loginId'] and candidate['origin'] == inspected['origin']), None)
            if record is None or website_login_generation(record) != request['generation']:
                return {'state': 'unavailable'}
            result = {}

            def deliver(username, password):
                payload = json.dumps({
                    'action': 'use-login', 'id': inspected['id'], 'origin': inspected['origin'],
                    'username': username, 'password': password,
                }, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
                result.update(browser_login_state(browser_client(payload)))

            self._use_website_login_locked(record['id'], inspected['origin'], deliver)
            return result if result else {'state': 'unavailable'}
        except (AttributeError, VaultError, OSError, OverflowError, TypeError, ValueError, UnicodeError, RecursionError):
            return {'state': 'unavailable'}

    def _decline_browser_login(self, request):
        """Release one pending browser request without returning browser diagnostics."""
        try:
            payload = json.dumps({'action': 'cancel-login', 'id': request['id']}, separators=(',', ':')).encode('ascii')
            browser_client(payload)
        except Exception:
            pass
        return {'state': 'unavailable'}

    def desktop(self, request, requester_uid):
        """Apply a validated Desktop request and return metadata or an acknowledgment."""
        if not directory(self.root):
            raise VaultError('Desktop Vault access is unavailable for this SSH account.')
        with self.locked():
            policy = self.desktop_policy(requester_uid)
            action = request['action']
            if action in ('list-logins', 'add-login', 'replace-login', 'remove-login'):
                request = website_login_request(request)
                if action == 'list-logins':
                    return {'logins': [
                        {key: record[key] for key in ('id', 'origin', 'label')}
                        for record in self.website_login_records()
                    ]}
                if action == 'add-login':
                    self.add_website_login(request)
                elif action == 'replace-login':
                    self.replace_website_login(request)
                else:
                    self.remove_website_login(request)
                return {'ok': True}
            if action == 'inspect-login-use':
                return self._inspect_browser_login(request)
            if action == 'approve-login-use':
                return self._approve_browser_login(request)
            if action == 'decline-login-use':
                return self._decline_browser_login(request)
            if action in ('inspect-request', 'save-request', 'dismiss-request'):
                grants = self.require_requests(policy)
                records, changed = self.clean_request_records(self.read_request_records())
                record = self.request_record(records, request['id'])
                if record is None:
                    raise VaultError(REQUEST_UNAVAILABLE)
                credentials = self.request_credentials(policy, grants, record['unit'], record['name'])
                changed = self.observe_request(record, credentials) or changed
                now = self.clock()
                if action == 'inspect-request':
                    if record['state'] == 'pending' and now >= record['lease']:
                        record['state'] = 'cancelled'
                        changed = True
                    if changed:
                        self.write_request_records(records)
                    return self.request_reply(record)
                if action == 'dismiss-request':
                    if record['state'] == 'pending':
                        record['state'] = 'cancelled'
                        changed = True
                    if changed:
                        self.write_request_records(records)
                    return {'state': record['state']}
                if not valid_secret(request['value'].encode()):
                    raise VaultError('Enter a non-empty credential of at most 8 KiB.')
                if record['state'] == 'saved':
                    if changed:
                        self.write_request_records(records)
                    return {'ok': True}
                if record['state'] != 'pending' or now >= record['lease']:
                    record['state'] = 'cancelled'
                    self.write_request_records(records)
                    raise VaultError(REQUEST_UNAVAILABLE)
                self.write_value(credentials, record['name'], request['value'].encode(), 'add')
                record['state'] = 'saved'
                self.write_request_records(records)
                return {'ok': True}
            if action == 'list':
                services = []
                for unit in policy['services']:
                    names = self.credential_names(self.enabled_credentials(unit, policy['cloud']))
                    if len(names) > DESKTOP_NAME_LIMIT:
                        raise VaultError('This service has too many entries for Desktop Vault.')
                    services.append({'unit': unit, 'names': names})
                return {'services': services}
            unit = request['unit']
            if unit not in policy['services']:
                raise VaultError('This service is not enabled for Desktop Vault.')
            credentials = self.enabled_credentials(unit, policy['cloud'])
            if action == 'revoke':
                self.remove_value(credentials / request['name'])
            else:
                if action == 'add' and len(self.credential_names(credentials)) >= DESKTOP_NAME_LIMIT:
                    raise VaultError('This service has too many entries for Desktop Vault.')
                self.write_value(credentials, request['name'], request['value'].encode(), action)
            return {'ok': True}

    def cloud(self, request, requester_uid):
        """Create or settle one Cloud request after peer and policy validation."""
        if not directory(self.root):
            raise VaultError(REQUEST_UNAVAILABLE)
        with self.locked():
            try:
                policy = self.root_policy()
                if requester_uid != policy['cloud']:
                    raise VaultError(REQUEST_UNAVAILABLE)
                if request.get('action') not in ('create', 'status', 'cancel'):
                    raise VaultError(REQUEST_UNAVAILABLE)
                grants = self.require_requests(policy)
                records, changed = self.clean_request_records(self.read_request_records())
                action = request['action']
                if action == 'create':
                    credentials = self.request_credentials(policy, grants, request['unit'], request['name'])
                    record = self.request_record(records, request['id'])
                    if record is not None:
                        if record['unit'] != request['unit'] or record['name'] != request['name']:
                            raise VaultError(REQUEST_UNAVAILABLE)
                        changed = self.observe_request(record, credentials) or changed
                        if record['state'] == 'pending' and self.clock() >= record['lease']:
                            record['state'] = 'cancelled'
                            changed = True
                    else:
                        if len(records) >= REQUEST_RECORD_LIMIT:
                            raise VaultError('The Vault request queue is full.')
                        now = self.clock()
                        record = {
                            'id': request['id'],
                            'unit': request['unit'],
                            'name': request['name'],
                            'state': 'saved' if file_exists(credentials / request['name']) else 'pending',
                            'created': now,
                            'lease': now + REQUEST_LEASE,
                        }
                        records.append(record)
                        changed = True
                    if changed:
                        self.write_request_records(records)
                    return {'state': record['state']}

                record = self.request_record(records, request['id'])
                if record is None:
                    raise VaultError(REQUEST_UNAVAILABLE)
                credentials = self.request_credentials(policy, grants, record['unit'], record['name'])
                changed = self.observe_request(record, credentials) or changed
                if action == 'status' and record['state'] == 'pending':
                    now = self.clock()
                    if now >= record['lease']:
                        record['state'] = 'cancelled'
                        changed = True
                    elif record['lease'] - now <= REQUEST_LEASE / 2:
                        record['lease'] = now + REQUEST_LEASE
                        changed = True
                elif action == 'cancel' and record['state'] == 'pending':
                    record['state'] = 'cancelled'
                    changed = True
                if changed:
                    self.write_request_records(records)
                return {'state': record['state']}
            except VaultError:
                raise
            except (OSError, OverflowError, TypeError, ValueError):
                raise VaultError(REQUEST_UNAVAILABLE) from None


def user_uid(explicit):
    """Resolve an explicitly selected Linux account."""
    if explicit is None:
        raise VaultError('Supply --cloud-user with the Linux account that runs Y Harness Cloud.')
    try:
        return pwd.getpwnam(explicit).pw_uid
    except KeyError:
        raise VaultError('The specified Linux account was not found.') from None


def prompt_secret():
    """Read one line from a terminal where password echo can be disabled."""
    try:
        with warnings.catch_warnings():
            warnings.simplefilter('error', getpass.GetPassWarning)
            return getpass.getpass('Credential value: ').encode()
    except (EOFError, getpass.GetPassWarning, OSError, UnicodeError):
        raise VaultError('Open an interactive terminal to enter the credential privately.') from None


def main():
    """Run the administrator's write-only Vault commands."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cloud-user', help='Linux user running Cloud, required for enable, set and allow-desktop')
    actions = parser.add_subparsers(dest='action', required=True)
    for action in ('enable', 'set', 'list', 'revoke'):
        command = actions.add_parser(action)
        command.add_argument('unit', help='exact systemd system service')
        if action in ('set', 'revoke'):
            command.add_argument('name', help='credential name such as EXAMPLE_API_KEY')
    allow = actions.add_parser('allow-desktop')
    allow.add_argument('--owner', required=True, help='SSH account used by Y Harness Desktop')
    allow.add_argument('units', nargs='*', help='exact enabled services that Desktop may manage')
    actions.add_parser('deny-desktop')
    enable_requests = actions.add_parser('enable-requests', help='enable the root Cloud request broker')
    enable_requests.add_argument('grants', metavar='UNIT.service=KEY_NAME', nargs='+', type=request_grant)
    actions.add_parser('disable-requests', help='disable the root Cloud request broker')
    actions.add_parser('desktop-client', help='forward one Desktop request to the local Vault socket')
    actions.add_parser('desktop-worker', help=argparse.SUPPRESS)
    actions.add_parser('cloud-request-worker', help=argparse.SUPPRESS)
    args = parser.parse_args()
    try:
        if sys.platform != 'linux':
            raise VaultError('Run the Vault on the Linux VPS.')
        if args.action == 'desktop-client':
            if os.geteuid() == 0:
                raise VaultError('Use your regular SSH account for Desktop Vault.')
            sys.stdout.buffer.write(desktop_client(desktop_body(sys.stdin.buffer)))
            return
        if os.geteuid() != 0:
            raise VaultError('Run the Vault as an administrator on the Linux VPS.')
        os.umask(0o077)
        vault = Vault()
        if args.action == 'desktop-worker':
            with socket.fromfd(0, socket.AF_UNIX, socket.SOCK_STREAM) as connection:
                desktop_worker(vault, connection)
        elif args.action == 'cloud-request-worker':
            with socket.fromfd(0, socket.AF_UNIX, socket.SOCK_STREAM) as connection:
                cloud_worker(vault, connection)
        elif args.action == 'allow-desktop':
            owner_uid = user_uid(args.owner)
            vault.allow_desktop(owner_uid, user_uid(args.cloud_user), args.units, start=True)
            print('Desktop Vault access enabled.')
        elif args.action == 'deny-desktop':
            vault.deny_desktop()
            print('Desktop Vault access removed.')
        elif args.action == 'enable-requests':
            vault.enable_requests(args.grants, start=True)
            print('Cloud Vault request broker enabled.')
        elif args.action == 'disable-requests':
            vault.disable_requests()
            print('Cloud Vault request broker disabled.')
        elif args.action == 'enable':
            vault.enable(args.unit, user_uid(args.cloud_user))
            print(f'Vault enabled for {args.unit}.')
        elif args.action == 'set':
            uid = user_uid(args.cloud_user)
            vault.save(args.unit, args.name, prompt_secret(), uid)
            print(f'{args.name} saved for the next start of {args.unit}.')
        elif args.action == 'list':
            for name in vault.names(args.unit):
                print(name)
        elif vault.revoke(args.unit, args.name):
            print(f'{args.name} revoked for future starts of {args.unit}.')
        else:
            print(f'{args.name} is already absent from {args.unit}.')
    except VaultError as error:
        parser.exit(1, f'Vault: {error}\n')
    except OSError:
        parser.exit(1, 'Vault: could not access its private storage or service configuration.\n')
    except KeyboardInterrupt:
        parser.exit(130, '\nVault: cancelled.\n')


if __name__ == '__main__':
    main()
