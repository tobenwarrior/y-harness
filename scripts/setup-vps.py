#!/usr/bin/env python3
"""Install the Y Harness Web profile as a private, persistent Linux user service."""

import argparse
import fcntl
import json
import os
import platform
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
BOT_IMAGE = 'localhost/yharness-vps-bot:24.04'
BOT_BASE_IMAGE = 'docker.io/library/ubuntu:24.04'
BOT_CONTAINERFILE = Path('scripts/vps-bot/Containerfile')
BOT_ROOT = Path('bots')
NATIVE_PACKAGES = Path('native/system/packages')
SANDBOX_SCRIPT = 'sandbox-setup.py'
BUBBLEWRAP_BIN = Path('/usr/bin/bwrap')
BUBBLEWRAP_PROFILE = Path('/etc/apparmor.d/bwrap-userns-restrict')
APPARMOR_USERNS = Path('/proc/sys/kernel/apparmor_restrict_unprivileged_userns')
SANDBOX_PROBE = """
import { Context } from '@yharness/cordis';
import { launcherPath } from '@yharness/node-addon-system/landlock-run';
import { LocalSandboxProvider } from '@yharness/sandbox-local';
const ctx = new Context();
await ctx.plugin(LocalSandboxProvider, {});
let backend = null;
try {
  const result = await ctx.sandbox.confine(['/bin/true'], { mode: 'read-only', workspaceRoot: '/' });
  backend = result.argv[0] === 'bwrap' && result.enforcement === 'full' ? 'bubblewrap' : 'other';
} catch (error) {
  if (error.code !== 'SANDBOX_UNAVAILABLE') throw error;
} finally {
  await ctx.fiber.dispose();
}
console.log(JSON.stringify({ backend, launcher: launcherPath() }));
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


def podman_environment():
    """Pass only non-sensitive owner paths to the local Podman client."""
    environment = {
        'PATH': '/usr/local/bin:/usr/bin:/bin',
        'LC_ALL': 'C',
    }
    for name in ('HOME', 'XDG_RUNTIME_DIR'):
        value = os.environ.get(name)
        if value is not None and not re.search(r'[\x00-\x1f\x7f]', value):
            environment[name] = value
    return environment


def podman_executable(root):
    """Find Podman or install it through the owner's interactive sudo prompt."""
    executable = shutil.which('podman')
    if executable is not None:
        path = Path(executable).resolve()
        if path == Path('/usr/bin/podman'):
            ensure_rootless_podman(path)
            return path
        raise SetupError('Podman must be installed at /usr/bin/podman for the rootless VPS Bot runtime.')
    print('Podman is not installed. Setup may ask for your sudo password.', flush=True)
    environment = build_environment()
    environment.update(podman_environment())
    with os.fdopen(private_file(root / 'podman.log', os.O_WRONLY | os.O_CREAT), 'w') as log:
        log.truncate()
        try:
            # Keep sudo interactive: the owner sees and authorizes every package
            # installation; setup never attempts a hidden or cached root shell.
            apt = ['/usr/bin/sudo', '/usr/bin/apt-get', '-o', 'DPkg::Lock::Timeout=30', '-o', 'Acquire::Retries=1']
            run([*apt, 'update'], env=environment, stdout=log, stderr=subprocess.STDOUT, timeout=180)
            run(
                [*apt, 'install', '--no-install-recommends', '--no-upgrade', '--no-remove', '--yes', 'podman', 'uidmap'],
                env=environment, stdout=log, stderr=subprocess.STDOUT, timeout=180,
            )
        except (OSError, subprocess.SubprocessError) as error:
            raise SetupError('Could not install Podman through interactive sudo. Check the private podman.log.') from error
    executable = shutil.which('podman')
    if executable is None or Path(executable).resolve() != Path('/usr/bin/podman'):
        raise SetupError('Podman is still unavailable after installation. Check the private podman.log.')
    path = Path('/usr/bin/podman')
    ensure_rootless_podman(path)
    return path


def subid_mapping(path, account):
    """Return whether an owner has a sufficiently large subordinate-id range."""
    try:
        lines = path.read_text().splitlines()
    except (OSError, UnicodeError):
        return False
    for line in lines:
        fields = line.split(':')
        if len(fields) != 3 or fields[0] not in (account, str(os.getuid())):
            continue
        try:
            int(fields[1])
            if int(fields[2]) >= 65_536:
                return True
        except ValueError:
            continue
    return False


def ensure_rootless_podman(podman):
    """Require subordinate ids and prove Podman can enter an owner namespace."""
    account = pwd.getpwuid(os.getuid()).pw_name
    if not subid_mapping(Path('/etc/subuid'), account) or not subid_mapping(Path('/etc/subgid'), account):
        raise SetupError('The VPS account needs 65,536-entry /etc/subuid and /etc/subgid mappings for rootless Podman.')
    try:
        run(
            [str(podman), 'unshare', '/usr/bin/true'], env=podman_environment(),
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30,
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise SetupError('Rootless Podman is not functional for this VPS account. Check uidmap and subordinate ids.') from error


def ensure_bot_image(root, source):
    """Build the audited local Bot desktop image once, without restarting Web."""
    podman = podman_executable(root)
    containerfile = source / BOT_CONTAINERFILE
    if containerfile.is_symlink() or not containerfile.is_file():
        raise SetupError('The installed source is missing the audited VPS Bot Containerfile.')
    environment = podman_environment()
    ensure_bot_base(root, podman, environment)
    try:
        run([str(podman), 'image', 'exists', BOT_IMAGE], env=environment, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except subprocess.CalledProcessError:
        descriptor = private_file(root / 'podman-build.log', os.O_WRONLY | os.O_CREAT)
        with os.fdopen(descriptor, 'w') as log:
            log.truncate()
            try:
                run(
                    [str(podman), 'build', '--pull=never', '--network=host', '--tag', BOT_IMAGE,
                     '--file', str(containerfile), str(containerfile.parent)],
                    cwd=source, env=environment, stdout=log, stderr=subprocess.STDOUT, timeout=600,
                )
            except (OSError, subprocess.SubprocessError) as error:
                raise SetupError('The audited VPS Bot image build failed. Check the private podman-build.log.') from error
    return podman


def ensure_bot_base(root, podman, environment):
    """Pull the pinned Ubuntu base explicitly before the offline image build."""
    try:
        run([str(podman), 'image', 'exists', BOT_BASE_IMAGE], env=environment,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return
    except subprocess.CalledProcessError:
        descriptor = private_file(root / 'podman-base.log', os.O_WRONLY | os.O_CREAT)
        with os.fdopen(descriptor, 'w') as log:
            log.truncate()
            try:
                run(
                    [str(podman), 'pull', '--quiet', BOT_BASE_IMAGE],
                    env=environment, stdout=log, stderr=subprocess.STDOUT, timeout=300,
                )
            except (OSError, subprocess.SubprocessError) as error:
                raise SetupError('The pinned Ubuntu Bot base could not be pulled. Check the private podman-base.log.') from error


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


def ubuntu_2404():
    """Identify the Ubuntu release whose optional Bubblewrap profile setup supports."""
    try:
        release = platform.freedesktop_os_release()
    except (AttributeError, OSError):
        return False
    return release.get('ID') == 'ubuntu' and release.get('VERSION_ID') == '24.04'


def bubblewrap_works(environment):
    """Probe the distro Bubblewrap with the same mounts the sandbox provider uses."""
    try:
        run(
            [str(BUBBLEWRAP_BIN), '--ro-bind', '/', '/', '--dev', '/dev', '--unshare-pid',
             '--proc', '/proc', '--die-with-parent', '--', '/usr/bin/true'],
            env=environment, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10,
        )
        return True
    except (OSError, subprocess.SubprocessError):
        return False


def install_bubblewrap_profile(root, environment, log):
    """Load only Ubuntu's packaged Bubblewrap profile and preserve existing profiles."""
    profiles = BUBBLEWRAP_PROFILE.parent
    related = (BUBBLEWRAP_PROFILE, profiles / 'disable' / BUBBLEWRAP_PROFILE.name,
               profiles / 'force-complain' / BUBBLEWRAP_PROFILE.name)
    if any(path.exists() or path.is_symlink() for path in related):
        raise SetupError('An existing Bubblewrap AppArmor configuration needs administrator review.')
    if APPARMOR_USERNS.read_text().strip() != '1':
        raise SetupError('Bubblewrap failed for a reason other than the Ubuntu AppArmor namespace restriction.')
    privileged = ['/usr/bin/sudo', '-n']
    parser = [*privileged, '/usr/sbin/apparmor_parser']

    def apply(args, timeout=25):
        return run(args, env=environment, stdout=log, stderr=subprocess.STDOUT, timeout=timeout)

    run(['/usr/bin/systemctl', 'is-enabled', '--quiet', 'apparmor'], env=environment, timeout=10)
    loaded = run(
        [*privileged, '/usr/bin/cat', '/sys/kernel/security/apparmor/profiles'],
        env=environment, capture_output=True, timeout=10,
    ).stdout
    if re.search(r'^(?:bwrap|unpriv_bwrap) ', loaded, re.MULTILINE):
        raise SetupError('A Bubblewrap profile is already loaded. Review it before retrying setup.')

    with tempfile.TemporaryDirectory(dir=root) as stage:
        run(
            ['/usr/bin/apt-get', 'download', 'apparmor-profiles'], cwd=stage, env=environment,
            stdout=log, stderr=subprocess.STDOUT, timeout=120,
        )
        packages = list(Path(stage).glob('apparmor-profiles_*.deb'))
        if len(packages) != 1:
            raise SetupError('Could not identify Ubuntu’s downloaded AppArmor profile package.')
        unpacked = Path(stage) / 'extracted'
        apply(['/usr/bin/dpkg-deb', '--extract', str(packages[0]), str(unpacked)])
        profile = unpacked / 'usr/share/apparmor/extra-profiles/bwrap-userns-restrict'
        if not profile.is_file() or profile.is_symlink():
            raise SetupError('Ubuntu’s AppArmor package is missing the Bubblewrap profile. Update the Ubuntu package lists.')

        pending = Path(run(
            [*privileged, '/usr/bin/mktemp', str(profiles / '.yharness-bwrap.XXXXXX')],
            env=environment, capture_output=True, timeout=10,
        ).stdout.strip())
        if pending.parent != profiles or not re.fullmatch(r'\.yharness-bwrap\.[A-Za-z0-9]{6}', pending.name):
            raise SetupError('Could not allocate a temporary system profile.')
        try:
            apply([*privileged, '/usr/bin/install', '-o', 'root', '-g', 'root', '-m', '0644', str(profile), str(pending)])
            apply([*parser, '-Q', '-T', str(pending)])
            apply([*privileged, '/usr/bin/ln', '-T', '--', str(pending), str(BUBBLEWRAP_PROFILE)])
            activated = False
            try:
                apply([*parser, '-a', '-T', str(BUBBLEWRAP_PROFILE)])
                activated = True
                if not bubblewrap_works(environment):
                    raise SetupError('Ubuntu’s AppArmor profile loaded, but Bubblewrap could not start.')
            except (SetupError, OSError, subprocess.SubprocessError):
                if activated:
                    apply([*parser, '-R', str(BUBBLEWRAP_PROFILE)])
                apply([*privileged, '/usr/bin/rm', '--', str(BUBBLEWRAP_PROFILE)])
                raise
        finally:
            apply([*privileged, '/usr/bin/rm', '--', str(pending)])


def ensure_bubblewrap(root):
    """Provision full Bubblewrap enforcement on Ubuntu 24.04 only during setup."""
    environment = build_environment()
    environment['PATH'] = '/usr/local/bin:/usr/bin:/bin'
    if bubblewrap_works(environment):
        return
    print('Configuring Ubuntu Bubblewrap. Setup may ask for sudo.', flush=True)
    with os.fdopen(private_file(root / 'bubblewrap.log', os.O_WRONLY | os.O_CREAT), 'w') as log:
        log.truncate()
        try:
            run(['/usr/bin/sudo', '-v'], env=environment, timeout=90)
            apt = [
                '/usr/bin/sudo', '-n', '/usr/bin/env', 'DEBIAN_FRONTEND=noninteractive', 'NEEDRESTART_MODE=l',
                '/usr/bin/apt-get', '-o', 'DPkg::Lock::Timeout=30', '-o', 'Acquire::Retries=1',
            ]
            run([*apt, 'update'], env=environment, stdout=log, stderr=subprocess.STDOUT, timeout=180)
            if not BUBBLEWRAP_BIN.is_file():
                run(
                    [*apt, 'install', '--no-install-recommends', '--no-upgrade', '--no-remove', '--yes', 'bubblewrap'],
                    env=environment, stdout=log, stderr=subprocess.STDOUT, timeout=180,
                )
            if not bubblewrap_works(environment):
                install_bubblewrap_profile(root, environment, log)
        except (OSError, subprocess.SubprocessError) as error:
            raise SetupError('Could not configure full Bubblewrap enforcement. Check sudo access and the private bubblewrap.log.') from error


def sandbox_probe(source, node, environment):
    """Query the checkout's sandbox provider under the service's executable search path."""
    try:
        result = run(
            [str(node), '--input-type=module', '-e', SANDBOX_PROBE],
            cwd=source / 'packages/sandbox/sandbox-local', env=environment, capture_output=True, timeout=20,
        )
        status = json.loads(result.stdout)
        return status['backend'], Path(status['launcher'])
    except (OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
        raise SetupError('Could not check the Linux sandbox in the Y Harness build.') from error


def ensure_sandbox(root, source, node):
    """Verify Ubuntu Bubblewrap or supply a probed Landlock fallback on other Linux hosts."""
    environment = build_environment()
    environment['PATH'] = f'{node.parent}:/usr/local/bin:/usr/bin:/bin'
    with os.fdopen(private_file(root / 'sandbox.lock', os.O_RDWR | os.O_CREAT), 'r+') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        backend, launcher = sandbox_probe(source, node, environment)
        if ubuntu_2404() and backend != 'bubblewrap':
            raise SetupError('Full Bubblewrap enforcement is unavailable. Run VPS setup to repair it before starting Y Harness.')
        if backend is not None:
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


def bot_resources(source):
    """Report whether this checkout carries the complete Bot runtime payload."""
    resources = (
        source / BOT_CONTAINERFILE,
        source / BOT_CONTAINERFILE.parent / 'start.sh',
        source / BOT_CONTAINERFILE.parent / 'capture.sh',
        source / BOT_CONTAINERFILE.parent / 'files.py',
        source / 'packages/bundle/web-app/src/vps-runtime.ts',
    )
    present = [path for path in resources if path.exists() or path.is_symlink()]
    if not present:
        return False
    if any(path.is_symlink() or not path.is_file() for path in resources):
        raise SetupError('The installed source has an incomplete VPS Bot runtime payload.')
    return True


def install_bot_dropin(unit_dir):
    """Install owner-only Web environment values without restarting the service."""
    dropin_dir = unit_dir / (SERVICE + '.d')
    private_directory(dropin_dir)
    dropin = (
        '[Service]\n'
        'Environment="YH_VPS_BOT_ROOT=%h/.yharness-vps/bots"\n'
        f'Environment="YH_VPS_BOT_IMAGE={BOT_IMAGE}"\n'
    )
    write_private_copy(dropin_dir / 'vps-bot.conf', dropin.encode())


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
        private_directory(root / BOT_ROOT)
        os.close(private_file(root / 'host.log', os.O_WRONLY | os.O_CREAT))
        source = root / 'source'
        if source.is_symlink() or (source.exists() and not (source / CLI).is_file()):
            raise SetupError('The existing Y Harness installation is incomplete. Check the private installation directory.')
        unit_path = unit_dir / SERVICE
        has_unit = unit_path.exists() or unit_path.is_symlink()
        if has_unit:
            with os.fdopen(private_file(unit_path, os.O_RDONLY)) as existing:
                if existing.read() != unit:
                    raise SetupError('The existing Y Harness service file differs. Review it before running setup again.')
        if ubuntu_2404():
            ensure_bubblewrap(root)
        if not source.exists():
            print('Downloading and building Y Harness. This can take several minutes.', flush=True)
            build_source(root, node)
        else:
            ensure_sandbox(root, source, node)
        unit_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        if bot_resources(source):
            ensure_bot_image(root, source)
            if not has_unit:
                install_bot_dropin(unit_dir)
        if not has_unit:
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
