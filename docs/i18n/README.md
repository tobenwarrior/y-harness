# Documentation language

This fork maintains documentation in English only. Current documents are authored, reviewed, and published as English files; new locale counterparts and consistency records are not created.

The policy is declared in [`scripts/translation-pairing.manifest.json`](../../scripts/translation-pairing.manifest.json). `verify-translation-pairing` therefore checks the English-only invariant: an unexpected `.zh.md` or `.i18n.yaml` is a failure, and links must continue to resolve to the English document.

## Scope and exclusions

The active documentation scope contains English sources under the repository roots named by `docs/AGENTS.md`. This directory's compatibility assets are explicit exclusions from locale pairing; the English-only gate rejects new counterparts and records instead of requiring them.

## Retained compatibility assets

The files in this directory are retained only where existing source tools or historical fixtures still read them:

- [`terminology.md`](terminology.md) is a legacy table consumed by the translation briefing code and its compatibility tests. It is not an authority for current English documentation.
- [`style-samples.md`](style-samples.md) is a legacy calibration fixture. It is not a supported authoring workflow.
- [`translation-prompt.md`](translation-prompt.md) contains the parser-compatible prompt fence used by source-level regression tests. The runtime verifier skips it when the English-only policy is active.
- [`translation-rules.md`](translation-rules.md) records the current English-only policy and the boundaries around those legacy assets.
- `.agents/notes/archived/` retains frozen English notes. The one-time translation-artifact retirement is recorded in `manifest.json`; [`verify-archived-agent-notes`](../../scripts/verify-archived-agent-notes.ts) validates retained content and immutable retired seals.

These files are explicit manifest exclusions. Their retained examples are test and migration data, not product documentation. Historical Han text is stored as `\u{...}` escapes and decoded only at the compatibility readers that require the original value. Do not copy their locale-specific examples into active docs, and do not add a new bilingual file to make a check pass.

## Current documentation checks

Run the checks that cover the changed surface:

1. `pnpm run verify-translation-pairing` confirms that the English-only policy has no leftover locale artifacts.
2. `pnpm run verify-md-wrap` checks paragraph layout and physical line rules.
3. `pnpm run verify-md-links` checks relative links and fragments.
4. `pnpm run doc-sync` runs the documentation gate set used by CI.

The pairing check is intentionally not a translation-quality signal in this fork. It protects the absence of unsupported locale artifacts; Markdown structure, links, and prose quality remain covered by their owning checks and review.

## Re-enabling locales

Re-enabling a translated documentation surface requires one reviewed migration covering the manifest, pairing verifier, generators, source tests, skills, and every affected document. Do not restore a counterpart or switcher in isolation. Until that migration is complete, write and review only the English source.
