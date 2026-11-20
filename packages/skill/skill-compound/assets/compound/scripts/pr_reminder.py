"""Show an optional PR reminder from repository-local Git settings."""
from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', type=Path, default=Path('.'))
    args = parser.parse_args(argv)
    try:
        result = subprocess.run(
            ['git', '-C', str(args.repo), 'config', '--local', '--no-includes',
             '--bool', '--get', 'compound.prReminder'],
            capture_output=True, timeout=3,
        )
    except (OSError, subprocess.TimeoutExpired):
        print('PR reminder unavailable. Continue with the PR.', file=sys.stderr)
        return 0
    if result.returncode == 0 and result.stdout.strip() == b'true':
        print('If this PR surfaced a reusable diagnosis, invariant, or check, consider saving a short note in docs/solutions.')
    elif result.returncode != 0 and (result.returncode != 1 or result.stderr):
        print('PR reminder unavailable. Check the repository setting compound.prReminder.', file=sys.stderr)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
