#!/usr/bin/env python3
"""Deterministic, read-only-by-default repository hygiene review aid.

Path, size, naming, and textual-reference checks are heuristics, not proof of
architecture, correctness, ownership, or dead code. The checker never deletes
project files; only ``--write-baseline`` writes its baseline. It audits tracked
and untracked-not-ignored files, with a filesystem fallback outside Git.

Usage: python3 repo_audit.py [PATH] [--strict] [--json] [--no-color]
Exit codes: 0 unblocked, 1 active violations, 2 invalid path/configuration.
Config: .repo-audit.toml or [tool.repo_audit] in pyproject.toml.
"""

from __future__ import annotations

import argparse
import fnmatch
import json
import os
import re
import subprocess
import sys
from dataclasses import dataclass, field, replace
from pathlib import Path

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
}
# Dotfiles / config globs allowed at root (tool config varies widely).
ROOT_ALLOW_GLOBS = [
    ".*",  # dotfiles at root are tool config; .DS_Store is caught by litter rules
    "Dockerfile*", "docker-compose*.yml", "docker-compose*.yaml", "requirements*.txt",
    "tsconfig*.json", "*.code-workspace", "*.cabal",
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
ASSET_HOMES = ("docs/", "doc/", "assets/", "public/", "static/", "media/", "images/",
               "img/", "artifacts/", ".github/")
# Data-dump extensions only allowed under these dirs.
DUMP_EXTS = {".jsonl"}
DUMP_HOMES = ("data/", "artifacts/", "tests/", "fixtures/")

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
# Reference corpus for the unreferenced-script heuristic.
REF_EXTS = SOURCE_EXTS | {".md", ".toml", ".cfg", ".ini", ".yaml", ".yml", ".txt", ".sh",
                          ".json", ".mk"}
REF_NAMES = {"Makefile", "GNUmakefile", "Dockerfile"}
ENTRYPOINT_STEMS = {"main", "__main__", "__init__", "conftest", "setup", "manage", "app", "cli"}


@dataclass
class Config:
    soft_max_lines: int = 800
    hard_max_lines: int = 1500
    # (glob, soft, hard) overrides, first match wins; tests are allowed to be larger.
    size_overrides: list = field(default_factory=lambda: [
        ("tests/**", 1500, 3000), ("**/test_*.py", 1500, 3000), ("**/*_test.go", 1500, 3000),
    ])
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

def _git_files(root: Path, *args: str) -> list[str] | None:
    """Run a `git ls-files` variant with -z: NUL-separated output that is
    byte-accurate and immune to git's default quoting of non-ASCII paths."""
    try:
        out = subprocess.run(["git", "-C", str(root), *args, "-z"],
                             capture_output=True, text=True, check=True)
    except (subprocess.CalledProcessError, FileNotFoundError):
        return None
    return [p for p in out.stdout.split("\0") if p]


def _excluded(rel: str) -> bool:
    parts = rel.split("/")
    if any(p in NOISE_DIRS_ANY for p in parts):
        return True
    if parts and parts[0] in NOISE_DIRS_ROOT:
        return True
    return any(rel == w or rel.startswith(w + "/") for w in WORKTREE_DIRS)


def list_repo_files(root: Path) -> list[str]:
    """Relative POSIX paths that would land in the repo (tracked + untracked-not-ignored)."""
    tracked = _git_files(root, "ls-files")
    if tracked is not None:
        others = _git_files(root, "ls-files", "--others", "--exclude-standard") or []
        files = set(tracked) | set(others)
    else:  # not a git repo: walk the filesystem, pruning noise dirs
        files = set()
        for p in root.rglob("*"):
            if p.is_file():
                files.add(p.relative_to(root).as_posix())
    return sorted(f for f in files if not _excluded(f))


def read_lines(path: Path) -> list[str] | None:
    try:
        return path.read_text(encoding="utf-8", errors="ignore").splitlines()
    except (OSError, UnicodeError):
        return None


def _match_any(name: str, patterns: list[str]) -> bool:
    return any(fnmatch.fnmatch(name, pat) for pat in patterns)


# ---------------------------------------------------------------------------
# checks
# ---------------------------------------------------------------------------

def check_root(root: Path, files: list[str], cfg: Config) -> list[Finding]:
    allow = ROOT_FILE_ALLOW | set(cfg.root_allow_extra)
    globs = ROOT_ALLOW_GLOBS
    out = []
    for rel in files:
        if "/" in rel:
            continue
        if rel in allow or _match_any(rel, globs):
            continue
        if _is_litter(rel, cfg):  # the litter check reports it with a more specific reason
            continue
        out.append(Finding(FAIL, "root", rel,
                           "unexpected file at repo root — move to src/tests/docs, "
                           "put scratch in .scratch/, or add to root allowlist"))
    return out


def _is_litter(rel: str, cfg: Config) -> str | None:
    if _match_any(rel, cfg.litter_ignore) or _match_any(Path(rel).name, cfg.litter_ignore):
        return None
    name = Path(rel).name
    if _match_any(name, LITTER_BASENAMES + cfg.litter_extra):
        return "session/scratch file — delete or promote into a durable, referenced path"
    ext = Path(rel).suffix.lower()
    if ext in ASSET_EXTS and not rel.startswith(ASSET_HOMES):
        return f"stray {ext} asset outside docs/assets/artifacts — move or delete"
    if ext in DUMP_EXTS and not rel.startswith(DUMP_HOMES):
        return f"stray {ext} data dump outside data/artifacts — gitignore or delete"
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


def _thresholds(rel: str, cfg: Config) -> tuple[int, int]:
    for glob, soft, hard in cfg.size_overrides:
        if fnmatch.fnmatch(rel, glob):
            return soft, hard
    return cfg.soft_max_lines, cfg.hard_max_lines


def check_sizes(root: Path, files: list[str], cfg: Config) -> list[Finding]:
    out = []
    for rel in files:
        if Path(rel).suffix.lower() not in SOURCE_EXTS:
            continue
        lines = read_lines(root / rel)
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
        base = root / wt
        if not base.is_dir():
            continue
        subs = [p.name for p in base.iterdir() if p.is_dir()]
        if len(subs) > cfg.max_worktrees:
            out.append(Finding(WARN, "worktrees", wt,
                               f"{len(subs)} agent worktrees present ({', '.join(sorted(subs)[:6])}"
                               f"{'…' if len(subs) > 6 else ''}) — remove merged ones with `git worktree remove`"))
    return out


def check_gitignore(root: Path, cfg: Config) -> list[Finding]:
    lines = read_lines(root / ".gitignore")
    if lines is None:
        return [Finding(WARN, "gitignore", ".gitignore",
                       "no readable .gitignore — caches and temporary files may leak into commits")]
    present = {ln.strip().rstrip("/") for ln in lines if ln.strip()}
    missing = [p for p in cfg.required_gitignore if p.rstrip("/") not in present]
    if missing:
        return [Finding(WARN, "gitignore", ".gitignore",
                       "missing recommended entries: " + ", ".join(missing))]
    return []


def check_refs(root: Path, files: list[str], cfg: Config) -> list[Finding]:
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
            text = "\n".join(read_lines(root / rel) or [])  # read_lines swallows OSError
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
        if _match_any(d, cfg.litter_ignore):
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
            if any(child == w or child.startswith(w + "/") for w in WORKTREE_DIRS):
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
            if rel not in visible and not _match_any(rel, cfg.litter_ignore)]


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


CHECKS_WITH_FILES = (check_root, check_litter, check_junkdirs, check_sizes, check_refs, check_ondisk)


def run_audit(root: Path, cfg: Config) -> list[Finding]:
    files = list_repo_files(root)
    findings: list[Finding] = []
    for fn in CHECKS_WITH_FILES:
        findings += fn(root, files, cfg)
    findings += check_worktrees(root, cfg)
    findings += check_gitignore(root, cfg)
    findings += check_config(root, cfg)
    return findings


# ---------------------------------------------------------------------------
# baseline: grandfather a messy repo's existing findings so the gate blocks
# only NEW mess. Existing violations become a backlog, not a wall.
# ---------------------------------------------------------------------------

BASELINE_FILE = ".repo-audit-baseline.json"


def _sig(f: Finding) -> str:
    return f"{f.check}:{f.path}"


def write_baseline(root: Path, findings: list[Finding]) -> int:
    """Record current findings as accepted. Sizes store the line count so a
    grandfathered god file that grows even bigger is re-flagged."""
    data = {
        "suppress": sorted({_sig(f) for f in findings if f.check != "size"}),
        "sizes": {f.path: f.metric for f in findings if f.check == "size" and f.metric is not None},
    }
    (root / BASELINE_FILE).write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    return len(data["suppress"]) + len(data["sizes"])


def load_baseline(root: Path) -> dict | None:
    p = root / BASELINE_FILE
    if not p.is_file():
        return None
    try:
        value = json.loads(p.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
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
        if f.check == "size":
            base = sizes.get(f.path)
            grandfathered = isinstance(base, int) and f.metric is not None and f.metric <= base
        else:
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
    dedicated, pp = root / ".repo-audit.toml", root / "pyproject.toml"
    try:
        if dedicated.is_file():
            section = tomllib.loads(dedicated.read_text(encoding="utf-8"))
        elif pp.is_file():
            data = tomllib.loads(pp.read_text(encoding="utf-8"))
            tool = data.get("tool", {})
            if not isinstance(tool, dict):
                raise ConfigError(f"invalid configuration {pp}: [tool] must be a table")
            section = tool.get("repo_audit", {})
        else:
            section = {}
    except (tomllib.TOMLDecodeError, OSError, UnicodeError) as exc:
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
    order = {"config": 0, "root": 1, "litter": 2, "junkdir": 3, "size": 4,
             "ondisk": 5, "worktrees": 6, "gitignore": 7, "refs": 8}
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

    root = Path(args.path).expanduser().resolve()
    if not root.is_dir():
        return _error(f"{root} is not a directory", args.json)

    try:
        cfg = load_config(root)
    except ConfigError as exc:
        return _error(f"config error: {exc}", args.json)
    findings = run_audit(root, cfg)

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
