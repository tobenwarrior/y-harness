"""Inspect the native owner of a caller-specified desktop development workspace."""

import re
import subprocess
from typing import Optional


def find_development_owner(executable: str, app_root: str, user_data: str,
                           expected_pid: Optional[int] = None) -> Optional[int]:
    """Return the matching native Electron PID, or None when no owner remains.

    The executable and app entry must match their process spelling. The app
    entry must be the final argument; user_data permits the known spaced
    --user-data-dir option in unquoted ps output. Inspector ports do not
    identify the owner. Unexpected process inspection failures propagate as
    CalledProcessError.
    """
    owner_command = re.compile(
        r'^' + re.escape(executable) + r'\s+'
        r'(?:(?:--user-data-dir=' + re.escape(user_data) + r'|--\S+)\s+)*'
        + re.escape(app_root) + r'\s*$'
    )
    commands = subprocess.check_output(['/bin/ps', '-axo', 'pid=,comm='], text=True).splitlines()
    for command in commands:
        fields = command.strip().split(None, 1)
        if len(fields) != 2 or fields[1] != executable:
            continue
        if expected_pid is not None and int(fields[0]) != expected_pid:
            continue
        try:
            arguments = subprocess.check_output(['/bin/ps', '-p', fields[0], '-o', 'args='],
                                                text=True)
        except subprocess.CalledProcessError as error:
            if error.returncode == 1:  # The process disappeared between the two ps calls.
                continue
            raise
        options = arguments.split()
        if ('--expose-internals' in options
                or any(option == '--type' or option.startswith('--type=') for option in options)):
            continue
        if owner_command.match(arguments.strip()):
            return int(fields[0])
    return None
