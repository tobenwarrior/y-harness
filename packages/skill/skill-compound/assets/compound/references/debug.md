# Debug

Capture the failing input, expected result, actual result, and execution surface. Start with the nearest regression and project runner. Use the real receiver’s source or existing tests to justify changed argument expectations. If a mock hides an uncertain contract, probe the receiver with the caller's exact arguments through the operation that decides success. For parsing or default changes, cover valid inputs with omitted fields and meaningful falsy values. Reproduce before exploring other dependencies, history, or alternative fixes. Diagnose setup failures before retrying. Use the same environment for probes and prevent Python bytecode with `PYTHONDONTWRITEBYTECODE=1`.

For a known pytest failure, start with `--tb=line`. Confirm the selected test, exit status and expected failure before editing source. Expand the traceback only when the report leaves that check unresolved. For an intermittent failure, record conditions and instrument the narrowest uncertain boundary within the authorized environment.

Form competing hypotheses and run checks that distinguish them. Follow the first incorrect state or effect back to its cause. A guard is appropriate when it handles a legitimate domain state. Check the underlying invariant otherwise.

Reuse fixtures and make the smallest causal correction. For split paths, test the required property directly on each path. Cover supported input categories and equivalent values across paths in both orders. Remove instrumentation and changes whose hypothesis was refuted.

When both patches are ready, use one supported tool batch. Apply the test patch, run the regression, and check its exit status and expected failure. Apply the source patch only after that check passes. Run the final suite and, in a Git checkout, `git diff --check` in the same batch. Return the reproduction and final results. Stop on patch errors or unexpected results. In Codex, await `tools.apply_patch` before `tools.exec_command`. If the source patch depends on the result, end the batch after the regression.

Verify on the original surface. If the final suite includes the regression, its passing result verifies the fix. After the last source edit, run the full suite once and check the diff. Run separate checks for specific gaps or project requirements. Reuse that result while checked inputs and environment are unchanged. If the original surface is unavailable, report what you verified and the remaining gap.
