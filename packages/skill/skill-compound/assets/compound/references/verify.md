# Verify

Choose evidence that could falsify the success claim. Run it against the final artifact and inspect the result yourself, including delegated work.

- Features: exercise the caller's successful path, meaningful failure cases, and relevant integration surface.
- Bugs: show the original reproduction failing before and passing after the correction.
- Refactors: compare observable behavior against the recorded baseline.
- Performance: compare the same workload and explain what the measurement includes.
- Documentation or packaging: inspect the actual paths, examples, links, and supported host format.

Tests should detect an incorrect observable result while surviving a behavior-preserving internal rewrite. Derive expected values from the contract, not from the implementation being tested. Select one check for each required behavior. Reuse passing regression/caller assertions; add output demonstrations or randomized probes only for a named coverage gap. Match effort to the change; inspect reversible wording edits.

Use the project's documented commands, working directory and environment. On a setup failure, inspect the captured error and correct its cause before retrying; do not rotate through runners or optional tools. Keep the exit status and enough failure output to diagnose the result. For long output, capture it once and inspect the log instead of rerunning solely to change verbosity. Run checks selected for the changed surface and project requirements against the final artifact. Reuse passing results while the checked files, inputs and environment are unchanged; a commit or push alone does not require a rerun. Rerun after relevant edits or to resolve failures. Inspect the diff and status for unintended files. Report the outcome, checks and limits once, concisely. A passing check establishes only the artifact and surface it exercised.
