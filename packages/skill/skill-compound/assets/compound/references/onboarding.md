# Repository assessment and onboarding

Explicit project `setup` requests a fresh assessment and verified cleanup, even when previously completed. Normal coding work runs one bounded first-use pass before the repository's first write-authorized task. Respect project instructions, read-only scope, and user opt-outs; global setup and activation-only modes do not request cleanup.

Use the installed [state helper](../scripts/onboarding.py) with the intended repository root. Its canonical checkout identity shares completion across Codex, Cursor, and Claude Code through machine-local state, without a project marker. A completed record suppresses automatic onboarding only.

## One pass

1. Read project instructions and record changed and untracked paths before writes. Preserve those paths during cleanup and keep unknown untracked content visible to Git; explicit setup may update only its managed routing sections within existing instruction files. Use the core code-map startup before broad reads, then inspect layout, entrypoints, build/test configuration, and project conventions.
2. Claim the pass atomically:

   ```bash
   python3 <installed-skill-dir>/scripts/onboarding.py claim --repo <repo-root>
   ```

   For explicit project `setup`, append `--refresh` to reopen completed state. Read the JSON: `busy` defers assessment without stealing the active lease; `already_completed` skips automatic onboarding. Retain a granted token for completion or release. For a sandbox write denial, request normal host approval and retry once. If state remains unavailable, report incomplete assessment and skip cleanup; do not move state into the project or loosen permissions.
3. Read [repository hygiene](repo-hygiene.md) and run its read-only audit with `--json --no-baseline`. Review responsibilities and boundaries, callers, duplication, dead code, dependencies, scripts, docs, test value, and Git conventions. Use focused source reads and project configuration; audit warnings are candidates, not proof. Establish a baseline with documented checks before cleanup. Load [refactoring](refactor.md) for structural changes and [Git guidance](git.md) when drafting commits or PRs.
4. Apply high-confidence, behavior-preserving cleanup in a reviewable diff. Add ignores for known project outputs and simplify or remove proven obsolete or redundant source, docs, and tests together with their callers. Delete superseded copies rather than archive them. For confirmed obsolete tracked files, use one exact worktree deletion through normal host approval; leave the index and history unchanged. Avoid `git rm`, resets, and index-restoration sequences. Keep deletion separate from other edits and verification. A host denial defers that operation; report it without retrying through another mechanism. Preserve user work and unknown artifacts. Defer broad redesign, migrations, dependency upgrades, public-contract changes, and uncertain deletions as a short actionable backlog.
5. Run relevant checks after cleanup and compare with the baseline. Inspect the diff and confirm protected paths are unchanged by cleanup. Audit findings (exit `0` or `1`) may remain as backlog; configuration errors (exit `2`) are not a successful assessment. Complete only after inspection and verification:

   ```bash
   python3 <installed-skill-dir>/scripts/onboarding.py complete --repo <repo-root> --token <claim-token>
   ```

   If assessment cannot run or cleanup cannot be verified, release the claim so a later task can retry:

   ```bash
   python3 <installed-skill-dir>/scripts/onboarding.py release --repo <repo-root> --token <claim-token>
   ```

Report what was inspected, changed, verified, preserved, and deferred, then continue any supplied task. Completion records a verified pass, not a perfect repository. Do not stage, commit, push, install dependencies, or change external services merely because assessment ran; those actions retain their normal authorization. The helper tracks state; the agent performs the assessment and cleanup.
