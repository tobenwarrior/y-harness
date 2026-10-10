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
- [Decision advice](#decision-advice)
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

Host-captured observations retain task, session and event identities immutably. Eligible completed, substantial live API tasks can automatically produce create or update proposals; completion, successful tool delivery and process output do not verify successful skill use. Providers receive bounded metadata, selected complete bodies and observations. `learn` selects relevant managed sources before proposing updates and rejects compression or archive drafts; creation checks existing metadata, binds the reviewed destination to the current registered project path and chooses a new project `.dsh/skills/<name>/SKILL.md` location. Unknown fields, arbitrary truncation and unselected writes are rejected.

Live root Codex tasks and explicitly enabled Claude root turns can learn concrete procedures from matched native item starts and settlements after the Session durability barrier. The collector retains the configured connection, original native session and item identities, ordered source event references, and reported outcomes. Codex preserves its actual turn; Claude preserves the explicit client send UUID and actual assistant-source, tool-use and result-message UUIDs without inventing a native turn. Learning evidence discards raw arguments and output. Explicitly agent-origin simple project-root reads of safe source paths and normalized allowlisted check invocations become reusable procedure steps. Paired completed Codex file-change metadata can also retain bounded add, delete and update operations with safe project paths and optional update move targets; raw diff text is discarded. These patch steps require current-task and current-file review and independent outcome checks; they grant no permission and never replay historical changes. The parser also recognizes fixed `/bin/zsh`, `/bin/bash` or `/bin/sh` wrappers with `-lc` or `-c` and one plain single-quoted allowlisted body; other shells, expansions, nested quotes and compound commands remain unsupported. At least two distinct concrete facts are required; unknown-only tools, mismatched settlements, overflow and interrupted or inherited work cannot generate automatic procedures. Native `SKILL.md` command-action paths remain read observations, with unknown full-load, version and application coverage.

Supported original-session sequential continuations run as fresh cancellable maintenance-owned Y tasks, separate from ordinary AgentLoop turns and imported history. Each admission receives a new task identity and durably records its original provider, profile and session before dispatch, then its actual current native turn before item collection. Normal Y followups wait until this task settles; cancellation and service disposal abort and join its admitted work. The bridge pairs only current-turn sanitized native starts and settlements, rejects duplicate or conflicting identity, and flushes the task and action records before existing project learning policy can act. Prior completed Y turns, mirror text and release receipts never grant fresh learning evidence. The log-only task settlement discloses unsupported or insufficient procedure evidence independently from native completion. `sequentialLearningMaxItems` and `sequentialLearningMaxTaskBytes` bound item collection and sanitized prompts. The learning input limit separately bounds cumulative complete Session event frames with reserved settlement space and complete evidence including source identities and event references, before either is written. Oversized evidence retains native completion with unavailable learning. The existing operation limit bounds durability waits.

Sequential Codex project-file observations supply supported safe read or patch facts to the existing deterministic generator and validator; check or command metadata does not create shell authority. The pinned public file-change protocol supplies paths, change kinds and reported completion status; only exact current-turn paired notifications can contribute patch facts. This wiring does not establish that the installed project-files subset exposes concrete read notifications while shell tools are disabled. Unsafe, unsupported or unknown-only items retain an explicit insufficient outcome. Claude's conversation-only sequential route exposes no paired project-action procedure and records an unsupported outcome without inventing Skill learning. Fixture notifications validate task ownership and evidence processing, not native capability availability or successful Skill use.

The deterministic `native-observation` generator updates an existing managed project Skill with the same set of concrete facts before creating a new path. Different fact sets are separate families; no semantic similarity or broader deduplication is inferred. Automatic creation requires an enabled project policy naming that generator and `native-observation-validator` with create permission. The independent validator recomputes the entire permitted addition from immutable facts. New Skills alone receive management and policy consent; existing user, pinned, vendor, native and hand-edited sources keep their protection. Repeated identical procedures produce no draft. The Claude root route retains a confined SDK query across ordinary turns of the same live Harness Session and durably logs separate public protocol events; only paired sanitized items contribute root learning. Its supported one-shot child stream still emits separate source-labelled tool observations and never establishes parent verification or authorizes root learning.

Durable proposals retain full source and survivor bodies, hashes, resource fingerprints, permission lines, literal code, references and uncertainty. Reviewed application rechecks these within the source writer's queue and keeps rollback history. Archive requires an active survivor with at least the original scope, equivalent instructions and resources, and no incoming references across registered projects. Archive compares resolved reference targets: references to skills retain the same skill identity, matching bundle resources can move with the survivor, and external file or URL references retain their targets. Uncertain equivalence requires an independent scoped check. Interrupted applications reconcile committed source changes before retry; rejection retains history.

The built-in `instruction-redundancy` operator removes exact duplicate standalone Markdown link bullets throughout one complete list under an explicit `References` heading, including blank separators. It retains first-reference order, blank separators, non-reference bytes and the final-newline convention. Every nonblank list line must be a standalone link entry; explanations, tasks, ordered or nested items and fences prevent reduction of that list. A new heading ends the list; entries are never merged across headings. Bodies with indentation or HTML remain unchanged. Its separate validator recomputes the exact transformation and binds a receipt to the complete proposal. Duplicate retirement requires equal bodies after that reduction, exact resources, compatible resolved references, an active survivor and the scope/invocation checks above. These are narrow mechanical invariants, not a guarantee of total semantic equivalence.

Automatic maintenance requires an approved `instruction-redundancy-validator` policy and explicit per-file consent matching the current adopted hash. The polling consumer runs bounded passes; `cleanupSemantic` runs one immediately. Per-file check timestamps rotate routine selection; a retained survivor cursor rotates bounded duplicate inspection across restarts. Force cleanup bypasses the routine interval, preserving ownership, pins, policy and hash checks. Generic validator claims remain reviewable and cannot authorize automatic rewrites. Revoking a policy removes automatic authority while retaining history; archiving disables the source consent so restoration remains visible.

An explicit project policy binding `native-observation` to `native-observation-validator` can authorize creation and update of observed procedures. The host selects the exact existing workflow before creation, independently recomputes its permitted text and opts in only a newly created Y-managed source. Project approval never adopts existing files. No policy means review; repeated procedures produce no write. Body, project growth, operation and time bounds apply before automatic source admission. Provider deadlines abort their signal and reject late results; another provider call is refused until underlying work settles; admitted source inspections, filesystem operations and provider tasks drain on disposal because their completion cannot be forcibly canceled. Mechanical maintenance makes zero model calls.

<a id="decision-advice"></a>
## Decision advice

`decisionStatus`, `decisionCapabilities` and revision-checked `configureDecision` own a separate opt-in selection, initially disabled. Only an exact registered adapter declaring `auxiliaryGeneration: 'api'` can prepare or execute advice. Native routes, including cached Codex gpt-6-luna, remain unavailable because empty Harness tool schemas or a final-response schema cannot disable native tools. No credentials, OAuth grants, main-chat routing or model preferences are changed. A future Hermes JEV integration requires a dedicated typed adapter; it cannot become a general automatic router.

Explicit `retrieve` requests first use deterministic project/shared filtering and ranking. Enabled advice sees only that admitted metadata subset and the query; it may reorder candidates, while membership and explicit selections remain authoritative. Abstention, invalid JSON or IDs, duplicate IDs, tool chunks, missing effort/tier, route changes, cancellation, deadline or durability failure retain deterministic order. Advice never grants verification, tools, permissions, writer ownership or maintenance authority. List and graph browsing do not call a model.

The `decision` deployment configuration bounds complete framed input bytes, a conservative input-token reservation, output bytes/tokens/chunks, deadline, concurrent calls and retained logs. Each retrieval has at most one call without retries. UTF-8 input bytes reserve one token per byte, and the exact model context reserves output separately. `skill_decision` stores independent settings and capped reconstructable request/result records before dispatch and before publishing advice. It contains metadata only; no instruction bodies, tool output or transcripts are sent. Provider calls must honor cancellation; disposal waits for in-flight work to settle.

On a new Host controller, advice requests retained as pending from a previous process are durably settled as abstained with `interrupted-before-settlement`. Prior selected IDs and output are discarded; no request is replayed. New advice and status remain gated until this exact repair is durable. A failed repair keeps the controller unavailable, and disposal joins admitted writes. Current-controller pending work is not classified as interrupted.

Human-labelled fixtures in `tests/fixtures/decision-labels.json` identify relevance, rejection, explicit requests and negative controls. Scripted tests establish admission, parsing, logging and fallback, not live model quality. Authorized provider evaluation must separately report recall, false selections, abstention/fallback, latency, tokens and disclosed cost.

<a id="configuration-and-provider-extension"></a>
## Configuration and provider extension

`dshHome`, `agentsHome`, `customSkillDirs` and `bundledSkillDir` select the same roots as the filesystem provider. Additional root configuration must match the mounted invocation source. `bodyBudgetBytes`, `retrievalLimit`, `proposalLimit` and `automaticMaintenanceIntervalMs` bound local maintenance and metadata selection. Native providers use `registerNativeProvider()`. Learning uses `registerLearningGenerator()`; `registerLearningValidator()` registers independent checks. Each registration returns a disposer. `learningMaxInputBytes`, `learningMaxSources`, `learningMaxEvidence`, `learningMaxResourceFiles` and `learningMaxResourceBytes` bound complete provider inputs, proposals and resource inspection. Resource hashes use bounded reads of actual bytes and bounded directory entry inspection, and refuse changing files. `maintenanceMaxOperations` limits automatic changes in one pass; `learningOperationTimeoutMs` sets its admission deadline; `automaticProjectSkillLimit` limits managed project growth during native creation.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

Skill files and bundle resources remain authoritative. The `skillLibrary` Remote namespace supplies scoped inventory, lazy instructions, load observations, explicit relationships, source history and learning proposals. The `skill_library` domain contains management flags and history references; `skill_learning` retains evidence, full proposals and approved and revoked semantic policy records.

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

- Generic action deletion, arbitrary rephrasing, paragraph merging, code changes and uncertain supersession remain review suggestions. Mechanical maintenance and native procedure recording make no model call and do not establish task success. Native instruction bodies and sizes still require an explicit loading adapter.
- Inactive preset roots, undiscovered projects and historical usage are outside current coverage. The built-in generator requires retained captured routes for selected evidence, including whether effort or tier were absent; missing route capture or conflicting controls makes a proposal unavailable. A latest project route cannot replace missing evidence routes. References do not establish inferred similarity or ownership.
- Archive and revision backups are retained without automatic expiry; interrupted restore recovery can require human inspection. Hash checks serialize library operations and reject changed previews, but do not provide an operating-system compare-and-swap lock against arbitrary external writers.

<a id="dev-note"></a>
### Dev Note

None.
