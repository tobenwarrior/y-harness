# Refactor

Name the behavior that must remain stable and the structural problem the change removes. Record a baseline through existing tests, representative outputs, or a characterization check before moving code.

Choose a target with clearer ownership, fewer hidden state assumptions, or fewer layers to trace. Keep a cohesive file when splitting it would scatter one responsibility. Inspect configuration, generated references, dynamic entry points, and external consumers before removing apparent dead code.

Move one verifiable unit at a time. For internal API changes, migrate callers and remove the obsolete implementation together when practical. An externally consumed API needs its compatibility contract respected.

Compare behavior against the baseline, including error and boundary cases. A passing type check is not equivalence evidence. If the task uncovers a bug or requires new behavior, identify that scope change explicitly rather than concealing it as cleanup.
