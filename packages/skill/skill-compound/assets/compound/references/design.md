# Design

Start with a concrete caller: what does it pass, receive, and observe on success and failure? Derive the data model and smallest useful interface from that example.

For a feature, turn the requested behavior and meaningful failure cases into acceptance examples before implementing it.

Identify valid states, transitions, ownership, lifetime, and external boundaries. Prefer structures that make contradictory states difficult to construct. Keep transport and persistence details outside domain decisions when that boundary simplifies callers.

For a consequential unresolved choice, compare structurally different alternatives using the same caller and failure cases. A small experiment can settle an empirical question. Use the simplest design supported by the evidence; routine changes can follow a sound existing pattern.

State what each module owns and which decisions its interface hides. If callers repeatedly need internal knowledge, or unrelated cases demand the same workaround, revisit the model. A new layer should remove more reader work than it introduces.

Implement in units with observable checks. Migrate internal callers together where practical. Preserve compatibility when an actual external contract requires it, with an explicit removal strategy.

## Existing repositories

Use the requested checkout. Check fork or upstream metadata when the target is unclear. A bare `contribute` gives a short read-only orientation from the contribution guide, a representative code-and-test pair, and the documented checks. Use source reads for orientation. Ask what the user wants to change, then stop.

For edits, check working-tree status and use applicable project instructions, including any for the affected directory. Reuse established conventions. Start from the target, its caller and nearest test. Use relevant line ranges. Read another example only if the local pattern is still unclear. Consult path-scoped history, design notes, or linked issues and PRs only when the rationale could change the patch. Distinguish recorded decisions from inference.

Use the smallest patch that fits the local design and preserves existing behavior outside the request. Reuse its extension points, helpers, and test style. Expand scope only for a requirement or compatibility need. Keep unrelated cleanup, formatting, moves, and dependency changes out of the diff.

Check your hunks against the task and preserve pre-existing edits. Run the relevant documented checks. Open another guide only for an unresolved decision. Setup, `compound tidy`, and publication require separate user requests.
