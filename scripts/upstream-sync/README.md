# Scoped upstream sync

English | [中文](README.zh.md)

Y Harness tracks the official [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)
fork-first: the paths named in [`config.json`](config.json) follow upstream, and
everything else is this fork's own work (providers, branding, launcher, bundles).
`master` is a squashed import with no ancestry shared with `upstream/master`, so
a merge cannot express that split — this tool expresses it as a path allowlist
instead.

## What it does

1. Fetches the `upstream` remote.
2. Diffs `baseline..target` limited to `include`, minus `exclude`.
3. Writes that delta as one patch and applies it with `git apply --3way`, which
   three-way merges each file against the fetched upstream blobs.
4. Aligns the workspace version with the target release when the target is a
   `dsh-v*` tag, using the repository's own `pnpm run release:dsh`.
5. Rewrites `baseline` in `config.json` **in the prepared branch**, so merging
   that branch is the only thing that advances the marker.

It never commits to `master`, never merges, and never pushes.

## Use

```sh
# See what a sync would bring; writes .artifacts/upstream-sync/<baseline>-<target>.patch
node scripts/upstream-sync/sync.mjs --to dsh-v0.2.1-rc.2

# Prepare the branch, apply, align the version
node scripts/upstream-sync/sync.mjs --to dsh-v0.2.1-rc.2 --apply

# Resolve reported conflicts, install, then run the configured checks
pnpm install --no-frozen-lockfile
node scripts/upstream-sync/sync.mjs --check
```

`--json <path>` writes a machine-readable report (files, commits, conflicts, new
packages, check results). Exit codes: `0` clean, `2` applied with conflicts,
`3` a check failed, `1` error.

On this machine, run pnpm through the fork wrapper: add
`--pnpm .local-setup/run-pnpm`.

## Changing what syncs

Edit `include` / `exclude` in `config.json`. Keep the list to packages whose
upstream behavior this fork actually wants; every added path is a standing
conflict surface against the fork's own edits. New packages appear in the report
under `newPackages` — they usually also need bundle rows, because
`packages/bundle/**` is deliberately not synced (fork wiring is hand-maintained).

## Scheduled runs

[`.github/workflows/upstream-scoped-sync.yml`](../../.github/workflows/upstream-scoped-sync.yml)
runs weekly and on demand: it prepares the branch, installs, runs the checks,
pushes the branch, and opens (or updates) a pull request. Nothing is merged
automatically. Two repository settings are required for the pull request to
appear:

- Actions → General → Workflow permissions: **Read and write**.
- Actions → General: **Allow GitHub Actions to create and approve pull requests**.

Without them the job still uploads the patch and report as artifacts.

## Requirements

- The `upstream` remote must exist (`git remote add upstream https://github.com/deepseek-ai/deepseek-harness.git`).
- The working tree must be clean for `--apply`.
