#!/usr/bin/env python3
"""Keep a private Xvfb display, Openbox, and an optional terminal alive."""

import os
import re
import secrets
import signal
import stat
import subprocess
import sys
import time
from pathlib import Path

DISPLAY_PATTERN = re.compile(r'^:[0-9]+$')
SCREEN = '1280x800x24'
READY_TIMEOUT = 10.0
POLL_INTERVAL = 0.2

XVFB = '/usr/bin/Xvfb'
XAUTH = '/usr/bin/xauth'
OPENBOX = '/usr/bin/openbox'
XDOTOOL = '/usr/bin/xdotool'
SCROT = '/usr/bin/scrot'
XTERM = '/usr/bin/xterm'


class SupervisorError(Exception):
    """A display setup failure safe to report without environment contents."""


def private_directory(path):
    """Create or validate an owner-only directory without accepting a symlink."""
    try:
        info = path.lstat()
    except FileNotFoundError:
        try:
            path.mkdir(mode=0o700, parents=False)
        except OSError as error:
            raise SupervisorError('The private display directory could not be created.') from error
        info = path.lstat()
    if (
        not stat.S_ISDIR(info.st_mode)
        or info.st_uid != os.getuid()
        or info.st_mode & 0o077
    ):
        raise SupervisorError('The private display directory is not owner-only.')


def private_authority(path):
    """Create an owner-only Xauthority file and reject links or shared files."""
    private_directory(path.parent)
    try:
        info = path.lstat()
    except FileNotFoundError:
        info = None
    if info is not None and (
        not stat.S_ISREG(info.st_mode)
        or info.st_uid != os.getuid()
        or info.st_mode & 0o077
        or info.st_nlink != 1
    ):
        raise SupervisorError('The Xauthority path is not an owner-only regular file.')
    try:
        descriptor = os.open(
            path,
            os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW,
            0o600,
        )
    except OSError as error:
        raise SupervisorError('The private Xauthority file could not be opened.') from error
    try:
        os.fchmod(descriptor, 0o600)
        info = os.fstat(descriptor)
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_uid != os.getuid()
            or info.st_mode & 0o077
            or info.st_nlink != 1
        ):
            raise SupervisorError('The Xauthority file is not owner-only.')
    finally:
        os.close(descriptor)


def child_environment(display, authority):
    """Build a PATH-limited display environment without inherited credentials."""
    sensitive = re.compile(r'(?:KEY|SECRET|TOKEN|PASSWORD)', re.IGNORECASE)
    environment = {
        key: value
        for key, value in os.environ.items()
        if not sensitive.search(key) and key not in {'SSH_AUTH_SOCK', 'GIT_SSH_COMMAND'}
    }
    environment.update({
        'DISPLAY': display,
        'XAUTHORITY': str(authority),
        'PATH': '/usr/local/bin:/usr/bin:/bin',
    })
    return environment


def require_tools(launch_terminal):
    """Check the fixed Ubuntu command paths before starting any child."""
    tools = (XVFB, XAUTH, OPENBOX, XDOTOOL, SCROT)
    if launch_terminal:
        tools += (XTERM,)
    for tool in tools:
        if not os.access(tool, os.X_OK):
            raise SupervisorError('A required virtual-display package is not installed.')


def wait_for_display(display_environment, xvfb):
    """Wait for Xvfb to accept an authenticated geometry query."""
    deadline = time.monotonic() + READY_TIMEOUT
    while time.monotonic() < deadline:
        if xvfb.poll() is not None:
            raise SupervisorError('The virtual display stopped before it became ready.')
        try:
            result = subprocess.run(
                [XDOTOOL, 'getdisplaygeometry'],
                check=False,
                env=display_environment,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=1.0,
            )
        except subprocess.TimeoutExpired as error:
            del error
            result = None
        if result is not None and result.returncode == 0:
            return
        time.sleep(0.1)
    raise SupervisorError('The virtual display did not become ready.')


def stop_children(children):
    """Terminate every child and wait for exit before the supervisor returns."""
    running = [child for child in reversed(children) if child.poll() is None]
    for child in running:
        child.terminate()
    deadline = time.monotonic() + 5.0
    for child in running:
        remaining = max(0.0, deadline - time.monotonic())
        try:
            child.wait(timeout=remaining)
        except subprocess.TimeoutExpired as error:
            del error
            child.kill()
            child.wait()


def run():
    """Start the display stack and supervise it until shutdown or failure."""
    display = os.environ.get('YH_VPS_DISPLAY', ':99')
    authority_value = os.environ.get('YH_VPS_XAUTHORITY')
    stop_requested = [False]

    def request_stop(signum, frame):
        del signum, frame
        stop_requested[0] = True

    signal.signal(signal.SIGTERM, request_stop)
    signal.signal(signal.SIGINT, request_stop)
    if not DISPLAY_PATTERN.fullmatch(display) or authority_value is None:
        raise SupervisorError('The virtual display settings are invalid.')
    authority = Path(authority_value)
    if not authority.is_absolute() or authority.name != 'Xauthority':
        raise SupervisorError('The private Xauthority path is invalid.')
    launch_terminal = os.environ.get('YH_VPS_LAUNCH_XTERM', '1') == '1'
    require_tools(launch_terminal)
    private_authority(authority)
    environment = child_environment(display, authority)
    cookie = secrets.token_hex(16)
    subprocess.run(
        [XAUTH, '-f', str(authority), 'add', display, '.', cookie],
        check=True,
        env=environment,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        timeout=5.0,
    )
    children = []
    if stop_requested[0]:
        return 0
    try:
        xvfb = subprocess.Popen(
            [XVFB, display, '-screen', '0', SCREEN, '-nolisten', 'tcp', '-auth', str(authority)],
            env=environment,
            close_fds=True,
        )
        children.append(xvfb)
        wait_for_display(environment, xvfb)
        openbox = subprocess.Popen(
            [OPENBOX, '--sm-disable'],
            env=environment,
            close_fds=True,
        )
        children.append(openbox)
        if launch_terminal:
            terminal_environment = dict(environment)
            terminal_environment.update({'PS1': 'Y Harness$ ', 'PROMPT_COMMAND': ''})
            terminal = subprocess.Popen(
                [
                    '/usr/bin/xterm', '-title', 'Y Harness Terminal',
                    '-geometry', '92x28+64+64', '-fa', 'monospace', '-fs', '15',
                    '-bg', '#1b1d23', '-fg', '#e0e3ec',
                    '-e', '/bin/bash', '--noprofile', '--norc', '-i',
                ],
                env=terminal_environment,
                close_fds=True,
            )
            children.append(terminal)
        while not stop_requested[0]:
            for child in children[:2]:
                status = child.poll()
                if status is not None:
                    return status if status != 0 else 1
            time.sleep(POLL_INTERVAL)
        return 0
    finally:
        stop_children(children)


def main():
    """Run the supervisor and report only a generic failure to systemd."""
    try:
        return run()
    except (OSError, SupervisorError, subprocess.CalledProcessError, subprocess.TimeoutExpired):
        print('Y Harness virtual display could not start.', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
