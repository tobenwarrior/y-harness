---
description: "The adjacent Session V4-to-V5 migration and native V5 codec for durable Bot group-message sources."
kind: "package-library"
---

# @yharness/session-format-v4-to-v5

## Summary

Read existing V4 Sessions as V5 without rewriting their stored generation. The edge preserves every logical event and advances only the header version; the V5 codec keeps V4 physical framing and native admission. V5 is required because `bot-group-message` participates in replay and isolated-turn attribution, so it cannot use the attribution-only compatibility promise.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

### When to use it

Use the [format catalog](../session-format-catalog/README.md) to restore a Session. Direct imports serve catalog assembly and focused tests; this library has no Cordis mount configuration. Its public exports provide the adjacent migration, V5 codec, and target validators.

### Entry point

The header-only operation advances the generation without converting event data:

```text
const targetHeader = sessionFormatV4ToV5.migrateHeader(sourceHeader)
```

The body stage is identity-preserving. It tracks the inherited cut from the source `session/end-seed` marker and emits events and compact runs without rewriting identities or source metadata. V5 physical rows use the same JSONL framing as V4 with a V5 header.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The migration stage validates the source V4 header and delivery ownership, then forwards every event and compact run. The V5 restorer delegates common lifecycle, source, compaction, and native-field checks to a private V4 view while applying V5 delivery-marker rules to the original artifact. The codec changes only the physical header version and leaves event rows in V4 framing.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Session format catalog](../session-format-catalog/README.md) — complete restoration and adjacent-edge assembly.
- [Session format status](../../../docs/session-format-status.md) — writer and accepted-baseline authority.
- [Persistence compatibility rules](../../../docs/persistence-changes/README.md#compatibility-rules) — source-policy and format decisions.

-----

<a id="model-experience"></a>
## Model Experience

### Historical restoration

#### What the model sees

The migration adds no model-visible content to `deriveMessages()`. Group-message source metadata remains attached to the same user message, so Bot replay and isolated-turn attribution can inspect the restored source.

#### Token effect

The conversion changes no message text or token-bearing data.

#### KV Cache effect

The conversion preserves the recorded request prefix; provider cache availability remains outside this library.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **One adjacent edge** — this package converts V4 to V5; persistence owns source reads, successor publication, and generation selection.
- **No attribution-only fallback** — `bot-group-message` remains a behavior-bearing source because Bot replay and isolation inspect it. Readers must use V5 Bot-aware validation when those semantics are required.
- **Physical framing reuse** — V5 keeps V4 JSONL row framing. A future framing change requires a separate codec and format transition.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
