# Debug

Capture a concrete failing input, expected result, actual result, and execution surface. Reproduce against the relevant version before choosing a fix. If the failure is intermittent, record conditions and instrument the narrowest uncertain boundary within the authorized environment.

Form competing hypotheses and run checks that distinguish them. Follow the first incorrect state or effect back to its cause. A guard is appropriate when it handles a legitimate domain state; otherwise it may hide a broken invariant.

Add a regression check that fails because of the observed defect, then make the smallest causal correction. For split paths, test the required property directly. One operation's success does not prove another's preconditions. Cover supported input categories and equivalent values across paths in both orders. Remove instrumentation and changes whose hypothesis was refuted.

Replay the original failure on the same surface and run relevant regression checks. Unit tests, type checks, and compilation each establish different facts. If the original surface is unavailable, report the narrower evidence and unresolved limitation instead of declaring the defect gone.
