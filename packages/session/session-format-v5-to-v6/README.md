---
description: "The adjacent Session V5-to-V6 migration and native V6 codec for durable Bot event-routine sources."
kind: "package-library"
---

# @yharness/session-format-v5-to-v6

## Summary

Read existing V5 Sessions as V6 without rewriting their stored generation. The edge preserves every logical event and advances only the header version; the V6 codec keeps V5 physical framing and validates the event-routine source fields used by Bot-triggered turns.

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

Use the [format catalog](../session-format-catalog/README.md) to restore a Session. Direct imports serve catalog assembly and focused tests; this library has no Cordis mount configuration. Its public exports provide the adjacent migration, V6 codec, and target validators.

### Entry point

The header-only operation advances the generation without converting event data:

```text
const targetHeader = sessionFormatV5ToV6.migrateHeader(sourceHeader)
```

The body stage is identity-preserving. It tracks the inherited cut from the source `session/end-seed` marker and emits events and compact runs without rewriting identities or source metadata. V6 physical rows use the same JSONL framing as V5 with a V6 header.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The migration stage validates the source V5 header and delivery ownership, then forwards every event and compact run. The V6 restorer delegates common lifecycle, source, compaction, delivery, and native-field checks to the released V5 view while validating `bot-event-routine` sources in each declared message slot. Source admission requires the runtime's non-blank routine metadata bounds (140-character summaries, 256-character routine and chain ids, and at most four relay hops). Native row admission applies the same V6 source check before recoverable reads can discard a suffix. The codec changes only the physical header version and leaves event rows in V5 framing.

</details>

<a id="further-exploration"></a>
## Further Exploration

- [Session format catalog](../session-format-catalog/README.md) — complete restoration and adjacent-edge assembly.
- [Session format status](../../../docs/session-format-status.md) — writer and accepted-baseline authority.
- [Persistence compatibility rules](../../../docs/persistence-changes/README.md#compatibility-rules) — source-policy and format decisions.

<a id="model-experience"></a>
## Model Experience

### Historical restoration

#### What the model sees

The migration adds no model-visible content to `deriveMessages()`. Event-routine source metadata remains attached to the same user messages, so Bot replay and relay-loop protection can inspect the restored source.

#### Token effect

The conversion changes no message text or token-bearing data.

#### KV Cache effect

The conversion preserves the recorded request prefix; provider cache availability remains outside this library.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **One adjacent edge** — this package converts V5 to V6; persistence owns source reads, successor publication, and generation selection.
- **Physical framing reuse** — V6 keeps V5 JSONL row framing. A future framing change requires a separate codec and format transition.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
