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

Pinning protects maintenance. Adoption is a deliberate action separate from automatic cleanup or semantic learning. Eligible managed skills expose archive/restore, conservative whitespace cleanup preview and explicit application, and historical instruction rollback. Existing user and provider skills retain their Host-declared protections. Native metadata-only entries show unknown instruction size and usage; unavailable providers remain visible as unavailable. No permanent deletion is offered.

### Review semantic proposals

The Review tab lists project-scoped create, update, compression and reversible archive proposals. Eligible substantial live API tasks automatically suggest create or update proposals; compression and deduplication require an explicit request. Selecting a proposal loads its complete before/after diff, recorded task evidence, uncertainty and any validation findings. Completion and tool outcomes do not establish successful skill use; the review distinguishes observations from independent checks, and the shipped package supplies no independent validator.

Archive review also shows the complete retained skill snapshot, including its identity, source and resource hashes, instructions, resources, and references, beside the source removal diff. The Host checks whole-bundle equivalence and preserves resolved reference targets before applying an archive; matching link text alone does not establish equivalence.

Apply or reject a proposal explicitly after reviewing its details. Every semantic source write requires explicit review. The Host checks current source hashes and protections before applying changes; pinned, protected, and native skills remain ineligible for semantic maintenance. Applied instruction changes retain revision history for rollback, and archived bundles can be restored. An interrupted proposal in the applying state offers **Resume application**; the Host reconciles committed changes and rechecks every remaining source and maintenance permission before continuing.

### Learning scope

Automatic learning produces review proposals only. Semantic source writes remain reviewed actions; the shipped runtime has no production automatic semantic operator. Validator, policy, per-file semantic opt-in and receipt controls remain inactive extension support, separate from the existing whitespace cleanup opt-in. No independent validator is supplied or selected by default.

<a id="understand-the-implementation"></a>
## Understand the implementation

`controller.ts` owns Remote query and operation state. It retains metadata on refresh failure, rejects late detail results after selection changes, and sends observed source hashes with edits. `navigation-store.ts` owns only view state. `SkillLibraryPage.tsx` consumes framework hooks and callbacks; `SkillGraph.tsx` consumes metadata, without reading instruction bodies. The deterministic graph layout uses explicit links and membership anchors in 36 fixed passes with bounded neighbor sampling. It has no continuous solver, graph database or third-party graph dependency. Manual refresh requests fresh native metadata; ordinary reads do not start a native runtime. [The Host library](../../skill/skill-library/README.md) owns evidence capture, registered proposal generators, protection checks and file history; validator and policy APIs support inactive extensions.

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
- **Semantic providers** — this package supplies no generator or independent validator. Review reflects Host-recorded evidence and any registered validation; it cannot establish semantic correctness from task completion, model claims or a smaller body alone. Validator, policy and receipt APIs remain inactive extension support; no production semantic operator automatically applies proposals.
- **Maintenance scope** — whitespace cleanup removes excess blank lines outside code blocks; semantic changes require proposals and explicit review. Provider-owned skills stay read-only. The graph uses explicit relationships, and no permanent deletion is offered.

<a id="dev-note"></a>
### Dev Note

None.
