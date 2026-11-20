#!/usr/bin/python3 -I
"""Print a dedicated Cloud connection link for the authorized SSH owner."""

import re
import socket
import sys


LINK_SOCKET = '/run/yharness-cloud-link.sock'
LINK_PATTERN = re.compile(rb'http://127\.0\.0\.1:3080/\?token=[A-Za-z0-9_-]{43}\n')


def owner_link(path=LINK_SOCKET):
    """Read one bounded launch link over the root-managed local socket."""
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        connection.settimeout(12)
        connection.connect(path)
        with connection.makefile('rb') as reply:
            line = reply.readline(128)
    if not LINK_PATTERN.fullmatch(line):
        raise ValueError('The Cloud connection returned an invalid launch link.')
    return line


def main():
    """Keep the existing Y Harness Desktop SSH launch command."""
    if sys.argv[1:] != ['url']:
        raise SystemExit('Use yharness-vps url to open the dedicated Cloud workspace.')
    try:
        sys.stdout.buffer.write(owner_link())
    except (OSError, ValueError):
        raise SystemExit('The private Cloud launch link is unavailable. Check the Cloud service.') from None


if __name__ == '__main__':
    main()
