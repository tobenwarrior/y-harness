# Investigate

Trace the question through its public entry point, data, state transitions, and side effects. Read callers and configuration as well as the named implementation. For historical rationale, use available commits, issues, and design records; distinguish a recorded decision from a plausible explanation.

Prefer the smallest observation that separates competing explanations. A read-only question does not authorize a code change, installation, benchmark with external costs, or instrumentation of a live system. Use existing observations or a permitted isolated probe. If evidence is unavailable, state what remains unknown.

Return the answer first, followed by specific file locations or sources and material uncertainty. Describe actual behavior before suggesting improvements. An unsupported assumption about how cancellation, retries, ordering, or ownership works is not an explanation.
