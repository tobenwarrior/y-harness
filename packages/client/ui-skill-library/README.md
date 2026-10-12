---
description: "Browse project and shared skills, inspect explicit relationships, and review reversible instruction changes."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-skill-library

English | [中文](README.zh.md)

## Summary

Browse skills by project or shared scope, inspect their instructions and revision history, and explore explicit relationships. Review complete proposed changes with recorded evidence and uncertainty before applying them. Adopt and maintain eligible skills through reviewed, reversible actions. Use the panel with the Host skill library; native and protected sources remain read-only.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

Mount this browser plugin with `dsh-skill-library` and API Remotes. Open Skills from the sidebar to browse one compact Project and Shared explorer beside the document or graph. The browser shell sidebar can collapse to its existing icon ribbon; macOS Desktop retains the shell's hidden-sidebar behavior and reopen controls. The Skills explorer remains available in both views and can be hidden independently. The mode tabs and search/filter controls use two compact rows, with inventory counts and source availability in the status area. Search and state filters use metadata; selecting an item fetches its instructions and revisions. The relationship graph draws every matching skill, with project filtering, pan, zoom, fit and keyboard activation. Graph controls overlay the canvas, and the inspector can collapse while retaining selection and loaded instructions. Stable project colors identify membership, skill node size reflects explicit link degree, and group nodes remain distinct. Labels appear progressively with zoom; selected, hovered and keyboard-focused names remain visible. The graph separates project membership from resolved explicit links without inferring similarity or usage.

Pinning protects maintenance. Adoption is a deliberate action separate from automatic cleanup or semantic learning. **Delete** removes an eligible source from discovery and retains its complete bundle in the Host archive; **Deleted skills** filters those entries, whose details expose **Restore**. Managed skills also expose reviewed whitespace cleanup and historical instruction restore. **Clean up this skill** requires current per-file consent and an approved compression or archive policy. **Force cleanup** requests an immediate pass with the same ownership, pin, policy and source-hash checks. Existing user and provider skills retain their Host-declared protections. Native metadata-only entries show unknown instruction size and usage; unavailable providers remain visible as unavailable. No permanent deletion is offered.

### Review semantic proposals

The Review tab lists project-scoped create, update, compression and reversible archive proposals. Eligible substantial completed work can suggest create or update proposals; maintenance passes produce compression and duplicate archive proposals. Selecting a proposal loads its complete before/after diff, recorded task evidence, uncertainty and any validation findings. Completion and tool outcomes do not establish successful skill use; the review distinguishes observations from independent checks. Native work observations remain unverified.

Archive review also shows the complete retained skill snapshot, including its identity, source and resource hashes, instructions, resources, and references, beside the source removal diff. The Host checks whole-bundle equivalence and preserves resolved reference targets before applying an archive; matching link text alone does not establish equivalence.

Apply or reject a proposal explicitly after reviewing its details. Automatic application additionally requires an approved policy and a trusted validation receipt for the complete proposal; existing sources require consent for their current version. The Host checks current source hashes and protections before applying changes; pinned, protected, and native source skills remain ineligible for semantic maintenance. Applied instruction changes retain revision history for rollback, and archived bundles can be restored. An interrupted proposal in the applying state offers **Resume application**; the Host reconciles committed changes and rechecks every remaining source and maintenance permission before continuing.

### Learning scope

Approve an existing skill's policy and enable **Automatic learning** separately to authorize maintenance of its current version. Revoking the policy or disabling per-file consent stops that authorization. Whitespace cleanup has its own opt-in.

Open **Project learning** from the toolbar to authorize creation before any skill exists. Select a known project, explicitly allow new skills from native work, then approve the project policy. This permits separate skills managed by Y to be created from substantial recorded observations; existing protected sources still need adoption and recorded outcomes remain unverified. The dialog exposes project policy revocation even when the native learning provider is unavailable.

### Decision settings

Settings → Models includes a separate Decision footer. Choose an available response-only API model, select any declared reasoning effort and processing tier explicitly, then save the opt-in against the current configuration. Native Codex routes remain visibly unavailable. The main chat model and authority stay unchanged. Choose a registered project and query to preview candidate order deliberately; ordinary Skills or Models browsing makes no advisory model call. Results preserve deterministic candidate membership and explicit choices, and failures use deterministic order. The Host owns request, token, deadline and log limits; the preview discloses these and cannot establish model quality.

<a id="understand-the-implementation"></a>
## Understand the implementation

`controller.ts` owns Remote query and operation state. It retains metadata on refresh failure, rejects late detail results after selection changes, and sends observed source hashes with edits. `navigation-store.ts` owns only view state. `SkillLibraryPage.tsx` consumes framework hooks and callbacks; `SkillGraph.tsx` consumes metadata, without reading instruction bodies. The deterministic graph layout uses explicit links and membership anchors in 36 fixed passes with bounded neighbor sampling. It has no continuous solver, graph database or third-party graph dependency. Manual refresh requests fresh native metadata; ordinary reads do not start a native runtime. [The Host library](../../skill/skill-library/README.md) owns evidence capture, registered proposal generators, validation and consent checks, automatic maintenance and file history.

<a id="model-experience"></a>
## Model Experience

### Library review and maintenance

#### What the model sees

`SkillLibraryPage` browsing and review change no request message or tool schema. Proposal generation runs through a registered Host generator, which may call a model with selected evidence and skill instructions. Maintenance updates skill files through the Host; a later skill load can supply the resulting instructions to a model. The graph remains human navigation.

#### Token effect

Browsing existing proposals, evidence, and diffs adds no model tokens. This package makes no model calls itself; the registered Host generator owns any model cost of generating a proposal. The Host skill loader owns the token cost when an edited skill is subsequently loaded.

#### KV Cache effect

The UI makes no prompt or history edit. The Host generator owns any generation request and cache behavior. Later skill loads use the Host loader's existing request admission and logging behavior.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Evidence coverage** — recorded loads and completed tasks do not establish successful skill application. Unknown telemetry is never labeled unused or rarely used. Native implicit loads and unavailable instruction bodies do not acquire automatic learning coverage through this UI.
- **Semantic providers** — this package supplies no generator or validator. Review reflects Host-recorded evidence and registered validation; it cannot establish semantic correctness from task completion, model claims or a smaller body alone. Host validators authorize only their recorded scope; native observation learning does not establish a verified outcome.
- **Maintenance scope** — whitespace cleanup removes excess blank lines outside code blocks. Automatic maintenance requires approved policy, validation and current-version consent; Force cleanup never widens those permissions. Provider-owned skills stay read-only. The graph uses explicit relationships, and deletion retains restorable bundles.

<a id="dev-note"></a>
### Dev Note

None.
