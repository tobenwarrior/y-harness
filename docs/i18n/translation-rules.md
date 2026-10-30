# Documentation language rules

This fork maintains documentation in English only. These rules describe the current authoring policy and the compatibility boundary around the retired bilingual tooling; they do not authorize creating translated counterparts.

## Current policy

- Author the English document as the sole current source of truth.
- Do not add `.zh.md` counterparts, `.i18n.yaml` records, language switchers, or locale-specific links.
- Keep code fences byte-identical to their owning source when a generated or compatibility fixture is regenerated.
- Keep commands, flags, paths, identifiers, API names, event names, configuration keys, protocol values, and version numbers verbatim.
- Write complete, direct technical prose. State the current behavior, failure mode, ownership, timing, and safe-use requirements without narrating review history or implementation steps.
- Route product or model-visible copy through its owning locale or presentation contract. Do not introduce ad hoc copy in a documentation migration.

## Retired bilingual assets

[`terminology.md`](terminology.md) and [`style-samples.md`](style-samples.md) remain as compatibility data for the translation briefing and parser tests. [`translation-prompt.md`](translation-prompt.md) retains an exact machine-consumed fence. Historical Han text in these assets uses `\u{...}` escapes; the compatibility readers decode the escapes before matching or rendering. These files are excluded from the English-only pairing gate because removing or rewriting their legacy structure would invalidate source-level compatibility checks.

Do not treat the wording or examples in those files as current product guidance. If a compatibility change is required, update the owning parser or test in the same migration and preserve the input structure that the test claims to protect.

## Safe maintenance

Before editing a compatibility asset, identify every reader with `rg`, preserve its delimiters and protected blocks, and run the focused source tests. Do not update a generated or recorded fixture by hand when an owning generator or scenario exists.

For ordinary documentation changes, run `pnpm run verify-md-wrap`, `pnpm run verify-md-links`, and `pnpm run verify-translation-pairing`; run `pnpm run doc-sync` at the documentation-change boundary. A green pairing check in this fork means that no unsupported locale artifact was added. It does not replace prose review or the structural and link gates.

## Re-enabling translated documents

A future locale migration must update the manifest, verifier, generators, source tests, and skills together before adding any counterpart. It must also define ownership for switchers, records, links, generated regions, and release maintenance. Until that migration lands, the English-only policy is authoritative.
