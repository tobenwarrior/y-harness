#!/usr/bin/env python3
"""Enable or inspect bounded Compound Skills routing blocks.

Project mode edits project-local instruction files.  Global mode edits only
the selected user instruction files. The optional Claude permissions check
reads only its user settings file and reports the expected allow rules. The
helper never changes host settings or edits an ancestor instruction file.
"""

from __future__ import annotations

import argparse
import codecs
import io
import json
import os
import stat
import sys
import tempfile
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Iterable, Sequence


START_MARKER = "<!-- compound-skills:project-setup:start -->"
END_MARKER = "<!-- compound-skills:project-setup:end -->"
MARKER_NAMESPACE = "compound-skills:project-setup:"
STATUS_SCOPE = "enabled under default project instruction settings"

GLOBAL_START_MARKER = "<!-- compound-skills:global-setup:start -->"
GLOBAL_END_MARKER = "<!-- compound-skills:global-setup:end -->"
GLOBAL_MARKER_NAMESPACE = "compound-skills:global-setup:"
GLOBAL_STATUS_SCOPE = "global"
GLOBAL_SCOPE_DETAIL = "global user instruction settings"
GLOBAL_PREREQUISITE = (
    "These rules require the Compound Skills plugin to be installed and enabled "
    "in the user scope; setup does not verify or install it."
)
CURSOR_HOST_NOTE = (
    "Cursor is host-managed by the native user-scope Compound Skills plugin rule; "
    "install or enable that plugin with its alwaysApply rule. This helper cannot "
    "verify or change Cursor settings."
)
CURSOR_DISABLE_NOTE = (
    "Cursor remains host-managed. Disable or turn off its native user-scope plugin "
    "rule in Cursor Customize; this helper does not change app settings."
)

ROUTING_PATH = Path(__file__).resolve().parent.parent / "references" / "default-routing.md"
BLOCK_LINES = (
    START_MARKER,
    "## Compound Skills default routing",
    "",
    ROUTING_PATH.read_text(encoding="utf-8").strip(),
    END_MARKER,
)

GLOBAL_BLOCK_LINES = (
    GLOBAL_START_MARKER,
    *BLOCK_LINES[1:-1],
    GLOBAL_END_MARKER,
)



class SetupError(ValueError):
    """A project setup input cannot be safely processed."""


class UsageError(ValueError):
    """CLI arguments are invalid but can still be reported as JSON."""


class ApplyError(SetupError):
    """A planned write failed after zero or more atomic replacements."""

    def __init__(self, message: str, changed_paths: Sequence[str]) -> None:
        super().__init__(message)
        self.changed_paths = tuple(changed_paths)


class JsonArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        raise UsageError(message)


@dataclass(frozen=True)
class MarkerRange:
    start: int
    end: int
    has_trailing_newline: bool


@dataclass(frozen=True)
class TargetState:
    name: str
    path: Path
    text: str | None
    markers: MarkerRange | None
    bom: bytes = b""

    @property
    def exists(self) -> bool:
        return self.text is not None


@dataclass(frozen=True)
class Context:
    root: Path
    primary: TargetState
    override: TargetState
    fallback: TargetState
    legacy_shadows: tuple[Path, ...]
    warnings: tuple[str, ...]


@dataclass(frozen=True)
class GlobalHost:
    name: str
    targets: tuple[TargetState, ...]
    warnings: tuple[str, ...]
    notes: tuple[str, ...] = ()


@dataclass(frozen=True)
class GlobalContext:
    hosts: tuple[GlobalHost, ...]
    warnings: tuple[str, ...]
    notes: tuple[str, ...] = ()


def _newline(text: str, default: str = "\n") -> str:
    if "\r\n" in text:
        return "\r\n"
    if "\n" in text:
        return "\n"
    if "\r" in text:
        return "\r"
    return default


def _has_line_ending(text: str) -> bool:
    return text.endswith(("\r\n", "\n", "\r"))


def _marker_lines(text: str, marker: str) -> list[tuple[int, int, str]]:
    matches: list[tuple[int, int, str]] = []
    offset = 0
    # Split only at the endings _has_line_ending accepts; str.splitlines() also splits at U+2028 and others.
    for line in io.StringIO(text, newline=""):
        if line.rstrip("\r\n").strip() == marker:
            matches.append((offset, offset + len(line), line))
        offset += len(line)
    return matches


def _parse_markers(
    text: str,
    *,
    start_marker: str = START_MARKER,
    end_marker: str = END_MARKER,
    marker_namespace: str = MARKER_NAMESPACE,
) -> MarkerRange | None:
    start_lines = _marker_lines(text, start_marker)
    end_lines = _marker_lines(text, end_marker)
    start_count = text.count(start_marker)
    end_count = text.count(end_marker)

    if start_count != len(start_lines) or end_count != len(end_lines):
        raise SetupError("managed markers must each occupy their own line")
    if not start_lines and not end_lines:
        if marker_namespace in text:
            raise SetupError("managed marker text is malformed")
        return None
    if len(start_lines) > 1 or len(end_lines) > 1:
        raise SetupError("managed markers are duplicated")
    if len(start_lines) != 1 or len(end_lines) != 1:
        raise SetupError("managed markers are incomplete")

    start, _, _ = start_lines[0]
    end, end_after, end_line = end_lines[0]
    if start >= end:
        raise SetupError("managed markers are out of order")
    return MarkerRange(
        start=start,
        end=end_after,
        has_trailing_newline=_has_line_ending(end_line),
    )


def _read_target(
    name: str,
    path: Path,
    *,
    start_marker: str = START_MARKER,
    end_marker: str = END_MARKER,
    marker_namespace: str = MARKER_NAMESPACE,
) -> TargetState:
    try:
        if path.is_symlink():
            raise SetupError(f"refusing symlink instruction target: {path}")
        if not path.exists():
            return TargetState(name, path, None, None)
        if not path.is_file():
            raise SetupError(f"instruction target is not a regular file: {path}")
        raw = path.read_bytes()
    except OSError as exc:
        raise SetupError(f"could not inspect instruction target {path}: {exc}") from exc
    # Some editors save a byte-order mark before the start marker; it is not content.
    bom = codecs.BOM_UTF8 if raw.startswith(codecs.BOM_UTF8) else b""
    try:
        text = raw[len(bom) :].decode("utf-8")
    except UnicodeDecodeError as exc:
        raise SetupError(f"instruction target is not UTF-8: {path}") from exc
    return TargetState(
        name,
        path,
        text,
        _parse_markers(
            text,
            start_marker=start_marker,
            end_marker=end_marker,
            marker_namespace=marker_namespace,
        ),
        bom,
    )


def _validate_not_symlink(path: Path, label: str) -> None:
    """Reject a symlink at a directory the helper writes in, whether or not it exists yet.

    Its ancestors may be links, such as a linked HOME or /home.
    """

    try:
        if path.is_symlink():
            raise SetupError(f"refusing symlink {label}: {path}")
    except OSError as exc:
        raise SetupError(f"could not inspect {label} {path}: {exc}") from exc


def _validate_global_base(path: Path, label: str) -> Path:
    _validate_not_symlink(path, label)
    try:
        if path.exists() and not path.is_dir():
            raise SetupError(f"global {label} is not a directory: {path}")
    except OSError as exc:
        raise SetupError(f"could not inspect global {label} {path}: {exc}") from exc
    return path


def _configured_global_base(environment_name: str, default_directory: str, label: str) -> Path:
    configured = os.environ.get(environment_name)
    if configured is None:
        base = Path.home() / default_directory
    elif not configured:
        raise SetupError(f"{environment_name} must not be empty")
    else:
        base = Path(configured)
        if not base.is_absolute():
            raise SetupError(f"{environment_name} must be an absolute path")
    return _validate_global_base(base, label)


def _global_file(name: str, path: Path) -> TargetState:
    _validate_not_symlink(path.parent, "global instruction parent")
    state = _read_target(
        name,
        path,
        start_marker=GLOBAL_START_MARKER,
        end_marker=GLOBAL_END_MARKER,
        marker_namespace=GLOBAL_MARKER_NAMESPACE,
    )
    return state


def _validate_fallback_ancestors(root: Path) -> None:
    claude = root / ".claude"
    rules = claude / "rules"
    for path in (claude, rules):
        try:
            if path.is_symlink():
                raise SetupError(f"refusing symlink fallback directory: {path}")
            if path.exists() and not path.is_dir():
                raise SetupError(f"fallback parent is not a directory: {path}")
        except OSError as exc:
            raise SetupError(f"could not inspect fallback directory {path}: {exc}") from exc


def _legacy_shadow_files(root: Path) -> tuple[Path, ...]:
    found: list[Path] = []
    ancestor = root
    primary = root / "AGENTS.md"
    user_claude_memory = Path.home().resolve() / ".claude" / "CLAUDE.md"
    while True:
        for relative in ("CLAUDE.md", ".claude/CLAUDE.md", "CLAUDE.local.md"):
            candidate = ancestor / relative
            if candidate == user_claude_memory:
                continue
            try:
                # A symlink to AGENTS.md still loads it after enable replaces the file; a hard link keeps the old text.
                if candidate.is_file() and candidate.resolve() != primary:
                    found.append(candidate)
            except OSError as exc:
                raise SetupError(f"could not inspect legacy instruction file {candidate}: {exc}") from exc
        parent = ancestor.parent
        if parent == ancestor:
            break
        ancestor = parent
    return tuple(found)


def _outdated_warning(target: TargetState, block_lines: Sequence[str], command: str) -> str | None:
    """A managed block whose text enable would rewrite was saved by an earlier version."""
    if target.markers is None or target.text is None:
        return None
    if _replace_block(target.text, target.markers, block_lines) == target.text:
        return None
    return f"Compound rule is from an earlier version at {target.path}. Run {command} to update it."


def _warning_list(
    override: TargetState,
    fallback: TargetState,
    shadows: Iterable[Path],
    primary: TargetState | None = None,
) -> list[str]:
    warnings: list[str] = []
    for state in (primary, override, fallback):
        if state is not None and (warning := _outdated_warning(state, BLOCK_LINES, "compound refresh")) is not None:
            warnings.append(warning)
    if override.exists and override.text and override.text.strip() and override.markers is None:
        warnings.append(f"AGENTS.override.md may shadow AGENTS.md without managed routing: {override.path}")
    if shadows and fallback.markers is None:
        for path in shadows:
            warnings.append(f"Claude instruction may shadow AGENTS.md without managed fallback: {path}")
    if (fallback.text or "").strip() and fallback.markers is None:
        warnings.append(f"Claude fallback contains unmanaged content and was left unchanged: {fallback.path}")
    if fallback.exists and not shadows and fallback.markers is not None:
        warnings.append(f"Managed Claude fallback has no current legacy shadow: {fallback.path}")
    return warnings


def _load_context(root: Path) -> Context:
    _validate_fallback_ancestors(root)
    primary_path = root / "AGENTS.md"
    override_path = root / "AGENTS.override.md"
    fallback_path = root / ".claude" / "rules" / "compound.md"

    # Read every candidate before validating any marker or planning a write.
    primary = _read_target("AGENTS.md", primary_path)
    override = _read_target("AGENTS.override.md", override_path)
    fallback = _read_target(".claude/rules/compound.md", fallback_path)
    shadows = _legacy_shadow_files(root)

    warnings = _warning_list(override, fallback, shadows, primary)
    return Context(root, primary, override, fallback, shadows, tuple(warnings))


GLOBAL_HOST_NAMES = ("codex", "cursor", "claude")
HOST_LABELS = {"codex": "Codex", "cursor": "Cursor", "claude": "Claude Code"}


def _host_home(name: str) -> Path:
    if name == "codex":
        return _configured_global_base("CODEX_HOME", ".codex", "Codex home")
    if name == "claude":
        return _configured_global_base("CLAUDE_CONFIG_DIR", ".claude", "Claude configuration directory")
    return Path.home() / ".cursor"


def _installed_hosts() -> tuple[tuple[str, ...], tuple[str, ...]]:
    """The apps whose configuration folder exists, and a note for each one skipped.

    Default setup and status use these apps. --host names one app, and --host all selects every supported host.
    """
    selected: list[str] = []
    notes: list[str] = []
    for name in GLOBAL_HOST_NAMES:
        home = _host_home(name)
        if home.is_dir():
            selected.append(name)
        else:
            notes.append(f"Skipped {HOST_LABELS[name]}: {home} does not exist. Use --host {name} to select it explicitly.")
    return tuple(selected), tuple(notes)


def _global_target_warning(target: TargetState, description: str) -> str | None:
    if target.exists and (target.text or "").strip() and target.markers is None:
        return f"{description} contains unmanaged content and was left unchanged: {target.path}"
    return _outdated_warning(target, GLOBAL_BLOCK_LINES, "compound refresh global")


def _load_global_context(host_names: Sequence[str]) -> GlobalContext:
    hosts: list[GlobalHost] = []
    for name in host_names:
        if name == "codex":
            base = _configured_global_base("CODEX_HOME", ".codex", "Codex home")
            targets = (
                _global_file("global AGENTS.md", base / "AGENTS.md"),
                _global_file("global AGENTS.override.md", base / "AGENTS.override.md"),
            )
            warnings = [
                warning
                for target, description in zip(
                    targets,
                    ("Global AGENTS.md", "Global AGENTS.override.md"),
                )
                if (warning := _global_target_warning(target, description)) is not None
            ]
        elif name == "claude":
            base = _configured_global_base(
                "CLAUDE_CONFIG_DIR", ".claude", "Claude configuration directory"
            )
            targets = (
                _global_file(
                    "global Claude compound rule",
                    base / "rules" / "compound-skills.md",
                ),
            )
            warnings = [
                warning
                for target in targets
                if (warning := _global_target_warning(target, "Global Claude rule")) is not None
            ]
        elif name == "cursor":
            # Cursor's supported user-scope path is the native plugin rule;
            # this helper deliberately never writes ~/.cursor or app state.
            hosts.append(GlobalHost(name, (), (), (CURSOR_HOST_NOTE,)))
            continue
        else:
            raise SetupError(f"unknown global host: {name}")
        hosts.append(GlobalHost(name, targets, tuple(warnings)))
    return GlobalContext(
        tuple(hosts),
        tuple(warning for host in hosts for warning in host.warnings),
        tuple(note for host in hosts for note in host.notes),
    )


def _global_preferred_newline(context: GlobalContext) -> str:
    for host in context.hosts:
        for target in host.targets:
            if target.text:
                return _newline(target.text)
    return "\n"


def _global_enable_dedicated(
    target: TargetState,
    preferred_newline: str,
) -> str:
    if target.markers is not None:
        return _replace_block(target.text or "", target.markers, GLOBAL_BLOCK_LINES)
    if target.exists and (target.text or "").strip():
        raise SetupError(f"refusing to overwrite unmanaged global rule: {target.path}")
    return _canonical_block(preferred_newline, False, GLOBAL_BLOCK_LINES)


def _global_enable_plans(context: GlobalContext) -> list[tuple[TargetState, str, bool]]:
    preferred = _global_preferred_newline(context)
    plans: list[tuple[TargetState, str, bool]] = []
    for host in context.hosts:
        if host.name == "codex":
            primary, override = host.targets
            for state in (primary, override):
                if state is override and not state.exists:
                    continue
                text = state.text or ""
                if state is override and not text.strip() and state.markers is None:
                    continue
                new_text = (
                    _replace_block(text, state.markers, GLOBAL_BLOCK_LINES)
                    if state.markers
                    else _append_block(text, preferred, GLOBAL_BLOCK_LINES)
                )
                if new_text != text:
                    plans.append((state, new_text, False))
        elif host.name == "claude":
            target = host.targets[0]
            new_text = _global_enable_dedicated(target, preferred)
            if new_text != (target.text or ""):
                plans.append((target, new_text, False))
        elif host.name == "cursor":
            # Cursor is configured by its native user-scope plugin rule.
            continue
    return plans


def _global_disable_plans(context: GlobalContext) -> list[tuple[TargetState, str, bool]]:
    plans: list[tuple[TargetState, str, bool]] = []
    for host in context.hosts:
        if host.name == "cursor":
            continue
        for state in host.targets:
            if not state.exists or state.markers is None:
                continue
            new_text = _remove_block(state.text or "", state.markers)
            remove_file = not new_text.strip()
            if remove_file or new_text != (state.text or ""):
                plans.append((state, new_text, remove_file))
    return plans


def _global_host_status(host: GlobalHost) -> str:
    if host.name == "cursor":
        return "host-managed"
    if host.name == "codex":
        primary, override = host.targets
        primary_managed = primary.markers is not None
        override_managed = (
            not override.exists
            or not (override.text or "").strip()
            or override.markers is not None
        )
        any_managed = primary.markers is not None or override.markers is not None
        base = "enabled" if primary_managed and override_managed else ("partial" if any_managed else "disabled")
    else:
        target = host.targets[0]
        managed = target.markers is not None
        base = "enabled" if managed else "disabled"
    return base + "-with-warnings" if host.warnings else base


def _global_status_name(context: GlobalContext) -> str:
    bases = {_global_host_status(host).removesuffix("-with-warnings") for host in context.hosts}
    # Host-managed hosts set the aggregate only when no helper-managed host is selected.
    helper_bases = bases - {"host-managed"}
    if not helper_bases:
        base = "host-managed" if bases else "disabled"
    elif helper_bases == {"disabled"}:
        base = "disabled"
    elif helper_bases == {"enabled"}:
        base = "enabled"
    else:
        base = "partial"
    return base + "-with-warnings" if context.warnings else base


CLAUDE_RULES_ELSEWHERE_NOTE = ("This copy of Compound belongs to {app}, so Claude Code allow rules would name a folder Claude Code "
                               "does not run; run this from Claude Code to add or remove its allow rules.")


def _other_app_holding_this_install() -> str | None:
    """The other app whose folder holds this copy of the plugin; Claude Code's allow rules must name its own copy."""
    here = Path(__file__).resolve()
    for name in ("codex", "cursor"):
        try:
            home = _host_home(name).resolve()
        except SetupError:
            continue
        if here.is_relative_to(home):
            return HOST_LABELS[name]
    return None


def _claude_permission_rules() -> list[str]:
    """Offer stable rules only from Claude's installed Compound copy."""
    try:
        try:
            from .claude_map_launcher import CACHE, SCRIPT, config_home, permission_rules
        except ImportError:
            from claude_map_launcher import CACHE, SCRIPT, config_home, permission_rules
        base = config_home()
        path = Path(__file__).resolve().with_name(SCRIPT.name)
        if os.name == "posix" and path.is_relative_to(base / CACHE):
            relative = path.relative_to(base / CACHE)
            if Path(*relative.parts[1:]) == SCRIPT:
                return permission_rules(base)
    except (ImportError, OSError, ValueError, RuntimeError):
        pass
    return []


MAX_CLAUDE_SETTINGS_BYTES = 1024 * 1024


def _claude_permission_check(rules: Sequence[str]) -> dict[str, object]:
    """Check literal allow entries in Claude Code's user settings."""
    try:
        base = _host_home("claude")
        # Allow a linked home ancestor while keeping the config directory and settings file no-follow.
        canonical = base.parent.resolve() / base.name
        if not rules or not Path(__file__).resolve().is_relative_to(canonical):
            return {"status": "unavailable", "message": "Run the permission check from Claude Code's installed copy."}
        try:
            from .safe_open import open_regular_nofollow
        except ImportError:  # direct script execution
            from safe_open import open_regular_nofollow
        with os.fdopen(open_regular_nofollow(canonical, "settings.json"), "rb") as settings:
            data = settings.read(MAX_CLAUDE_SETTINGS_BYTES + 1)
        if len(data) > MAX_CLAUDE_SETTINGS_BYTES:
            raise ValueError("settings exceed the size limit")
        document = json.loads(data)
        permissions = document.get("permissions", {}) if isinstance(document, dict) else None
        allowed = permissions.get("allow", []) if isinstance(permissions, dict) else None
        if not isinstance(allowed, list) or not all(isinstance(rule, str) for rule in allowed):
            raise ValueError("invalid allow list")
    except FileNotFoundError:
        allowed = []
    except (OSError, ValueError, RuntimeError):
        return {"status": "unavailable", "message": "Could not safely inspect Claude Code's user settings."}

    missing = [rule for rule in rules if rule not in allowed]
    if missing:
        return {
            "status": "missing",
            "missing_rules": missing,
            "message": "Run setup-global in Claude Code to add the missing rules for this installation.",
        }
    try:
        try:
            from .claude_map_launcher import LAUNCHER, _read_owned, current_install
        except ImportError:
            from claude_map_launcher import LAUNCHER, _read_owned, current_install
        current_install(canonical)
        if not _read_owned(canonical, LAUNCHER):
            raise ValueError("launcher is empty")
    except (OSError, ValueError, TypeError, AttributeError, RuntimeError):
        return {"status": "missing", "missing_rules": [],
                "message": "Run setup-global in Claude Code to prepare the stable map launcher."}
    return {"status": "present", "missing_rules": []}


def _global_payload(
    action: str,
    status: str,
    changed: bool,
    context: GlobalContext | None,
    *,
    error: str | None = None,
    changed_paths: Sequence[str] = (),
    check_claude_permissions: bool = False,
) -> dict[str, object]:
    hosts: dict[str, object] = {}
    notes: list[str] = [GLOBAL_PREREQUISITE]
    path = ""
    warnings: list[str] = []
    if context is not None:
        notes.extend(context.notes)
        warnings.extend(context.warnings)
        for host in context.hosts:
            host_status = _global_host_status(host)
            base_status = host_status.removesuffix("-with-warnings")
            target_paths = [str(target.path) for target in host.targets]
            if not path and target_paths:
                path = target_paths[0]
            host_notes = list(host.notes)
            if action == "disable" and host.name == "cursor":
                host_notes.append(CURSOR_DISABLE_NOTE)
                notes.append(CURSOR_DISABLE_NOTE)
            hosts[host.name] = {
                "status": host_status,
                "configured": base_status == "enabled",
                "paths": target_paths,
                "warnings": list(host.warnings),
                "notes": host_notes,
            }
            if host.name == "cursor":
                hosts[host.name]["managed_by"] = "native Cursor user-scope plugin rule"
                hosts[host.name]["runtime_verified"] = False
            if host.name == "claude":
                other = _other_app_holding_this_install()
                rules = [] if other else _claude_permission_rules()
                hosts[host.name]["permission_rules"] = rules
                if check_claude_permissions:
                    hosts[host.name]["permission_check"] = _claude_permission_check(rules)
                if other:
                    note = CLAUDE_RULES_ELSEWHERE_NOTE.format(app=other)
                    hosts[host.name]["notes"].append(note)
                    notes.append(note)
    value: dict[str, object] = {
        "action": action,
        "status": status,
        "changed": changed,
        "path": path,
        "warnings": warnings,
        "scope": GLOBAL_STATUS_SCOPE,
        "scope_detail": GLOBAL_SCOPE_DETAIL,
        "prerequisite": GLOBAL_PREREQUISITE,
        "notes": list(dict.fromkeys(notes)),
        "hosts": hosts,
    }
    if error is not None:
        value["error"] = error
    if changed_paths:
        value["changed_paths"] = list(changed_paths)
    return value


def _canonical_block(
    newline: str,
    trailing: bool,
    block_lines: Sequence[str] = BLOCK_LINES,
) -> str:
    block = newline.join(block_lines)
    return block + (newline if trailing else "")


def _append_block(
    text: str,
    preferred_newline: str,
    block_lines: Sequence[str] = BLOCK_LINES,
) -> str:
    newline = _newline(text, preferred_newline)
    if not text:
        return _canonical_block(newline, False, block_lines)
    if _has_line_ending(text):
        return text + _canonical_block(newline, True, block_lines)
    return text + newline + _canonical_block(newline, False, block_lines)


def _replace_block(
    text: str,
    markers: MarkerRange,
    block_lines: Sequence[str] = BLOCK_LINES,
) -> str:
    newline = _newline(text)
    return (
        text[: markers.start]
        + _canonical_block(newline, markers.has_trailing_newline, block_lines)
        + text[markers.end :]
    )


def _remove_block(text: str, markers: MarkerRange) -> str:
    before = text[: markers.start]
    if not markers.has_trailing_newline:
        # Enable separates a block it appends to a file without a final
        # newline by one line ending; remove that separator again.
        before = before.removesuffix("\n").removesuffix("\r")
    return before + text[markers.end :]


def _preferred_newline(context: Context) -> str:
    for state in (context.primary, context.override, context.fallback):
        if state.text:
            return _newline(state.text)
    return "\n"


def _planned_enable(context: Context) -> list[tuple[TargetState, str, bool]]:
    preferred = _preferred_newline(context)
    plans: list[tuple[TargetState, str, bool]] = []

    for state in (context.primary, context.override):
        if not state.exists and state is context.override:
            continue
        text = state.text or ""
        if state is context.override and not text.strip() and state.markers is None:
            continue
        new_text = _replace_block(text, state.markers) if state.markers else _append_block(text, preferred)
        if new_text != text:
            plans.append((state, new_text, False))

    if context.legacy_shadows:
        fallback = context.fallback
        user_claude = Path(os.environ.get("CLAUDE_CONFIG_DIR") or Path.home() / ".claude").resolve()
        if context.root / ".claude" == user_claude:
            # Claude loads rules there for every project, so this would be a global default.
            raise SetupError(f"refusing to write project Claude rule into user Claude configuration: {fallback.path}")
        if fallback.markers is not None:
            new_text = _replace_block(fallback.text or "", fallback.markers)
        elif (fallback.text or "").strip():
            raise SetupError(f"refusing to overwrite unmanaged Claude fallback: {fallback.path}")
        else:
            new_text = _canonical_block(preferred, False)
        if new_text != (fallback.text or ""):
            plans.append((fallback, new_text, False))
    return plans


def _planned_refresh(
    targets: Iterable[TargetState], block_lines: Sequence[str],
) -> list[tuple[TargetState, str, bool]]:
    plans = []
    for state in targets:
        if state.markers is None or state.text is None:
            continue
        new_text = _replace_block(state.text, state.markers, block_lines)
        if new_text != state.text:
            plans.append((state, new_text, False))
    return plans


def _planned_disable(context: Context) -> list[tuple[TargetState, str, bool]]:
    plans: list[tuple[TargetState, str, bool]] = []
    for state in (context.primary, context.override, context.fallback):
        if not state.exists or state.markers is None:
            continue
        new_text = _remove_block(state.text or "", state.markers)
        remove_file = not new_text.strip()
        if remove_file or new_text != (state.text or ""):
            plans.append((state, new_text, remove_file))
    return plans


@dataclass
class StagedPlan:
    state: TargetState
    text: str
    remove_file: bool
    temporary: Path | None = None


def _stage(plans: Iterable[tuple[TargetState, str, bool]]) -> list[StagedPlan]:
    staged: list[StagedPlan] = []
    try:
        for state, text, remove_file in plans:
            item = StagedPlan(state, text, remove_file)
            if not remove_file:
                state.path.parent.mkdir(parents=True, exist_ok=True)
                descriptor, temporary = tempfile.mkstemp(
                    prefix=f".{state.path.name}.compound-setup-",
                    dir=state.path.parent,
                )
                item.temporary = Path(temporary)
                staged.append(item)
                with os.fdopen(descriptor, "wb") as handle:
                    handle.write(state.bom + text.encode("utf-8"))
                    handle.flush()
                    os.fsync(handle.fileno())
                if state.exists:
                    mode = stat.S_IMODE(state.path.stat().st_mode)
                else:
                    mode = 0o644
                os.chmod(item.temporary, mode)
            else:
                staged.append(item)
    except OSError as exc:
        _cleanup_staged(staged)
        raise SetupError(f"could not stage project setup writes: {exc}") from exc
    return staged


def _cleanup_staged(staged: Iterable[StagedPlan]) -> None:
    for item in staged:
        if item.temporary is None:
            continue
        try:
            item.temporary.unlink()
        except FileNotFoundError:
            pass
        except OSError:
            pass
        item.temporary = None


def _require_unchanged_target(state: TargetState) -> None:
    """Compare the live instruction file with the snapshot used to plan the write."""
    try:
        mode = state.path.lstat().st_mode
        if not stat.S_ISREG(mode):
            raise SetupError(f"instruction target is no longer a regular file: {state.path}")
        current = state.path.read_bytes()
    except FileNotFoundError:
        current = None
    except OSError as exc:
        raise SetupError(f"could not recheck instruction target {state.path}: {exc}") from exc
    expected = None if state.text is None else state.bom + state.text.encode("utf-8")
    if current != expected:
        raise SetupError(f"instructions changed during setup: {state.path}. Rerun to use the latest text.")


def _apply(plans: Iterable[tuple[TargetState, str, bool]]) -> tuple[bool, tuple[str, ...]]:
    staged = _stage(plans)
    changed_paths: list[str] = []
    try:
        for item in staged:
            _require_unchanged_target(item.state)
        # Replace all staged files before deleting any emptied file.
        for item in sorted(staged, key=lambda item: item.remove_file):
            _require_unchanged_target(item.state)
            if item.remove_file:
                try:
                    item.state.path.unlink()
                except OSError as exc:
                    raise SetupError(f"could not remove {item.state.path}: {exc}") from exc
            else:
                assert item.temporary is not None
                try:
                    os.replace(item.temporary, item.state.path)
                except OSError as exc:
                    raise SetupError(f"could not atomically update {item.state.path}: {exc}") from exc
                item.temporary = None
            changed_paths.append(str(item.state.path))
    except SetupError as exc:
        raise ApplyError(str(exc), changed_paths) from exc
    finally:
        _cleanup_staged(staged)
    return bool(changed_paths), tuple(changed_paths)


def _status_name(context: Context) -> str:
    primary_managed = context.primary.markers is not None
    override_managed = (
        not context.override.exists
        or not (context.override.text or "").strip()
        or context.override.markers is not None
    )
    fallback_managed = not context.legacy_shadows or context.fallback.markers is not None
    any_managed = any(
        state.markers is not None for state in (context.primary, context.override, context.fallback)
    )
    if primary_managed and override_managed and fallback_managed:
        base = "enabled"
    elif any_managed:
        base = "partial"
    else:
        base = "disabled"
    return base + "-with-warnings" if context.warnings else base


def _payload(
    action: str,
    status: str,
    changed: bool,
    path: Path | None,
    warnings: Sequence[str],
    *,
    error: str | None = None,
    changed_paths: Sequence[str] = (),
) -> dict[str, object]:
    value: dict[str, object] = {
        "action": action,
        "status": status,
        "changed": changed,
        "path": str(path) if path is not None else "",
        "warnings": list(warnings),
        "scope": STATUS_SCOPE,
    }
    if error is not None:
        value["error"] = error
    if changed_paths:
        value["changed_paths"] = list(changed_paths)
    return value


def _emit(value: dict[str, object]) -> int:
    try:
        print(json.dumps(value, ensure_ascii=False))
    except UnicodeEncodeError:
        # A strict stdout, as under en_US.UTF-8, cannot encode undecodable path bytes; the files are already written.
        print(json.dumps(value))
    return 0 if value["status"] != "error" else 2


def _resolve_root(raw: str) -> Path:
    lexical = Path(raw)
    if not lexical.is_absolute():
        lexical = Path.cwd() / lexical
    try:
        if lexical.is_symlink():
            raise SetupError(f"project root may not be a symlink: {lexical}")
        root = lexical.resolve(strict=True)
    except SetupError:
        raise
    except OSError as exc:
        raise SetupError(f"could not resolve project root {lexical}: {exc}") from exc
    if not root.is_dir():
        raise SetupError(f"project root is not a directory: {root}")
    return root


def _parser() -> argparse.ArgumentParser:
    parser = JsonArgumentParser(
        description="Enable, refresh, inspect, or disable bounded Compound Skills routing blocks."
    )
    parser.add_argument("action", nargs="?", help="enable, refresh, status, or disable")
    scope = parser.add_mutually_exclusive_group()
    scope.add_argument("--project-root", metavar="PATH", help="project root")
    scope.add_argument("--global", dest="global_scope", action="store_true", help="use global user instruction files")
    parser.add_argument("--host", choices=("all", "codex", "cursor", "claude"), help="global host selection")
    parser.add_argument("--check-claude-permissions", action="store_true",
                        help="check user allow entries with status --global --host claude")
    parser.add_argument("--quiet", action="store_true",
                        help="suppress success output from a single-host global refresh")
    return parser


def _action_hint(argv: Sequence[str] | None) -> str:
    if not argv:
        return ""
    for value in argv:
        if not value.startswith("-"):
            return value
    return ""


def main(argv: Sequence[str] | None = None) -> int:
    argv_list = list(sys.argv[1:] if argv is None else argv)
    try:
        args = _parser().parse_args(argv_list)
    except (UsageError, SystemExit) as exc:
        if isinstance(exc, SystemExit):
            raise
        return _emit(_payload(_action_hint(argv_list), "error", False, None, [], error=str(exc)))

    action = args.action or ""
    if action not in {"enable", "refresh", "status", "disable"}:
        return _emit(_payload(action, "error", False, None, [], error="action must be enable, refresh, status, or disable"))
    if args.host is not None and not args.global_scope:
        return _emit(_payload(action, "error", False, None, [], error="--host requires --global"))
    if args.check_claude_permissions and (action != "status" or not args.global_scope or args.host != "claude"):
        return _emit(_payload(action, "error", False, None, [],
                              error="--check-claude-permissions requires status --global --host claude"))
    if args.quiet and (action != "refresh" or not args.global_scope or args.host not in {"codex", "claude"}):
        return _emit(_payload(action, "error", False, None, [],
                              error="--quiet requires refresh --global --host codex or claude"))
    if args.global_scope:
        global_context: GlobalContext | None = None
        try:
            skipped: tuple[str, ...] = ()
            if args.host is None and action in {"enable", "refresh", "status"}:
                host_names, skipped = _installed_hosts()
                if action == "enable" and not host_names:
                    raise SetupError("no Claude Code, Codex or Cursor configuration folder found; add --host to choose an app")
            else:
                host_names = GLOBAL_HOST_NAMES if args.host in (None, "all") else (args.host,)
            global_context = _load_global_context(host_names)
            global_context = replace(global_context, notes=global_context.notes + skipped)
            if action == "status":
                return _emit(
                    _global_payload(
                        action,
                        _global_status_name(global_context),
                        False,
                        global_context,
                        check_claude_permissions=args.check_claude_permissions,
                    )
                )
            if action == "refresh":
                targets = (target for host in global_context.hosts for target in host.targets)
                plans = _planned_refresh(targets, GLOBAL_BLOCK_LINES)
            elif action == "enable":
                plans = _global_enable_plans(global_context)
            else:
                plans = _global_disable_plans(global_context)
            changed, changed_paths = _apply(plans)
            if args.quiet:
                return 0
            after = _load_global_context(host_names)
            after = replace(after, notes=after.notes + skipped)
            return _emit(
                _global_payload(
                    action,
                    _global_status_name(after),
                    changed,
                    after,
                    changed_paths=changed_paths,
                )
            )
        except SetupError as exc:
            if args.quiet:
                print(f"Compound Skills global refresh: {exc}", file=sys.stderr)
                return 1
            changed_paths = exc.changed_paths if isinstance(exc, ApplyError) else ()
            return _emit(
                _global_payload(
                    action,
                    "error",
                    bool(changed_paths),
                    global_context,
                    error=str(exc),
                    changed_paths=changed_paths,
                )
            )
    if not args.project_root:
        return _emit(_payload(action, "error", False, None, [], error="--project-root is required"))

    try:
        root = _resolve_root(args.project_root)
        context = _load_context(root)
        path = context.primary.path
        if action == "status":
            return _emit(_payload(action, _status_name(context), False, path, context.warnings))
        if action == "refresh":
            plans = _planned_refresh((context.primary, context.override, context.fallback), BLOCK_LINES)
        elif action == "enable":
            plans = _planned_enable(context)
        else:
            plans = _planned_disable(context)
        changed, changed_paths = _apply(plans)
        after = _load_context(root)
        return _emit(
            _payload(
                action,
                _status_name(after),
                changed,
                path,
                after.warnings,
                changed_paths=changed_paths,
            )
        )
    except ApplyError as exc:
        return _emit(
            _payload(
                action,
                "error",
                bool(exc.changed_paths),
                context.primary.path if "context" in locals() else None,
                context.warnings if "context" in locals() else (),
                error=str(exc),
                changed_paths=exc.changed_paths,
            )
        )
    except SetupError as exc:
        return _emit(_payload(action, "error", False, None, [], error=str(exc)))


if __name__ == "__main__":
    raise SystemExit(main())
