---
description: "Opt in to sharing ordinary provider catalogs between isolated Harness profiles."
kind: "package-reference"
---

# @deepseek-ai/dsh-provider-config-sync

English | [中文](README.zh.md)

## Summary

Share ordinary provider names, endpoints, and model catalogs between compatible, explicitly paired profiles. Each application keeps its own authentication, session history, recipient restrictions, and runtime home. The base bundle mounts this plugin with sharing unconfigured.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

After both applications have qualified code supporting this package, configure the same absolute local file path in each approved profile:

```yaml
- id: provider-config-sync
  name: '@deepseek-ai/dsh-provider-config-sync'
  config:
    sharedPath: /absolute/owner-only/provider-catalogs.json
```

An absent `sharedPath` performs no synchronization and creates no files. Pairing never enables a disabled adapter. A profile whose `llm-pi-ai` namespace is absent remains pending. In particular, an approved vault profile restricted to Sol/OpenAI retains that restriction; use an independently scoped profile to configure other providers.

| Field | Default | Meaning |
|---|---|---|
| `sharedPath` | unset | Explicit absolute path to the ordinary catalog document shared by approved local profiles. |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-provider-config-sync) is the exhaustive source for accepted configuration fields.

The allowlist contains `displayName`, `api`, a credential-free HTTP(S) `baseURL`, `models`, and `modelOverrides`. Model fields contain IDs, names, capacities, supported input modalities, reasoning choices, and default effort. Unknown fields, request headers, API key references or values, OAuth grants and client identities, cookies, vault settings, experimental controls, default recipients, and session selections are excluded. URLs with userinfo, any query, or a fragment are refused rather than rewritten.

`ctx.providerConfigSync.synchronize()` requests a serialized refresh and `status()` reports readiness, pending configuration, conflicts, or errors. Same-provider conflicts preserve local and shared values. Resolve one by explicitly editing the local ordinary configuration to the shared choice, or by choosing a distinct shared path. An existing route's protocol or endpoint change always requires local resolution; sync cannot silently redirect its authorization. Deletion remains a conflict while inherited or excluded local fields would be discarded. Confirm and remove those local routes through their owning settings interface before retrying.

New API-key routes receive a target-owned, unique, intentionally unconfigured credential reference. No credential record is created. Enter a key through that application's masked provider form when desired. New Nous/retired ChatGPT routes require local setup because they cannot use this missing-key protection.

### Authentication consent

Ordinary configuration synchronization does not avoid separate authentication. The supported route today is user entry in the target application's masked key form, or an explicit target-app sign-in. The user chooses whether to persist the credential locally; the assistant does not inspect or transfer its value.

A future secure transfer requires separate, specific consent identifying the source and destination applications, the provider/account, the exact key or grant scope, whether access persists, and how to revoke it. The handoff must run directly between trusted Host processes or an approved OS credential store with destination identity checks, owner-only access, and a provider-scoped record; it must not pass through chat, the ordinary shared file, screenshots, logs, or Library. OAuth transfer additionally requires provider support for that destination and grant audience. No such transfer or new authorization grant is initiated by this plugin. Pointing both apps at one whole credentials file would share unrelated access and is outside this route.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

Each provider is compared against the current local projection, shared record, and persisted common baseline. Independent provider edits converge; competing changes to the same provider preserve both and report a conflict. Explicit deletion tombstones remain in the shared document. Namespace disappearance and missing keys never imply deletion.

The shared document uses version 1 and a fingerprint of the active namespace schema. Unknown versions, mismatched schemas, malformed documents, and unsafe values pause synchronization without overwriting files. A receipt owned by each local profile binds its baseline to the shared path and schema, so a restart does not republish a stale profile over a tombstone. Missing shared files with an existing baseline require recovery instead of automatic recreation.

Shared writers use the existing cross-process atomic-write lock and rename commit. Local imports use revision-checked Settings mutations and the Configuration Editor's locked validation/reconciliation path. A receipt advances only after the local and shared provider projections agree. Notifications coalesce into one queue; disposal closes the watcher and drains the current operation. Files are written with mode `0600`; only same-host local-file coordination is supported.

HMR starts the queue and watcher outside its transaction context. Owner cancellation settles queue and preflight preparation before a caller's intended change begins, including self-disposal caused by external profile reconciliation. An apply already started drains; cancellation before atomic replacement leaves the patch unchanged, and cancellation after that cutoff completes reconciliation or its existing rollback. The shared document and receipt are each bounded to 1 MiB before any publication or local import.

</details>

<a id="further-exploration"></a>
## Further Exploration

- [Settings forms](../settings/README.md) — active descriptors and revisioned edits.
- [Configuration editor](../../boot/config-editor/README.md) — locked persistence and rollback.
- [Pi-ai provider configuration](../../llm/llm-pi-ai/README.md) — route catalogs and serviceability.

<a id="model-experience"></a>
## Model Experience

### Provider catalog selection

#### What the model sees

The plugin performs no model requests. Synchronized catalogs become available only in an already permitted active `llm-pi-ai` namespace. Existing sessions and their provider-qualified model choices remain local.

#### Token effect

Synchronization adds no prompt text, tool schema, messages, or auxiliary model requests. Any later user-authorized inference uses the selected adapter's ordinary request assembly.

#### KV Cache effect

None directly. A user-authorized subsequent model choice retains its owning adapter's cache behavior.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

Sharing requires compatible code and explicit pairing; authentication stays local.

- Pairing requires explicit activation in both qualified applications. Installing Test source does not update or promote Main.
- Exact schema compatibility is conservative; unsupported schema versions require a reviewed migration.
- Authentication transfer, cross-host synchronization, conflict resolution UI, and shared session/default-recipient selection are deferred.
- Remote deletion or model replacement that would discard excluded local fields requires local resolution. Tombstones are retained without automatic compaction.
- This package has no inference entitlement and performs no live provider validation.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The bounded Main/Test repair preserves deliberately separate runtime homes and the existing provider recipient guard. Fabricated, keyless fixtures own synchronization acceptance.

</details>
