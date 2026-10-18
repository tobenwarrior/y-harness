# Agent Note: Ordinary provider configuration sharing with local authorization

Status: implemented

## Problem

Independent application profiles keep their own provider catalogs, so users repeat ordinary provider and model setup. Sharing an entire Harness home also shares session histories, credentials, vault state, and experimental controls. Copying a credential reference can silently bind another application's existing or ambient authorization, and an endpoint change can send that authorization to a different recipient.

## Decision

The optional [provider-config-sync package](../../../../packages/settings/provider-config-sync/README.md) pairs profiles only through an explicit shared local path. Its strict projection contains ordinary route names, protocol, credential-free endpoint, and model catalog fields. Session/default-recipient choices, disabled flags, auth references, headers, OAuth state, and unknown fields remain local. A missing adapter namespace waits without changing the recipient guard.

Each provider has a shared record and local common baseline. Three-way comparison merges independent providers, preserves competing changes as conflicts, and publishes deletion only through explicit tombstones. Namespace disappearance does not delete records. Schema fingerprints normalize process-local Schemastery IDs but retain schema meaning; mismatches and unknown versions refuse synchronization. Local imports retain revision checking and use the existing Settings/Configuration Editor persistence owner. One cross-process lock covers shared publication, local reconciliation, and receipt advancement; atomic writes and bounded documents preserve restart and crash recovery.

New API-key routes receive a fresh, target-owned missing credential reference, with no credential value or record. This uses the fail-closed lookup established by the [credential-boundary decision](2026-07-30-credential-boundaries-and-atomic-registration.md). Routes incompatible with that protection require local setup. Existing endpoint/protocol changes conflict, and deletion or model replacement cannot discard excluded target fields. Credential entry or sign-in happens separately in the target application; a secure transfer would require distinct provider/account-scoped consent and a trusted Host or OS credential-store handoff.

The refresh queue and watcher start outside HMR's transaction context through an additive `runOutsideTransaction` helper. HMR exclusivity remains intact. A Host-only owner signal cancels queued work and preflight preparation before the intended change starts, including external profile reconciliation that disposes the caller. Started apply work drains; abort before atomic replacement writes nothing, while abort after replacement starts completes reconciliation or the existing rollback. This prevents disposal from waiting on the transaction that is disposing it. The [runtime-refresh decision](2026-09-30-profile-package-refresh-and-manifest-invalidation.md) retains ownership of package resolution and cache expiry; neither existing decision is superseded.

## Alternatives considered

**Share the whole application home or credentials file.** This would share unrelated histories and persistent access. Ordinary configuration consent does not authorize that expansion.

**Copy references, omit authentication fields, or reuse a deterministic missing reference.** Omitted references permit ambient/provider-native fallback. Copied or reused references can resolve unrelated or previously persisted keys. Fresh target-owned references remain unconfigured until explicit local setup.

**Last writer wins, or merge every nested key independently.** Either can discard concurrent intent or combine incompatible endpoint/model facts. Per-provider conflicts retain both values, while the strict allowlist leaves target-only fields with their owning application.

**Await every cancelled queued editor operation, or settle active commits early.** The first deadlocks HMR self-disposal; the second reports cancellation while durable work still runs. The owner signal settles only before intended apply begins and preserves the existing commit cutoff.

## Verification

The package's [projection](../../../../packages/settings/provider-config-sync/tests/projection.spec.ts), [merge](../../../../packages/settings/provider-config-sync/tests/sync.spec.ts), [real Loader/HMR](../../../../packages/settings/provider-config-sync/tests/plugin.spec.ts), [lifecycle](../../../../packages/settings/provider-config-sync/tests/lifecycle.spec.ts), [commit cancellation](../../../../packages/settings/provider-config-sync/tests/cancellation.spec.ts), and [independent-process](../../../../packages/settings/provider-config-sync/tests/process.spec.ts) fixtures use fabricated, keyless profiles. They cover conflicts, deletion, schema compatibility, excluded data, re-entry, hot activation/disposal, concurrent writers, crash recovery, and restart persistence without inference.

## Consequences

Compatible, explicitly paired profiles share ordinary catalogs while retaining separate access and session state. Conflicts and target-only fields require local resolution. Pairing remains unconfigured by default; this source change does not promote another installed application. Cross-host coordination, conflict-resolution UI, credential transfer, and shared default recipients remain deferred. Owner-only POSIX file modes do not provide a boundary against processes running as the same OS user; stronger credential isolation belongs to the credential provider.
