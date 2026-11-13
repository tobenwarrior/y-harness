#!/usr/bin/python3 -I
"""Manage write-only, encrypted credentials for dedicated Linux services."""

import argparse
import base64
import fcntl
import getpass
import json
import os
import pwd
import re
import socket
import stat
import struct
import subprocess
import sys
import tempfile
import warnings
from contextlib import contextmanager
from pathlib import Path


ROOT = Path('/var/lib/yharness-vault')
UNITS = Path('/etc/systemd/system')
DROPIN = '90-yharness-vault.conf'
PREFIX = 'yharness'
UNIT = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.:@-]{0,220}\.service')
NAME = re.compile(r'[A-Za-z_][A-Za-z0-9_]{0,63}')
USER = re.compile(r'[A-Za-z_][A-Za-z0-9_-]{0,30}')
SECRET_LIMIT = 8192
DESKTOP_REQUEST_LIMIT = 64 * 1024
DESKTOP_SERVICE_LIMIT = 16
DESKTOP_NAME_LIMIT = 100
DESKTOP_RESPONSE_LIMIT = 160 * 1024
DESKTOP_SOCKET = Path('/run/yharness-vault/desktop.sock')
DESKTOP_LISTENER = 'yharness-vault-desktop.socket'
DESKTOP_WORKER = 'yharness-vault-desktop@.service'
INSTALLED_VAULT = Path('/usr/local/sbin/yharness-vault')
SYSTEMCTL = ['/usr/bin/systemctl', '--system', '--no-pager', '--no-ask-password']
COMMAND_ENV = {'PATH': '/usr/bin:/bin', 'LC_ALL': 'C'}


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


def valid_unit(unit):
    """Accept an exact system service, including instances of templates."""
    return type(unit) is str and UNIT.fullmatch(unit) is not None and not unit.endswith('@.service')


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
        fields = {'action', 'unit', 'name'}
        if action in ('add', 'replace'):
            fields.add('value')
            value = request.get('value')
            if type(value) is not str or not valid_secret(value.encode()):
                raise VaultError('Enter a non-empty credential of at most 8 KiB.')
        elif action != 'revoke':
            raise VaultError('Invalid Vault request.')
        if (set(request) != fields or not valid_unit(request['unit'])
                or type(request['name']) is not str or not NAME.fullmatch(request['name'])):
            raise VaultError('Invalid Vault request.')
        return request
    except (ValueError, RecursionError):
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


def desktop_worker(vault, connection):
    """Check the peer and handle one request without logging or returning secret values."""
    uid = desktop_peer(connection)
    connection.settimeout(15)
    with connection.makefile('rb') as request:
        payload = desktop_body(request)
    answer = vault.desktop(desktop_request(payload), uid)
    connection.sendall((json.dumps(answer) + '\n').encode())


class Vault:
    """Owner-only encrypted storage for exact systemd service names."""

    def __init__(self, root=ROOT, units=UNITS, run=subprocess.run):
        self.root = root
        self.units = units
        self.run = run

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

    def allow_desktop(self, owner_uid, cloud_uid, units, *, start=False):
        """Authorize one distinct SSH account for already enabled services."""
        if owner_uid <= 0 or cloud_uid <= 0 or owner_uid == cloud_uid:
            raise VaultError('Desktop Vault needs an SSH owner account separate from Cloud.')
        units = sorted(set(units))
        if not 0 < len(units) <= DESKTOP_SERVICE_LIMIT:
            raise VaultError('Select between 1 and 16 services for Desktop Vault.')
        if not directory(self.root):
            raise VaultError('Enable the Vault for each selected service first.')
        with self.locked():
            for unit in units:
                self.enabled_credentials(unit, cloud_uid)
            policy = self.root / 'desktop.json'
            previous = policy.read_bytes() if file_exists(policy) else None
            if previous is not None:
                self.desktop_policy(owner_uid)
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
                self.stop_desktop()

    def desktop_policy(self, requester_uid):
        """Resolve the current, root-owned authorization while holding the Vault lock."""
        policy = self.root / 'desktop.json'
        denied = 'Desktop Vault access is unavailable for this SSH account.'
        if not file_exists(policy):
            raise VaultError(denied)
        with policy.open('rb') as source:
            payload = source.read(DESKTOP_REQUEST_LIMIT + 1)
        try:
            data = json.loads(payload.decode('utf-8'), object_pairs_hook=exact_object)
            if (len(payload) > DESKTOP_REQUEST_LIMIT or type(data) is not dict
                    or data.get('owner') != requester_uid or type(data.get('owner')) is not int
                    or type(data.get('cloud')) is not int or data['cloud'] <= 0
                    or requester_uid <= 0 or requester_uid == data['cloud']
                    or type(data.get('services')) is not list or not 0 < len(data['services']) <= DESKTOP_SERVICE_LIMIT
                    or any(not valid_unit(unit) for unit in data['services'])):
                raise VaultError(denied)
            return data
        except (ValueError, RecursionError):
            raise VaultError(denied) from None

    def desktop(self, request, requester_uid):
        """Apply a validated Desktop request and return metadata or an acknowledgment."""
        if not directory(self.root):
            raise VaultError('Desktop Vault access is unavailable for this SSH account.')
        with self.locked():
            policy = self.desktop_policy(requester_uid)
            action = request['action']
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
    allow.add_argument('units', nargs='+', help='enabled services that Desktop may manage')
    actions.add_parser('deny-desktop')
    actions.add_parser('desktop-client', help='forward one Desktop request to the local Vault socket')
    actions.add_parser('desktop-worker', help=argparse.SUPPRESS)
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
        elif args.action == 'allow-desktop':
            owner_uid = user_uid(args.owner)
            vault.allow_desktop(owner_uid, user_uid(args.cloud_user), args.units, start=True)
            print('Desktop Vault access enabled.')
        elif args.action == 'deny-desktop':
            vault.deny_desktop()
            print('Desktop Vault access removed.')
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
