# Verify

Choose evidence that could falsify the success claim. Run it against the final artifact and inspect the result yourself, including delegated work.

- Features: exercise the caller's successful path, meaningful failure cases, and relevant integration surface.
- Bugs: show the original reproduction failing before and passing after the correction.
- Refactors: compare observable behavior against the recorded baseline.
- Performance: compare the same workload and explain what the measurement includes.
- Documentation or packaging: inspect the actual paths, examples, links, and supported host format.

Tests should detect an incorrect observable result while surviving a behavior-preserving internal rewrite. Derive expected values from the contract, not from the implementation being tested. Match verification effort to the change; a reversible wording edit needs inspection, not a new test suite.

Run the relevant checks after the last change. Inspect the diff and repository status for unintended files. Report what was run, what it established, and what remains unverified. Existing green results, successful compilation, or an agent's completion message cannot establish a claim about a different artifact or surface.
