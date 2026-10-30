---
name: dsh-translate-docs
description: Retired compatibility marker for the former bilingual-document workflow; the current fork maintains English documentation only.
disable-model-invocation: true
user-invocable: true
---

# Retired bilingual-document workflow

## Status

This fork maintains English documentation only. `verify-translation-pairing` rejects new locale counterparts and consistency records, and active documentation has no language switchers. This skill remains so old invocations fail with an explicit policy rather than silently restoring a retired workflow.

## Do not invoke the former workflow

- Do not create `.zh.md` files, `.i18n.yaml` records, locale switchers, or translated links.
- Do not run the former briefing, delegated-translation, whole-document, or record-writing paths for current docs.
- Do not use retained locale examples as product copy or as an authority for English prose.
- Do not modify frozen Agent Notes under `.agents/notes/archived/`.

For a current documentation change, edit the English source directly and follow [`docs/AGENTS.md`](../../../docs/AGENTS.md), [`dsh-doc`](../dsh-doc/SKILL.md), and [`dsh-prose-standard`](../dsh-prose-standard/SKILL.md). Run the owning Markdown and documentation checks; the pairing check confirms only that retired locale artifacts were not reintroduced.

## Legacy assets

[`docs/i18n/terminology.md`](../../../docs/i18n/terminology.md), [`style-samples.md`](../../../docs/i18n/style-samples.md), and [`translation-prompt.md`](../../../docs/i18n/translation-prompt.md) remain only for source-level compatibility tests and historical replay. The prompt keeps an exact parser marker; changing it requires the renderer tests in the same migration. The current policy does not consume these assets for active documentation.

## Re-enabling locales

A future locale migration must update the manifest, pairing verifier, generators, source tests, documentation skills, and every affected document together. It must define ownership for switchers, records, generated regions, and release maintenance before any counterpart is added. Until then, English-only documentation is the repository policy.
