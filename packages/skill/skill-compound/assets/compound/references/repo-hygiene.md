# Repository hygiene

The installed checker is [repo_audit.py](../scripts/repo_audit.py). Run it with
the host's Python 3 interpreter:

```bash
python3 <installed-skill-dir>/scripts/repo_audit.py <repo-root>
```

Audits are read-only. The explicit `--write-baseline` option writes only
`.repo-audit-baseline.json`; the checker never deletes or rewrites project
files. Size and reference checks read regular files within the selected checkout. Links to files inside that checkout still work. A configuration link that resolves outside it returns exit `2`.

## Commands and exit status

```bash
python3 <installed-skill-dir>/scripts/repo_audit.py <repo-root> --strict
python3 <installed-skill-dir>/scripts/repo_audit.py <repo-root> --json
python3 <installed-skill-dir>/scripts/repo_audit.py <repo-root> --write-baseline
python3 <installed-skill-dir>/scripts/repo_audit.py <repo-root> --no-baseline
```

Exit `0` means no active blocking finding, `1` means an active `FAIL` (or a
`WARN` under `--strict`), and `2` means an invalid path or configuration, or
an audit or baseline write that could not run.
An audit with `--json` emits one object with `status`, `exit_code`,
`findings`, `baselined`, `fail`, and `warn`; `--write-baseline` reports the
accepted count, and errors report `status`, `error`, and `exit_code`. `--help`
lists every option.

The checks cover repository-root litter, scratch names, source size, dated or
scratch directories, dependency, cache, and build folders in version control,
ignored loop litter, audit allowlists, worktrees, `.gitignore`, and scripts with
no inbound textual reference. These are review
heuristics: they do not prove architecture, correctness, ownership, or dead
code. A `refs` warning can miss dynamic imports, generated code, plugin
discovery, external callers, and runtime configuration. Use `rg` and relevant
tests as evidence, but an `rg` no-match result is not grounds by itself to
remove a file.

## Test value

Keep tests that protect contracts, regressions, failures, and boundaries. Assess test configuration, CI discovery, behavior covered, duplication, and runtime; count, age, length, or a search no-match does not establish uselessness. Remove or consolidate tests only with evidence that their behavior is retired or already protected, then rerun relevant checks. Application tests normally stay versioned; Compound's own ignored development tests are a plugin-packaging choice, not a rule for consuming projects.

## Configuration and baselines

Configuration is read from `.repo-audit.toml`, or from `[tool.repo_audit]` in
`pyproject.toml` when the dedicated file is absent. Known settings include
size limits, size overrides, worktree limits, root/litter allowlists, and the
reference check. A `litter_ignore` glob matches a path or its basename and
also exempts a deliberately committed dependency folder, such as a
`node_modules` test fixture. The checker requires Python 3.11+ (`tomllib`);
malformed TOML, unsupported runtimes, or unknown/invalid settings return
exit `2`.

The default ignore recommendations cover virtual environments, caches,
bytecode, and `.scratch/`. `artifacts/` is project-specific and is not forced
on repositories that do not use it; add it to `.gitignore` when appropriate.

`--write-baseline` records current finding signatures, plus the line count,
number of missing ignore entries, or worktree count of comparable findings.
Later runs report accepted findings only as a count and block new findings; a
comparable finding becomes active again when its number exceeds the recorded
one; a baseline from an earlier release accepts gitignore and worktree findings
by signature until it is rewritten. A baseline is an adoption aid, not a
cleanliness claim. Use `--no-baseline` to inspect the whole repository.
