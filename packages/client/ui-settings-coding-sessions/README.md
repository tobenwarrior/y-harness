---
description: "Native coding-session mirrors, reviewed ordinary-Y linked imports, compensation, and continuation recovery in Settings."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-coding-sessions

English | [中文](README.zh.md)

## Summary

Browse a configured native coding-session source, import its history, and select a readable mirror in Settings. Refresh brings in new source history, while conflicts retain the existing mirror. The page shows original source IDs and connection readiness. Reviewed linked imports add quoted history to a cold ordinary Y Session. Explicit sequential continuation and restart recovery follow the Host’s published capabilities and visible ownership state.

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

Mount beside the Settings, locale, and Remote client services, with the Host [coding-session service](../../session/coding-session/README.md) available. The browser entry injects `slots`, `locale`, and generated `remote.codingSessions`; the Host entry contributes no authority or configuration.

### Source actions

The Coding sessions section lists readiness and imported metadata for explicitly configured native sources. Original-profile source plugins can register selected Codex homes or Claude profiles/projects independently of model enablement; an already connected Codex backend and registered local Claude projects remain available sources. Browse pages native metadata; Import selects a readable original-ID mirror. Selecting a retained mirror requests its history explicitly. Refresh preserves visible data on failures and exposes source divergence. Disconnected sources and unsupported native writer handoffs have distinct visible states.

For linked import, select an existing cold ordinary Y destination in the exact recorded project or explicitly create one. Destination review displays its canonical event count and digest, the mirror revision, and the link revision when present. Import and linked refresh require that exact review. Imported history is labelled quoted context and grants no current instruction, tool, approval, sandbox, model, or native writer authority. Append-only compensation withdraws owned imported context from future ordinary-Y history while retaining the raw Session log, native history, and unrelated destination turns; it cannot undo responses already produced. An unresolved prepared linked write requires explicit recovery or abandonment. Abandonment is allowed only when the Host verifies that none of its owned context payload was written.

A supported continuation sends human text with the exact reviewed mirror revision. Sequential claim also requires selecting a live idle Y root Session for the same project and acknowledging that the other native writers are closed and the selected native profile will remain unchanged until release. The page shows the provider’s tool mode, Y ownership, explicit release and blocked uncertainty. Continue requires held Y ownership; release must complete before reopening the native CLI.

Where restart recovery is available, review the exact old owner, current mirror revision, interrupted phase, admitted turns, native receipt IDs, and unresolved turn count. Recovery requires acknowledging closed external writers, an unchanged native profile, and any admitted turns without native receipts. The cold history check permits a separate fresh claim; it does not establish the prior process’s exit, stream drain, or native persistence. The page retains those unknown observations in its recovery history, including after a later owner releases.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The feature owns the `coding-sessions` Settings section, typed English/Chinese copy, controller-derived component props, and operation notices in `shell.overlay`. It imports no values from other client plugins. Reconnect invalidates old replies and refreshes availability; owning-fiber disposal removes registrations, locale seats, and callbacks, and prevents late state changes. Slot redeclaration recovers both Settings and overlay contributions.

The Host owns source identity, bounds, durable reconciliation, and continuation admission. The UI grants no native writer, approval, sandbox, or model authority. Successful operations update the selected mirror, mapping, and inventory; failures retain readable history and report a transient notice. Cancellation waits for admitted Host writes, then reads the resulting mirror and mapping state. It clears the destination review without replaying or undoing any write; failed reconciliation remains visible and requires a later reload. Source reload updates the selected mirror's action capabilities without rereading its transcript and clears discovery pages whose source is unavailable. A changed revision clears the selection so the user can select and review current history before continuing.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Coding-session service](../../session/coding-session/README.md) — native read and continuation admission requirements.
- [Settings service](../ui-settings/README.md) — section registration and navigation.
- [Locale service](../locale/README.md) — typed feature copy and language selection.

-----

<a id="model-experience"></a>
## Model Experience

### Coding-session actions

#### What the model sees

The UI uses `remote.codingSessions` to display source metadata and readable mirrors. Browsing and mirror reads contribute no prompt, tool schema, or message to model context. Reviewed linked import adds historical quoted context to a destination’s later ordinary-Y requests; compensation withdraws its owned imported context from future effective history. These actions grant no native model or writer authority. Explicit continuation forwards human text and the reviewed mirror revision only when the Host publishes its opted-in provider capability. Sequential claim selects the existing Y execution authority; it creates no Agent or model turn.

#### Token effect

Browsing, mirror import, selection, refresh, destination review, linked import, and compensation make no model calls. Linked import and compensation can change token use in later ordinary-Y requests by changing their effective history. Any supported native continuation’s token use belongs to the Host’s source provider; this UI assembles no model request.

#### KV Cache effect

Displaying or refreshing a mirror leaves model request prefixes unchanged. Linked import appends quoted context to later ordinary-Y history; compensation withdraws earlier owned context and can invalidate prefix reuse. Neither transfers native cache state. Native continuation context and cache reuse belong to the source provider; displaying or refreshing a mirror does not reconstruct that context.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

This surface follows the capabilities published by the current Host source.

- Sequential handoff depends on explicit Host and source configuration plus a suitable live Y root Session; readers alone remain read-only.
- An unrelated external process can reopen the same native session. Restart recovery permits a separate claim only after explicit review and a cold source check; the page cannot infer prior process closure, stream drain, or native persistence from history.
- Imports retain a bounded public transcript; private context and unexposed native details are Unknown. Native non-text items appear as source markers rather than runnable Harness tool events. Imported history establishes no historical skill usage or learning evidence.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

`tests/browser-fixture.tsx` renders the production component and controller against a synthetic source for built browser checks. Fixture capabilities do not establish production native writer safety.

</details>
