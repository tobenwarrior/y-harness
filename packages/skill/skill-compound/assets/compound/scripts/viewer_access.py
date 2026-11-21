"""Private browser launch for the loopback map service."""
from __future__ import annotations

import base64
import hashlib
import hmac
import html
import json
import os
from pathlib import Path
import stat
import tempfile


def read_token(runtime_token: str) -> str:
    """Derive a per-service browser credential that cannot authorize control calls."""
    return hmac.new(runtime_token.encode(), b"compound-map-viewer", hashlib.sha256).hexdigest()


def bearer_matches(header: str, token: str) -> bool:
    return hmac.compare_digest(header.encode(), b"Bearer " + token.encode())


def require_private_state(directory: Path) -> None:
    """Reject a state directory another local account can replace or modify."""
    if os.name != "posix":
        return  # The default user cache inherits its Windows account ACL.
    for path in (directory.parent, directory):
        info = path.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o022:
            raise ValueError(f"map state must be in a user-owned directory: {path}")


def launch_link(directory: Path, project: str, url: str, runtime_token: str) -> str:
    """Write a local redirect outside the repo. Its path carries no credential."""
    require_private_state(directory)
    destination = directory / f"viewer-{project}.html"
    target = url + "#access=" + read_token(runtime_token)
    script = "location.replace(" + json.dumps(target, ensure_ascii=True) + ");"
    digest = base64.b64encode(hashlib.sha256(script.encode()).digest()).decode()
    contents = (
        '<!doctype html><meta charset="utf-8">'
        '<meta name="referrer" content="no-referrer">'
        f'<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'sha256-{digest}\'">'
        '<title>Open Compound code map</title>'
        f'<script>{script}</script>'
        f'<a href="{html.escape(target, quote=True)}" rel="noreferrer">Open Compound code map</a>'
    )
    temporary: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=directory, delete=False) as stream:
            temporary = Path(stream.name)
            stream.write(contents)
        os.chmod(temporary, 0o600)
        os.replace(temporary, destination)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
    return destination.as_uri()
