---
description: "Claude Code delegations and optional normal root turns for users and maintainers configuring a native product route."
kind: "package-bundle"
---

# @deepseek-ai/dsh-subagent-claude-code

English | [中文](README.zh.md)

## Summary

Install this Profile Bundle for fresh, unattended Claude Code delegations in the parent workspace. Each run accepts one self-contained text task and returns the final answer or a safe failure diagnostic; reasoning, tool traffic, stderr, usage, and workspace diffs stay out of the parent Session. Native Claude settings and authentication remain authoritative; Profile configuration selects the model, environment, and `permissionMode`. The platform-pinned runtime starts on demand without host `claude` fallback. Explicit `rootRoute` enables normal text-only root turns with one live native query per Harness Session; it is dormant by default.

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

Mount this provider when a delegation should run as a real Claude Code session in the parent's workspace. The common path is explicit: install the Bundle into a Profile, optionally configure the provider row, and expose it to the model through a delegation tool row.

### Installing the Bundle

Install the package into the target Profile, then restart that Profile. The installation brings the pinned Agent SDK and one compatible platform CLI payload into the Profile; the declared patch layer registers only the dormant provider and starts no Claude process.

```sh
dsh plugin --profile <name> add @deepseek-ai/dsh-subagent-claude-code
dsh plugin --profile <name> remove @deepseek-ai/dsh-subagent-claude-code
dsh --profile <name>
```

Removing the package withdraws the provider and its private runtime closure on the next Profile start. Installation controls Host availability, not model permission: the model can only reach the provider through a delegation tool row you compose.

### Configuration

| Field | Default | Meaning |
|---|---|---|
| `providerName` | `claude-code` | Non-empty registry name on `ctx.subagents`; each mounted instance needs a unique value |
| `model` | native Claude settings | Optional non-empty model name fixed for every run from this provider instance; omission sends no SDK override |
| `env` | `{}` | Explicit SDK/CLI environment layered over the credential-scrubbed parent environment |
| `permissionMode` | `dontAsk` | Native non-interactive permission policy fixed for every run from this provider instance |
| `disposeGraceMs` | `3000` | Grace between the shared managed-range owner's termination tiers |
| `toolObservationMaxItems` | `64` | Direct child tool identity collection bound, an integer from 1 to 256; overflow discards the complete observation batch |
| `rootRoute` | absent | Optional normal root route with explicit `connectionId` and `model`; its limits and confinement are independent of the child settings |

| `permissionMode` value | Native behavior |
|---|---|
| `dontAsk` | Deny operations that are not already authorized instead of prompting |
| `acceptEdits` | Accept file edits; any remaining permission prompt is denied by the unattended callback |
| `auto` | Let Claude Code's native classifier allow or deny permission requests |
| `plan` | Run in native planning mode, deny execution approval, and return the completed plan as the final answer |
| `bypassPermissions` | Explicitly set the SDK's dangerous confirmation and bypass permission checks |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-subagent-claude-code) is the exhaustive source for every accepted field and its JSDoc. A configured `model` passes unchanged to every query from that provider instance; omission leaves native model selection in force. Credential-shaped ambient variables are removed before the explicit `env` overlay, so an API key intended for the child must be supplied there. The provider omits the SDK `settingSources` option, so Claude Code reads the host's normal user, project, and local settings relative to the parent Session cwd. It does not copy or filter those files, create or modify login state, inspect `PATH`, or fall back to a host `claude` executable.

### Normal root turns

Set `rootRoute.connectionId` and `rootRoute.model` on the installed provider row, then select provider `claude-code-native` with that exact model for the root Agent. The route requires the exact live Session cwd to equal a registered project root. The child `env`, model and permission mode do not configure this route. Root requests accept text history; per-request effort, service tier, token overrides, nested Sessions and auxiliary generation are unsupported.

The route keeps one confined SDK query across compatible turns of the same live Harness Session, with native transcript persistence disabled. The native default permission policy remains active. A deny-or-neutral `PreToolUse` hook rechecks the initiating Agent, Session, project and current sandbox policy before each tool; native permission prompts use Harness approval for that exact action and permit only `allowed-once`. Policy narrowing, cancellation, unsupported nested or background work, recalled memory, context reset and compaction close the query. The route requires full process enforcement, refuses full-access mode, and refuses writable roots overlapping the native profile or authentication paths. Native cache or authentication refresh writes outside that policy can fail; the route never widens roots.

The route captures the actual launched `HOME` on POSIX or `USERPROFILE` on Windows and the `CLAUDE_CONFIG_DIR` path, resolving missing suffixes from existing ancestors. These paths appear in bounded durable public protocol records. `connectionId` is a deployment label, not an account, external CLI profile or reusable native session. The configured tools are Read, Glob, Grep, Bash, Edit and Write; file-loaded settings, skills, plugins and external MCP are disabled and the actual native init declarations are checked.

`maxSessions`, `maxItems`, pending-frame, input, output, complete-session byte and turn-duration limits bound retained work. Shutdown cancels pending confinement and direct outcome waits, then observes the managed range for `disposeGraceMs + 1000` milliseconds, capped by the timer limit. Failed confirmation closes protocol streams, retains failed process ownership and blocks further admission. Exact public SDK inputs/system and owned context frames are durable ignorable `claude-code/root-protocol` records, separate from sanitized `skill/native-item` learning. They preserve observable records; hidden native prompts, tool schemas and private memory cannot be reconstructed from them. This ephemeral root route does not support restart, external CLI continuation or alternating native writers. The separate sequential mode below resumes persisted original sessions.

### Sequential original-session conversation

The [original-profile coding-session source](../../session/coding-session/README.md) opts into persisted same-ID Claude conversation turns through its optional `sequentialHandoff` object with `knownUnmanagedStartup: true`. That field defaults to false; an omitted object or false or unestablished declaration leaves the source read-only. That object requires the selected `nativeExecutablePath` and exact `nativeExecutableSha256` for the pinned Claude 2.1.263 payload. The `codingSessions` service's `enableSequentialHandoff` setting defaults to false and must also be enabled. This mode is independent of child settings and the ephemeral `rootRoute`. It requires the selected live idle same-project Y root, the exact original profile/project/session, and acknowledgement that other writers are closed and the native profile remains unchanged until release.

`knownUnmanagedStartup` is a trusted deployment declaration that the selected account, profile and machine have no managed, remote, helper or parent startup policy, separate from the user's writer/profile acknowledgement. Before every dispatch, a fresh selected-profile worker observes public `resolveSettings({ cwd, settingSources: [] })`; only an empty supported cascade yields `noManagedSettingsObserved: true` and a fingerprint. Nonempty settings, per-field settings origins or source lists, unknown shape, thrown resolution, any stderr bytes or incomplete stderr coverage refuse before durable dispatch and query. SDK 0.3.263 exposes no resolution-error list, skips policy-helper execution and cannot certify fresh remote-policy absence. The declaration is an operational assumption, not an error-free startup certificate, atomic policy pin or managed-policy bypass.

Each turn starts a cold finite SDK query with original-ID resume and persistence enabled; it neither forks nor replaces history. The adapter supplies no new model or effort override; native resume and settings resolution determine effective selection, which is not guaranteed to match the prior CLI turn. Native project tools, settings-loaded skills, plugins and external MCP are disabled. The native process can write only the selected project's transcript directory. Project work cannot execute through this mode. Child-only `CLAUDE_CODE_DISABLE_FAST_MODE=1`, `settings.fastMode: false`, `settings.fastModePerSessionOptIn: true` and `settingSources: []` disable Fast without rewriting the original profile settings. Native retained context remains subject to Claude's compaction and retention; continuation does not transfer interrupted tools or private live state.

The executor records bounded public inputs and frames in the initiating Y Session. Successful release requires a naturally exited owned process/range, drained stdout and stderr, no observed diagnostics or persistence failure, and cold original-profile readback matching the retained prefix and exact dispatched user and assistant bodies. SDK result, idle or `Query.close()` alone does not establish this evidence. Uncertain release stays blocked, including after a restart that loses the process handle. Resume the same ID externally only after release succeeds; code rollback cannot remove native turns already appended. The [coding-session service](../../session/coding-session/README.md) owns persistent claim, continue and release controls.

### Exposing the tool

Each delegation tool row names one provider and needs its own `toolName`, so the model sees static tools rather than a dynamic provider selector. Full Agent Presets carry a matching default tool row with `disabled: true`; copy a preset and remove that field to expose `subagent_claude_code` only to agents composed from the copy.

```yaml
- id: jobs
  name: '@deepseek-ai/dsh-jobs-local'
- id: tool-jobs
  name: '@deepseek-ai/dsh-tool-jobs'
- id: tool-subagent-claude
  name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: claude-code
    toolName: subagent_claude_code
    backgroundMode: one-shot
    maxDepth: provider-managed
```

The `one-shot` policy keeps omitted or `false` `run_in_background` calls in the foreground, while explicit `true` returns a parent-owned job id for `job_output` or `job_kill`; the base host and full presets already provide the generic Job registry and controls.

### What you get

A foreground call gives the model the strict final Claude Code answer, or an error with the stop reason and optional safe diagnostic for a failed run. A background call first returns a job id; the generic job controls later deliver a completion notice and expose the same final answer or failed status through `job_output`. Claude Code reasoning, tool activity, intermediate messages, stderr, and workspace diffs never enter the parent session.

### Failure and recovery

An install that omits optional dependencies, uses an unsupported platform, or loses the selected payload leaves the provider dormant and fails the first delegation at the SDK startup boundary with a safe `query-start` / `unknown` failure fact; there is no host-CLI fallback. The original product error stays on the internal cause chain and in the provider's Host log. A cancelled run settles as `aborted`.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the provider drives a real Claude Code CLI and where the observable behavior comes from; the full contract lives in [Use this package](#use-this-package).

### Design concept

- **One fresh child query per run.** Every run has an independent SDK query, cancellation controller, CLI process, and non-persisted product session; there is no continuation, resume, or pooling.
- **Native child settings are authoritative.** The provider deliberately omits the SDK `settingSources` option, so Claude Code reads the host's normal user, project, and local settings; an optional `model` and the required `permissionMode` are the only query-level overrides.
- **Unattended child delegation.** `AskUserQuestion` is disabled and permission prompts are denied except in bypass mode, so the query never waits for a user interface.

The live `claude-code/tool-observations` event publishes frozen, bounded child diagnostics to observers scoped to the initiating parent Agent and carries its exact Session separately. Each receipt preserves the SDK session id, assistant message UUID as `sourceMessageId`, tool-use id, optional actual result message UUID, allowlisted tool name, action kind and reported outcome. Message UUIDs identify source messages, not native turns. Explicit tool-result `is_error` values determine `reported-success` or `reported-error`; omission remains `unknown`. The event does not append parent Session evidence or verify task completion, and retains no arguments or output bodies. Publication requires normal iterator completion and is suppressed after cancellation, disposal or an observed process failure.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: config schema, provider registration |
| [`src/run.ts`](src/run.ts) | The SDK query lifecycle, result acceptance, and permission handling |
| [`src/process.ts`](src/process.ts) | Managed-range termination escalation on disposal |
| [`src/tool-observations.ts`](src/tool-observations.ts) | Bounded direct SDK tool receipt correlation and sanitization |
| [`src/root.ts`](src/root.ts), [`src/root-process.ts`](src/root-process.ts), [`src/root-profile.ts`](src/root-profile.ts) | Optional root query, initiating authority, complete confinement and profile isolation |
| [`src/root-observations.ts`](src/root-observations.ts), [`src/root-types.ts`](src/root-types.ts) | Actual SDK identity pairing and separate bounded public protocol records |
| [`src/sequential.ts`](src/sequential.ts) | Separate cold original-ID conversation turns and independently drained native processes |
| [`cordis.patch.yml`](cordis.patch.yml) | The Profile patch layer that registers the dormant provider |

### Run flow

A start accepts only a non-empty sequence of text blocks and derives the child cwd from the parent session. It creates a private `AbortController`, calls the official SDK `query()` with the exact concatenated task, and publishes the run only after the SDK's custom-spawn hook has supplied a live CLI handle owned by the subprocess seam. The provider iterates the complete message stream and accepts only a `result` message with `subtype: "success"`, `is_error: false`, and a nonblank `result`, followed by normal iterator completion. Every other outcome maps to a fixed-category `error` diagnostic naming the lifecycle stage and observed process outcome — the category set lives in [`src/run.ts`](src/run.ts). Local cancellation wins the result race and maps to `aborted` without a failure diagnostic.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from this provider to the seam it plugs into and the sibling product provider.

- [Subagent subsystem](../../../docs/subsystems/subagent.md) — the service contract, provider contract, and terminal result semantics.
- [dsh-subagent seam](../subagent/README.md) — the registry and start API this provider registers on.
- [Codex subagent provider](../subagent-codex/README.md) — the sibling product backend over the official app-server protocol.
- [historical Claude Code and Codex backends](../../../.agents/notes/archived/feature/2026-08-04-claude-code-and-codex-subagent-backends.md) — the design record for the product providers.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-subagent-claude-code) — every accepted config field and its source declaration.

-----

<a id="model-experience"></a>
## Model Experience

### Child request

#### What the model sees

The Claude Code child receives the standalone text task as one fresh SDK query. Its workspace is the parent Session cwd; the selected provider instance fixes the query's configured model, environment, and non-interactive permission mode, while an omitted model and every other product setting come from native Claude configuration. The executable version comes from the Bundle's pinned SDK platform payload.

#### Token effect

The child pays for an independent Claude Code context and query. Child tokens do not enter the parent's context.

#### KV Cache effect

Independent of the parent request cache. Reuse depends only on Claude Code's own model, instructions, tools, native settings, and fresh query.

### Parent scheduling and results, indirectly

#### What the model sees

Through `dsh-tool-subagent`, a foreground call gives the parent the strict final Claude Code answer or an error containing the stop reason and optional safe diagnostic for a non-completed result. That diagnostic can distinguish a coarse action category, lifecycle stage, and observed process outcome without copying raw product text or version-specific subtype names. A background call first returns a Job id; the generic job controls later deliver a completion notice, expose the same final answer or failed status detail through `job_output`, and let `job_kill` request cancellation. Claude Code reasoning, tool activity, intermediate messages, stderr, workspace diffs, usage, product ids, tool inputs, and raw protocol payloads are not copied into the parent Session.

#### Token effect

Foreground input grows by the retained final answer or error. Background input also includes the start acknowledgement, completion notice, and any `job_output`, `job_kill`, or later status results; child tokens still do not enter the parent context. This provider adds no parent tool schema by itself.

#### KV Cache effect

Append-only: foreground adds one result after the reusable parent prefix, while background appends the Job acknowledgement, notice, and later control or collection results. Background scheduling can add a notice-driven turn, but none of these messages rewrites the earlier prefix.

### Normal root request

#### What the model sees

The native root model receives the owned system and quoted text history, then native tool results inside its live query. Harness projects assistant text into the ordinary conversation and keeps exact public protocol records and sanitized learning items ignorable. The continuation marker binds the exact projected history and assistant text; it does not restore hidden native context.

#### Token effect

The native query retains its own tool context across compatible live turns. A changed projected history, system or sandbox policy creates a fresh query with the current text history; root limits stop unsupported native context changes.

#### KV Cache effect

Native reuse follows the live SDK query. Public protocol records and learning items add no Harness model input, and no cache or restart restoration is promised.

### Sequential native conversation

#### What the model sees

Claude resumes its retained native conversation and receives one explicit human message under the original ID. The query disables project tools and does not receive replacement mirror history. Public protocol records remain log-only in the initiating Y Session.

#### Token effect

Each native continuation uses Claude's retained context and consumes native model tokens. Conversation-only turns produce no paired project-tool observations for automatic procedure learning.

#### KV Cache effect

Native cache behavior follows Claude's persisted resume and retention. Neither the mirror nor the public protocol record promises hidden context or cache restoration.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


Sequential conversation excludes project tools and requires completed release before external resume. Unresolved ownership cannot be recovered from history metadata alone. The following child-provider limits define when a delegation is a poor fit or needs special operational care. They are current package constraints, not a general Claude Code comparison or a task backlog.

- **One fresh child query and process per run** — there is no continuation, resume, pooling, progress stream, or product-session persistence.
- **Direct diagnostics have limited coverage** — only Read, Glob, Grep, Bash, Edit, MultiEdit, Write, WebFetch and WebSearch can contribute correlated receipts. Replay, nested workers, Agent/Task, MCP and dynamic tools, background tasks, duplicate or orphan identities and missing or mismatched result sessions are excluded. Bash requires structured foreground output metadata; unstructured receipts cannot rule out background placeholders and are excluded. Diagnostics neither prove task success nor enable automatic learning.
- **Static instance selection** — Profile rows fix provider names, optional models, and tool bindings; calls cannot choose or change either a provider or model dynamically, and every exposed tool needs a unique `toolName`.
- **Host settings are intentionally authoritative** — when `model` is omitted, project and user settings choose it; native settings always retain the remaining tools and behavior, and the provider does not provide a filtered or hermetic production mode.
- **Authentication and account state remain native** — the Bundle supplies the CLI but does not create an account, log in, or rewrite Claude settings; configuration and authentication failures surface with their lifecycle stage and the safe `unknown` fallback rather than a separate public classification.
- **The SDK platform payload is required at delegation time** — installs that omit optional dependencies, unsupported platforms, and missing or damaged payloads fail at the first query; there is no host-CLI fallback.
- **No human interaction path** — `AskUserQuestion` is disabled, permission prompts are denied, MCP elicitation is declined, and blocking dialogs fail closed instead of suspending.
- **Assistant payload is final text only** — reasoning, intermediate messages, tool traffic, usage, stderr, and workspace diffs remain product-local.
- **No optional shared capabilities** — `agentOptions`, output schemas, child personas, tool filtering, and harness depth enforcement are rejected by the shared service for this provider.
- **No wall-clock timeout or side-effect rollback** — the caller cancels long work, and files or external systems changed before cancellation are not restored.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and undecided directions. It is explicitly non-authoritative — shipped behavior and limits live in the sections above and in the package code.

- **Payload size disclosure** — the current darwin-arm64 platform payload packs to about 92 MB and unpacks to about 325 MB; these are disclosure numbers, not installation thresholds.
- **Version-pinned protocol** — the runtime dependency is pinned to Agent SDK 0.3.263; upgrading pins a new SDK version and requires re-running the keyless real-product and loader-composition evidence.

</details>
