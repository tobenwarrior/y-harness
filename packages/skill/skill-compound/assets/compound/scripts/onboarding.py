#!/usr/bin/env python3
"""Coordinate one short-lived Compound Skills onboarding lease per repository."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import secrets
import sqlite3
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path


LEASE_SECONDS = 30 * 60
DATABASE_NAME = "onboarding.sqlite3"
SCHEMA_COLUMNS = ("repo_key", "state", "token", "lease_until", "updated_at")
CREATE_TABLE = """
CREATE TABLE IF NOT EXISTS onboarding (
    repo_key TEXT PRIMARY KEY,
    state TEXT NOT NULL,
    token TEXT,
    lease_until REAL,
    updated_at REAL NOT NULL
)
"""


class SetupError(ValueError):
    pass


class UsageError(ValueError):
    pass


class JsonParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        raise UsageError(message)


@dataclass(frozen=True)
class Identity:
    root: Path
    key: str


def _now() -> float:
    return time.time()


def _emit(value: dict[str, object]) -> int:
    try:
        print(json.dumps(value, ensure_ascii=False))
    except UnicodeEncodeError:
        # A strict stdout, as under en_US.UTF-8, cannot encode undecodable path bytes; claim already stored the lease.
        print(json.dumps(value))
    return 2 if value["status"] == "error" else 0


def _result(
    action: str,
    identity: Identity | None,
    status: str,
    changed: bool,
    **extra: object,
) -> dict[str, object]:
    value: dict[str, object] = {
        "action": action,
        "status": status,
        "changed": changed,
        "repo": str(identity.root) if identity else "",
    }
    value.update(extra)
    return value


def _error(action: str, message: str, identity: Identity | None = None) -> dict[str, object]:
    return _result(action, identity, "error", False, error=message)


def _canonical_directory(raw: str) -> Path:
    try:
        path = Path(raw).expanduser()
        if not path.is_absolute():
            path = Path.cwd() / path
        if not path.exists():
            raise SetupError(f"repository path does not exist: {path}")
        if not path.is_dir():
            raise SetupError(f"repository path is not a directory: {path}")
        return path.resolve(strict=True)
    except SetupError:
        raise
    except (OSError, RuntimeError) as exc:
        raise SetupError(f"could not resolve repository path {raw}: {exc}") from exc


def _repository_identity(raw: str) -> Identity:
    supplied = _canonical_directory(raw)
    try:
        result = subprocess.run(
            ["git", "-C", str(supplied), "rev-parse", "--show-toplevel", "--git-common-dir"],
            capture_output=True,
            check=False,
            timeout=10,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise SetupError(f"could not inspect repository with git: {exc}") from exc

    if result.returncode == 0:
        # Paths need not be UTF-8; decode them as the file system does.
        lines = [os.fsdecode(line) for line in result.stdout.splitlines()]
        if len(lines) != 2 or not all(lines):
            raise SetupError("git returned an invalid repository identity")
        try:
            root = Path(lines[0]).resolve(strict=True)
            common = Path(lines[1])
            if not common.is_absolute():
                common = supplied / common
            common = common.resolve(strict=True)
            stat_result = common.stat()
        except OSError as exc:
            raise SetupError(f"could not inspect git metadata: {exc}") from exc
        parts = ("git", str(root), str(common), str(stat_result.st_dev), str(stat_result.st_ino))
    else:
        try:
            stat_result = supplied.stat()
        except OSError as exc:
            raise SetupError(f"could not inspect repository identity: {exc}") from exc
        root = supplied
        parts = ("nongit", str(root), str(stat_result.st_dev), str(stat_result.st_ino))
    key = hashlib.sha256("\0".join(parts).encode("utf-8", "surrogateescape")).hexdigest()
    return Identity(root, key)


def _state_paths() -> tuple[Path, Path]:
    configured = os.environ.get("COMPOUND_SKILLS_STATE_DIR")
    try:
        if configured is None:
            directory = Path.home() / ".cache" / "compound-skills"
        elif not configured:
            raise SetupError("COMPOUND_SKILLS_STATE_DIR must not be empty")
        else:
            directory = Path(configured).expanduser()
            if not directory.is_absolute():
                raise SetupError("COMPOUND_SKILLS_STATE_DIR must be an absolute path")
    except RuntimeError as exc:
        raise SetupError(f"could not determine onboarding state directory: {exc}") from exc
    return directory, directory / DATABASE_NAME


def _reject_symlink(path: Path, label: str) -> None:
    """Refuse a symlink at the path itself; its ancestors may be links, such as /home on FreeBSD."""
    try:
        if path.is_symlink():
            raise SetupError(f"refusing symlink {label}: {path}")
    except OSError as exc:
        raise SetupError(f"could not inspect {label} {path}: {exc}") from exc


def _prepare_state(write: bool) -> tuple[Path, Path, bool]:
    directory, database = _state_paths()
    _reject_symlink(directory, "state directory")
    try:
        if directory.exists() and not directory.is_dir():
            raise SetupError(f"state path is not a directory: {directory}")
        if write and not directory.exists():
            try:
                directory.mkdir(parents=True)
            except FileExistsError:
                pass
            _reject_symlink(directory, "state directory")
        if database.is_symlink():
            raise SetupError(f"refusing symlink state database: {database}")
        if database.exists() and not database.is_file():
            raise SetupError(f"state database is not a regular file: {database}")
        return directory, database, database.exists()
    except SetupError:
        raise
    except OSError as exc:
        raise SetupError(f"could not prepare state path {directory}: {exc}") from exc


def _connect(database: Path, readonly: bool) -> sqlite3.Connection:
    try:
        if readonly:
            connection = sqlite3.connect(database.as_uri() + "?mode=ro", uri=True, timeout=5)
        else:
            connection = sqlite3.connect(database, timeout=5)
        connection.execute("PRAGMA busy_timeout=5000")
        return connection
    except sqlite3.Error as exc:
        raise SetupError(f"could not open onboarding state: {exc}") from exc


def _check_schema(connection: sqlite3.Connection) -> None:
    try:
        rows = connection.execute("PRAGMA table_info(onboarding)").fetchall()
    except sqlite3.DatabaseError as exc:
        raise SetupError(f"onboarding state is unreadable: {exc}") from exc
    columns = tuple(str(row[1]) for row in rows)
    if columns != SCHEMA_COLUMNS:
        raise SetupError("onboarding state schema is missing or corrupted")


def _begin_write(connection: sqlite3.Connection) -> None:
    try:
        connection.execute("BEGIN IMMEDIATE")
        tables = tuple(
            str(row[0])
            for row in connection.execute(
                "SELECT name FROM sqlite_master "
                "WHERE type='table' AND name NOT LIKE 'sqlite_%'"
            ).fetchall()
        )
        if "onboarding" not in tables:
            if tables:
                raise SetupError("onboarding state schema is missing or corrupted")
            connection.execute(CREATE_TABLE)
        _check_schema(connection)
    except (sqlite3.DatabaseError, SetupError) as exc:
        try:
            connection.rollback()
        except sqlite3.Error:
            pass
        if isinstance(exc, SetupError):
            raise
        raise SetupError(f"onboarding state is unavailable: {exc}") from exc


def _read_row(connection: sqlite3.Connection, key: str) -> tuple[str, str | None, float | None] | None:
    try:
        row = connection.execute(
            "SELECT state, token, lease_until FROM onboarding WHERE repo_key = ?", (key,)
        ).fetchone()
    except sqlite3.DatabaseError as exc:
        raise SetupError(f"could not read onboarding state: {exc}") from exc
    if row is None:
        return None
    state, token, lease_until = row
    if state not in {"in_progress", "completed"}:
        raise SetupError("onboarding state row is corrupted")
    if state == "in_progress" and (not isinstance(token, str) or not token or not isinstance(lease_until, (int, float))):
        raise SetupError("onboarding lease row is corrupted")
    if state == "completed" and (token is not None or lease_until is not None):
        raise SetupError("onboarding completed row is corrupted")
    return str(state), token, float(lease_until) if lease_until is not None else None


def _status(identity: Identity, action: str) -> dict[str, object]:
    _, database, exists = _prepare_state(False)
    if not exists:
        return _result(action, identity, "unseen", False)
    connection = _connect(database, True)
    try:
        _check_schema(connection)
        row = _read_row(connection, identity.key)
    finally:
        connection.close()
    if row is None:
        return _result(action, identity, "unseen", False)
    state, _, lease_until = row
    if state == "completed":
        return _result(action, identity, "completed", False)
    if lease_until is not None and lease_until > _now():
        return _result(action, identity, "in_progress", False, lease_expires_at=lease_until)
    return _result(action, identity, "unseen", False)


def _claim(
    identity: Identity,
    supplied_token: str | None,
    refresh: bool = False,
) -> dict[str, object]:
    _, database, exists = _prepare_state(True)
    connection = _connect(database, False)
    try:
        _begin_write(connection)
        row = _read_row(connection, identity.key)
        now = _now()
        if row is not None:
            state, _, lease_until = row
            if state == "completed" and not refresh:
                connection.commit()
                return _result("claim", identity, "already_completed", False)
            if lease_until is not None and lease_until > now:
                connection.commit()
                return _result("claim", identity, "busy", False)
        # Hex never starts with "-", which argparse would read as an option after --token.
        token = supplied_token or secrets.token_hex(32)
        expires = now + LEASE_SECONDS
        connection.execute(
            "INSERT INTO onboarding(repo_key,state,token,lease_until,updated_at) VALUES(?,?,?,?,?) "
            "ON CONFLICT(repo_key) DO UPDATE SET state=excluded.state, token=excluded.token, "
            "lease_until=excluded.lease_until, updated_at=excluded.updated_at",
            (identity.key, "in_progress", token, expires, now),
        )
        connection.commit()
        return _result("claim", identity, "claimed", True, token=token, lease_expires_at=expires)
    except SetupError:
        raise
    except sqlite3.DatabaseError as exc:
        try:
            connection.rollback()
        except sqlite3.Error:
            pass
        raise SetupError(f"could not claim onboarding lease: {exc}") from exc
    finally:
        connection.close()


def _complete_or_release(identity: Identity, action: str, token: str) -> dict[str, object]:
    _, database, exists = _prepare_state(False)
    if not exists:
        raise SetupError("no current onboarding lease")
    connection = _connect(database, False)
    try:
        _begin_write(connection)
        row = _read_row(connection, identity.key)
        if row is not None and row[0] == "completed" and action == "complete":
            connection.commit()
            return _result(action, identity, "already_completed", False)
        if row is None or row[0] != "in_progress" or row[1] != token:
            connection.rollback()
            raise SetupError("token does not match the current onboarding lease")
        now = _now()
        if row[2] is None or row[2] <= now:
            connection.rollback()
            raise SetupError("onboarding lease has expired")
        if action == "complete":
            connection.execute(
                "UPDATE onboarding SET state='completed', token=NULL, lease_until=NULL, updated_at=? "
                "WHERE repo_key=?",
                (now, identity.key),
            )
            connection.commit()
            return _result(action, identity, "completed", True)
        connection.execute("DELETE FROM onboarding WHERE repo_key=?", (identity.key,))
        connection.commit()
        return _result(action, identity, "released", True)
    except SetupError:
        raise
    except sqlite3.DatabaseError as exc:
        try:
            connection.rollback()
        except sqlite3.Error:
            pass
        raise SetupError(f"could not update onboarding state: {exc}") from exc
    finally:
        connection.close()


def _parser() -> argparse.ArgumentParser:
    parser = JsonParser(description="Manage one bounded Compound Skills onboarding lease.")
    parser.add_argument("action", nargs="?", choices=("status", "claim", "complete", "release"))
    parser.add_argument("--repo", metavar="PATH")
    parser.add_argument("--token", metavar="TOKEN")
    parser.add_argument("--refresh", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:
    raw_args = list(sys.argv[1:] if argv is None else argv)
    try:
        args = _parser().parse_args(raw_args)
    except (UsageError, SystemExit) as exc:
        if isinstance(exc, SystemExit):
            raise
        return _emit(_error("", str(exc)))
    action = args.action or ""
    if action not in {"status", "claim", "complete", "release"}:
        return _emit(_error(action, "action must be status, claim, complete, or release"))
    if not args.repo:
        return _emit(_error(action, "--repo is required"))
    if args.refresh and action != "claim":
        return _emit(_error(action, "--refresh is only valid for claim"))
    if action == "status" and args.token is not None:
        return _emit(_error(action, "--token is not valid for status"))
    if action in {"complete", "release"} and not args.token:
        return _emit(_error(action, "--token is required"))
    try:
        identity = _repository_identity(args.repo)
        if action == "status":
            return _emit(_status(identity, action))
        if action == "claim":
            return _emit(_claim(identity, args.token, args.refresh))
        return _emit(_complete_or_release(identity, action, args.token))
    except SetupError as exc:
        return _emit(_error(action, str(exc)))


if __name__ == "__main__":
    raise SystemExit(main())
