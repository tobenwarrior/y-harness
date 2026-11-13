#!/usr/bin/python3 -I
"""Preserve an existing workspace path when Cloud moves to a dedicated Linux user."""

import argparse
import grp
import importlib.util
import os
import pwd
import re
import stat
import sys
from pathlib import Path


def account_installer():
    """Load the adjacent dedicated-account installer."""
    path = Path(__file__).resolve().with_name('setup-vps-account.py')
    spec = importlib.util.spec_from_file_location('yharness_setup_account', path)
    if spec is None or spec.loader is None:
        raise RuntimeError('The dedicated Cloud installer is missing.')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


account = account_installer()
AccountError = account.AccountError
command = account.command
install_unit = account.install_unit
SYSTEMCTL = account.SYSTEMCTL
LEGACY_DIR = '.yharness-vps'
SYSTEM_UNITS = Path('/etc/systemd/system')
MANAGER_CONFIG = '90-yharness-cloud-workspace.conf'
MAPPED_DATA = account.HOME.parent / 'yharness-cloud-data'
WORKSPACE_LAYERS = account.HOME.parent / 'yharness-cloud-layers'
HOME_PATH = re.compile(r'/home/[A-Za-z0-9_][A-Za-z0-9_.-]*')
MOUNT_NAME = re.compile(r'[A-Za-z0-9_\\.-]+\.mount')


def require_directory(path, uid, gid=None):
    """Require a directory with the expected owner and no group or public write access."""
    info = path.lstat()
    if (not stat.S_ISDIR(info.st_mode) or info.st_uid != uid
            or (gid is not None and info.st_gid != gid) or info.st_mode & 0o022):
        raise AccountError('A Cloud or source directory has unexpected ownership or permissions.')
    return info


def source_home(owner, cloud):
    """Resolve distinct identities and one ordinary home without unit syntax."""
    if (owner.pw_uid <= 0 or owner.pw_gid <= 0 or cloud.pw_uid <= 0 or cloud.pw_gid <= 0
            or owner.pw_uid == cloud.pw_uid or owner.pw_gid == cloud.pw_gid
            or not HOME_PATH.fullmatch(owner.pw_dir)):
        raise AccountError('Use a separate SSH owner with a regular /home directory and dedicated group.')
    return Path(owner.pw_dir)


def workspace_units(owner, cloud, data, layers, name, lower_name):
    """Render the read-only source, writable overlay, and private home view."""
    home = source_home(owner, cloud)
    if (any(not account.SAFE_PATH.fullmatch(str(path)) or '..' in path.parts
            or path.is_relative_to(home) or home.is_relative_to(path) for path in (data, layers))
            or data.is_relative_to(layers) or layers.is_relative_to(data)
            or not all(MOUNT_NAME.fullmatch(unit) for unit in (name, lower_name)) or name == lower_name):
        raise AccountError('The Cloud workspace mapping paths are invalid.')
    legacy = home / LEGACY_DIR
    options = (f'bind,ro,nosuid,nodev,X-mount.idmap=u:{owner.pw_uid}:{cloud.pw_uid}:1'
               f' g:{owner.pw_gid}:{cloud.pw_gid}:1')
    lower = f"""[Unit]
Description=Y Harness Cloud read-only workspace source

[Mount]
What={legacy}/workspace
Where={layers}/lower
Type=none
Options={options}
"""
    mount = f"""[Unit]
Description=Y Harness Cloud workspace mapping
Requires={lower_name}
After={lower_name}

[Mount]
What=overlay
Where={data}/workspace
Type=overlay
Options=lowerdir={layers}/lower,upperdir={layers}/changes,workdir={layers}/work,nosuid,nodev,index=on,redirect_dir=on,metacopy=off
"""
    manager = f"""[Unit]
Requires={name}
After={name}

[Service]
TemporaryFileSystem={home}:ro,mode=0755
BindPaths={data}:{legacy}:rbind
"""
    return lower.encode(), mount.encode(), manager.encode()


def check_unit(path, content):
    """Refuse administrator edits or links at a managed unit destination."""
    try:
        info = path.lstat()
    except FileNotFoundError:
        return False
    if (not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022
            or info.st_nlink != 1 or path.read_bytes() != content):
        raise AccountError('A different Cloud workspace unit already exists. Review it before setup.')
    return True


def parse_mount_points(content):
    """Read Linux mountpoint names, including same-filesystem bind mounts."""
    points = set()
    for line in content.splitlines():
        field = line.split(' ')[4]
        decoded = re.sub(r'\\([0-7]{3})', lambda match: chr(int(match[1], 8)), field)
        points.add(Path(decoded))
    return points


def mount_points():
    """Return mountpoints in this installer process's Linux namespace."""
    return parse_mount_points(Path('/proc/self/mountinfo').read_text())


def prepare_mountpoint(path):
    """Require an empty directory before covering it with the workspace mount."""
    path.mkdir(mode=0o700, exist_ok=True)
    require_directory(path, 0, 0)
    if path in mount_points() or any(path.iterdir()):
        raise AccountError('The Cloud workspace mountpoint must be empty and unused.')


def prepare_data_root(path, cloud_gid):
    """Share only a new or empty mapped-data directory with the dedicated group."""
    path.mkdir(mode=0o700, exist_ok=True)
    info = require_directory(path, 0)
    if info.st_gid not in (0, cloud_gid) or info.st_mode & 0o007:
        raise AccountError('Cloud mapped data must be accessible only to the dedicated account.')
    if any(mount.is_relative_to(path) for mount in mount_points()):
        raise AccountError('Cloud mapped data must not cover an existing mount.')
    if any(entry.name != 'workspace' for entry in path.iterdir()):
        raise AccountError('Cloud mapped data must be empty before preparing the workspace.')
    prepare_mountpoint(path / 'workspace')
    os.chown(path, 0, cloud_gid)
    path.chmod(0o750)


def prepare_layers(path, uid, gid):
    """Keep backing directories hidden from the Cloud account and preserve existing data."""
    path.mkdir(mode=0o700, exist_ok=True)
    info = require_directory(path, 0, 0)
    if info.st_mode & 0o077 or any(mount.is_relative_to(path) for mount in mount_points()):
        raise AccountError('Cloud workspace layers must be private and unmounted during setup.')
    if any(entry.name not in ('lower', 'changes', 'work') for entry in path.iterdir()):
        raise AccountError('Cloud workspace layers contain unrelated files.')
    prepare_mountpoint(path / 'lower')
    for name in ('changes', 'work'):
        directory = path / name
        directory.mkdir(mode=0o700, exist_ok=True)
        info = directory.lstat()
        if (not stat.S_ISDIR(info.st_mode) or (info.st_uid, info.st_gid) not in ((0, 0), (uid, gid))
                or info.st_mode & 0o077 or any(directory.iterdir())):
            raise AccountError('Cloud workspace layers already contain data or have unexpected ownership.')
    for name in ('changes', 'work'):
        os.chown(path / name, uid, gid)


def read_accounts(owner_name):
    """Verify the separately provisioned Cloud account and its private primary group."""
    owner = pwd.getpwnam(owner_name)
    if owner.pw_uid <= 0 or owner.pw_gid <= 0 or not HOME_PATH.fullmatch(owner.pw_dir):
        raise AccountError('Use a separate SSH owner with a regular /home directory and dedicated group.')
    legacy_workspace(owner)
    try:
        cloud = pwd.getpwnam(account.ACCOUNT)
    except KeyError:
        cloud = account.ensure_account()
    source_home(owner, cloud)
    if (cloud.pw_dir != str(account.HOME) or cloud.pw_shell != account.NOLOGIN
            or grp.getgrnam(account.ACCOUNT).gr_gid != cloud.pw_gid
            or set(os.getgrouplist(account.ACCOUNT, cloud.pw_gid)) != {cloud.pw_gid}):
        raise AccountError('Prepare the locked Cloud service account before mapping its workspace.')
    password_status = command(['/usr/bin/passwd', '-S', account.ACCOUNT],
                              'Could not verify the Cloud password status.').split()
    if password_status[:2] != [account.ACCOUNT, 'L']:
        raise AccountError('Lock the Cloud service account password before mapping its workspace.')
    return owner, cloud


def legacy_workspace(owner):
    """Require a private source path before making it available to Cloud."""
    home = Path(owner.pw_dir)
    require_directory(home, owner.pw_uid)
    source = home / LEGACY_DIR
    require_directory(source, owner.pw_uid, owner.pw_gid)
    path = source / 'workspace'
    original = require_directory(path, owner.pw_uid, owner.pw_gid)
    if original.st_mode & 0o077 or any(mount.is_relative_to(path) for mount in mount_points()):
        raise AccountError('The original Cloud workspace must be a private directory on the owner’s filesystem.')


def prepare(owner_name):
    """Install the mount dependency without restarting the existing Cloud service."""
    owner, cloud = read_accounts(owner_name)
    unit = f'user@{cloud.pw_uid}.service'
    status = command([*SYSTEMCTL, 'show', '--property=ActiveState', '--value', '--', unit],
                     'Could not check the dedicated Cloud account manager.').strip()
    if status not in ('inactive', 'failed'):
        raise AccountError('Stop the dedicated Cloud account manager before preparing its workspace mapping.')
    require_directory(account.HOME, cloud.pw_uid, cloud.pw_gid)
    data = MAPPED_DATA
    layers = WORKSPACE_LAYERS
    name, lower_name = (command(['/usr/bin/systemd-escape', '--path', '--suffix=mount', str(path)],
                                'Could not identify the Cloud workspace mount unit.').strip()
                        for path in (data / 'workspace', layers / 'lower'))
    lower, mount, manager = workspace_units(owner, cloud, data, layers, name, lower_name)
    config = SYSTEM_UNITS / (unit + '.d') / MANAGER_CONFIG
    for parent in (SYSTEM_UNITS, SYSTEM_UNITS.parent, Path('/var/lib')):
        require_directory(parent, 0)
    if config.parent.exists() or config.parent.is_symlink():
        require_directory(config.parent, 0, 0)
    units = ((SYSTEM_UNITS / lower_name, lower), (SYSTEM_UNITS / name, mount), (config, manager))
    found = [(path, contents, check_unit(path, contents)) for path, contents in units]
    prepare_layers(layers, cloud.pw_uid, cloud.pw_gid)
    prepare_data_root(data, cloud.pw_gid)
    config.parent.mkdir(mode=0o755, exist_ok=True)
    require_directory(config.parent, 0, 0)
    created = []
    try:
        for path, contents, present in found:
            install_unit(path, contents)
            if not present:
                created.append((path, contents))
        command([*SYSTEMCTL, 'daemon-reload'], 'Could not load the Cloud workspace mapping.')
    except BaseException:
        for path, contents in reversed(created):
            if check_unit(path, contents):
                path.unlink()
        raise


def main():
    """Prepare the dedicated account's legacy workspace path on the local VPS."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--owner', required=True, help='SSH account that currently owns the workspace')
    args = parser.parse_args()
    try:
        if sys.platform != 'linux' or os.geteuid() != 0:
            raise AccountError('Run this setup as an administrator on the Linux VPS.')
        os.umask(0o077)
        with account.installation_lock():
            prepare(args.owner)
        print('Cloud workspace mapping prepared.')
    except AccountError as error:
        parser.exit(1, f'{error}\n')
    except KeyboardInterrupt:
        parser.exit(130, 'Cloud workspace setup interrupted.\n')
    except (OSError, ValueError, KeyError):
        parser.exit(1, 'Cloud workspace mapping could not be prepared. Review the account and private paths.\n')


if __name__ == '__main__':
    main()
