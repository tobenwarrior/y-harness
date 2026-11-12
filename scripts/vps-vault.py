#!/usr/bin/python3 -I
"""Manage write-only, encrypted credentials for dedicated Linux services."""

import argparse
import base64
import fcntl
import getpass
import os
import pwd
import re
import stat
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
SYSTEMCTL = ['/usr/bin/systemctl', '--system', '--no-pager', '--no-ask-password']
COMMAND_ENV = {'PATH': '/usr/bin:/bin', 'LC_ALL': 'C'}


class VaultError(Exception):
    """Vault failure that can be displayed to the owner without a value."""


def directory(path, create=False, private=True):
    """Check an owner-controlled directory without following a symbolic link."""
    if create:
        path.mkdir(mode=0o700 if private else 0o755, exist_ok=True)
    try:
        info = path.lstat()
    except FileNotFoundError:
        return False
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & (0o077 if private else 0o022):
        raise VaultError('The Vault directory must be controlled by the administrator.')
    return True


def file_exists(path, private=True):
    """Admit an owner-controlled regular file with exactly one directory entry."""
    try:
        info = path.lstat()
    except FileNotFoundError:
        return False
    if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_nlink != 1
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


class Vault:
    """Owner-only encrypted storage for exact systemd service names."""

    def __init__(self, root=ROOT, units=UNITS, run=subprocess.run):
        self.root = root
        self.units = units
        self.run = run

    def paths(self, unit):
        """Resolve a service's credential directory and managed drop-in."""
        if not UNIT.fullmatch(unit) or unit.endswith('@.service'):
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
        credentials, dropin = self.paths(unit)
        target = credentials / credential_name(name)
        if not value or len(value) > SECRET_LIMIT or b'\0' in value:
            raise VaultError('Enter a non-empty credential of at most 8 KiB.')
        if not directory(self.root):
            raise VaultError('Enable the Vault for this service first.')
        with self.locked():
            fields = self.service(unit, cloud_uid)
            if (not directory(self.units, private=False) or not directory(dropin.parent, private=False)
                    or not file_exists(dropin, private=False) or dropin.read_bytes() != self.binding(credentials)
                    or str(dropin) not in fields.get('DropInPaths', '').split()
                    or not directory(credentials.parent) or not directory(credentials)):
                raise VaultError('Enable the Vault for this service first.')
            file_exists(target)
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

    def names(self, unit):
        """Return saved names for one scope without reading the encrypted files."""
        credentials, _dropin = self.paths(unit)
        if not directory(self.root):
            return []
        with self.locked():
            if not directory(credentials.parent) or not directory(credentials):
                return []
            return sorted(credential_name(path.name) for path in credentials.iterdir() if file_exists(path))

    def revoke(self, unit, name):
        """Remove the credential from future activations of its service."""
        credentials, _dropin = self.paths(unit)
        target = credentials / credential_name(name)
        if not directory(self.root):
            return False
        with self.locked():
            if not directory(credentials.parent) or not directory(credentials) or not file_exists(target):
                return False
            target.unlink()
            sync_directory(credentials)
            return True


def cloud_user_uid(explicit):
    """Resolve the Linux account that runs Cloud independently of the administrator."""
    if explicit is None:
        raise VaultError('Supply --cloud-user with the Linux account that runs Y Harness Cloud.')
    try:
        return pwd.getpwnam(explicit).pw_uid
    except KeyError:
        raise VaultError('The Y Harness Cloud account was not found.') from None


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
    parser.add_argument('--cloud-user', help='Linux user running Cloud, required for enable and set')
    actions = parser.add_subparsers(dest='action', required=True)
    for action in ('enable', 'set', 'list', 'revoke'):
        command = actions.add_parser(action)
        command.add_argument('unit', help='exact systemd system service')
        if action in ('set', 'revoke'):
            command.add_argument('name', help='credential name such as EXAMPLE_API_KEY')
    args = parser.parse_args()
    try:
        if sys.platform != 'linux' or os.geteuid() != 0:
            raise VaultError('Run the Vault as an administrator on the Linux VPS.')
        os.umask(0o077)
        vault = Vault()
        if args.action == 'enable':
            vault.enable(args.unit, cloud_user_uid(args.cloud_user))
            print(f'Vault enabled for {args.unit}.')
        elif args.action == 'set':
            uid = cloud_user_uid(args.cloud_user)
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
