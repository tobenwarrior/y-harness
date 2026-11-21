#!/usr/bin/env python3
"""Deterministic, read-only-by-default repository hygiene review aid.

Path, size, naming, and textual-reference checks are heuristics, not proof of
architecture, correctness, ownership, or dead code. The checker never deletes
project files; only ``--write-baseline`` writes its baseline. It audits tracked
and untracked-not-ignored files, with a filesystem fallback outside Git.

Usage: python3 repo_audit.py [PATH] [--strict] [--json] [--no-color]
Exit codes: 0 unblocked, 1 active violations, 2 invalid path/configuration or a failed run.
Config: .repo-audit.toml or [tool.repo_audit] in pyproject.toml.
"""

from __future__ import annotations

import argparse
import fnmatch
import json
import os
import re
import stat
import subprocess
import sys
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field, replace
from pathlib import Path

try:
    from .safe_open import open_regular_files_nofollow
except ImportError:  # direct script execution
    from safe_open import open_regular_files_nofollow

try:
    import tomllib  # py3.11+
except ModuleNotFoundError:  # pragma: no cover - older interpreters
    tomllib = None


class ConfigError(ValueError):
    """The optional audit configuration is malformed or invalid."""

FAIL, WARN = "FAIL", "WARN"

# Noise dirs pruned at ANY depth: namespaced/vendored/dotted, so colliding with a
# real source dir is implausible.
NOISE_DIRS_ANY = {
    ".git", ".venv", "node_modules", "__pycache__", ".pytest_cache", ".mypy_cache",
    ".ruff_cache", ".cache", ".next", ".turbo", ".gradle",
}
# Generic names pruned ONLY as the top-level component — a tracked src/build/ or
# src/env/ is real source and must still be audited.
NOISE_DIRS_ROOT = {"venv", "env", "build", "dist", "target", "out"}
# Root env/ and venv/ count as dependency folders only when these files show a Python environment.
VENV_MARKERS = ("pyvenv.cfg", "bin/activate", "Scripts/activate", "conda-meta/history")
WORKTREE_DIRS = (".claude/worktrees", ".worktrees")

# Files allowed at repo root (exact names). Anything else at root is a defect.
ROOT_FILE_ALLOW = {
    "README.md", "README.rst", "README", "LICENSE", "LICENSE.md", "LICENSE.txt",
    "COPYING", "NOTICE", "CHANGELOG.md", "CONTRIBUTING.md", "CODE_OF_CONDUCT.md",
    "SECURITY.md", "AUTHORS", "Makefile", "GNUmakefile", "Dockerfile",
    "docker-compose.yml", "docker-compose.yaml", "package.json", "package-lock.json",
    "pnpm-lock.yaml", "yarn.lock", "bun.lockb", "pyproject.toml", "setup.py",
    "setup.cfg", "tox.ini", "poetry.lock", "uv.lock", "Pipfile", "Pipfile.lock",
    "Cargo.toml", "Cargo.lock", "go.mod", "go.sum", "mkdocs.yml", "netlify.toml",
    "vercel.json", "tsconfig.json", "jsconfig.json", "babel.config.js",
    "jest.config.js", "pytest.ini", "mypy.ini", "ruff.toml",
    "AGENTS.md", "CLAUDE.md", "GEMINI.md",  # agent-instruction files
    # Standard manifests and entry points of other ecosystems.
    "pom.xml", "gradle.properties", "Gemfile", "Gemfile.lock", "Rakefile", "composer.json", "composer.lock",
    "Package.swift", "Package.resolved", "CMakeLists.txt", "global.json", "manage.py", "conftest.py",
    "noxfile.py", "MANIFEST.in", "pnpm-workspace.yaml", "index.html", "CITATION.cff", "CODEOWNERS",
    "Procfile", "Justfile", "justfile", "Brewfile", "flake.nix", "flake.lock", "deno.json", "deno.jsonc",
    "turbo.json", "nx.json", "lerna.json", "biome.json", "renovate.json", "rust-toolchain.toml",
    "rustfmt.toml", "environment.yml", "CHANGES.md", "HISTORY.md", "SUPPORT.md", "GOVERNANCE.md",
}
# Dotfiles / config globs allowed at root (tool config varies widely).
ROOT_ALLOW_GLOBS = [
    ".*",  # dotfiles at root are tool config; .DS_Store is caught by litter rules
    "Dockerfile*", "docker-compose*.yml", "docker-compose*.yaml", "requirements*.txt",
    "tsconfig*.json", "*.code-workspace", "*.cabal", "build.gradle*", "settings.gradle*", "gradlew*",
    "*.gemspec", "*.sln", "*.csproj", "Directory.Build.*", "go.work*", "*.config.js", "*.config.mjs",
    "*.config.cjs", "*.config.ts", "*.config.mts", "LICENSE-*",
]

# Litter basename globs: files that should not be in the repo at all (FAIL).
LITTER_BASENAMES = [
    ".DS_Store", "Thumbs.db", "desktop.ini",
    "*_REVIEW.md", "*_FINDINGS.md", "REVIEW_*.md", "FINDINGS_*.md",
    "OVERNIGHT_*.md", "MORNING_*.md", "NIGHT_*.md", "EVENING_*.md",
    "*_STATE.md", "*_LOOP_*.md", "LOOP_*.md",
    "plan.md", "PLAN.md", "NOTES.md", "SCRATCH*.md", "scratch*.md", "TEMP*.md", "tmp*.md",
    "analyze_*.py", "probe_*.py", "debug_*.py", "scratch*.py", "tmp_*.py", "try_*.py",
]
# Binary/asset extensions only allowed under these "home" dirs.
ASSET_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".pdf", ".ico", ".svg"}
ASSET_HOMES = {"docs", "doc", "assets", "public", "static", "media", "images", "img", "artifacts", ".github"}
# Data-dump extensions only allowed under these dirs.
DUMP_EXTS = {".jsonl"}
DUMP_HOMES = {"data", "artifacts", "tests", "test", "fixtures"}

# Date-stamped experiment folders + scratch/backup dirs at repo root: agent-loop
# output, not project structure.
DATE_STAMP_RE = re.compile(r"\d{4}[-_]\d{2}[-_]\d{2}")
JUNK_DIR_GLOBS = ["tmp", "temp", "scratch", "scratch*", "backup", "backups", "bak",
                  "old", "*_old", "*-old", "copy", "*-copy"]
# Unambiguous loop-litter names. Flagged even when gitignored (hiding != cleaning),
# and never legitimate to allowlist. Kept tight to avoid false positives.
LOOP_LITTER_GLOBS = ["OVERNIGHT_*", "MORNING_*", "NIGHT_*", "EVENING_*", "*_LOOP_*.md",
                     "LOOP_*.md", "*_STATE.md", "plan.md", "PLAN.md", "*_REVIEW.md",
                     "*_FINDINGS.md", "REVIEW_*.md", "analyze_*.py", "probe_*.py",
                     "scratch*.py", "tmp_*.py"]
# Sanctioned invisible scratch space — never scanned for on-disk litter.
ONDISK_SKIP = {".scratch", "artifacts"}

SOURCE_EXTS = {".py", ".ts", ".tsx", ".js", ".jsx", ".go", ".rs", ".java", ".swift",
               ".rb", ".php", ".c", ".cc", ".cpp", ".h", ".hpp", ".cs", ".kt", ".scala",
               ".m", ".mm", ".lua", ".ex", ".exs"}
ARCH_OK = "ARCH-OK:"  # marker that justifies an oversized-but-cohesive file
MARKER_SCAN_LINES = 60
MAX_READ_BYTES = 8 * 1024 * 1024
# Reference corpus for the unreferenced-script heuristic.
REF_EXTS = SOURCE_EXTS | {".md", ".toml", ".cfg", ".ini", ".yaml", ".yml", ".txt", ".sh",
                          ".json", ".mk"}
REF_NAMES = {"Makefile", "GNUmakefile", "Dockerfile"}
ENTRYPOINT_STEMS = {"main", "__main__", "__init__", "conftest", "setup", "manage", "app", "cli"}


@dataclass
class Config:
    soft_max_lines: int = 800
    hard_max_lines: int = 1500
    # (glob, soft, hard) overrides, first match wins; tests then get twice the limits.
    size_overrides: list = field(default_factory=list)
    max_worktrees: int = 1
    root_allow_extra: list = field(default_factory=list)
    litter_extra: list = field(default_factory=list)
    litter_ignore: list = field(default_factory=list)  # globs to exempt from litter
    junk_dir_extra: list = field(default_factory=list)  # extra root-dir junk globs
    required_gitignore: list = field(default_factory=lambda: [
        ".venv", "__pycache__", ".DS_Store", "*.pyc", ".scratch/",
        ".pytest_cache", ".mypy_cache", ".ruff_cache",
    ])
    check_refs: bool = True


@dataclass
class Finding:
    level: str
    check: str
    path: str
    message: str
    metric: int | None = None  # e.g. line count for size findings; used by baseline


# ---------------------------------------------------------------------------
# file discovery
# ---------------------------------------------------------------------------

def _noise_folder(rel: str, roots: set[str]) -> str | None:
    parts = rel.split("/")
    for index, part in enumerate(parts[:-1]):
        if part in NOISE_DIRS_ANY or index == 0 and part in roots:
            return "/".join(parts[:index + 1]) + "/"
    return None


def _git_files(root: Path, *args: str) -> list[str] | None:
    """Run a `git ls-files` variant with -z and decode names like the filesystem,
    so quoting, carriage returns and non-UTF-8 bytes survive."""
    try:
        out = subprocess.run(["git", "-C", str(root), *args, "-z"], capture_output=True, check=True)
    except (subprocess.CalledProcessError, FileNotFoundError):
        return None
    return [os.fsdecode(p) for p in out.stdout.split(b"\0") if p]


def _excluded(rel: str) -> bool:
    parts = rel.rstrip("/").split("/")
    if any(p in NOISE_DIRS_ANY for p in parts):
        return True
    if parts and parts[0] in NOISE_DIRS_ROOT:
        return True
    return _excluded_worktree(rel)


def _excluded_worktree(rel: str) -> bool:
    return any(rel == w or rel.startswith(w + "/") for w in WORKTREE_DIRS)


def _git_ok(root: Path, *args: str) -> bool:
    try:
        return subprocess.run(["git", "-C", str(root), *args], capture_output=True).returncode == 0
    except OSError:
        return False


def repo_inventory(root: Path) -> tuple[set[str], bool]:
    """Relative POSIX paths that would land in the repo (tracked + untracked-not-ignored), and whether Git listed them."""
    tracked = _git_files(root, "ls-files")
    # A folder that an enclosing repository ignores lists nothing, so audit it from disk.
    if tracked is not None and not (not tracked and _git_ok(root, "check-ignore", "-q", ".")):
        # Onboarding removes obsolete tracked files from the worktree only, so those are gone.
        deleted = _git_files(root, "ls-files", "--deleted") or []
        others = _git_files(root, "ls-files", "--others", "--exclude-standard") or []
        return (set(tracked) - set(deleted)) | set(others), True
    files = set()
    for dirpath, dirnames, filenames in os.walk(root):
        base = Path(dirpath).relative_to(root).as_posix()
        dirnames[:] = [d for d in dirnames if not _excluded(d if base == "." else f"{base}/{d}/") and not (base == "." and d in ONDISK_SKIP)]
        files.update(name if base == "." else f"{base}/{name}" for name in filenames)
    return files, False


def _checkout_target(root: Path, relative: str) -> Path:
    """Resolve an audit input against the canonical checkout."""
    try:
        target = (root / relative).resolve()
    except RuntimeError as error:
        raise OSError(f"{relative}: cannot resolve audit input") from error
    if not target.is_relative_to(root):
        raise OSError(f"{relative}: audit input resolves outside the checkout")
    return target


@contextmanager
def _audit_opener(root: Path) -> Iterator[Callable[[str], int]]:
    """Keep the checkout open while auditing. Resolve aliases only when needed."""
    if os.name == "posix" and os.open in os.supports_dir_fd and hasattr(os, "O_NOFOLLOW"):
        with open_regular_files_nofollow(root) as open_file:
            def open_relative(relative: str) -> int:
                try:
                    return open_file(relative)
                except OSError:
                    target = _checkout_target(root, relative)
                    if target == root / relative:
                        raise
                    return open_file(target.relative_to(root).as_posix())

            yield open_relative
        return

    def open_resolved(relative: str) -> int:
        target = _checkout_target(root, relative)
        return os.open(target, os.O_RDONLY | getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_BINARY", 0))

    yield open_resolved


def _read_audit_text(open_file: Callable[[str], int], relative: str, limit: int = -1, errors: str = "strict") -> str:
    with os.fdopen(open_file(relative), "rb") as handle:
        if not stat.S_ISREG(os.fstat(handle.fileno()).st_mode):
            raise OSError(f"{relative}: audit input must be a regular file")
        data = handle.read(limit)
    return data.decode("utf-8", errors=errors).replace("\r\n", "\n").replace("\r", "\n")


def read_lines(open_file: Callable[[str], int], relative: str) -> list[str] | None:
    """Lines from the first 8 MiB of a regular file inside the checkout."""
    try:
        lines = _read_audit_text(open_file, relative, MAX_READ_BYTES, errors="ignore").split("\n")
    except OSError:
        return None
    return lines[:-1] if lines[-1] == "" else lines


def _match_any(name: str, patterns: list[str]) -> bool:
    return any(fnmatch.fnmatch(name, pat) for pat in patterns)


def _litter_ignored(rel: str, cfg: Config) -> bool:
    # Findings print folders with a trailing slash, so an entry copied from one must match too.
    patterns = [pattern.rstrip("/") for pattern in cfg.litter_ignore]
    return _match_any(rel.rstrip("/"), patterns) or _match_any(Path(rel).name, patterns)


# ---------------------------------------------------------------------------
# checks
# ---------------------------------------------------------------------------

def check_root(root: Path, files: list[str], cfg: Config) -> list[Finding]:
    globs = ROOT_ALLOW_GLOBS + cfg.root_allow_extra
    out = []
    for rel in files:
        if "/" in rel:
            continue
        if rel in ROOT_FILE_ALLOW or _match_any(rel, globs):
            continue
        if _is_litter(rel, cfg):  # the litter check reports it with a more specific reason
            continue
        out.append(Finding(FAIL, "root", rel,
                           "unexpected file at repo root — move to src/tests/docs, "
                           "put scratch in .scratch/, or add to root allowlist"))
    return out


def _is_litter(rel: str, cfg: Config) -> str | None:
    if _litter_ignored(rel, cfg):
        return None
    name = Path(rel).name
    if _match_any(name, LITTER_BASENAMES + cfg.litter_extra):
        return "session/scratch file — delete or promote into a durable, referenced path"
    ext = Path(rel).suffix.lower()
    folders = set(rel.split("/")[:-1])
    if ext in ASSET_EXTS and not folders & ASSET_HOMES:
        return f"stray {ext} asset outside an assets, docs or public folder — move or delete"
    if ext in DUMP_EXTS and not folders & DUMP_HOMES:
        return f"stray {ext} data dump outside a data, fixtures or tests folder — gitignore or delete"
    if "/" not in rel and name.startswith("test_") and rel.endswith(".py"):
        return "test file at repo root — belongs under tests/"
    return None


def check_litter(root: Path, files: list[str], cfg: Config) -> list[Finding]:
    out = []
    for rel in files:
        msg = _is_litter(rel, cfg)
        if msg:
            out.append(Finding(FAIL, "litter", rel, msg))
    return out


TEST_GLOBS = ("tests/**", "**/test_*.py", "**/*_test.go")


def _thresholds(rel: str, cfg: Config) -> tuple[int, int]:
    for glob, soft, hard in cfg.size_overrides:
        if fnmatch.fnmatch(rel, glob):
            return soft, hard
    if _match_any(rel, list(TEST_GLOBS)):
        return 2 * cfg.soft_max_lines, 2 * cfg.hard_max_lines
    return cfg.soft_max_lines, cfg.hard_max_lines


def check_sizes(files: list[str], cfg: Config, open_file: Callable[[str], int]) -> list[Finding]:
    out = []
    for rel in files:
        if Path(rel).suffix.lower() not in SOURCE_EXTS:
            continue
        lines = read_lines(open_file, rel)
        if lines is None:
            continue
        n = len(lines)
        soft, hard = _thresholds(rel, cfg)
        if n < soft:
            continue
        has_marker = any(ARCH_OK in ln for ln in lines[:MARKER_SCAN_LINES])
        if n >= hard and not has_marker:
            out.append(Finding(FAIL, "size", rel,
                               f"{n} lines (hard limit {hard}) — split by responsibility, "
                               f"or add a '# {ARCH_OK} <reason>' marker if the size is truly earned", metric=n))
        elif n >= soft and not has_marker:
            out.append(Finding(WARN, "size", rel,
                               f"{n} lines (soft limit {soft}) — consider splitting before it becomes a god file", metric=n))
    return out


def check_worktrees(root: Path, cfg: Config) -> list[Finding]:
    out = []
    for wt in WORKTREE_DIRS:
        try:
            base = _checkout_target(root, wt)
        except OSError:
            continue
        if not base.is_dir():
            continue
        subs = [p.name for p in base.iterdir() if p.is_dir()]
        if len(subs) > cfg.max_worktrees:
            out.append(Finding(WARN, "worktrees", wt,
                               f"{len(subs)} agent worktrees present ({', '.join(sorted(subs)[:6])}"
                               f"{'…' if len(subs) > 6 else ''}) — remove merged ones with `git worktree remove`", metric=len(subs)))
    return out


def _git_ignored(root: Path, entries: list[str]) -> set[str] | None:
    """Recommended entries that Git's ignore rules already cover, probed as a file inside each, or None outside Git."""
    probes = {entry.rstrip("/").replace("*", "probe") + "/probe": entry for entry in entries}
    try:
        result = subprocess.run(["git", "-C", str(root), "check-ignore", "--no-index", "--stdin", "-z"],
                                input=b"\0".join(os.fsencode(probe) for probe in probes), capture_output=True)
    except OSError:
        return None
    if result.returncode not in (0, 1):
        return None
    return {probes[os.fsdecode(path)] for path in result.stdout.split(b"\0") if os.fsdecode(path) in probes}


def check_gitignore(root: Path, cfg: Config, open_file: Callable[[str], int]) -> list[Finding]:
    lines = read_lines(open_file, ".gitignore")
    covered = _git_ignored(root, cfg.required_gitignore)
    if covered is None and lines is not None:
        present = {ln.strip().rstrip("/") for ln in lines if ln.strip()}
        covered = {p for p in cfg.required_gitignore if p.rstrip("/") in present}
    missing = [p for p in cfg.required_gitignore if p not in (covered or set())]
    if lines is None and missing:
        return [Finding(WARN, "gitignore", ".gitignore",
                       "no readable .gitignore — caches and temporary files may leak into commits", metric=len(missing))]
    if missing:
        return [Finding(WARN, "gitignore", ".gitignore",
                       "missing recommended entries: " + ", ".join(missing), metric=len(missing))]
    return []


def check_refs(files: list[str], cfg: Config, open_file: Callable[[str], int]) -> list[Finding]:
    """Report scripts with no inbound textual match as review candidates.

    Dynamic imports, generated code, plugin discovery, and external callers can
    be invisible, so this is WARN-only and never establishes that code is dead.
    """
    if not cfg.check_refs:
        return []
    candidates = [f for f in files
                  if f.startswith("scripts/") and f.endswith(".py")
                  and Path(f).stem not in ENTRYPOINT_STEMS]
    if not candidates:
        return []
    tokens: set[str] = set()
    cand_stems = {Path(c).stem for c in candidates}
    for rel in files:
        if Path(rel).suffix.lower() in REF_EXTS or Path(rel).name in REF_NAMES:
            try:
                text = _read_audit_text(open_file, rel, MAX_READ_BYTES, errors="ignore").removesuffix("\n")
            except OSError:
                continue
            for stem in cand_stems:
                if stem in text and not (rel in candidates and Path(rel).stem == stem):
                    tokens.add(stem)
    return [Finding(WARN, "refs", c,
                   "no inbound textual reference found — heuristic only; dynamic imports, "
                   "generated code, plugin discovery, and external callers can be missed; "
                   "inspect before removal")
            for c in candidates if Path(c).stem not in tokens]


def check_junkdirs(root: Path, files: list[str], cfg: Config) -> list[Finding]:
    """Date-stamped / scratch directories at repo root (agent-loop output).
    Root dirs are otherwise unrestricted, so these slip past check_root."""
    rootdirs = {rel.split("/")[0] for rel in files if "/" in rel}
    out = []
    for d in sorted(rootdirs):
        if _litter_ignored(d, cfg):
            continue
        if DATE_STAMP_RE.search(d) or _match_any(d, JUNK_DIR_GLOBS + cfg.junk_dir_extra):
            out.append(Finding(FAIL, "junkdir", d + "/",
                               "date-stamped/scratch directory at repo root — agent-loop "
                               "output; keep any durable parts in docs/ and delete the folder"))
    return out


def _walk_loop_litter(root: Path):
    """Yield on-disk relpaths whose basename is unambiguous loop-litter, pruning
    noise dirs and the sanctioned .scratch/ + artifacts/ scratch space."""
    for dirpath, dirnames, filenames in os.walk(root):
        rel = Path(dirpath).relative_to(root).as_posix()
        at_root = rel == "."
        keep = []
        for d in dirnames:
            if d in NOISE_DIRS_ANY or (at_root and (d in NOISE_DIRS_ROOT or d in ONDISK_SKIP)):
                continue
            child = d if at_root else f"{rel}/{d}"
            # Worktrees, submodules and nested repositories hold another checkout's files.
            if _excluded_worktree(child) or os.path.lexists(os.path.join(dirpath, d, ".git")):
                continue
            keep.append(d)
        dirnames[:] = keep
        for fn in filenames:
            if _match_any(fn, LOOP_LITTER_GLOBS):
                yield fn if at_root else f"{rel}/{fn}"


def check_ondisk(root: Path, files: list[str], cfg: Config) -> list[Finding]:
    """Loop-litter present on disk but hidden from git (gitignored). Surfaced for
    the agent to judge — gitignoring a loop file hides tree inflation rather than
    removing it. WARN, not a block: the agent decides (delete vs genuinely needed).
    Files already visible to git are covered by check_litter, so skip them."""
    visible = set(files)
    return [Finding(WARN, "ondisk", rel,
                    "loop-litter on disk but gitignored — hiding a file does not establish "
                    "that it is clean; review it and use .scratch/ for temporary work")
            for rel in _walk_loop_litter(root)
            if rel not in visible and not _litter_ignored(rel, cfg)]


def _entry_looks_like_litter(entry: str) -> bool:
    # Only unambiguous loop-litter names — a date inside a filename (e.g. a dated
    # screenshot asset) is legitimate, so DATE_STAMP_RE is dir-only, not used here.
    return _match_any(Path(entry).name, LOOP_LITTER_GLOBS)


def _is_broad_pattern(entry: str) -> bool:
    pattern = entry.strip("/")
    return any(ch in pattern for ch in "*?[")


def check_config(root: Path, cfg: Config) -> list[Finding]:
    """Surface allowlist/ignore entries that look like litter — a possible attempt
    to pass the gate by silencing rather than deleting. WARN (the agent judges): if
    it's really a durable file, keeping it is fine; if it's junk, delete it."""
    return [Finding(WARN, "config", entry,
                    "broad or litter-like suppression in audit configuration — confirm it is "
                    "durable and scoped rather than hidden to pass the gate")
            for entry in sorted(set(cfg.root_allow_extra) | set(cfg.litter_ignore))
            if _is_broad_pattern(entry) or _entry_looks_like_litter(entry)]


def check_noise(inventory: set[str], cfg: Config) -> list[Finding]:
    """Dependency, cache and build folders that Git tracks or would add."""
    roots = {name for name in NOISE_DIRS_ROOT
             if name not in ("env", "venv") or any(f"{name}/{marker}" in inventory for marker in VENV_MARKERS)}
    folders = {_noise_folder(rel, roots) for rel in inventory if not _excluded_worktree(rel)} - {None}
    out = []
    for folder in sorted(folders):
        if _litter_ignored(folder, cfg):
            continue
        if folder.count("/") == 1 and folder.rstrip("/") in {"build", "dist", "out", "target"}:
            out.append(Finding(WARN, "noise", folder, "build output in version control — gitignore it unless it is published on purpose"))
        else:
            out.append(Finding(FAIL, "noise", folder, "dependency or cache folder in version control — gitignore it and untrack its files"))
    return out


CHECKS_WITH_FILES = (check_root, check_litter, check_junkdirs)


def run_audit(root: Path, cfg: Config) -> list[Finding]:
    root = root.resolve()
    inventory, listed_by_git = repo_inventory(root)
    files = sorted(f for f in inventory if not _excluded(f))
    findings: list[Finding] = check_noise(inventory, cfg) if listed_by_git else []
    for fn in CHECKS_WITH_FILES:
        findings += fn(root, files, cfg)
    with _audit_opener(root) as open_file:
        findings += check_sizes(files, cfg, open_file)
        findings += check_refs(files, cfg, open_file)
        findings += check_ondisk(root, files, cfg)
        findings += check_worktrees(root, cfg)
        findings += check_gitignore(root, cfg, open_file)
    findings += check_config(root, cfg)
    return findings


# ---------------------------------------------------------------------------
# baseline: grandfather a messy repo's existing findings so the gate blocks
# only NEW mess. Existing violations become a backlog, not a wall.
# ---------------------------------------------------------------------------

BASELINE_FILE = ".repo-audit-baseline.json"


def _sig(f: Finding) -> str:
    return f"{f.check}:{f.path}"


# Comparable findings also store a metric (line count, missing ignore count, worktree count) so getting worse re-flags them.
COMPARABLE_CHECKS = {"size", "gitignore", "worktrees"}


def write_baseline(root: Path, findings: list[Finding]) -> int:
    """Record current findings as accepted."""
    data = {
        "suppress": sorted({_sig(f) for f in findings}),
        "sizes": {f.path: f.metric for f in findings if f.check in COMPARABLE_CHECKS and f.metric is not None},
    }
    path = root / BASELINE_FILE
    # A committed symlink must not redirect the write to another file.
    if path.is_symlink() or path.exists() and not path.is_file():
        raise OSError("existing baseline is not a regular file")
    with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, "O_NOFOLLOW", 0), 0o644), "w", encoding="utf-8") as handle:
        handle.write(json.dumps(data, indent=2) + "\n")
    return len(data["suppress"])


def load_baseline(root: Path) -> dict | None:
    p = root / BASELINE_FILE
    if p.is_symlink() or not p.is_file():
        return None
    try:
        value = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError, RecursionError):  # JSONDecodeError and UnicodeError are ValueErrors
        return None
    return value if isinstance(value, dict) else None


def split_baselined(findings: list[Finding], baseline: dict | None) -> tuple[list[Finding], list[Finding]]:
    """Return (active, baselined). Active findings block; baselined ones are backlog."""
    if not baseline:
        return findings, []
    raw_suppress = baseline.get("suppress", [])
    suppress = {item for item in raw_suppress if isinstance(item, str)} if isinstance(raw_suppress, list) else set()
    sizes = baseline.get("sizes", {})
    if not isinstance(sizes, dict):
        sizes = {}
    active, based = [], []
    for f in findings:
        base = sizes.get(f.path) if f.check in COMPARABLE_CHECKS else None
        if isinstance(base, int):
            grandfathered = f.metric is not None and f.metric <= base
        else:  # earlier releases recorded gitignore and worktree findings by signature only
            grandfathered = _sig(f) in suppress
        (based if grandfathered else active).append(f)
    return active, based


# ---------------------------------------------------------------------------
# config + reporting
# ---------------------------------------------------------------------------

def _config_int(value, name: str, minimum: int = 0) -> int:
    if type(value) is not int or value < minimum:
        raise ConfigError(f"{name} must be an integer >= {minimum}")
    return value


def _config_strings(value, name: str) -> list[str]:
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        raise ConfigError(f"{name} must be a list of strings")
    return value


def _config_sizes(value) -> list[tuple[str, int, int]]:
    if not isinstance(value, list):
        raise ConfigError("size_overrides must be a list of [glob, soft, hard] values")
    result = []
    for index, item in enumerate(value):
        if not isinstance(item, list) or len(item) != 3 or not isinstance(item[0], str):
            raise ConfigError(f"size_overrides[{index}] must be [glob, soft, hard]")
        soft = _config_int(item[1], f"size_overrides[{index}].soft", 1)
        hard = _config_int(item[2], f"size_overrides[{index}].hard", soft)
        result.append((item[0], soft, hard))
    return result


def load_config(root: Path) -> Config:
    """Overrides come from `.repo-audit.toml` (top-level keys) if present, else
    `[tool.repo_audit]` in pyproject.toml. Non-Python repos use the former."""
    cfg = Config()
    if tomllib is None:
        raise ConfigError("repo_audit requires Python 3.11+ for TOML support")
    root = root.resolve()
    dedicated, pp = root / ".repo-audit.toml", root / "pyproject.toml"
    try:
        with _audit_opener(root) as open_file:
            if dedicated.is_symlink() or dedicated.is_file():
                section = tomllib.loads(_read_audit_text(open_file, dedicated.name))
            elif pp.is_symlink() or pp.is_file():
                data = tomllib.loads(_read_audit_text(open_file, pp.name))
                tool = data.get("tool", {})
                if not isinstance(tool, dict):
                    raise ConfigError(f"invalid configuration {pp}: [tool] must be a table")
                section = tool.get("repo_audit", {})
            else:
                section = {}
    except (OSError, ValueError, RecursionError) as exc:  # TOMLDecodeError and UnicodeError are ValueErrors
        raise ConfigError(f"invalid configuration: {exc}") from exc
    if not isinstance(section, dict):
        raise ConfigError("invalid configuration: audit settings must be a table")
    unknown = sorted(set(section) - set(cfg.__dataclass_fields__))
    if unknown:
        raise ConfigError("unknown configuration keys: " + ", ".join(unknown))
    overrides = {k: v for k, v in section.items() if k in cfg.__dataclass_fields__}
    for name in ("soft_max_lines", "hard_max_lines", "max_worktrees"):
        if name in overrides:
            overrides[name] = _config_int(overrides[name], name, 1 if name != "max_worktrees" else 0)
    if overrides.get("hard_max_lines", cfg.hard_max_lines) < overrides.get("soft_max_lines", cfg.soft_max_lines):
        raise ConfigError("hard_max_lines must be >= soft_max_lines")
    if "size_overrides" in overrides:
        overrides["size_overrides"] = _config_sizes(overrides["size_overrides"])
    for name in ("root_allow_extra", "litter_extra", "litter_ignore", "junk_dir_extra", "required_gitignore"):
        if name in overrides:
            overrides[name] = _config_strings(overrides[name], name)
    if "check_refs" in overrides and type(overrides["check_refs"]) is not bool:
        raise ConfigError("check_refs must be a boolean")
    return replace(cfg, **overrides) if overrides else cfg


def _color(txt: str, code: str, on: bool) -> str:
    return f"\033[{code}m{txt}\033[0m" if on else txt


def _suppression_note(cfg: Config, based: list[Finding]) -> str:
    """Make gaming visible: a green result riding on a huge allowlist or baseline
    is a red flag, not a clean repo."""
    parts = []
    if cfg.root_allow_extra:
        parts.append(f"{len(cfg.root_allow_extra)} root-allowlisted")
    if cfg.litter_ignore:
        parts.append(f"{len(cfg.litter_ignore)} litter-ignored")
    if based:
        parts.append(f"{len(based)} baselined")
    return "; ".join(parts)


def report(active: list[Finding], based: list[Finding], cfg: Config, strict: bool, color: bool) -> int:
    fails = [f for f in active if f.level == FAIL]
    warns = [f for f in active if f.level == WARN]
    order = {"config": 0, "root": 1, "litter": 2, "noise": 3, "junkdir": 4, "size": 5,
             "ondisk": 6, "worktrees": 7, "gitignore": 8, "refs": 9}
    for f in sorted(active, key=lambda x: (order.get(x.check, 9), x.level != FAIL, x.path)):
        tag = _color("FAIL", "31;1", color) if f.level == FAIL else _color("WARN", "33;1", color)
        print(f"  {tag}  [{f.check}] {f.path}\n         {f.message}")
    print()
    blocked = bool(fails) or (strict and bool(warns))
    supp = _suppression_note(cfg, based)
    supp_tail = f"  [suppressed: {supp}]" if supp else ""
    if blocked:
        print(_color(f"✗ repo_audit: {len(fails)} FAIL, {len(warns)} WARN{supp_tail}"
                     " — fix before commit/push/done.", "31;1", color))
    else:
        warn_note = f" ({len(warns)} WARN — fix or justify)" if warns else ""
        print(_color(f"✓ repo_audit: clean{warn_note}{supp_tail}.", "32;1", color))
    return 1 if blocked else 0


def _error(message: str, json_mode: bool) -> int:
    if json_mode:
        print(json.dumps({"status": "error", "error": message, "exit_code": 2}, indent=2))
    else:
        print(f"error: {message}", file=sys.stderr)
    return 2


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Deterministic, read-only repository-hygiene review aid.")
    ap.add_argument("path", nargs="?", default=".", help="repo root (default: cwd)")
    ap.add_argument("--strict", action="store_true", help="treat WARN as failure")
    ap.add_argument("--json", action="store_true", help="emit findings as JSON")
    ap.add_argument("--no-color", action="store_true", help="disable ANSI color")
    ap.add_argument("--write-baseline", action="store_true",
                    help=f"record current findings to {BASELINE_FILE} and exit (grandfather a messy repo)")
    ap.add_argument("--no-baseline", action="store_true", help=f"ignore {BASELINE_FILE} if present")
    args = ap.parse_args(argv)
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(errors="backslashreplace")  # non-UTF-8 file names stay printable

    try:
        root = Path(args.path).expanduser().resolve()
        if not root.is_dir():
            return _error(f"{root} is not a directory", args.json)
    except (OSError, RuntimeError) as exc:
        return _error(f"invalid path: {exc}", args.json)

    try:
        cfg = load_config(root)
    except ConfigError as exc:
        return _error(f"config error: {exc}", args.json)
    try:
        findings = run_audit(root, cfg)
    except Exception as exc:  # exit 1 means findings, so an unexpected failure must not produce it
        return _error(f"audit failed: {exc}", args.json)

    if args.write_baseline:
        try:
            n = write_baseline(root, findings)
        except OSError as exc:
            return _error(f"could not write {BASELINE_FILE}: {exc}", args.json)
        if args.json:
            print(json.dumps({"status": "baseline-written", "baseline": BASELINE_FILE,
                              "findings": len(findings), "accepted": n, "exit_code": 0}, indent=2))
        else:
            print(f"wrote {BASELINE_FILE}: {n} pre-existing findings accepted. "
                  "New findings still fail; review this backlog over time.")
        return 0

    baseline = None if args.no_baseline else load_baseline(root)
    active, based = split_baselined(findings, baseline)

    if args.json:
        fails = sum(f.level == FAIL for f in active)
        warns = sum(f.level == WARN for f in active)
        code = 1 if fails or (args.strict and warns) else 0
        payload = {
            "root": str(root),
            "status": "violations" if code else "clean",
            "exit_code": code,
            "strict": args.strict,
            "findings": [f.__dict__ for f in active],
            "baselined": len(based),
            "suppressed": {
                "root_allow_extra": len(cfg.root_allow_extra),
                "litter_ignore": len(cfg.litter_ignore),
                "baselined": len(based),
            },
            "fail": fails,
            "warn": warns,
        }
        print(json.dumps(payload, indent=2))
        return code

    color = sys.stdout.isatty() and not args.no_color
    print(f"repo_audit: {root}")
    if not active:
        supp = _suppression_note(cfg, based)
        tail = f"  [suppressed: {supp}]" if supp else ""
        print(_color(f"\n✓ repo_audit: clean{tail}.", "32;1", color))
        return 0
    print()
    return report(active, based, cfg, args.strict, color)


if __name__ == "__main__":
    raise SystemExit(main())
