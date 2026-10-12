---
description: "Native Codex and Claude coding-session discovery, durable mirrors, and safe continuation admission for deployments and maintainers."
kind: "package-reference"
---

# @deepseek-ai/dsh-coding-session

English | [中文](README.zh.md)

## Summary

Browse configured native coding sessions, import readable history, and refresh the same source into a durable Y mirror. Provider, authorized profile, and original native IDs keep sources distinct. Choose this package for coding-session history; consumer ChatGPT conversations are outside its scope. Selected original-profile sources can opt into explicit sequential continuation; native-enforced exclusive continuation remains a separate capability.

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

Mount beside configured storage-domain and Typert registry services. The Settings consumer is [ui-settings-coding-sessions](../../client/ui-settings-coding-sessions/README.md). Codex discovery uses an already connected configured backend; Claude discovery uses only registered workspace directories and the actual SDK profile root. Native discovery does not launch a model or request sign-in.

Codex source identity follows the backend's `DSH_CODEX_HOME`, which is passed as native `CODEX_HOME`; it does not discover a separate ordinary CLI home. Claude source identity includes `CLAUDE_CONFIG_DIR` or the SDK's default home and one registered project directory; worktree discovery is disabled. A source outside those configured scopes requires a separately authorized provider. The service does not change profile roots or authentication to find it.

### Configuration

`pageSize` bounds native pages; `maxEvents` and `maxBytes` bound complete histories and responses, including record wrappers. `maxMirrors` caps retained records and defaults to 500. `maxImportGenerations` defaults to 64 and preserves complete rollback generations; `maxEvents` and `maxBytes` also bound complete canonical Y destination logs and linked journals. `timeoutMs` bounds admission lifetime; cancellation drains underlying work. `enableClaudeDiscovery` defaults to true and can disable local Claude source registration. `enableSequentialHandoff` defaults to false. `sequentialTurnTimeoutMs` bounds sequential turns separately and defaults to 600000. A sequential source adapter and a selected live idle same-project Y root Session are also required; mounting a reader alone grants no model authority.

Mount `@deepseek-ai/dsh-coding-session/claude-source` beside this service and a managed subprocess provider to select an original external Claude profile without enabling a model. Its `sources` defaults to an empty array. Each source requires a stable `id`, visible `label`, absolute `profileRoot`, project `directory`, `shellHome`, `nodePath`, canonical `sdkModulePath` and `sdkManifestPath`, trusted `sdkModuleSha256`, `sdkVersion: '0.3.263'`, and positive `processGraceMs`. Source identity hashes the selected profile root, project and id. The plugin neither guesses personal roots nor copies authentication or history.

Claude sequential writer registration requires `sequentialHandoff.knownUnmanagedStartup: true`; omission or false keeps the source reader-only. It defaults to false and declares, through trusted deployment configuration, that the selected account, profile and machine have no managed, remote, helper or parent startup policy. Codex registration likewise requires both default-false source fields `enableSequentialProjectFiles` and `knownNoManagedFeatureOverrides` to be true; the latter declares that native feature requirements are absent or all false and remain unchanged. These declarations are separate from the user's closed-writer/unchanged-profile acknowledgement.

Fresh native observations still apply. Before each Claude dispatch, a selected-profile worker calls public `resolveSettings({ cwd, settingSources: [] })` and returns only a fingerprint and `noManagedSettingsObserved: true` for an empty supported result. Nonempty effective settings, provenance or sources, unknown shape, thrown resolution, any stderr bytes or incomplete stderr coverage refuse before durable dispatch and query. SDK 0.3.263 exposes no resolution-error list, skips policy-helper execution and cannot certify fresh remote-policy absence. Codex observes `configRequirements/read` after initialization and refuses forced-true feature requirements before thread operations; that observation cannot certify earlier Plugin warm startup. The trusted declarations are operational assumptions, not policy certificates or managed-policy bypasses. Provider details belong to the [Claude adapter](../../subagent/subagent-claude-code/README.md) and [Codex adapter](../../llm/llm-pi-ai/README.md).

Explicit discovery and history operations start private Node workers with child-only `CLAUDE_CONFIG_DIR` and `HOME`; the parent environment stays unchanged. Workers verify the official SDK manifest name, version and entry path plus the configured module digest before importing it. History requests accept only `listSessions`, `getSessionInfo` and `getSessionMessages`; the separate sequential policy observation uses `resolveSettings`. Complete UTF8 request/reply wrappers and raw history pages share the configured byte bounds. SDK and process failures expose sanitized errors. Registration and `getState` start no worker; cancellation and removal await child completion, output draining and managed-range release.

### History and recovery

`getState` returns bounded source readiness and mirror metadata without transcript bodies. Explicit selection loads `detail`. Import and refresh preserve stable original event IDs, digests, order, and cursors; repeated reads do not duplicate history. Edited, truncated, reordered, or conflicting native history retains the prior content with an explicit conflict. Refresh clears the conflict only when the source again extends that retained prefix. Removed and disconnected sources leave retained mirrors readable.

Codex reads use the connected desktop backend's 0.160.0 app-server API, distinct from the package-local subagent binary. Discovery sends `thread/list` with `useStateDbOnly: true` and the native default interactive source filter. Metadata-first reading hydrates complete legacy histories, or uses bounded `thread/turns/list` and `thread/items/list` pages for paginated histories. Two complete passes must match. Paginated reads never send full-history `thread/read`, whose loaded-thread path can persist native state. Supported read APIs can initialize or migrate their own database; import sends no native turn or transcript-write request.

Claude uses installed `@anthropic-ai/claude-agent-sdk` 0.3.263 public `listSessions`, `getSessionInfo`, and paginated `getSessionMessages`. Reads stay in the selected project, preserve message UUIDs, include system markers, and compare two complete metadata/history passes. Each pass rechecks original-session metadata after pagination; removed or changed sources refuse import. Native writer state remains unknown. Changing the SDK root or removing the registered workspace invalidates source readiness. Non-text items display native markers and retain their payload digest; imported history does not establish historical skill usage.

### Import into an ordinary Y Session

An explicitly reviewed public native mirror can be linked to one selected cold Y Session in the exact recorded project. The Host takes the existing SessionPersistence write ownership and refuses a destination that is published or live. The link retains the provider, configured profile, original native session ID, mirror revision, native event IDs and digests, and each event's destination sequence and quoted-text offsets. One active source maps to one destination, and one active destination maps to one source within the Host-owned journal.

Imported native user, assistant, system and tool records enter one labelled quoted user-context message per generation. The durable source is `coding-session-import`; historical tools remain observations and grant no executable tool, approval or instruction authority. Private context and unexposed native details are Unknown. Ordinary Y continuation uses its own provider, policy and tools; imported text supplies no learning evidence.

Journal admission reconstructs the complete source, project and authority-disclosure frame and ordered public records, then verifies each contiguous UTF-16 text mapping. Each generation keeps its original displayed title when mirror metadata refreshes.

An empty destination surface reserves an empty protected system head in the same write-ahead batch, before admitting quoted history. The local turn and step close at a dispatch barrier with the existing `blocked` ending; no AgentLoop request, model usage, learning evidence or native execution is recorded. An ignorable `coding-session/import-initialization` receipt binds its system message ID to the exact source, mirror and link. Ordinary Y resume supplies its own prompt on that reserved head. A nonempty destination without a protected head refuses before journal or destination changes.

Repeat delivery adds no second copy. Append refresh accepts only an unchanged native event prefix and adds the verified suffix. Edited, reordered or truncated native histories retain the prior imported data and publish a conflict. Resolving that conflict requires review and rollback; refresh never silently replaces retained history.

The versioned `coding_session_links` journal binds the exact canonical destination revision and complete staged Session events, including message IDs, timestamps and a detached constructor marker. Intent becomes durable before the destination append; committed link state becomes visible after destination flush. Explicit recovery verifies the complete stored prefix and exact prepared batch, appends only its missing contiguous suffix, and finishes an already durable receipt without duplicating context or changing later user turns. Unexpected prefix or batch changes are retained and refused.

A reviewed unexecuted intent may be cancelled to retry after a destination change. Cancellation changes only the journal and preserves prior committed generations. It refuses if any planned import, compensation or initializer system message ID already appears in the canonical destination log, or an owned initializer receipt is durable; changing timestamps does not make these writes unexecuted. Those writes require recovery and guarded rollback.

Host cancellation rejects mutations queued under the previous cancellation epoch and joins admitted work. An admitted write retains its durability result or prepared receipt. A fresh reviewed request can run after cancellation.

Rollback appends single-node surface replacements for exact owned current import nodes. It withdraws those nodes from future model history, retains original native receipts and the append-only Session log, and preserves subsequent Y turns. It cannot undo responses already produced using the imported context. A replaced, compacted or edited import node refuses compensation instead of overwriting current user content.

The deployment bounds complete framed UTF-8 journal and inventory bytes, retained event count, mappings, records and generations. Hitting a bound refuses the operation; rollback receipts are not discarded to make room. The journal has one active Host/domain owner. SessionPersistence protects destination writes, but this feature does not establish global native-writer exclusion or a cross-process lock against arbitrary journal-file writers.

An unfinished destination tool turn refuses cold writes until ordinary Y resume repairs it; the operator then reviews the new canonical revision. Cancellation aborts destination admission, joins uncancellable handle closure and refreshes the Settings mapping inventory. It never promises to undo a committed write.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The `coding_sessions` storage domain holds independent mirror records, separate from runnable Harness Session logs. Source registration belongs to the native connection; removing a registration changes availability without deleting history. Operations serialize through their actual underlying work. A read deadline may return early, but cancel/dispose fences late responses and waits for native reads and admitted durable writes before closing the domain. An admitted write may finish during draining; none outlives completed disposal.

### Continuation ownership

Sequential claim requires the original source/profile/session, exact reviewed revision and project, selected live Y root Session, and explicit acknowledgements that the other native writers are closed and the selected native profile will remain unchanged until release. A fresh private process reads the original history before a turn. Stale history rejects claim. Continued turns recheck the same live Agent and retained history, resume the original native ID, and use the provider’s published tool mode. This mode does not prevent an unrelated process reopening the source.

The independent `coding_session_handoffs` domain records ownership before native effects. Claim, continue and release remain visible; uncertain persistence or closure blocks further continuation. Release requires owned process exit, drained streams and a new cold source read confirming the retained prefix and completed native turns. These observations establish saved-turn evidence, not a universal native recorder or context certificate. After a Host restart, unresolved markers retain the old ownership phase and remain blocked because metadata cannot reconstruct the original process handle. `recoverSequential` uses the connected reader to check the exact original source and retained prefix after the operator reviews the current mirror revision and old owner token, stops preceding writers, and acknowledges a stable native profile. Admissions lacking recorded native turn receipts require explicit acceptance. Divergence retains a conflict; restoring the retained prefix and reviewing the conflict revision permits another cold check. A committed `recovered-acknowledged` checkpoint allows a separate fresh claim while retaining all prior admissions, observed turn IDs and missing old process/stream/persistence evidence. Recovery never reports successful original release, and a later owner’s release does not settle those earlier unknown observations. Writer and startup opt-ins remain required for each new claim; cold recovery itself starts no turn.

An explicitly registered exclusive writer must atomically exclude every native/external writer before returning an idle lease. The Host checks the original provider/profile/native ID, reviewed revision, cursor, and digest while ownership is held. It calls `resumeOriginal` on that identity, imports the settled source result, and awaits release. The provider owns normal source-bound approvals and sandbox policy and must settle cancelled resources before release. A Y-local lease, idle observation, copied history, or replacement source cannot implement this role.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Storage-domain service](../../storage/storage-domain/README.md) — durable record ownership.
- [Codex connection provider](../../llm/llm-pi-ai/README.md) — configured native peer readiness.
- [Coding-session Settings](../../client/ui-settings-coding-sessions/README.md) — source selection and readable history.

-----

<a id="model-experience"></a>
## Model Experience

### Native history and continuation admission

#### What the model sees

Native discovery and mirror import or refresh register no model-visible prompt, tool, or input. Explicit ordinary-Y linked import makes source-labelled historical quoted context visible in that destination’s later requests; it supplies no current instructions, tool authority or learning evidence. The `coding_sessions` records are readable mirrors, separate from runnable Harness Session logs. Explicitly opted-in sequential continuation passes human text to the original native provider/profile/session. The native provider retains its own context; the mirror is not a replacement transcript. Claude’s conversation mode disables project tools. Codex’s project-files mode confines file changes to the selected Y root’s writable policy; shell, JS, multiagent, native extensions, escalation and added permission grants are unavailable. The stronger exclusive writer uses its separate source lease.

#### Token effect

Discovery, import, and refresh make no model calls and consume no model tokens. A supported writer's continuation can consume native model tokens; the registered source provider owns its request and retained context rather than reconstructing model input from the mirror.

#### KV Cache effect

Read operations neither append to nor replace model request prefixes. Native continuation context and cache behavior belong to the registered writer provider; the mirror itself establishes no cache reuse or transfer of live runtime state.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

Sequential continuation is an explicit operational handoff. Other writers must be closed by the user, and Y must complete release before the native CLI resumes the same ID.

- Native-enforced exclusive continuation remains unavailable from the shipped native readers. Sequential ownership does not implement that stronger capability.
- Claude sequential mode does not execute project tools; Codex supports only its declared project-files subset. Retained native context remains subject to provider compaction and retention.
- Unresolved ownership after Host restart cannot be released using history metadata alone. Code rollback cannot undo native turns already appended.
- Sequential turns use the selected Y root for authority outside its ordinary AgentLoop task. They do not generate normal Y task skill-learning evidence. Codex configuration checks are observational; no atomic profile pin excludes arbitrary external edits.
- Trusted startup declarations cannot certify global policy absence; unsupported or undeclared deployments remain reader-only.
- Native reads are observational snapshots; two matching complete passes do not create native writer exclusion.
- In-process SDK reads cannot be physically cancelled; safe teardown waits for them. Explicit source workers can be terminated and must reach managed-range quiescence before disposal completes.
- Retention capacity refuses additional imports without deleting records; deployments can raise the configured cap.

<a id="dev-note"></a>

Lost ownership handles cannot be reattached or naturally released through supported upstream APIs. Operator-acknowledged restart checkpoints preserve this uncertainty and do not exclude arbitrary external writers.

The version-2 `coding_session_handoffs` journal refuses predecessor readers and existing version-1 units. There is no automatic migration. Existing version-1 data requires an explicitly reviewed offline conversion preserving every marker and its backup before deployment; reverting to the old backup after later admissions would lose uncertainty and is not a supported rollback. No user journal conversion occurs in this local feature phase.

### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Loader and composed browser fixtures exercise source reads, original-ID continuation, ownership, conflicts and failure handling with mocked writers. They do not establish actual native process persistence or external-writer exclusion.

</details>
