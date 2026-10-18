# Design

Start with a concrete caller: what does it pass, receive, and observe on success and failure? Derive the data model and smallest useful interface from that example.

For a feature, turn the requested behavior and meaningful failure cases into acceptance examples before implementing it.

Identify valid states, transitions, ownership, lifetime, and external boundaries. Prefer structures that make contradictory states difficult to construct. Keep transport and persistence details outside domain decisions when that boundary simplifies callers.

For a consequential unresolved choice, compare structurally different alternatives using the same caller and failure cases. A small experiment can settle an empirical question. Use the simplest design supported by the evidence; routine changes can follow a sound existing pattern.

State what each module owns and which decisions its interface hides. If callers repeatedly need internal knowledge, or unrelated cases demand the same workaround, revisit the model. A new layer should remove more reader work than it introduces.

Implement in units with observable checks. Migrate internal callers together where practical. Preserve compatibility when an actual external contract requires it, with an explicit removal strategy.
