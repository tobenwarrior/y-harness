# Vendored upstream

`assets/` is a byte-identical copy of the skill content of
[compound-skills](https://github.com/tobenwarrior/compound-skills), the plugin
this fork's author maintains for Codex, Claude Code, and Cursor. Y Harness ships
it as a first-party provider instead of installing it as a third-party plugin.

| Field | Value |
|---|---|
| Upstream repository | `https://github.com/tobenwarrior/compound-skills` |
| Vendored version | `0.11.0` (upstream `plugin.json`) |
| Vendored commit | `a9e2e9ef5f76d68089034522b89b8330a2c49d4d` (2026-10-17) |
| Vendored on | 2026-10-18 |
| Upstream license | MIT, `Copyright (c) 2026 tobenwarrior` |

## What is copied

`assets/` mirrors upstream `skills/`, including the four Codex descriptor files
(`agents/openai.yaml`) that Y Harness ignores. Keeping the tree byte-identical
to upstream makes a re-sync a plain directory diff.

`LICENSE`, `THIRD_PARTY_NOTICES.md`, and `SOURCES.md` are copied unchanged from
the upstream repository root; the pstack notice in `THIRD_PARTY_NOTICES.md`
covers the adapted material this content derives from.

## What is not copied

| Upstream path | Reason |
|---|---|
| `.claude-plugin/`, `.codex-plugin/`, `.cursor-plugin/`, `.agents/` | Host manifests for the other three applications; Y Harness discovers these skills through `src/index.ts`. |
| `scripts/check.py` | The upstream repository's own package checker; it validates upstream manifests and release content that do not exist here. |
| `tests/`, `.pytest_cache/` | Upstream development tests for its own packaging. |

## Re-sync

Update this package when upstream publishes a new `plugin.json` version; the
`skill-compound` update indicator reports that difference in the Y Harness UI.

```sh
git clone https://github.com/tobenwarrior/compound-skills /tmp/compound-skills
git -C /tmp/compound-skills checkout <target-commit>
rsync -a --delete --exclude '__pycache__' --exclude '.DS_Store' \
  /tmp/compound-skills/skills/ packages/skill/skill-compound/assets/
cp /tmp/compound-skills/LICENSE /tmp/compound-skills/THIRD_PARTY_NOTICES.md \
   /tmp/compound-skills/SOURCES.md packages/skill/skill-compound/
```

Then update the version and commit in the table above, re-run the package tests,
and confirm `diff -r` between upstream `skills/` and `assets/` reports no
difference. Local edits to `assets/` are not an option: the update indicator,
the vendored-version record, and this diff all assume the copy stays faithful.
Adaptations for Y Harness belong in `src/index.ts` (the runtime section it
appends) or upstream, never in the vendored tree.
