---
description: "Inspect project skills and maintain explicitly adopted files with reversible history."
kind: "package-reference"
---
# Skill Library

English | [中文](README.zh.md)

## Summary

Browse project and shared skills, inspect complete instructions and history, and review proposed reusable procedures. Keep existing skills protected until you explicitly adopt a file, and maintain eligible skills through reviewed proposals. Restore archived bundles and roll back instruction changes while retaining history. Use this package for the human Skills library; the [skill subsystem](../../../docs/subsystems/skills.md) owns model invocation.

## Table of Contents

- [Inventory and protection](#inventory-and-protection)
- [Maintenance and history](#maintenance-and-history)
- [Evidence and semantic proposals](#evidence-and-semantic-proposals)
- [Configuration and provider extension](#configuration-and-provider-extension)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="inventory-and-protection"></a>
## Inventory and protection

The library reuses filesystem skill discovery with watching disabled, preserving candidates that the invocation registry normally shadows. Registered Workspace paths select project roots. Global and currently mounted agent registries add protected packaged and custom summaries; inactive presets are not mounted for inventory. Native providers contribute metadata from existing connections without starting a process. Provider availability and telemetry coverage are independent.

Identity combines provider and canonical instruction location. Recreating a file at an archived location produces a distinct active identity, preserving the archive. Existing files start protected; bundled and native entries cannot be adopted or archived. Adoption explicitly owns one file hash and leaves automatic cleanup off. A later hand edit restores protection until deliberate re-adoption. Pinning excludes a managed skill from maintenance.

Successful Harness `skill` tool results count only when provider, name, resource directory and current instruction text uniquely match a local file. Counts describe observed loads, never successful application. Explicit injections, historical sessions and native implicit loads have unknown coverage; zero recorded loads does not mean unused. No activity-based expiry runs.

<a id="maintenance-and-history"></a>
## Maintenance and history

Cleanup previews contain complete before/after instructions. Managed, unpinned files can remove excessive blank lines outside fenced code. Skills with indented code are left intact. YAML, wording, repeated paragraphs, code and permission instructions remain unchanged. The configurable body budget flags a need for semantic review; it never truncates instructions.

Application checks the source hash before applying a preview and saves the previous instructions. Source replacement and management publication have recovery journals. A conflicting later edit is preserved, with the previous version still available. Rollback creates another revision. Archive moves the complete bundle into a nested `.skill-library-archive` directory on its own filesystem. Restore uses exclusive destination creation and retains the archive backup; occupied locations are never overwritten. Interrupted restores preserve both locations and report a recovery warning.

Automatic whitespace cleanup requires adoption and a separate per-skill opt-in. The configurable poll interval defaults to ten minutes; zero disables polling. Existing user, vendor and unknown-owner skills are never automatically adopted or edited. There is no permanent-delete endpoint.

<a id="evidence-and-semantic-proposals"></a>
## Evidence and semantic proposals

Host-captured observations retain task, session and event identities immutably. Eligible completed, substantial live API tasks can automatically produce create or update proposals; completion, successful tool delivery and process output do not verify successful skill use. Providers receive bounded metadata, selected complete bodies and observations. `learn` selects relevant managed sources before proposing updates and rejects compression or archive drafts; creation checks existing metadata and chooses a new project `.dsh/skills/<name>/SKILL.md` location. Unknown fields, arbitrary truncation and unselected writes are rejected.

Durable proposals retain full source and survivor bodies, hashes, resource fingerprints, permission lines, literal code, references and uncertainty. Reviewed application rechecks these within the source writer's queue and keeps rollback history. Archive requires an active survivor with at least the original scope, equivalent instructions and resources, and no incoming references across registered projects. Archive compares resolved reference targets: references to skills retain the same skill identity, matching bundle resources can move with the survivor, and external file or URL references retain their targets. Uncertain equivalence requires an independent scoped check. Interrupted applications reconcile committed source changes before retry; rejection retains history.

Compression and deduplication require explicit requests and reviewed proposals. Semantic source writes require review; no production operator automatically applies them. Validator registration, approved policies, per-file semantic opt-ins and hash-bound receipts remain inactive extension support. The package supplies no independent validator; observations cannot authorize semantic writes.

<a id="configuration-and-provider-extension"></a>
## Configuration and provider extension

`dshHome`, `agentsHome`, `customSkillDirs` and `bundledSkillDir` select the same roots as the filesystem provider. Additional root configuration must match the mounted invocation source. `bodyBudgetBytes`, `retrievalLimit`, `proposalLimit` and `automaticMaintenanceIntervalMs` bound local maintenance and metadata selection. Native providers use `registerNativeProvider()`. Learning uses `registerLearningGenerator()`; `registerLearningValidator()` supports inactive validation extensions. Each registration returns a disposer. `learningMaxInputBytes`, `learningMaxSources`, `learningMaxEvidence`, `learningMaxResourceFiles` and `learningMaxResourceBytes` bound complete provider inputs, proposals and resource inspection.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

Skill files and bundle resources remain authoritative. The `skillLibrary` Remote namespace supplies scoped inventory, lazy instructions, load observations, explicit relationships, source history and learning proposals. The `skill_library` domain contains management flags and history references; `skill_learning` retains evidence, full proposals and inactive semantic policy records.

</details>

<a id="model-experience"></a>
## Model Experience

### Management and progressive retrieval

#### What the model sees

The management API does not inject a skill inventory or graph into model context. `retrieve` ranks current-project and shared metadata before a caller requests individual bodies, excluding native entries without a loading adapter. Human graph relationships come from explicit metadata and Markdown resource links outside code examples. Learning generators see a separate bounded request containing recorded observations and selected complete sources; they cannot issue verification evidence.

#### Token effect

Inventory and graph navigation add no model tokens. Loading a selected body through an existing invocation path retains that path's token cost. Proposal generation adds the configured bounded auxiliary request; shorter reviewed bodies can reduce later load size, without a token or success guarantee.

#### KV Cache effect

Management reads do not change the model request prefix. Existing skill invocation owns subsequent context changes. Auxiliary proposal requests do not rewrite the active task prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Semantic suggestions need an available bounded generator. The shipped runtime has no automatic semantic operator or independent validator; validator, policy and receipt APIs provide inactive extension support. No verifier is inferred from turn completion. Native instruction bodies and sizes require an explicit loading adapter.
- Inactive preset roots, undiscovered projects and historical usage are outside current coverage. The built-in generator requires retained captured routes for selected evidence, including whether effort or tier were absent; missing route capture or conflicting controls makes a proposal unavailable. A latest project route cannot replace missing evidence routes. References do not establish inferred similarity or ownership.
- Archive and revision backups are retained without automatic expiry; interrupted restore recovery can require human inspection. Hash checks serialize library operations and reject changed previews, but do not provide an operating-system compare-and-swap lock against arbitrary external writers.

<a id="dev-note"></a>
### Dev Note

None.
