# Review

Establish intended behavior and the contract affected by the diff. Follow changed values through callers, boundaries, state transitions, errors, and observable effects. Examine tests as claims about that contract.

Look for correctness failures, unsupported assumptions, concurrency or retry problems, and design that makes a local change unsafe elsewhere. Review reader effort: unnecessary layers, synchronized duplicate state, unclear ownership, and misleading names. Apply project conventions without turning preferences into defects.

Use independent reviewers for distinct uncertainties when the host supports it and the benefit warrants the cost. Give them the same intent and artifact, then verify findings yourself. Reviewer agreement is supporting evidence, not proof.

Return actionable findings with location, triggering condition, impact, and supporting evidence. Separate confirmed defects, unresolved questions, and optional improvements. Dismiss a false positive with a concrete reason. A review request remains read-only unless changes are authorized.
